/* ============================================================
   oss.js — 阿里云 OSS 云端备份（纯前端直连）
   ------------------------------------------------------------
   完全参照 evanlu 的实现思路：
     · Bucket / Endpoint / AccessKey / Secret 只存在本地浏览器，
       清掉浏览器数据后重新填即可（密钥不上传任何服务器）。
     · 用阿里云 OSS V4 签名生成「预签名 URL」，浏览器直接 PUT/GET，
       不需要自建后端（静态 Pages 也能用）。
   前置条件（用户在阿里云控制台配置）：
     1) Bucket 已开启「跨域访问（CORS）」，允许 GET/PUT/DELETE/HEAD；
     2) AccessKey 用「 RAM 子用户 + 仅该 Bucket 的读写权限」，
        不要用主账号 AccessKey（纯前端一定会暴露 SecretKey）。

   数据怎么存：
     · 本地：localStorage（文字/设置/字卡）+ IndexedDB（表情包/头像/字体大图）
     · 云端：把 Store.snapshot() 整包上传到 <prefix>full-backup.json
   ============================================================ */

import { Store } from '../core/store.js';

const KEY = 'ossConfig';

/* ---------------- 配置读写 ---------------- */
function getConfig() {
    const c = Store.get(KEY, {}, { scope: 'global' });
    return (c && typeof c === 'object') ? c : {};
}
function saveConfig(cfg) {
    const cur = getConfig();
    const next = Object.assign({}, cur, cfg || {});
    Store.set(KEY, next, { scope: 'global' });
    return next;
}
function isConfigured() {
    const c = getConfig();
    return !!(c.endpoint && c.bucket && c.ak && c.sk);
}

/* ---------------- V4 签名工具（核心，照搬阿里云文档） ---------------- */
async function _hmacSha256(key, message) {
    const enc = new TextEncoder();
    const keyBuf = key instanceof Uint8Array ? key : enc.encode(key);
    const cryptoKey = await crypto.subtle.importKey(
        'raw', keyBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
    return new Uint8Array(sig);
}
async function _sha256Hex(message) {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(message));
    return _bytesToHex(new Uint8Array(buf));
}
function _bytesToHex(bytes) {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        const h = bytes[i].toString(16);
        hex += (h.length === 1 ? '0' : '') + h;
    }
    return hex;
}
function _iso8601(date) {
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return date.getUTCFullYear() + p(date.getUTCMonth() + 1) + p(date.getUTCDate()) +
        'T' + p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + 'Z';
}
function _dateStamp(date) {
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return date.getUTCFullYear() + p(date.getUTCMonth() + 1) + p(date.getUTCDate());
}
/* OSS 百分号编码（保留 - _ . ~，其余全编码） */
function _ossEncode(s, encodeSlash) {
    s = encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    if (!encodeSlash) s = s.replace(/%2F/g, '/');
    return s;
}

/* 生成 V4 预签名 URL（GET/PUT/DELETE/HEAD 通用） */
async function buildSignedUrl(cfg, method, objectKey, extraQuery, contentType, expiresSeconds) {
    const now = new Date();
    const dateTime = _iso8601(now);
    const dateStamp = _dateStamp(now);
    const region = String(cfg.endpoint || '').replace(/\.aliyuncs\.com$/, '').replace(/^oss-/, ''); // oss-cn-hangzhou
    const host = cfg.bucket + '.' + cfg.endpoint;
    const credentialScope = dateStamp + '/' + region + '/oss/aliyun_v4_request';
    const credential = cfg.ak + '/' + credentialScope;

    const query = {};
    if (extraQuery) {
        for (const k in extraQuery) {
            if (Object.prototype.hasOwnProperty.call(extraQuery, k)) query[k] = String(extraQuery[k]);
        }
    }
    query['x-oss-signature-version'] = 'OSS4-HMAC-SHA256';
    query['x-oss-credential'] = credential;
    query['x-oss-date'] = dateTime;
    query['x-oss-expires'] = String(expiresSeconds || 120);
    query['x-oss-additional-headers'] = 'host';

    const keys = Object.keys(query).sort();
    const canonicalQuery = keys.map((k) => _ossEncode(k, true) + '=' + _ossEncode(query[k], true)).join('&');

    const canonicalUri = '/' + cfg.bucket + '/' + (objectKey ? _ossEncode(objectKey, false) : '');
    const requestPath = '/' + (objectKey ? _ossEncode(objectKey, false) : '');

    const canonicalHeadersMap = { host: host };
    if (contentType) canonicalHeadersMap['content-type'] = contentType;
    const chKeys = Object.keys(canonicalHeadersMap).sort();
    const canonicalHeaders = chKeys.map((k) => k + ':' + canonicalHeadersMap[k]).join('\n') + '\n';
    const additionalHeaders = 'host';

    const canonicalRequest = [
        method, canonicalUri, canonicalQuery, canonicalHeaders, additionalHeaders, 'UNSIGNED-PAYLOAD'
    ].join('\n');

    const stringToSign = [
        'OSS4-HMAC-SHA256', dateTime, credentialScope, await _sha256Hex(canonicalRequest)
    ].join('\n');

    const kDate = await _hmacSha256('aliyun_v4' + cfg.sk, dateStamp);
    const kRegion = await _hmacSha256(kDate, region);
    const kService = await _hmacSha256(kRegion, 'oss');
    const kSigning = await _hmacSha256(kService, 'aliyun_v4_request');
    const sigBytes = await _hmacSha256(kSigning, stringToSign);
    const signature = _bytesToHex(sigBytes);

    const finalQuery = canonicalQuery + '&x-oss-signature=' + _ossEncode(signature, true);
    return 'https://' + host + requestPath + '?' + finalQuery;
}

function _friendlyError(code, message, status) {
    if (code === 'InvalidAccessKeyId') return 'AccessKey ID 不正确';
    if (code === 'SignatureDoesNotMatch') return 'AccessKey Secret 不正确';
    if (code === 'NoSuchBucket') return '找不到 Bucket，请检查 Bucket 名和 Endpoint 是否匹配';
    if (code === 'AccessDenied') return '权限不足。请给该 AccessKey 配置这个 Bucket 的读写权限';
    if (status === 403) return '权限被拒绝（403）。检查 AccessKey 权限或 Bucket 配置';
    if (status === 404) return '资源不存在（404）。检查 Bucket / Endpoint';
    return message || '连接失败';
}

function backupKey(cfg) {
    const prefix = (cfg.prefix || 'zika/').replace(/^\/+|\/+$/g, '');
    return (prefix ? prefix + '/' : '') + 'full-backup.json';
}

/* ---------------- 上传单个文件（图片迁移用） ----------------
   传 dataURL（或 Blob）上 OSS，返回**不带签名的公开 URL**。
   调用方把本地 dataURL 换成这个 URL，本地占用从几百 KB 降到几十字节。 */
async function uploadFile(dataUrlOrBlob, name, cfg) {
    cfg = cfg || getConfig();
    if (!isConfigured()) throw new Error('未配置 OSS');
    let blob;
    let ext = 'jpg';
    if (typeof dataUrlOrBlob === 'string') {
        const m = /^data:([^;,]+)[;,]/.exec(dataUrlOrBlob);
        if (m && m[1]) {
            if (/png/.test(m[1])) ext = 'png';
            else if (/gif/.test(m[1])) ext = 'gif';
            else if (/webp/.test(m[1])) ext = 'webp';
            else if (/svg/.test(m[1])) ext = 'svg';
        }
        const bin = atob(dataUrlOrBlob.slice(dataUrlOrBlob.indexOf(',') + 1));
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        blob = new Blob([buf], { type: (m && m[1]) || 'image/jpeg' });
    } else {
        blob = dataUrlOrBlob;
    }
    const prefix = (cfg.prefix || 'zika/').replace(/^\/+|\/+$/g, '');
    const safe = String(name || 'file').replace(/[^\w.-]/g, '_').slice(-40) || 'file';
    const objectKey = (prefix ? prefix + '/' : '') + 'img/' + Date.now().toString(36) + '_' + safe + '.' + ext;
    const contentType = blob.type || 'image/jpeg';
    const url = await buildSignedUrl(cfg, 'PUT', objectKey, {}, contentType, 600);
    const res = await fetch(url, {
        method: 'PUT',
        body: blob,
        headers: { 'Content-Type': contentType }
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const code = (/<Code>([^<]+)<\/Code>/.exec(text) || [])[1];
        const msg = (/<Message>([^<]+)<\/Message>/.exec(text) || [])[1];
        throw new Error(_friendlyError(code, msg, res.status));
    }
    // 公开 URL（Bucket 需为公共读，或至少该对象可匿名读）
    return 'https://' + cfg.bucket + '.' + cfg.endpoint + '/' + _ossEncode(objectKey, false);
}

/* ---------------- 连接测试 ----------------
   直接 GET 备份对象：
     200 → 已连上，且有备份
     404 → 已连上，只是还没备份（正常）
     403 → 没权限
     网络错 → CORS / 网络问题 */
async function testConnection(cfg) {
    cfg = cfg || getConfig();
    if (!isConfigured()) return { ok: false, code: 'MISSING', message: '请先填好 Endpoint / Bucket / AccessKey / Secret' };
    try {
        const url = await buildSignedUrl(cfg, 'GET', backupKey(cfg), {}, null, 120);
        const res = await fetch(url, { method: 'GET' });
        if (res.ok || res.status === 404) {
            saveConfig({ connectedAt: Date.now() });
            return { ok: true, hasBackup: res.ok };
        }
        const text = await res.text().catch(() => '');
        const code = (/<Code>([^<]+)<\/Code>/.exec(text) || [])[1];
        const msg = (/<Message>([^<]+)<\/Message>/.exec(text) || [])[1];
        return { ok: false, code, message: _friendlyError(code, msg, res.status) };
    } catch (e) {
        const msg = String(e && e.message || e);
        if (/Failed to fetch|NetworkError|CORS/i.test(msg)) {
            return { ok: false, code: 'CORS', message: '连不上阿里云：\n1) 检查网络\n2) Bucket 是否开启 CORS（允许 GET/PUT）\n3) Endpoint / Bucket 是否正确' };
        }
        return { ok: false, code: 'ERR', message: msg.slice(0, 120) };
    }
}

/* ---------------- 上传整包备份 ---------------- */
async function uploadSnapshot(jsonString, cfg) {
    cfg = cfg || getConfig();
    if (!isConfigured()) throw new Error('未配置 OSS');
    const objectKey = backupKey(cfg);
    const contentType = 'application/json;charset=utf-8';
    const url = await buildSignedUrl(cfg, 'PUT', objectKey, {}, contentType, 600);
    const res = await fetch(url, {
        method: 'PUT',
        body: new Blob([jsonString], { type: contentType }),
        headers: { 'Content-Type': contentType }
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const code = (/<Code>([^<]+)<\/Code>/.exec(text) || [])[1];
        const msg = (/<Message>([^<]+)<\/Message>/.exec(text) || [])[1];
        throw new Error(_friendlyError(code, msg, res.status));
    }
    saveConfig({ lastUpload: Date.now(), connectedAt: Date.now() });
    return { ok: true, objectKey };
}

/* ---------------- 下载整包备份 ---------------- */
async function downloadSnapshot(cfg) {
    cfg = cfg || getConfig();
    if (!isConfigured()) throw new Error('未配置 OSS');
    const objectKey = backupKey(cfg);
    const url = await buildSignedUrl(cfg, 'GET', objectKey, {}, null, 120);
    const res = await fetch(url, { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const code = (/<Code>([^<]+)<\/Code>/.exec(text) || [])[1];
        const msg = (/<Message>([^<]+)<\/Message>/.exec(text) || [])[1];
        throw new Error(_friendlyError(code, msg, res.status));
    }
    const text = await res.text();
    return JSON.parse(text);
}

export const OSS = {
    KEY,
    getConfig,
    saveConfig,
    isConfigured,
    buildSignedUrl,
    uploadFile,
    testConnection,
    uploadSnapshot,
    downloadSnapshot
};
