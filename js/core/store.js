/* ============================================================
   store.js — 统一存储层
   ------------------------------------------------------------
   以前最痛的问题：每个模块自己拼 localStorage 前缀，
   有的按会话隔离、有的不隔离，还有的在会话 id 就绪前就去读，
   于是「改了不生效」「数据串台」「启动静默丢数据」全来了。

   这里收口成唯一入口：
     Store.get('messages', { scope: 'session' })  → 当前会话的 key
     Store.set('cards', data, { scope: 'global' }) → 全站共用
   ============================================================ */

import { bus, EV } from './bus.js';

const NS = 'zika_';
const CURRENT_SESSION_KEY = NS + 'currentSessionId';

/** 当前会话 id：由 session.js 写入，这里只读取 */
function currentSessionId() {
    try { return localStorage.getItem(CURRENT_SESSION_KEY) || 'default'; }
    catch { return 'default'; }
}

/**
 * 计算真实存储键
 * scope = 'session' → 按会话隔离（聊天记录、该联系人的字卡等）
 * scope = 'global'  → 全站共用（联系人表、设置、我的头像等）
 */
function keyOf(key, scope) {
    return (scope === 'global') ? (NS + key) : (NS + currentSessionId() + ':' + key);
}

function readRaw(k) {
    try { return localStorage.getItem(k); } catch { return null; }
}
function writeRaw(k, v) {
    try { localStorage.setItem(k, v); return true; }
    catch (err) {
        const quota = err && (err.name === 'QuotaExceededError' ||
            err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22);
        if (quota) {
            // 爆配额：先把历史聊天记录砍掉一半再试一次。
            // 聊天记录是最占空间又最容易丢的，字卡/表情包必须留住。
            if (trimHistoryForQuota()) {
                try { localStorage.setItem(k, v); return true; }
                catch (e2) { /* 下面统一报失败 */ }
            }
        }
        console.error('[store] 写入失败', k, err);
        bus.emit('store:quota', { key: k, error: err });
        return false;
    }
}

/**
 * 配额不够时的应急：把各会话的聊天记录砍掉一半（只留最近 50 条），
 * 腾出空间让本次写入成功。字卡/素材/设置一律不动。
 */
let quotaTrimDone = false;
function trimHistoryForQuota() {
    if (quotaTrimDone) return false;      // 一次只救一次，避免反复扫描
    quotaTrimDone = true;
    try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (!k || k.indexOf(NS) !== 0) continue;
            const idx = k.indexOf(':', NS.length);
            if (idx < 0) continue;
            if (k.slice(idx + 1) !== 'messages') continue;
            const list = JSON.parse(localStorage.getItem(k) || '[]');
            if (!Array.isArray(list) || list.length <= 50) continue;
            localStorage.setItem(k, JSON.stringify(list.slice(-50)));
        }
        return true;
    } catch { return false; }
}

export const Store = {
    /** 当前会话 ID（外部只读） */
    sessionId: currentSessionId,

    /**
     * 读取。自动识别 JSON；非 JSON 原样返回字符串。
     * @returns 解析后的值，失败返回 fallback
     */
    get(key, fallback = null, opts = {}) {
        const raw = readRaw(keyOf(key, opts.scope));
        if (raw === null || raw === undefined) return fallback;
        try { return JSON.parse(raw); }
        catch { return raw; } // 历史数据是裸字符串的情况
    },

    /** 写入（自动 JSON 序列化） */
    set(key, value, opts = {}) {
        const text = (typeof value === 'string') ? value : JSON.stringify(value);
        return writeRaw(keyOf(key, opts.scope), text);
    },

    /** 写入并返回新值，省一次 get */
    update(key, updater, fallback, opts = {}) {
        const cur = Store.get(key, fallback, opts);
        const next = (typeof updater === 'function') ? updater(cur) : updater;
        Store.set(key, next, opts);
        return next;
    },

    /**
     * 按指定会话 id 读（不依赖当前桶）。
     * 字卡库改成按联系人分桶后，抽取时必须显式指定是谁的库——
     * 否则「当前桶」停在谁那儿就会抽到谁的字卡（从桌面直接进聊天就会串）。
     */
    getFor(sessionId, key, fallback = null, opts = {}) {
        if (!sessionId) return Store.get(key, fallback, opts);
        const k = (opts.scope === 'global') ? (NS + key) : (NS + sessionId + ':' + key);
        const raw = readRaw(k);
        if (raw === null || raw === undefined) return fallback;
        try { return JSON.parse(raw); }
        catch { return raw; }
    },

    /** 按指定会话 id 写 */
    setFor(sessionId, key, value, opts = {}) {
        if (!sessionId) return Store.set(key, value, opts);
        const k = (opts.scope === 'global') ? (NS + key) : (NS + sessionId + ':' + key);
        const text = (typeof value === 'string') ? value : JSON.stringify(value);
        return writeRaw(k, text);
    },

    remove(key, opts = {}) {
        try { localStorage.removeItem(keyOf(key, opts.scope)); return true; }
        catch { return false; }
    },

    has(key, opts = {}) {
        return readRaw(keyOf(key, opts.scope)) !== null;
    },

    /**
     * 会话切换时调用：把「上一个会话」的数据留在原 key 不动，
     * 只是把 currentSessionId 指向新的，读取自然切换到新桶。
     * —— 这就是会话隔离的全部实现，各业务模块不需要关心。
     */
    setSessionId(id) {
        if (!id) return false;
        try { localStorage.setItem(CURRENT_SESSION_KEY, id); return true; }
        catch { return false; }
    },

    /** 列出某 scope 下所有键（导入导出 / 调试用） */
    keys(scope) {
        const prefix = (scope === 'global') ? NS : (NS + currentSessionId() + ':');
        const out = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k || !k.startsWith(prefix)) continue;
                if (scope !== 'global' && k === CURRENT_SESSION_KEY) continue;
                // global 列举时要排除掉会话私有的
                if (scope === 'global') {
                    const rest = k.slice(NS.length);
                    if (rest.includes(':')) continue;
                }
                out.push(scope === 'global' ? k.slice(NS.length) : k.slice(prefix.length));
            }
        } catch { /* 隐私模式下可能拿不到 length */ }
        return out;
    },

    /** 导出全站数据（备份用）：global 一组，每个会话一组 */
    snapshot() {
        const dump = { global: {}, sessions: {} };
        Store.keys('global').forEach((k) => {
            dump.global[k] = Store.get(k, null, { scope: 'global' });
        });
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k || !k.startsWith(NS)) continue;
                const rest = k.slice(NS.length);
                if (rest === 'currentSessionId') continue;
                const idx = rest.indexOf(':');
                if (idx < 0) continue;                       // 不是会话私有数据
                const sid = rest.slice(0, idx);
                const field = rest.slice(idx + 1);
                const bucket = (dump.sessions[sid] = dump.sessions[sid] || {});
                const raw = localStorage.getItem(k);
                try { bucket[field] = JSON.parse(raw); } catch { bucket[field] = raw; }
            }
        } catch { /* 隐私模式等场景，忽略 */ }
        return dump;
    },

    /** 导入（覆盖写入） */
    restore(dump) {
        if (!dump || typeof dump !== 'object') return false;
        try {
            Object.keys(dump.global || {}).forEach((k) => {
                Store.set(k, dump.global[k], { scope: 'global' });
            });
            Object.keys(dump.sessions || {}).forEach((sid) => {
                const fields = dump.sessions[sid] || {};
                Object.keys(fields).forEach((f) => {
                    writeRaw(NS + sid + ':' + f, JSON.stringify(fields[f]));
                });
            });
            return true;
        } catch (err) {
            console.error('[store] 恢复失败', err);
            return false;
        }
    }
};

/** 联系人表是全站共用的，切换联系人不换桶 */
export const CONTACTS_KEY = 'contacts';
