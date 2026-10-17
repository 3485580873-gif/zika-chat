/* ============================================================
   bus.js — 全局事件总线
   模块之间不互相 import，只通过事件通信，
   避免又长成以前那种「谁都能直接改谁的 DOM」的网状耦合。
   ============================================================ */

const channels = new Map();

function ensure(name) {
    let set = channels.get(name);
    if (!set) { set = new Set(); channels.set(name, set); }
    return set;
}

export const bus = {
    /** 订阅，返回取消订阅函数 */
    on(name, fn) {
        ensure(name).add(fn);
        return () => bus.off(name, fn);
    },

    /** 订阅一次 */
    once(name, fn) {
        const off = bus.on(name, (payload) => { off(); fn(payload); });
        return off;
    },

    off(name, fn) {
        const set = channels.get(name);
        if (set) set.delete(fn);
    },

    emit(name, payload) {
        const set = channels.get(name);
        if (!set) return;
        // 复制一份，防止回调内部增删订阅导致迭代错乱
        Array.from(set).forEach((fn) => {
            try { fn(payload); } catch (err) { console.error('[bus]', name, err); }
        });
    },

    clear(name) {
        if (name) channels.delete(name);
        else channels.clear();
    }
};

/** 事件名集中登记，避免各处硬编码字符串写错 */
export const EV = {
    SESSION_CHANGED: 'session:changed',   // 切换了联系人 / 群聊
    CONTACTS_CHANGED: 'contacts:changed', // 联系人增删或改名
    AVATAR_CHANGED: 'avatar:changed',     // 头像变更 { who, src }
    CARDS_CHANGED: 'cards:changed',       // 字卡库变更
    MESSAGE_ADDED: 'message:added',       // 新增一条消息
    THEME_CHANGED: 'theme:changed',       // 主题切换
    STYLE_CHANGED: 'style:changed',       // 聊天样式设置变更
    MEDIA_CHANGED: 'media:changed'        // 表情包 / 颜文字 / emoji / 拍一拍 变更
};
