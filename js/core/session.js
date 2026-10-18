/* ============================================================
   session.js — 联系人 / 会话
   ------------------------------------------------------------
   一个联系人 = 一个独立会话，聊天记录天然隔离（见 store.js 的
   scope:'session'）。群聊 = 多个联系人聚合，抽字卡时任一成员的
   专属卡都算可用（见 cards.js）。
   ============================================================ */

import { Store } from './store.js';
import { bus, EV } from './bus.js';

const KEY = 'contacts';          // global

function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function normalize(c) {
    return {
        id: c.id || uid('c'),
        kind: c.kind === 'group' ? 'group' : 'friend',
        name: String(c.name || '未命名').trim(),
        avatar: c.avatar || '',
        sign: c.sign || '',
        members: Array.isArray(c.members) ? c.members.slice() : [],
        pinned: !!c.pinned,
        created: c.created || Date.now()
    };
}

function readAll() {
    const raw = Store.get(KEY, [], { scope: 'global' });
    const arr = Array.isArray(raw) ? raw : [];
    return arr.map(normalize);
}

function writeAll(list) {
    Store.set(KEY, list, { scope: 'global' });
}

export const Session = {
    /** 全部联系人（含群聊） */
    all() {
        return readAll().sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            return b.created - a.created;
        });
    },

    /** 按 id 取 */
    get(id) {
        if (!id) return null;
        return readAll().find((c) => c.id === id) || null;
    },

    /** 当前会话；不存在则返回 null（由调用方决定如何处理） */
    current() {
        return Session.get(Store.sessionId());
    },

    /** 当前会话 id */
    currentId() {
        return Store.sessionId();
    },

    /**
     * 切换会话。只改「指向」，各模块读 scope:'session' 时自然切桶，
     * 不存在把旧会话数据写进新会话的可能。
     */
    activate(id) {
        const c = Session.get(id);
        if (!c) return false;
        if (Store.sessionId() === id) return true;

        Store.setSessionId(id);
        bus.emit(EV.SESSION_CHANGED, { id, contact: c, previous: null });
        return true;
    },

    /** 新建联系人 / 群聊，返回新建对象 */
    add(data) {
        const list = readAll();
        const c = normalize(data);
        list.push(c);
        writeAll(list);
        bus.emit(EV.CONTACTS_CHANGED, { type: 'add', contact: c });
        return c;
    },

    /** 更新字段（改名 / 换头像 / 改签名 / 改成员） */
    update(id, patch) {
        const list = readAll();
        const i = list.findIndex((c) => c.id === id);
        if (i < 0) return null;
        const next = normalize(Object.assign({}, list[i], patch, { id: list[i].id }));
        list[i] = next;
        writeAll(list);
        bus.emit(EV.CONTACTS_CHANGED, { type: 'update', contact: next });
        // 改的是当前会话 → 也要通知界面刷新顶栏
        if (Store.sessionId() === id) bus.emit(EV.SESSION_CHANGED, { id, contact: next });
        return next;
    },

    remove(id) {
        const list = readAll().filter((c) => c.id !== id);
        writeAll(list);
        bus.emit(EV.CONTACTS_CHANGED, { type: 'remove', id });
        // 删的是当前会话 → 切到剩下的第一个
        if (Store.sessionId() === id) {
            const rest = Session.all();
            if (rest.length) Session.activate(rest[0].id);
            else Store.setSessionId('');
        }
        return true;
    },

    /** 群聊成员（friend 返回空数组） */
    membersOf(contact) {
        if (!contact || contact.kind !== 'group') return [];
        return (contact.members || []).map((id) => Session.get(id)).filter(Boolean);
    },

    /** 首次运行：给一个示例联系人，避免空白页 */
    ensureSeed() {
        const list = readAll();
        if (list.length) return list;
        const c = normalize({ name: 'TA', sign: '点这里改名字和头像' });
        writeAll([c]);
        if (!Store.sessionId() || !Session.get(Store.sessionId())) Store.setSessionId(c.id);
        return [c];
    }
};
