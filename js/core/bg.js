/* ============================================================
   bg.js — 后台模拟（保活 + 通知）
   ------------------------------------------------------------
   用户 2026-10-17 反馈：「离开聊天界面对方就不发信息了」。
   根因：之前「后台保活 / 后台通知」只是设置里两个空开关，没有任何实现。

   现实约束（先说清楚，别骗用户）：
     · 纯静态 PWA，**没法在页面关掉之后还跑代码**。
       浏览器一杀进程，JS 就停了 —— 这不是 bug，是平台限制。
     · 但下面这些场景是能覆盖的，也是用户实际遇到的：
         a) 切到别的标签页 / 按 Home 键把浏览器放后台（页面还活着）→ 继续发
         b) 在站内从聊天页返回桌面、去字卡库、去设置（页面还活着）→ 继续发
         c) 手机锁屏但浏览器没被系统杀掉（几分钟内）→ 继续发
     · 做法：页面不可见 / 不在聊天页时，按「主动发送」的间隔持续生成 TA 消息，
       直接写进对应联系人的消息桶（不打扰当前正在看的会话）；
       期间来新消息就弹系统通知（Notification API）+ 桌面图标角标。

   页面真的被关掉了 → 靠 Service Worker + 推送才能做到，那需要服务端，
   静态站做不到，界面上也写清楚了。
   ============================================================ */

import { Store } from '../core/store.js';
import { Session } from '../core/session.js';
import { Settings } from '../core/settings.js';
import { SilentLoop, Sound } from './sound.js';
import { bus, EV } from '../core/bus.js';
import { toast } from '../ui/toast.js';

const MSG_KEY = 'messages';
const KA_KEY = 'keepalive';
const LAST_BG_KEY = 'bgLastAt';        // global：上次后台发送时间（按联系人存 map）
const PEND_KEY = 'bgPending';          // global：退出聊天时没发出去的「待回复」交接

let timer = null;
let nextAt = 0;                        // 下一次该发的时间戳
let started = false;

/* ---------------- 配置 ---------------- */
function cfg() {
    return Store.get(KA_KEY, { on: false, notify: false }, { scope: 'global' }) || {};
}
function saveCfg(patch) {
    const cur = cfg();
    Store.set(KA_KEY, Object.assign(cur, patch), { scope: 'global' });
    // ★ 用户 2026-10-17：后台保活 = 真的去播一段静音音频循环占住音频会话。
    //   开关一变立刻同步音频层（记住选择存在这里，所以刷新后也能恢复）。
    try { SilentLoop.set(!!cur.on); } catch (e) { console.warn('[bg] 静音循环启动失败', e); }
    bus.emit('ka:changed', cfg());
}

/** 后台**主动**投递（对方自己找过来）该跑：静音循环 + 主动发送总开关 */
export function enabled() {
    const c = cfg();
    return !!(c.on && Settings.g().pushEnabled);
}

/** 通知是否允许：设置里开了 + 浏览器授权了 */
function notifyReady() {
    if (!cfg().notify) return false;
    if (typeof Notification === 'undefined') return false;
    return Notification.permission === 'granted';
}

/**
 * ★ 退出聊天界面时的「待回复交接」（用户 2026-10-17：
 *   「退出聊天界面对方不发信息依旧没解决」）
 *
 * 根因：聊天页 destroy() 会 clearAllTimers()，把还没发出的那条回复直接掐掉；
 *      而后台循环只按 pushMinM~pushMaxM 的间隔走（最短 5 分钟），
 *      所以「我发完就退出」这个最常见的场景，等 5 分钟也等不到。
 *
 * 做法：退出时把这笔「欠着的话」记下来（写 localStorage，刷新/切标签也在），
 *      由后台循环在**原来那个时间点**补发 —— 不改变节奏语义，
 *      用户体感就是「我退出后对方照常说，只是不在眼前」。
 *
 * @returns true = 已交接；false = 没开静音循环，不交接（用户原话：
 *          「未开启静音循环时，字卡只在前台回复」）
 */
export function armPending(sid, name, delayMs) {
    if (!cfg().on) return false;
    if (!sid) return false;
    const list = Store.get(PEND_KEY, [], { scope: 'global' });
    const arr = Array.isArray(list) ? list : [];
    // 同一联系人只保留最新的一笔（避免反复进出越攒越多）
    const next = arr.filter((x) => x && x.sid !== sid);
    next.push({ sid, name: name || '', at: Date.now() + Math.max(1200, Math.round(delayMs || 4000)) });
    Store.set(PEND_KEY, next.slice(-30), { scope: 'global' });
    // 立刻醒一次看看有没有到期的（delayMs 很短时用得上）
    wake();
    return true;
}

function duePendings(now) {
    const list = Store.get(PEND_KEY, [], { scope: 'global' });
    return (Array.isArray(list) ? list : []).filter((x) => x && x.sid && x.at <= now);
}
function dropPending(sid) {
    const list = Store.get(PEND_KEY, [], { scope: 'global' });
    const arr = Array.isArray(list) ? list : [];
    Store.set(PEND_KEY, arr.filter((x) => x && x.sid !== sid), { scope: 'global' });
}

export async function askNotifyPermission() {
    if (typeof Notification === 'undefined') {
        toast('这个浏览器不支持系统通知', 'warn', 2400);
        return false;
    }
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') {
        toast('通知被浏览器拦了，去浏览器设置里放行', 'warn', 3000);
        return false;
    }
    try {
        const r = await Notification.requestPermission();
        if (r === 'granted') { saveCfg({ notify: true }); toast('通知已开启', 'ok', 1600); return true; }
        toast('没拿到通知权限', 'warn', 2200);
    } catch { toast('通知授权失败', 'warn'); }
    return false;
}

/* ---------------- 发一条 ---------------- */
function lastAtMap() {
    const m = Store.get(LAST_BG_KEY, {}, { scope: 'global' });
    return (m && typeof m === 'object') ? m : {};
}

/** 从字卡库抽一条（后台没有聊天页实例，自己实现一个最小版） */
function drawLine(sid) {
    const g = Settings.g();
    // 拼字卡
    if (g.pinyinCard && Math.random() * 100 < (g.pinyinCardProb || 35)) {
        const merged = spliceFor(sid);
        if (merged) return merged;
    }
    return pickCard(sid);
}

/** 拼字卡：抽几张主字卡/颜文字/emoji 拼一句 */
function spliceFor(sid) {
    const g = Settings.g();
    const min = Math.max(1, g.pinyinCardMin || 1);
    const max = Math.max(min, Math.min(3, g.pinyinCardMax || 3));
    const n = min + Math.floor(Math.random() * (max - min + 1));
    const pool = [];
    cardsOf(sid).forEach((k) => pool.push({ w: 10, text: k.text }));
    mediaOf(sid, 'kaomoji').forEach((it) => pool.push({ w: 3, text: it.text }));
    mediaOf(sid, 'emoji').forEach((it) => pool.push({ w: 3, text: it.text }));
    if (!pool.length) return '';
    const bag = pool.slice();
    const out = [];
    for (let i = 0; i < n && bag.length; i++) {
        let total = 0;
        bag.forEach((x) => { total += x.w; });
        let r = Math.random() * total;
        let idx = bag.length - 1;
        for (let j = 0; j < bag.length; j++) { r -= bag[j].w; if (r <= 0) { idx = j; break; } }
        out.push(bag.splice(idx, 1)[0]);
    }
    return out.map((x) => x.text).join(' ');
}

/** 从会话桶读字卡（Cards 模块是按「当前桶」设计的，后台必须显式指定 sid） */
function cardsOf(sid) {
    try {
        const raw = Store.getFor(sid, 'cards', [], { scope: 'session' });
        const list = Array.isArray(raw) ? raw : [];
        return list.filter((k) => k && String(k.text || '').trim() && (k.enabled === undefined || k.enabled !== 0));
    } catch { return []; }
}
function pickCard(sid) {
    const list = cardsOf(sid);
    if (!list.length) return null;
    const one = list[Math.floor(Math.random() * list.length)];
    return one ? String(one.text) : null;
}
/** 会话桶里的素材（拍一拍/颜文字/emoji/表情包） */
function mediaOf(sid, kind) {
    try {
        const raw = Store.getFor(sid, 'media', null, { scope: 'session' });
        const all = (raw && typeof raw === 'object') ? raw : null;
        const list = all && Array.isArray(all[kind]) ? all[kind] : [];
        return list.filter((it) => it && it.text);
    } catch { return []; }
}

let uidSeq = 0;
function newId() {
    return 'b_' + Date.now().toString(36) + (uidSeq++).toString(36) + Math.random().toString(36).slice(2, 5);
}

/** 给某个联系人生成 1~N 条 TA 消息，写进他的桶（不动当前会话） */
function deliver(sid, name) {
    const g = Settings.g();
    const mn = Math.max(1, g.pushCountMin || 1);
    const mx = Math.max(mn, g.pushCountMax || 1);
    const count = mn + Math.floor(Math.random() * (mx - mn + 1));
    const list = (Store.getFor(sid, MSG_KEY, [], { scope: 'session' }) || []).slice();
    if (!Array.isArray(list)) return 0;

    // 已读不回：后台也遵守
    const s = (Store.getFor(sid, 'settings', null, { scope: 'session' }) || {});
    const noReplyOn = (s.noReply != null)
        ? (s.noReply === 1 || s.noReply === '1' || s.noReply === true)
        : (!!g.noReplyDefault);
    if (noReplyOn && Math.random() * 100 < (s.noReplyProb || 30)) {
        markLast(sid);
        return 0;
    }

    let added = 0;
    for (let i = 0; i < count; i++) {
        // 概率发表情包（只从字卡库的表情包分组，不碰 __mine）
        // ★ v40：主动发来的消息打 push:1 —— 聊天页据此在左上角显示 ❤️ 标识
        //   （设置里的「标识池」一直没被渲染，等于空设置；用户 2026-10-18 要求固定用 ❤️）
        if (i === 0 && Math.random() * 100 < (g.taStickerProb || 10)) {
            const stk = mediaOf(sid, 'sticker').filter((it) => it.src && (it.group || '') !== '__mine');
            if (stk.length) {
                const one = stk[Math.floor(Math.random() * stk.length)];
                list.push({ id: newId(), role: 'ta', type: 'image', src: one.src, stk: 1, ts: Date.now(), uid: null, retracted: 0, orig: '', quote: null, status: 'sent', push: 1 });
                added++;
                continue;
            }
        }
        const text = drawLine(sid);
        if (!text) break;
        list.push({ id: newId(), role: 'ta', type: 'text', text, ts: Date.now(), uid: null, retracted: 0, orig: '', quote: null, status: 'sent', push: 1 });
        added++;
    }
    if (added) {
        Store.setFor(sid, MSG_KEY, list, { scope: 'session' });
        // 正在看这个会话 → 让聊天页自己补渲染
        if (Session.currentId() === sid) bus.emit(EV.MESSAGE_ADDED, { contactId: sid, message: list[list.length - 1], fromBg: true });
        // 角色回复提示音（用户上传了音频 + 设置里开着才有声音）
        if (Settings.g().soundMsg) { try { Sound.playMsg(); } catch { /* noop */ } }
        // 系统通知
        if (notifyReady()) {
            try {
                const last = list[list.length - 1];
                const body = last.type === 'image' ? '[表情包]' : String(last.text || '').slice(0, 60);
                const n = new Notification(name || '有人找你', { body, tag: 'zika-' + sid, renotify: false });
                n.onclick = () => { try { window.focus(); } catch { /* noop */ } };
            } catch { /* 某些浏览器构造 Notification 也会抛 */ }
        }
    }
    markLast(sid);
    return added;
}

function markLast(sid) {
    const m = lastAtMap();
    m[sid] = Date.now();
    Store.set(LAST_BG_KEY, m, { scope: 'global' });
}

/** 挑一个「该发了」的联系人 */
function pickDue() {
    const g = Settings.g();
    const now = Date.now();
    const last = lastAtMap();
    const minMs = Math.max(1, g.pushMinM || 5) * 60000;
    const maxMs = Math.max(minMs, g.pushMaxM || 10) * 60000;
    const all = Session.all().filter((c) => !c.blocked);
    if (!all.length) return null;
    // 找出等待最久的
    let best = null;
    let bestWait = -1;
    all.forEach((c) => {
        const t = last[c.id] || 0;
        const wait = now - t;
        if (wait > bestWait) { bestWait = wait; best = c; }
    });
    if (!best) return null;
    const dueAt = (last[best.id] || 0) + (minMs + Math.random() * Math.max(1, maxMs - minMs));
    return now >= dueAt ? best : null;
}

/* ---------------- 主循环 ---------------- */
/** 立刻把定时器重排到最近的到期点（新增待回复 / 开关变了都要叫它） */
function wake() {
    if (!started) return;
    if (timer) { clearTimeout(timer); timer = null; }
    scheduleNext();
}

function tick() {
    timer = null;
    // ① 先处理「退出聊天时交接过来的欠条」，到点就补发
    const now = Date.now();
    duePendings(now).forEach((p) => {
        dropPending(p.sid);
        markLast(p.sid);
        deliver(p.sid, p.name);
    });

    if (!enabled()) { nextAt = 0; return; }
    const due = pickDue();
    if (due) {
        deliver(due.id, due.name);
        // 发完重新排下一次
        scheduleNext();
    } else {
        scheduleNext();
    }
}

function scheduleNext() {
    if (timer) { clearTimeout(timer); timer = null; }
    // 等待上限：把「待回复到期时间」和「主动发送到期时间」里更早的那个算进来，
    // 不然刚交接完的欠条要干等一整个轮询间隔。
    let wait = enabled() ? 30000 : 15000;
    const now = Date.now();
    const list = Store.get(PEND_KEY, [], { scope: 'global' });
    (Array.isArray(list) ? list : []).forEach((p) => {
        if (!p || !p.at) return;
        const d = Math.max(300, p.at - now);
        if (d < wait) wait = d;
    });
    if (enabled()) {
        const g = Settings.g();
        const minMs = Math.max(1, g.pushMinM || 5) * 60000;
        const maxMs = Math.max(minMs, g.pushMaxM || 10) * 60000;
        const w = Math.min(30000, Math.max(5000, (minMs + Math.random() * (maxMs - minMs)) / 6));
        if (w < wait) wait = w;
    }
    nextAt = Date.now() + wait;
    timer = setTimeout(tick, wait);
}

/** 页面状态变化时调用：可见且在聊天页 → 交给聊天页自己的 taSpeak；
 *  不可见 / 不在聊天页 → 后台循环接管 */
export function syncWithPage(visible, onChatPage) {
    if (!started) return;
    // ★ 有交接过来的欠条时，后台循环必须继续跑（哪怕当前在聊天页），
    //   否则退出聊天时交接的那条回复永远等不到 —— 这正是用户反馈的那个 bug。
    const owes = (Store.get(PEND_KEY, [], { scope: 'global' }) || []).some((x) => x && x.at);
    // ★ v38：「主动发送」在聊天界面里也要生效（用户 2026-10-18：
    //   「主动发信息这个在聊天界面里根本没被应用」）。
    //   以前这里要求 `(!visible || !onChatPage)` —— 人待在聊天页时整个循环停摆，
    //   「对方主动发消息」只有离开聊天页才跑，等于这个开关在聊天里形同虚设。
    //   现在只要开关开着就一直按 pushMinM~pushMaxM 的节奏跑；
    //   聊天页收到 fromBg 事件本来就会自动补渲染并滚到底（chat.js 已处理）。
    const shouldRun = owes || enabled();
    if (shouldRun) {
        if (!timer) scheduleNext();
    } else if (timer) {
        clearTimeout(timer);
        timer = null;
        nextAt = 0;
    }
}

export function start() {
    if (started) return;
    started = true;
    // 设置改了（开关/间隔）→ 重排
    bus.on('ka:changed', () => scheduleNext());
    bus.on(EV.STYLE_CHANGED, () => scheduleNext());
    // 页面隐藏/显示
    document.addEventListener('visibilitychange', () => {
        // ★ 从后台回来：尝试恢复静音音频会话（用户 2026-10-17：「中断后会尝试恢复」）
        if (!document.hidden) { try { SilentLoop.resume(); } catch { /* noop */ } }
        syncWithPage(!document.hidden, isOnChatPage());
    });
    // ★ 记住选择：上次开着静音循环，刷新后自动恢复（浏览器放行就直接播）
    if (cfg().on) { try { SilentLoop.start(); } catch { /* noop */ } }
    scheduleNext();
}

let onChatPage = false;
export function setOnChatPage(v) { onChatPage = !!v; }
export function isOnChatPage() { return onChatPage; }

export const KeepAlive = {
    start,
    cfg,
    saveCfg,
    enabled,
    askNotifyPermission,
    syncWithPage,
    setOnChatPage,
    /** 退出聊天时交接欠着的那条回复 */
    armPending,
    /** 静音音频循环状态：off 未开 / on 正在播 / blocked 被浏览器拦了 */
    loopState() {
        try { return SilentLoop.state(); } catch { return 'off'; }
    },
    /** 立刻重排定时器（armPending 之后要立刻生效） */
    wake,
    /** 立刻跑一次（测试用） */
    fireOnce() {
        const all = Session.all().filter((c) => !c.blocked);
        if (!all.length) { toast('还没有联系人', 'warn'); return 0; }
        let n = 0;
        all.forEach((c) => { n += deliver(c.id, c.name); });
        if (!n) toast('字卡库是空的，没内容可发', 'warn', 2600);
        return n;
    },
    notifyState() {
        if (typeof Notification === 'undefined') return 'unsupported';
        return Notification.permission;
    }
};
