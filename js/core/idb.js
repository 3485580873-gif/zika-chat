/* ============================================================
   idb.js — 大二进制存储（IndexedDB）
   ------------------------------------------------------------
   localStorage 只有 ~5MB，字体文件（几个 MB 的 ttf/woff）
   base64 后必爆配额，表现为「上传成功但刷新就没 / 当场无效」。
   这类大块头一律走 IndexedDB（容量几百 MB 起步）。
   localStorage 只留小元数据（字段名 + 标记位）。

   API 全部 Promise；失败不抛，resolve(false) 由调用方降级。
   ============================================================ */

const DB_NAME = 'zika-chat';
const DB_VERSION = 1;
const STORE = 'blobs';

let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        if (!window.indexedDB) { resolve(null); return; }
        let req;
        try {
            req = indexedDB.open(DB_NAME, DB_VERSION);
        } catch { resolve(null); return; }
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { console.warn('[idb] 打开失败，退回 localStorage'); resolve(null); };
        req.onblocked = () => resolve(null);
    });
    return dbPromise;
}

/**
 * 跑一个事务。
 * @param missVal 请求结果 undefined 时 resolve 什么：
 *   · get 传 null（读不到就是没有）
 *   · set / del 不传 → true（只要事务完成就算成功）
 * ⚠ 以前所有调用都走「undefined → true」这条分支，导致
 *   **IDB.get('homeBg') 在键不存在时返回 true**，
 *   home.js 直接拿它当背景图 URL → url("true") 404 + 背景「没效果」。
 */
function tx(mode, fn, missVal) {
    return openDb().then((db) => {
        if (!db) return null;
        return new Promise((resolve) => {
            try {
                const t = db.transaction(STORE, mode);
                const store = t.objectStore(STORE);
                const r = fn(store);
                t.oncomplete = () => resolve(r && r.result !== undefined ? r.result
                    : (missVal !== undefined ? missVal : true));
                t.onerror = () => resolve(null);
                t.onabort = () => resolve(null);
            } catch { resolve(null); }
        });
    });
}

export const IDB = {
    /** 读；不存在 / 失败 → null（★绝不是 true，见 tx 的 missVal） */
    get(key) {
        return tx('readonly', (s) => s.get(String(key)), null);
    },

    /** 写；成功 true，失败 false */
    set(key, value) {
        return tx('readwrite', (s) => s.put(value, String(key))).then((v) => (v === null ? false : true));
    },

    /** 删；成功 true */
    del(key) {
        return tx('readwrite', (s) => s.delete(String(key))).then((v) => (v === null ? false : true));
    }
};
