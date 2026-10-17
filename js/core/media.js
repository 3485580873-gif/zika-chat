/* ============================================================
   media.js — 素材库（数据层）
   ------------------------------------------------------------
   四大类（CATEGORIES）：
     主字卡  text      —— 走 Cards（主字卡，有 公用/专属）
     互动    kaomoji 颜文字 / emoji / poke 拍一拍 / sticker 表情包
     朋友圈  sig 个性签名 / nick 网名 / comment 路人评论 / post 路人帖子
     氛围感  status 对方状态 / loc 他的位置

   ★ 归属模型（v13 起，参照 dunian 重做）：
     不再有「公用 / 专属」。每个联系人各自持有一整套素材，物理分桶：
       scope:'session' → localStorage key = zika_<联系人id>:media
     和 core/cards.js 同一套模型，A 的表情包不会出现在 B 的会话里。
   旧版 global 数据首次进入时迁进当前联系人桶（只迁一次）。

   规则：站内不内置任何一条内容。池子为空 → 界面提示去添加。
   分组：每条可归属一个分组；分组可启用/停用，停用的不参与抽取。
   ============================================================ */

import { Store } from './store.js';
import { IDB } from './idb.js';
import { bus, EV } from './bus.js';

const KEY = 'media';              // ★ 数据本体已迁到 IndexedDB（见下）
const GROUPS_KEY = 'mediaGroups'; // localStorage：{ kind: [{ name, enabled }] }（很小，留 LS）
const MIGRATE_FLAG = 'mediaMigratedFromGlobal';

/* ============================================================
   ★ 存储改造（v20）：
   表情包是 dataURL 图片，几张就把 localStorage 的 5MB 配额吃光，
   写入静默失败 → 用户看到的就是「上传了却没有」。
   现在数据本体放 IndexedDB（容量几百 MB），内存里留一份缓存同步读写，
   首次打开时自动把 localStorage 旧数据搬过去（搬完删旧键）。
   API 保持同步 —— 读的是内存缓存；桶还没加载完时先返回空，
   加载完成后广播 MEDIA_CHANGED，页面自动补渲染。
   ============================================================ */
const memCache = {};              // sid → { kind: [items] }
const loadingSids = new Set();    // 正在从 IDB 加载的桶

/* ★ 「我的」全局桶：拍一拍 / 颜文字 / emoji 这些互动内容
   是用户单方面上传、单方面用的，**不属于任何联系人**（用户 2026-10-17 明确要求）。
   用固定 id '__me' 当桶名，与联系人桶天然隔离、永不串数据。 */
export const ME_SID = '__me';

function sidOf(sid) { return sid || Store.sessionId(); }
function idbKey(sid) { return 'media:' + sidOf(sid); }

/** 某个联系人的桶没进内存时，从 IndexedDB 拉起来（含 localStorage 迁移） */
function ensureLoaded(sid) {
    const s = sidOf(sid);
    if (memCache[s] || loadingSids.has(s)) return;
    loadingSids.add(s);
    IDB.get(idbKey(s)).then((data) => {
        let loaded = (data && typeof data === 'object') ? data : null;
        if (!loaded) {
            // 旧版数据在 localStorage：搬进 IDB，删旧键（旧键最占配额）
            const old = Store.getFor(s, KEY, null, { scope: 'session' });
            if (old && typeof old === 'object' &&
                Object.keys(old).some((k) => Array.isArray(old[k]) && old[k].length)) {
                loaded = old;
                IDB.set(idbKey(s), loaded);
            }
            try { localStorage.removeItem('zika_' + s + ':' + KEY); } catch { /* noop */ }
        }
        const norm = normalizeAll(loaded);
        const cur = memCache[s];
        if (cur) {
            // 加载期间用户已经写入过：按 id 合并，谁都不丢
            BUCKETS.forEach((k) => {
                const seen = new Set((cur[k] || []).map((x) => x.id));
                (norm[k] || []).forEach((it) => { if (!seen.has(it.id)) cur[k].push(it); });
            });
        } else {
            memCache[s] = norm;
        }
        loadingSids.delete(s);
        bus.emit(EV.MEDIA_CHANGED, {});   // 页面收到后补渲染
    });
}

/** 分类表。text 走 Cards，其余走 Media */
export const KINDS = {
    text:    { name: '主字卡',   cat: 'text',     text: true },
    kaomoji: { name: '颜文字',   cat: 'interact', text: true },
    emoji:   { name: 'emoji',    cat: 'interact', text: true },
    poke:    { name: '拍一拍',   cat: 'interact', text: true },
    sticker: { name: '表情包',   cat: 'sticker',  image: true },
    sig:     { name: '个性签名', cat: 'moments',  text: true },
    nick:    { name: '网名',     cat: 'moments',  text: true },
    comment: { name: '路人评论', cat: 'moments',  text: true },
    post:    { name: '路人帖子', cat: 'moments',  text: true },
    status:  { name: '对方状态', cat: 'ambient',  text: true },
    loc:     { name: '他的位置', cat: 'ambient',  text: true }
};

/** 五大类（顺序即展示顺序）；表情包独立成栏，互动只留颜文字/emoji/拍一拍 */
export const CATEGORIES = [
    { id: 'all',      name: '全部',     kinds: Object.keys(KINDS) },
    { id: 'text',     name: '主字卡',   kinds: ['text'] },
    { id: 'interact', name: '互动',     kinds: ['kaomoji', 'emoji', 'poke'] },
    { id: 'sticker',  name: '表情包',   kinds: ['sticker'] },
    { id: 'moments',  name: '朋友圈',   kinds: ['sig', 'nick', 'comment', 'post'] },
    { id: 'ambient',  name: '氛围感',   kinds: ['status', 'loc'] }
];

const BUCKETS = Object.keys(KINDS);

function uid(p) { return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function emptyAll() {
    const out = {};
    BUCKETS.forEach((k) => { out[k] = []; });
    return out;
}

function normalizeItem(kind, it) {
    if (!it) return null;
    const obj = (typeof it === 'string') ? { text: it } : it;
    const meta = KINDS[kind] || {};
    const src = String(obj.src || '');
    const text = String(obj.text || '').replace(/\r/g, '').trim();

    if (meta.image || meta.audio) {
        if (!src) return null;
        return {
            id: obj.id || uid('s'),
            src,
            name: String(obj.name || '').trim(),
            text: text,
            group: String(obj.group || '').trim(),
            created: obj.created || Date.now()
        };
    }
    if (!text) return null;
    return {
        id: obj.id || uid('t'),
        text,
        group: String(obj.group || '').trim(),
        created: obj.created || Date.now()
    };
}

function normalizeAll(data) {
    const out = emptyAll();
    if (!data || typeof data !== 'object') return out;
    BUCKETS.forEach((kind) => {
        const bucket = data[kind];
        if (!bucket || !Array.isArray(bucket)) return;
        out[kind] = bucket.map((it) => normalizeItem(kind, it)).filter(Boolean);
    });
    return out;
}

function readAll(sid) {
    const s = sidOf(sid);
    const c = memCache[s];
    if (c) return c;
    ensureLoaded(s);            // 没加载完先给空，加载完广播补渲染
    return emptyAll();
}

function writeAll(data, sid) {
    const s = sidOf(sid);
    memCache[s] = data;
    IDB.set(idbKey(s), data);   // 异步落盘，IndexedDB 失败也不影响本次会话使用
    bus.emit(EV.MEDIA_CHANGED, { sid: s });
}

/* ---------------- 分组（按 kind，不再分 owner） ---------------- */
function gKey(kind) { return kind; }

function readGroups(sid) {
    const raw = sid ? Store.getFor(sid, GROUPS_KEY, null, { scope: 'session' })
                    : Store.get(GROUPS_KEY, null, { scope: 'session' });
    return (raw && typeof raw === 'object') ? raw : {};
}

function writeGroups(g) {
    Store.set(GROUPS_KEY, g, { scope: 'session' });
    bus.emit(EV.MEDIA_CHANGED, {});
}

/**
 * 兼容入口（旧调用点仍在用）：确保当前桶已从 IndexedDB 加载。
 * 旧版「global → session」的一次性迁移逻辑并入 ensureLoaded 的
 * localStorage → IndexedDB 迁移，这里只负责触发。
 */
function migrateOnce() {
    ensureLoaded(Store.sessionId());
}

export const Media = {
    /** 确保某个联系人的素材桶已加载（切联系人 / 进聊天前调用） */
    _migrate(sid) { ensureLoaded(sid || Store.sessionId()); },

    /**
     * 某一类全部条目。
     * @param kind 类别
     * @param sid 指定联系人的桶（聊天抽屉用；不传 = 当前桶）
     */
    all(kind, sid) {
        if (!KINDS[kind]) return [];
        if (!sid) migrateOnce();
        const all = readAll(sid);
        return all[kind] || [];
    },

    /**
     * 列表（当前联系人桶里的全部）。
     * @param _unused 保留位，旧调用会传归属过滤参数，现在已无意义（分桶天然隔离）
     */
    list(kind, sid) {
        if (!KINDS[kind]) return [];
        return Media.all(kind, sid || null);
    },

    /**
     * 聊天抽屉用：显式按 contactId 取桶。
     * 不能依赖「当前桶」——从桌面直接进聊天时桶未必是这个人，
     * 会把别人的表情包/拍一拍抽出来。
     */
    forChat(kind, contactId) {
        if (!KINDS[kind]) return [];
        return Media.all(kind, contactId || null);
    },

    count(kind, _scopeFilter) { return Media.list(kind).length; },

    /** 分组列表（含停用状态）；条目里实际出现过的分组自动补齐 */
    groups(kind, sid) {
        const declared = readGroups(sid)[gKey(kind)] || [];
        const used = new Set();
        Media.all(kind, sid || null).forEach((it) => { if (it.group) used.add(it.group); });
        const map = {};
        declared.forEach((g) => { map[g.name] = { name: g.name, enabled: g.enabled !== false }; });
        used.forEach((n) => { if (!map[n]) map[n] = { name: n, enabled: true }; });
        return Object.keys(map).map((k) => map[k]);
    },

    groupEnabled(kind, name, sid) {
        if (!name) return true;
        const g = Media.groups(kind, sid || null).find((x) => x.name === name);
        return g ? g.enabled : true;
    },

    addGroup(kind, name) {
        name = String(name || '').trim();
        if (!name) return false;
        const all = readGroups();
        const list = all[kind] || (all[kind] = []);
        if (list.some((g) => g.name === name)) return false;
        list.push({ name, enabled: true });
        writeGroups(all);
        return true;
    },

    renameGroup(kind, oldName, newName) {
        newName = String(newName || '').trim();
        if (!newName) return false;
        const all = readGroups();
        const list = all[kind] || (all[kind] = []);
        const g = list.find((x) => x.name === oldName);
        if (g) g.name = newName;
        else if (!list.some((x) => x.name === newName)) list.push({ name: newName, enabled: true });
        writeGroups(all);
        const data = readAll();
        if (data[kind]) {
            data[kind].forEach((it) => { if (it.group === oldName) it.group = newName; });
            writeAll(data);
        }
        return true;
    },

    removeGroup(kind, name) {
        const all = readGroups();
        all[kind] = (all[kind] || []).filter((g) => g.name !== name);
        writeGroups(all);
        const data = readAll();
        if (data[kind]) {
            data[kind].forEach((it) => { if (it.group === name) it.group = ''; });
            writeAll(data);
        }
        return true;
    },

    toggleGroup(kind, name) {
        const all = readGroups();
        const list = all[kind] || (all[kind] = []);
        let g = list.find((x) => x.name === name);
        if (!g) { g = { name, enabled: true }; list.push(g); }
        g.enabled = !g.enabled;
        writeGroups(all);
        return g.enabled;
    },

    /** 新增（文本按行拆分；图片/音频单条）
     *  @param sid 指定桶（'__me' = 我的全局桶；不传 = 当前联系人桶） */
    add(kind, value, name = '', group = '', sid) {
        if (!KINDS[kind]) return 0;
        const s = sidOf(sid);
        const all = readAll(s);
        const bucket = all[kind] || (all[kind] = []);

        if (KINDS[kind].image || KINDS[kind].audio) {
            const one = normalizeItem(kind, { src: value, name, text: name, group });
            if (!one) return 0;
            bucket.push(one);
            writeAll(all, s);
            return 1;
        }

        const exist = new Set(bucket.map((x) => x.text));
        let n = 0;
        String(value || '').split('\n').map((x) => x.replace(/\r/g, '').trim()).filter(Boolean)
            .forEach((t) => {
                if (exist.has(t)) return;
                bucket.push({ id: uid('t'), text: t, group: String(group || '').trim(), created: Date.now() });
                exist.add(t);
                n++;
            });
        if (n) writeAll(all, s);
        return n;
    },

    /**
     * 批量添加。
     * 文本类：接受字符串数组（['一句话','另一句']）或 \n 分隔文本，
     *        也接受 [{text}] 对象；
     * 图片类：接受 [{src,name}]。
     * 之前只认对象，字符串会被 Object.assign 拆成 {0:'字',1:'符'} 然后静默丢掉
     * （dunian 字卡文件导入踩过这个坑：分组建好了但一条都没进来）。
     */
    addMany(kind, arr, group = '') {
        if (!KINDS[kind] || !arr) return 0;
        const meta = KINDS[kind] || {};
        const all = readAll();
        const bucket = all[kind] || (all[kind] = []);
        const exist = new Set(bucket.map((x) => x.text).filter(Boolean));
        let n = 0;

        const pushOne = (obj) => {
            const one = normalizeItem(kind, Object.assign({}, obj, { group }));
            if (!one) return;
            if (!meta.image && exist.has(one.text)) return;   // 文本去重
            bucket.push(one);
            if (!meta.image) exist.add(one.text);
            n++;
        };

        if (typeof arr === 'string') {
            arr.split('\n');
            String(arr).split('\n').map((s) => String(s).replace(/\r/g, '').trim()).filter(Boolean).forEach(pushOne);
        } else if (Array.isArray(arr)) {
            arr.forEach((it) => {
                if (typeof it === 'string') pushOne({ text: it });
                else if (it && typeof it === 'object') pushOne(it);
            });
        }
        if (n) writeAll(all);
        return n;
    },

    update(kind, id, patch) {
        const all = readAll();
        if (!all[kind]) return null;
        const i = all[kind].findIndex((x) => x.id === id);
        if (i < 0) return null;
        const next = Object.assign({}, all[kind][i], patch || {});
        if (KINDS[kind].image || KINDS[kind].audio) {
            if (!next.src) return null;
        } else if (!String(next.text || '').trim()) {
            return null;
        }
        all[kind][i] = next;
        writeAll(all);
        return next;
    },

    moveToGroup(kind, ids, group) {
        const all = readAll();
        if (!all[kind]) return 0;
        const set = new Set(Array.isArray(ids) ? ids : [ids]);
        let n = 0;
        all[kind].forEach((it) => {
            if (!set.has(it.id)) return;
            it.group = String(group || '').trim();
            n++;
        });
        if (n) writeAll(all);
        return n;
    },

    /** 删除一条。@param sid 指定桶（不传 = 当前桶）。
     *  @returns 真的删掉了才 true（找不到 / 桶不存在都返回 false） */
    remove(kind, id, sid) {
        if (!KINDS[kind]) return false;
        const s = sidOf(sid);
        const all = readAll(s);
        if (!all[kind]) return false;
        const before = all[kind].length;
        all[kind] = all[kind].filter((x) => x.id !== id);
        if (all[kind].length === before) return false;   // 没这条，别白写一次盘
        writeAll(all, s);
        return true;
    },

    removeMany(kind, ids) {
        const set = new Set(Array.isArray(ids) ? ids : []);
        const all = readAll();
        if (!all[kind]) return 0;
        const before = all[kind].length;
        all[kind] = all[kind].filter((x) => !set.has(x.id));
        const n = before - all[kind].length;
        if (n) writeAll(all);
        return n;
    },

    clear(kind) {
        const all = readAll();
        if (!all[kind]) return false;
        all[kind] = [];
        writeAll(all);
        return true;
    },

    /** 去重（按内容/图片源），返回删掉的数量 */
    dedupe(kind) {
        const all = readAll();
        if (!all[kind]) return 0;
        const seen = new Set();
        const keep = [];
        all[kind].forEach((it) => {
            const k = (KINDS[kind].image || KINDS[kind].audio) ? it.src : it.text;
            if (seen.has(k)) return;
            seen.add(k);
            keep.push(it);
        });
        const n = all[kind].length - keep.length;
        if (n) { all[kind] = keep; writeAll(all); }
        return n;
    },

    /** 搜索（跨分类或指定分类） */
    search(kw, kind) {
        const q = String(kw || '').trim().toLowerCase();
        if (!q) return [];
        const kinds = kind ? [kind] : BUCKETS;
        const out = [];
        kinds.forEach((k) => {
            Media.all(k).forEach((it) => {
                const hay = ((it.text || '') + ' ' + (it.name || '')).toLowerCase();
                if (hay.indexOf(q) >= 0) out.push({ kind: k, item: it });
            });
        });
        return out;
    },

    /**
     * 随机抽一条（只从启用的分组里抽）。
     * @param scopeFilter 抽卡范围：'*' / contactId / 'all'
     */
    pick(kind, scopeFilter, group) {
        let list = Media.list(kind, scopeFilter);
        if (group) list = list.filter((it) => it.group === group);
        list = list.filter((it) => Media.groupEnabled(kind, it.group));
        if (!list.length) return null;
        return list[Math.floor(Math.random() * list.length)];
    },

    /** 统计（导出/界面用）：每个 kind 的 公用 / 专属 数量 */
    stats() {
        const out = {};
        BUCKETS.forEach((k) => {
            const items = Media.all(k);
            const pub = items.filter((x) => x.group).length;
            const priv = items.length - pub;
            out[k] = { total: items.length, public: pub, private: priv };
        });
        return out;
    },

    _raw: readAll
};
