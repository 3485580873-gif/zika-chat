/* ============================================================
   cards.js — 字卡库（数据层 + 抽取引擎）
   ------------------------------------------------------------
   全局规则：站内一切自动出现的内容，只能来自这里的字卡。
   没有任何内置文案、没有装饰性模板句。
   字卡库为空 → 不生成内容，并提示用户去添加。

   ★ 归属模型（参照 dunian 重做，v13 定案）：
     不再有「公用 / 专属」的概念。
     每个联系人各自持有一整套字卡，物理分桶存储：
       scope:'session' → localStorage key = zika_<联系人id>:cards
     所以「A 说的」和「B 说的」永远不会串味——这是用户明确要的：
     两个联系人各自发各自设定的字卡。
     代价：每个联系人的字卡要各填各的（换来的是真隔离）。

   旧数据迁移：v12 及以前的公用/专属字卡存在 global 桶里，
   首次进入字卡库时把 global 的卡拷进当前联系人桶（只拷一次，
   保证老用户不丢数据），之后一律按桶读写。
   ============================================================ */

import { Store } from './store.js';
import { Session } from './session.js';
import { bus, EV } from './bus.js';

const KEY = 'cards';             // session: [{ id, text, group, created }]
const GROUPS_KEY = 'cardGroups'; // session: [{ name, enabled }]
const OLD_KEY = 'cards';        // v12 的 global 桶
const MIGRATE_FLAG = 'cardsMigratedFromGlobal';

function uid() {
    return 'k_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function normalize(k) {
    const text = String((k && k.text) || '').trim();
    if (!text) return null;
    return {
        id: (k && k.id) || uid(),
        text,
        group: String((k && k.group) || '').trim(),
        created: (k && k.created) || Date.now()
    };
}

/** 旧数据（global + scope 字段）→ 新结构 */
function normalizeOld(k) {
    const text = String((k && k.text) || '').trim();
    if (!text) return null;
    return {
        id: (k && k.id) || uid(),
        text,
        group: String((k && k.group) || '').trim(),
        created: (k && k.created) || Date.now()
    };
}

/**
 * 一次性迁移：把 v12 的 global 字卡搬到「当前联系人桶」。
 * 只在当前桶还是空的时候搬，搬完打标记，避免覆盖用户后来的数据。
 */
function migrateOnce() {
    if (Store.get(MIGRATE_FLAG, false, { scope: 'session' })) return;
    const old = Store.get(OLD_KEY, [], { scope: 'global' });
    // ★ global 桶里确实没有老数据时「不要」打标记 ——
    //   否则首次加载时打上标记，用户随后导入的老数据（v13 导出再导入等场景）
    //   就再也搬不进来了。宁可多跑几次这个廉价检查。
    if (!Array.isArray(old) || !old.length) return;
    const mine = readAll();
    if (!mine.length) {
        const moved = old.map(normalizeOld).filter(Boolean);
        if (moved.length) {
            Store.set(KEY, moved, { scope: 'session' });
            const og = Store.get(GROUPS_KEY, [], { scope: 'global' });
            if (Array.isArray(og) && og.length) Store.set(GROUPS_KEY, og, { scope: 'session' });
            bus.emit(EV.CARDS_CHANGED, { count: moved.length, migrated: true });
        }
    }
    Store.set(MIGRATE_FLAG, true, { scope: 'session' });
}

function readAll(sid) {
    const raw = sid ? Store.getFor(sid, KEY, [], { scope: 'session' })
                    : Store.get(KEY, [], { scope: 'session' });
    const arr = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    return arr.map(normalize).filter(Boolean).filter((k) => {
        if (seen.has(k.id)) return false;
        seen.add(k.id);
        return true;
    });
}

function writeAll(list, sid) {
    if (sid) Store.setFor(sid, KEY, list, { scope: 'session' });
    else Store.set(KEY, list, { scope: 'session' });
    bus.emit(EV.CARDS_CHANGED, { count: list.length, for: sid || null });
}

export const Cards = {
    /** 触发一次性迁移（进入字卡库/抽取前都调一次） */
    _migrate() { migrateOnce(); },

    /**
     * 全部字卡。
     * @param sid 指定联系人的桶；不传 = 当前桶（界面增删改用这个）
     */
    all(sid) { if (!sid) migrateOnce(); return readAll(sid); },

    /** 分组名列表（按顺序，含空分组不列出） */
    groups() {
        const set = new Set();
        readAll().forEach((k) => { if (k.group) set.add(k.group); });
        return Array.from(set);
    },

    /** 单条 */
    get(id) { return readAll().find((k) => k.id === id) || null; },

    /**
     * 新增。
     * @param text  内容（必填）
     * @param group 分组名
     */
    add(text, group = '') {
        const one = normalize({ text, group });
        if (!one) return null;
        const list = readAll();
        // 同内容不重复添加
        if (list.some((k) => k.text === one.text)) {
            return list.find((k) => k.text === one.text);
        }
        list.push(one);
        writeAll(list);
        return one;
    },

    /** 批量新增（每行一条），返回新增条数 */
    addMany(texts, group = '') {
        const list = readAll();
        const exist = new Set(list.map((k) => k.text));
        // 兼容数组和 \n 分隔文本两种传法
        const lines = Array.isArray(texts) ? texts : String(texts || '').split('\n');
        let n = 0;
        lines.map((s) => String(s).trim()).filter(Boolean).forEach((t) => {
            if (exist.has(t)) return;
            const one = normalize({ text: t, group });
            if (one) { list.push(one); exist.add(t); n++; }
        });
        if (n) writeAll(list);
        return n;
    },

    remove(id) {
        const list = readAll().filter((k) => k.id !== id);
        writeAll(list);
        return true;
    },

    clear() { writeAll([]); return true; },

    /**
     * 该会话能抽到哪些卡 —— 抽取逻辑唯一实现。
     * v13 起物理分桶：读的就是当前联系人自己的桶，不存在公用池串味。
     */
    usable(contactId) {
        if (!contactId) migrateOnce();
        // 显式按 contactId 取桶：聊天页从桌面直接进来时「当前桶」未必是这个人，
        // 靠全局状态抽卡会抽到别人的字卡。
        return readAll(contactId || null).filter((k) => Cards.groupEnabled(k.group, contactId));
    },

    /** 按分组过滤 */
    byGroup(group) {
        const all = readAll();
        return group ? all.filter((k) => k.group === group) : all;
    },

    /* ---------------- 分组（参照 mochi 字卡库） ---------------- */
    /** 分组列表；条目里出现过的分组会自动补齐 */
    groups(sid) {
        const declared = sid
            ? Store.getFor(sid, GROUPS_KEY, [], { scope: 'session' })
            : Store.get(GROUPS_KEY, [], { scope: 'session' });
        const arr = Array.isArray(declared) ? declared : [];
        const map = {};
        arr.forEach((g) => {
            if (g && g.name) map[g.name] = { name: g.name, enabled: g.enabled !== false };
        });
        readAll(sid).forEach((k) => {
            if (k.group && !map[k.group]) map[k.group] = { name: k.group, enabled: true };
        });
        return Object.keys(map).map((k) => map[k]);
    },

    groupEnabled(name, sid) {
        if (!name) return true;
        const g = Cards.groups(sid).find((x) => x.name === name);
        return g ? g.enabled : true;
    },

    addGroup(name) {
        name = String(name || '').trim();
        if (!name) return false;
        const list = Cards.groups();
        if (list.some((g) => g.name === name)) return false;
        list.push({ name, enabled: true });
        Cards._writeGroups(list);
        return true;
    },

    renameGroup(oldName, newName) {
        newName = String(newName || '').trim();
        if (!newName || !oldName) return false;
        const list = Cards.groups();
        const g = list.find((x) => x.name === oldName);
        if (g) g.name = newName;
        else if (!list.some((x) => x.name === newName)) list.push({ name: newName, enabled: true });
        Cards._writeGroups(list);
        // 卡片上的分组名跟着改
        const all = readAll();
        let changed = false;
        all.forEach((k) => { if (k.group === oldName) { k.group = newName; changed = true; } });
        if (changed) writeAll(all);
        return true;
    },

    /** 删除分组：组内卡片回到未分组 */
    removeGroup(name) {
        Cards._writeGroups(Cards.groups().filter((g) => g.name !== name));
        const all = readAll();
        let changed = false;
        all.forEach((k) => { if (k.group === name) { k.group = ''; changed = true; } });
        if (changed) writeAll(all);
        return true;
    },

    /** 启用/停用：停用的分组不参与抽取 */
    toggleGroup(name) {
        const list = Cards.groups();
        let g = list.find((x) => x.name === name);
        if (!g) { g = { name, enabled: true }; list.push(g); }
        g.enabled = !g.enabled;
        Cards._writeGroups(list);
        return g.enabled;
    },

    moveToGroup(ids, group) {
        const set = new Set(Array.isArray(ids) ? ids : [ids]);
        const all = readAll();
        let n = 0;
        all.forEach((k) => {
            if (!set.has(k.id)) return;
            k.group = String(group || '').trim();
            n++;
        });
        if (n) writeAll(all);
        return n;
    },

    /** 去掉内容重复的卡，返回删掉的数量 */
    dedupe() {
        const all = readAll();
        const seen = new Set();
        const keep = [];
        all.forEach((k) => {
            if (seen.has(k.text)) return;
            seen.add(k.text);
            keep.push(k);
        });
        const n = all.length - keep.length;
        if (n) writeAll(keep);
        return n;
    },

    /** 搜索 */
    search(kw) {
        const q = String(kw || '').trim().toLowerCase();
        if (!q) return [];
        return readAll().filter((k) => k.text.toLowerCase().indexOf(q) >= 0);
    },

    /** 更新（编辑内容 / 改分组 / 改归属） */
    update(id, patch) {
        const list = readAll();
        const i = list.findIndex((k) => k.id === id);
        if (i < 0) return null;
        const next = normalize(Object.assign({}, list[i], patch, { id }));
        if (!next) return null;
        list[i] = next;
        writeAll(list);
        return next;
    },

    removeMany(ids) {
        const set = new Set(Array.isArray(ids) ? ids : []);
        const list = readAll();
        const keep = list.filter((k) => !set.has(k.id));
        const n = list.length - keep.length;
        if (n) writeAll(keep);
        return n;
    },

    _writeGroups(list) {
        Store.set(GROUPS_KEY, list, { scope: 'global' });
        bus.emit(EV.CARDS_CHANGED, { groups: true });
    },

    /**
     * 随机抽 n 条（尽量不重复）。
     * 抽不到返回空数组 —— 由调用方提示去字卡库添加，绝不兜底造内容。
     */
    pick(contactId, n = 1) {
        const pool = Cards.usable(contactId);
        if (!pool.length) return [];
        const bag = pool.slice();
        const out = [];
        for (let i = 0; i < n && bag.length; i++) {
            const idx = Math.floor(Math.random() * bag.length);
            out.push(bag.splice(idx, 1)[0]);
        }
        return out;
    },

    /** 该会话可用卡数量（界面显示用） */
    countFor(contactId) { return Cards.usable(contactId).length; },

    /** 把某人的字卡整库复制到另一人（新建联系人时可一键「复制 TA 的配置」） */
    copyFrom(fromId, toId) {
        if (!fromId || !toId || fromId === toId) return 0;
        const src = readAll(fromId);
        if (!src.length) return 0;
        const cloned = src.map((k) => Object.assign({}, k, {
            id: uid(), created: Date.now()
        }));
        writeAll(cloned, toId);
        return cloned.length;
    }
};
