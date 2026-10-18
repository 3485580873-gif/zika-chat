/* ============================================================
   call.js — 视频通话（对齐 evanlu-repo/js/features/call.js）
   ------------------------------------------------------------
   ★ v35 重做（用户 2026-10-18：「通话你自己好好看看 evanlu 怎么实现的」）：
     上一版只搬了皮，逻辑全是自己瞎写的，漏掉四样：
       ① **通话记录写进聊天**（evanlu 的 sendCallEvent → type:'call-event' 系统消息）
       ② **隐藏头像**按钮（顶栏三个钮之一）
       ③ **浮窗大小拖拽调节**（右下角 resize handle）
       ④ **判定时机**：我打过去 → 先模拟显示通话 → 再掷骰子判定
          （35% 对方拒接 / 65% 接通），不是我上一版「掷骰子在前」。

   判定与记录（全部照 evanlu 的文案与概率）：
     · 我打过去 35% 拒接 → 「XX 未接听 / 正在忙，无法接听 / 拒绝了通话 / 暂时无法接听」
     · 对方来电 30% 自动未接（4~10 秒）→「XX 的来电，我未接听 / 我拒绝了… / 错过了… / 我暂时无法接听…」
     · 通话中 3% 概率 10~120 秒后对方主动挂断 → 「对方有事忙，主动结束了通话 · 时长」
     · 正常挂断 → 「视频通话已结束 · 时长」
   ★ 用户明确要求：挂断时**不改动头像**（这里绝不碰任何 avatar 数据）。
   ============================================================ */

import { icon } from '../ui/icon.js';
import { Session } from '../core/session.js';
import { Store } from '../core/store.js';
import { Settings } from '../core/settings.js';
import { bus, EV } from '../core/bus.js';
import { IDB } from '../core/idb.js';
import { toast } from '../ui/toast.js';

const SVG_HANG = '<svg viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.7 5.1 6.5 6.5l2.2-2.2c.28-.27.68-.36 1.03-.24 1.1.37 2.3.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C10.56 21 3 13.44 3 4c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.28.2 2.5.57 3.57.11.35.03.74-.24 1.02L6.6 10.8z"/><line x1="21" y1="3" x2="3" y2="21" stroke="white" stroke-width="2.4" stroke-linecap="round"/></svg>';
const SVG_PHONE = '<svg viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.7 5.1 6.5 6.5l2.2-2.2c.28-.27.68-.36 1.03-.24 1.1.37 2.3.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C10.56 21 3 13.44 3 4c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.28.2 2.5.57 3.57.11.35.03.74-.24 1.02L6.6 10.8z"/></svg>';

const BG_KEY = 'callBgImage';
const POS_KEY = 'callWinPos';        // 浮窗位置
const PILL_POS_KEY = 'callPillPos';  // 最小化胶囊位置
const SIZE_KEY = 'callWinSize';      // 浮窗大小

const SIZES = [
    { w: 160, h: 240, name: '迷你' },
    { w: 220, h: 350, name: '小' },
    { w: 280, h: 440, name: '标准' },
    { w: 360, h: 560, name: '大' }
];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* 运行状态 */
let S = {
    active: false, startTime: 0, elapsed: 0,
    isPartnerCall: false, minimized: false, immersive: false, hideAvatar: false,
    size: { w: 280, h: 440 }
};

let R = {};
let randTimer = null;
let tickRaf = null;
let connTimer = null;
let incTimer = null;
let partnerHangupTimer = null;

/* ---------------- 工具 ---------------- */
function fmt(ms) {
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
    return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function partnerName() {
    const c = Session.current();
    return (c && c.name) || '对方';
}
function myName() {
    try { return (Settings.g().myName) || '我'; } catch { return '我'; }
}
function avatarInner(av, size) {
    if (av && /^(data:|https?:|blob:)/i.test(av)) return '<img src="' + av + '" alt="">';
    return icon('avatars', size || 20);
}

/* ---------------- ★ 通话记录写进聊天 ---------------- */
/* ★ v36：发送队列兜底（照 evanlu 的 enqueueCallEvent/flushCallEventQueue）
   —— 写盘失败（配额爆 / 临时异常）时先入内存队列，下一次任何通话动作再重试，
   保证「这通电话发生过」这个记录不会丢。 */
let pendingEvents = [];

function flushPending() {
    if (!pendingEvents.length) return;
    const q = pendingEvents.slice();
    pendingEvents = [];
    const left = [];
    q.forEach((ev) => { if (!writeEvent(ev.label, ev.detail)) left.push(ev); });
    pendingEvents = left.concat(pendingEvents);
}

/** 真正写盘；成功返回 true */
function writeEvent(label, detail) {
    const sid = Session.currentId();
    if (!sid) return false;
    try {
        const list = Store.getFor(sid, 'messages', [], { scope: 'session' }) || [];
        if (!Array.isArray(list)) return false;
        list.push({
            id: 'call_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            role: 'me',
            type: 'system',
            text: label + (detail ? ' · ' + detail : ''),
            ts: Date.now(),
            status: 'read'
        });
        Store.setFor(sid, 'messages', list, { scope: 'session' });
        bus.emit(EV.MESSAGE_ADDED, { contactId: sid, message: list[list.length - 1], fromBg: true });
        return true;
    } catch (e) {
        console.warn('[call] 写通话记录失败', e);
        return false;
    }
}

/** 照 evanlu 的 sendCallEvent：往当前会话追加一条系统消息（失败进队列兜底） */
function sendCallEvent(label, detail) {
    flushPending();
    if (!writeEvent(label, detail)) pendingEvents.push({ label, detail });
}

/* ---------------- ★ 崩溃恢复 ---------------- */
/* 通话中每 2 秒写一次心跳快照到 localStorage；
   页面闪退/被刷新后重新打开，能检测到「没正常挂断」的通话并询问用户。 */
const LIVE_KEY = 'callLiveSession';

function writeCallSession() {
    try {
        localStorage.setItem(LIVE_KEY, JSON.stringify({
            active: true,
            startTime: S.startTime || Date.now(),
            isPartnerCall: S.isPartnerCall,
            savedAt: Date.now()
        }));
    } catch (e) { /* 配额满就算了，不影响通话 */ }
}
function clearCallSession() {
    try { localStorage.removeItem(LIVE_KEY); } catch (e) {}
}
let heartbeat = null;
function startHeartbeat() {
    stopHeartbeat();
    writeCallSession();
    heartbeat = setInterval(writeCallSession, 2000);
}
function stopHeartbeat() {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    clearTimeout(partnerHangupTimer); partnerHangupTimer = null;
}

/** 打开网站时检查：上次通话没正常结束 → 弹窗问「继续通话 / 直接挂断」 */
function checkRecover() {
    let snap = null;
    try { snap = JSON.parse(localStorage.getItem(LIVE_KEY) || 'null'); } catch (e) { return; }
    if (!snap || !snap.active) return;
    // 快照太旧（> 2 小时）就不问了，直接清掉
    if (Date.now() - (snap.savedAt || 0) > 2 * 3600 * 1000) { clearCallSession(); return; }

    const ov = document.createElement('div');
    ov.id = 'call-recover-overlay';
    ov.className = 'call-recover';
    ov.innerHTML =
        '<div class="call-recover-box">' +
            '<div class="call-recover-ico">' + icon('video', 30) + '</div>' +
            '<b>检测到未挂断的通话</b>' +
            '<p>网页可能闪退或被刷新了，通话没有正常结束。<br>要继续这通电话，还是直接挂断？</p>' +
            '<div class="call-recover-cd">15 秒内不操作将自动挂断</div>' +
            '<div class="call-recover-btns">' +
                '<button class="call-recover-btn ghost" data-r="hangup">挂断</button>' +
                '<button class="call-recover-btn primary" data-r="continue">继续通话</button>' +
            '</div>' +
        '</div>';
    document.body.appendChild(ov);

    let left = 15;
    const cdEl = ov.querySelector('.call-recover-cd');
    const timer = setInterval(() => {
        left -= 1;
        if (cdEl) cdEl.textContent = left + ' 秒内不操作将自动挂断';
        if (left <= 0) { clearInterval(timer); doHangup(); }
    }, 1000);

    function close() { clearInterval(timer); if (ov.parentNode) ov.parentNode.removeChild(ov); }
    function doHangup() {
        const dur = snap.startTime ? (Date.now() - snap.startTime) : 0;
        clearCallSession();
        close();
        if (dur > 0) sendCallEvent('视频通话已结束', fmt(dur));
        toast('已挂断', 'info', 1800);
    }
    function doContinue() {
        clearCallSession();
        close();
        fill(); applyBg(); positionWindow();
        S.active = true;
        S.isPartnerCall = !!snap.isPartnerCall;
        S.startTime = snap.startTime || Date.now();
        S.elapsed = Math.max(0, Date.now() - S.startTime);
        R.win.classList.remove('immersive', 'hide-avatar');
        R.win.classList.add('visible');
        R.connState.style.display = 'none';
        R.bodyState.style.display = '';
        startTimer(S.startTime);      // ★ 沿用原 startTime，时长不归零
        startHeartbeat();
        rollPartnerHangup();
        toast('通话已恢复', 'ok', 1800);
    }
    ov.addEventListener('click', (e) => {
        const b = e.target.closest('[data-r]');
        if (!b) return;
        if (b.getAttribute('data-r') === 'continue') doContinue();
        else doHangup();
    });
}

/* ---------------- ★ 来电系统通知 ---------------- */
function notifyIncoming(name) {
    try {
        if (typeof Notification === 'undefined') return;
        if (Notification.permission !== 'granted') return;
        const n = new Notification(name + ' 请求视频通话', {
            body: name + ' 打视频给你了，点击返回接听',
            tag: 'zika-call-incoming',
            icon: (function () {
                const c = Session.current();
                return (c && c.avatar) || '';
            })()
        });
        n.onclick = function () { try { window.focus(); } catch (e) {} n.close(); };
    } catch (e) { /* 通知失败不影响来电 UI */ }
}

/* ---------------- 背景图 ---------------- */
function applyBg(src) {
    if (!R.bgImg) return;
    const ok = typeof src === 'string' && /^data:image/i.test(src);
    if (ok) { R.bgImg.src = src; R.bgImg.style.display = 'block'; R.win.classList.add('has-bg'); }
    else { R.bgImg.src = ''; R.bgImg.style.display = 'none'; R.win.classList.remove('has-bg'); }
}
function loadBg() {
    IDB.get(BG_KEY).then((v) => { if (v) applyBg(v); }).catch(() => {});
}

/* ---------------- 构建 ---------------- */
function build() {
    if (document.getElementById('call-feature-root')) return;
    const root = document.createElement('div');
    root.id = 'call-feature-root';
    root.innerHTML =
        '<div id="call-incoming-overlay">' +
            '<div class="call-inc-card">' +
                '<div class="call-inc-ring"><div class="call-inc-avatar" id="call-inc-avatar"></div></div>' +
                '<div class="call-inc-name" id="call-inc-name">对方</div>' +
                '<div class="call-inc-sub"><span class="call-inc-sub-dot"></span><span>邀请您进行视频通话</span></div>' +
                '<div class="call-inc-actions">' +
                    '<button class="call-inc-btn call-inc-reject" id="call-inc-reject">' +
                        '<div class="call-inc-circle">' + SVG_HANG + '</div><span class="call-inc-lbl">拒绝</span></button>' +
                    '<button class="call-inc-btn call-inc-accept" id="call-inc-accept">' +
                        '<div class="call-inc-circle">' + SVG_PHONE + '</div><span class="call-inc-lbl">接听</span></button>' +
                '</div>' +
            '</div>' +
        '</div>' +

        '<div id="call-window">' +
            '<div id="call-window-inner">' +
                '<div id="call-window-bg">' +
                    '<div class="call-bg-grad"></div>' +
                    '<div class="call-orb call-orb-1"></div>' +
                    '<div class="call-orb call-orb-2"></div>' +
                    '<div class="call-orb call-orb-3"></div>' +
                    '<img id="call-bg-img" src="" alt="">' +
                '</div>' +
                '<div class="call-overlay"></div>' +
                '<div id="call-window-header">' +
                    '<div class="call-badge"><span class="call-rec-dot"></span>' +
                        '<span class="call-timer-txt" id="call-timer-display">00:00</span></div>' +
                    '<div class="call-top-btns">' +
                        /* ★ 隐藏头像（evanlu 的 call-hide-avatar-btn） */
                        '<button class="call-top-btn" id="call-hide-avatar-btn" title="隐藏头像">' + icon('eyeOff', 12) + '</button>' +
                        '<button class="call-top-btn" id="call-size-toggle" title="调整大小">' + icon('sliders', 12) + '</button>' +
                        '<button class="call-top-btn" id="call-minimize-btn" title="最小化">' + icon('min', 12) + '</button>' +
                    '</div>' +
                '</div>' +
                '<div id="call-connecting-state">' +
                    '<div class="call-av-wrap"><div class="call-av-pulse"></div><div class="call-av-pulse2"></div>' +
                        '<div class="call-avatar" id="call-conn-avatar"></div></div>' +
                    '<div class="call-name" id="call-conn-name">对方</div>' +
                    '<div class="call-conn-sub" id="call-conn-sub">' + icon('video', 11) + ' 正在连接…</div>' +
                    '<div class="call-wave"><span></span><span></span><span></span><span></span><span></span></div>' +
                '</div>' +
                '<div id="call-window-body">' +
                    '<div class="call-av-wrap"><div class="call-av-pulse"></div><div class="call-av-pulse2"></div>' +
                        '<div class="call-avatar" id="call-win-avatar"></div></div>' +
                    '<div class="call-name" id="call-win-name">通话中</div>' +
                    '<div class="call-wave"><span></span><span></span><span></span><span></span><span></span></div>' +
                '</div>' +
                '<button class="call-util-btn" id="call-immersive-btn" title="沉浸模式">' + icon('eye', 13) + '</button>' +
                '<button class="call-util-btn" id="call-bg-btn" title="更换通话背景">' + icon('image', 13) + '</button>' +
                '<input type="file" id="call-bg-file-input" accept="image/*,.gif">' +
                '<div id="call-window-controls">' +
                    '<button class="call-hangup-btn" id="call-hangup-btn">' + SVG_HANG + '</button>' +
                '</div>' +
            '</div>' +
            /* ★ 右下角拖拽把手：调浮窗大小（evanlu 的 #call-resize-handle） */
            '<div id="call-resize-handle"></div>' +
        '</div>' +

        '<div id="call-size-presets">' +
            SIZES.map((s) => '<button class="call-size-btn" data-w="' + s.w + '" data-h="' + s.h + '">' + s.name + '</button>').join('') +
            '<button class="call-size-btn" data-full="1">全屏</button>' +
        '</div>' +

        '<div id="call-mini-pill">' +
            '<div class="call-mini-av" id="call-mini-av"></div>' +
            '<div class="call-mini-info">' +
                '<div class="call-mini-name" id="call-mini-name">通话中</div>' +
                '<div class="call-mini-time" id="call-mini-timer">00:00</div>' +
            '</div>' +
            '<span class="call-mini-dot"></span>' +
            '<button class="call-mini-hangup" id="call-mini-hangup">' + SVG_HANG + '</button>' +
        '</div>';

    document.body.appendChild(root);

    const q = (s) => root.querySelector(s);
    R = {
        root, overlay: q('#call-incoming-overlay'), win: q('#call-window'),
        bgImg: q('#call-bg-img'), bgBtn: q('#call-bg-btn'), bgFile: q('#call-bg-file-input'),
        timer: q('#call-timer-display'), connSub: q('#call-conn-sub'),
        connState: q('#call-connecting-state'), bodyState: q('#call-window-body'),
        incName: q('#call-inc-name'), incAv: q('#call-inc-avatar'),
        connName: q('#call-conn-name'), connAv: q('#call-conn-avatar'),
        winName: q('#call-win-name'), winAv: q('#call-win-avatar'),
        miniName: q('#call-mini-name'), miniAv: q('#call-mini-av'), miniTimer: q('#call-mini-timer'),
        miniPill: q('#call-mini-pill'), presets: q('#call-size-presets'),
        accept: q('#call-inc-accept'), reject: q('#call-inc-reject'),
        hangup: q('#call-hangup-btn'), miniHangup: q('#call-mini-hangup'),
        header: q('#call-window-header'), handle: q('#call-resize-handle'),
        immersive: q('#call-immersive-btn'), sizeToggle: q('#call-size-toggle'),
        minimize: q('#call-minimize-btn'), hideAv: q('#call-hide-avatar-btn')
    };
    bind();
}

/* 填联系人信息（只读，绝不修改任何头像数据） */
function fill() {
    const c = Session.current() || { name: '对方', avatar: '' };
    R.incName.textContent = c.name;
    R.incAv.innerHTML = avatarInner(c.avatar, 34);
    R.connName.textContent = c.name;
    R.connAv.innerHTML = avatarInner(c.avatar, 20);
    R.winName.textContent = c.name;
    R.winAv.innerHTML = avatarInner(c.avatar, 20);
    R.miniName.textContent = c.name;
    R.miniAv.innerHTML = avatarInner(c.avatar, 12);
}

/* ---------------- 交互绑定 ---------------- */
function bind() {
    R.accept.addEventListener('click', acceptCall);
    R.reject.addEventListener('click', rejectIncoming);
    R.hangup.addEventListener('click', endCall);
    R.miniHangup.addEventListener('click', endCall);

    // ★ 隐藏头像（toggle，只影响通话窗显示，不动数据）
    R.hideAv.addEventListener('click', (e) => {
        e.stopPropagation();
        const on = R.win.classList.toggle('hide-avatar');
        R.hideAv.classList.toggle('active', on);
        R.hideAv.innerHTML = icon(on ? 'eye' : 'eyeOff', 12);
        R.hideAv.title = on ? '显示头像' : '隐藏头像';
    });

    // 沉浸模式
    R.immersive.addEventListener('click', (e) => {
        e.stopPropagation();
        const on = R.win.classList.toggle('immersive');
        R.immersive.classList.toggle('active', on);
        R.immersive.innerHTML = icon(on ? 'eyeOff' : 'eye', 13);
        S.immersive = on;
    });

    // 最小化
    R.minimize.addEventListener('click', (e) => { e.stopPropagation(); minimize(); });
    // ★ v41：胶囊的「点击=展开 / 拖动=挪位置」统一交给 dragify 的 onTap，
    //   不再单独挂 click —— 之前 touchstart 上的 preventDefault 会吞掉 click，
    //   导致点了没反应（用户 2026-10-18：「点击这个还要有展开通话窗啊」）。

    // 尺寸预设
    R.sizeToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const on = R.presets.classList.toggle('open');
        if (on) {
            const r = R.sizeToggle.getBoundingClientRect();
            R.presets.style.right = (window.innerWidth - r.right) + 'px';
            R.presets.style.top = (r.bottom + 6) + 'px';
        }
    });
    R.presets.addEventListener('click', (e) => {
        const b = e.target.closest('[data-w],[data-full]');
        if (!b) return;
        if (b.hasAttribute('data-full')) {
            R.win.classList.add('full');
            R.immersive.classList.remove('active');
            R.immersive.innerHTML = icon('eye', 13);
        } else {
            setSize(Number(b.getAttribute('data-w')), Number(b.getAttribute('data-h')));
        }
        R.presets.classList.remove('open');
    });
    document.addEventListener('click', () => R.presets.classList.remove('open'));

    // 换通话背景
    if (R.bgBtn && R.bgFile) {
        R.bgBtn.addEventListener('click', (e) => { e.stopPropagation(); R.bgFile.click(); });
        R.bgFile.addEventListener('change', (e) => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            const fr = new FileReader();
            fr.onload = async () => {
                const d = String(fr.result || '');
                if (!d.startsWith('data:')) return;
                applyBg(d);
                if (!(await IDB.set(BG_KEY, d))) toast('背景图太大，存不下，换张小一点的', 'warn', 2400);
            };
            fr.readAsDataURL(f);
            e.target.value = '';
        });
    }

    // ★ v41：全部改成 pointer 事件版 dragify（照 mochi）
    //   大浮窗：跳过顶栏按钮，点击不响应（顶栏只是拖动把手）
    dragify(R.header, R.win, { skipSel: 'button', storeKey: POS_KEY, safeTop: 0 });
    resizify(R.handle, R.win);
    //   最小化胶囊：跳过挂断按钮；没移动就展开回完整通话窗
    dragify(R.miniPill, R.miniPill, {
        skipSel: '#call-mini-hangup',
        storeKey: PILL_POS_KEY,
        safeTop: safeTop(),
        onTap: () => restore()
    });
}

function setSize(w, h) {
    // ★ v37：先退出全屏。#call-window.full 的 left/top/width/height 全是 !important，
    //   不先摘掉 full 类，用户在全屏后选任何尺寸都「没反应」（用户 v37 反馈）。
    R.win.classList.remove('full');
    R.win.classList.remove('immersive');
    S.size = { w: clamp(w, 160, 600), h: clamp(h, 240, 800) };
    R.win.style.width = S.size.w + 'px';
    R.win.style.height = S.size.h + 'px';
    R.win.classList.toggle('size-xs', S.size.w <= 200);   // ★ v37 迷你窗
    keepInViewport();       // ★ v37：缩小后别把窗口缩到屏幕外
    try { localStorage.setItem(SIZE_KEY, JSON.stringify(S.size)); } catch (e) {}
}

/* ---------- ★ v41 拖动：照 mochi call.js 重做 ----------
   mochi 的做法（src/js/call.js 753-798）：
     · 用 **pointer 事件**（pointerdown/move/up/cancel）而不是 touch+mouse 两套
     · pointerdown 时 setPointerCapture，指针移出元素也能继续拖
     · **只有真正移动过**（moved）才切换到拖动态、才写位置
     · pointerup 时：moved → 存位置；没动 → 当作「点击」
   我 v39 之前用 touchstart + 无条件 preventDefault()，在移动端会**直接吞掉 click**，
   于是「点胶囊展开通话窗」永远不触发（用户 2026-10-18：「点击这个还要有展开通话窗啊」）。

   @param skipSel 落在这个选择器上的指针不接管（按钮）
   @param onTap    没移动就松开时的回调（点击语义）
   @param storeKey 拖动后保存位置的 localStorage key（不传则不保存） */
function dragify(handle, box, opts) {
    if (!handle || !box) return;
    const o = opts || {};
    let dragging = false, moved = false, offX = 0, offY = 0, pid = null;

    box.classList.add('draggable');   // CSS: touch-action:none

    const onDown = (e) => {
        if (e.button != null && e.button !== 0) return;
        if (o.skipSel && e.target && e.target.closest && e.target.closest(o.skipSel)) return;
        dragging = true; moved = false; pid = e.pointerId;
        const r = box.getBoundingClientRect();
        offX = e.clientX - r.left;
        offY = e.clientY - r.top;
        try { box.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器忽略 */ }
        // 不 preventDefault —— 让 click 正常派发，交给 onTap 判定
    };

    const onMove = (e) => {
        if (!dragging || (pid != null && e.pointerId !== pid)) return;
        const dx = e.clientX - offX - parseFloat(box.style.left || 0) + parseFloat(box.style.left || 0);
        const x = e.clientX - offX;
        const y = e.clientY - offY;
        if (!moved) {
            if (Math.abs(e.clientX - (offX + parseFloat(box.style.left || 0))) < 3 &&
                Math.abs(e.clientY - (offY + parseFloat(box.style.top || 0))) < 3) return;
            moved = true;
            box.classList.add('dragging');
            // ★ 首次移动才清 bottom —— top/bottom 同时存在会让 fixed 元素跳位（mochi 注释）
            box.style.bottom = 'auto';
            box.style.right = 'auto';
        }
        const w = box.offsetWidth, h = box.offsetHeight;
        const safeTop = (o.safeTop != null) ? o.safeTop : 0;
        const nx = clamp(x, 0, Math.max(0, window.innerWidth - w));
        const ny = clamp(y, safeTop, Math.max(safeTop, window.innerHeight - h));
        box.style.left = nx + 'px';
        box.style.top = ny + 'px';
    };

    const finish = (e) => {
        if (!dragging) return;
        dragging = false;
        try { if (pid != null) box.releasePointerCapture(pid); } catch (err) { /* noop */ }
        pid = null;
        if (moved) {
            box.classList.remove('dragging');
            if (o.storeKey) {
                try { localStorage.setItem(o.storeKey, JSON.stringify({ x: box.style.left, y: box.style.top })); } catch (err) {}
            }
        } else if (o.onTap) {
            o.onTap(e);          // ← 没移动 = 点击
        }
    };

    const cancel = () => { dragging = false; moved = false; box.classList.remove('dragging'); pid = null; };

    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', cancel);
    // 指针移出元素（没 capture 成功的老浏览器）时也能继续拖
    handle.addEventListener('pointerleave', (e) => { if (dragging && !moved) return; });
}

/* ---------- ★ v41 安全区顶部（照 mochi miniSafeTop） ----------
   iOS standalone 下 fixed 元素 top:0 会落进系统状态栏/灵动岛区域，
   触点被系统栏吞掉 → 浮窗「点不动、拖不动」（mochi bug #114 / #137）。
   三级探测：① env(safe-area-inset-top) 探针 ② screen-innerHeight 差值 ③ 47px 兜底。 */
let _safeTopCache = -1;
function safeTop() {
    if (_safeTopCache >= 0) return _safeTopCache;
    let top = 0;
    try {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;' +
            'padding-top:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none;';
        document.body.appendChild(probe);
        const v = parseFloat(getComputedStyle(probe).paddingTop);
        document.body.removeChild(probe);
        if (!isNaN(v) && v >= 20 && v <= 160) top = v;
    } catch (e) { /* 探针失败走下面 */ }
    if (!top) {
        const sh = (window.screen && window.screen.height) || 0;
        const ih = window.innerHeight || 0;
        const diff = sh - ih;
        if (diff >= 20 && diff <= 160) top = diff;
    }
    if (!top) top = 47;            // 刘海/灵动岛机型状态栏最小高度保守值
    _safeTopCache = top;
    return top;
}

/* 拖拽 / 恢复位置后把窗口抬到安全区下方（mochi liftMiniIntoSafeArea） */
function liftIntoSafeArea(box) {
    if (!box || box === R.win) return;
    const st = safeTop();
    if (st <= 0) return;
    const m = String(box.style.top || '').match(/^(-?\d+(\.\d+)?)px$/);
    if (!m) return;                                  // 无内联 top（默认贴底）不用管
    if (parseFloat(m[1]) < st) {
        box.style.top = st + 'px';
        box.style.bottom = 'auto';
        try { localStorage.setItem(PILL_POS_KEY, JSON.stringify({ x: box.style.left, y: box.style.top })); } catch (e) {}
    }
}

/* ★ 拖拽调节大小（右下角把手）——同样改 pointer 事件 */
function resizify(handle, box) {
    if (!handle) return;
    let sx = 0, sy = 0, w0 = 0, h0 = 0, on = false, pid = null;
    handle.style.touchAction = 'none';
    const start = (e) => {
        if (e.button != null && e.button !== 0) return;
        on = true; pid = e.pointerId;
        box.classList.remove('full');
        const r = box.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; w0 = r.width; h0 = r.height;
        box.classList.add('dragging');
        try { handle.setPointerCapture(e.pointerId); } catch (err) {}
        e.stopPropagation();
    };
    const move = (e) => {
        if (!on || (pid != null && e.pointerId !== pid)) return;
        setSize(w0 + (e.clientX - sx), h0 + (e.clientY - sy));
    };
    const end = () => { if (!on) return; on = false; box.classList.remove('dragging'); try { if (pid != null) handle.releasePointerCapture(pid); } catch (e) {} };
    handle.addEventListener('pointerdown', start);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
}

function minimize() {
    S.minimized = true;
    R.win.classList.remove('visible');
    // ★ v41：设置里关掉「最小化胶囊」时就不显示胶囊（通话转后台，仍可回大窗挂断）
    //   —— 照 mochi call-mini-enabled 的语义。
    if (callCfg().mini) {
        R.miniPill.classList.add('visible');
    } else {
        R.miniPill.classList.remove('visible');
        return;
    }
    positionPill();
    // ★ v41：显示后立刻抬到系统状态栏下方（mochi liftMiniIntoSafeArea）
    //   旧坐标落在状态栏区时触点会被系统栏吞 → 点不动、拖不动
    requestAnimationFrame(() => liftIntoSafeArea(R.miniPill));
}

/** 胶囊定位：优先用上次拖到哪儿（且必须在可视区 + 安全区内），否则默认右下 */
function positionPill() {
    if (!R.miniPill) return;
    const w = R.miniPill.offsetWidth || 150;
    const h = R.miniPill.offsetHeight || 56;
    let placed = false;
    try {
        const ps = JSON.parse(localStorage.getItem(PILL_POS_KEY) || 'null');
        if (ps && ps.x != null && ps.y != null) {
            const px = parseFloat(ps.x), py = parseFloat(ps.y);
            const st = safeTop();
            const ok = !isNaN(px) && !isNaN(py) &&
                px >= -2 && px <= window.innerWidth - 30 &&
                py >= st - 2 && py <= window.innerHeight - 30;
            if (ok) {
                R.miniPill.style.left = clamp(px, 0, Math.max(0, window.innerWidth - w)) + 'px';
                R.miniPill.style.top = clamp(py, st, Math.max(st, window.innerHeight - h)) + 'px';
                R.miniPill.style.right = 'auto';
                R.miniPill.style.bottom = 'auto';
                placed = true;
            } else {
                try { localStorage.removeItem(PILL_POS_KEY); } catch (e) {}
            }
        }
    } catch (e) {}
    if (placed) return;
    R.miniPill.style.left = '';
    R.miniPill.style.top = '';
    R.miniPill.style.right = '14px';
    R.miniPill.style.bottom = '84px';
}
/** 点胶囊 = 展开回完整通话窗（用户 2026-10-18：「点击这个还要有展开通话窗」） */
function restore() {
    S.minimized = false;
    R.miniPill.classList.remove('visible');
    R.win.classList.add('visible');
    keepInViewport();
}

/* ---------------- 计时 ---------------- */
/** @param startAt 传入时从该时刻起算（崩溃恢复用，保留原来的通话时长） */
function startTimer(startAt) {
    S.startTime = startAt || Date.now();
    const base = S.startTime;
    if (tickRaf) cancelAnimationFrame(tickRaf);
    const tick = () => {
        S.elapsed = Date.now() - base;
        const txt = fmt(S.elapsed);
        if (R.timer) R.timer.textContent = txt;
        if (R.miniTimer) R.miniTimer.textContent = txt;
        tickRaf = requestAnimationFrame(tick);
    };
    tick();
}
function stopTimer() {
    if (tickRaf) { cancelAnimationFrame(tickRaf); tickRaf = null; }
    clearTimeout(connTimer); connTimer = null;
    clearTimeout(incTimer); incTimer = null;
    clearTimeout(partnerHangupTimer); partnerHangupTimer = null;
    stopHeartbeat();          // ★ v36：停心跳 + 清崩溃恢复快照
    clearCallSession();
}

/* ---------------- 关闭所有浮层（不碰头像） ---------------- */
function closeAll() {
    R.overlay.classList.remove('visible');
    R.win.classList.remove('visible', 'immersive', 'full', 'hide-avatar');
    R.miniPill.classList.remove('visible');
    R.presets.classList.remove('open');
    R.hideAv.classList.remove('active');
    R.hideAv.innerHTML = icon('eyeOff', 12);
    R.immersive.classList.remove('active');
    R.immersive.innerHTML = icon('eye', 13);
    R.connState.style.display = '';
    R.bodyState.style.display = 'none';
    R.timer.textContent = '00:00';
    R.miniTimer.textContent = '00:00';
    S.immersive = false; S.minimized = false; S.hideAvatar = false;
}

/* ---------- ★ v41 通话配置（照 mochi callCfg） ----------
   以前所有概率都硬编码在代码里，用户没法调。mochi 把它们全放进
   「回复/通话设置」页（call-incoming / call-pickup / call-busy /
   call-reject / call-hangup / call-no-hangup / call-resume / call-mini-enabled）。
   这里照做：从 Settings 读，带默认值，读不到就回落到原来的硬编码值。 */
function callCfg() {
    const g = Settings.g();
    const num = (k, d) => {
        const v = Number(g[k]);
        return isFinite(v) ? Math.max(0, Math.min(100, v)) : d;
    };
    const on = (k) => g[k] !== 0;               // 总开关语义：0 = 关，其它（含未设置）= 开
    return {
        incomingOn: on('callIncomingOn'),       // 对方来电总开关
        pickupOn:   on('callPickupOn'),         // 我打过去总开关
        incoming: num('callIncoming', 25),      // 来电触发概率 %
        pickup:   num('callPickup', 60),       // 去电接通概率 %
        busy:     num('callBusy', 10),         // 忙线 %
        reject:   num('callReject', 25),       // 拒绝 %
        hangup:   num('callHangProb', 3),      // 通话中被对方挂断 %
        nohangup: g.callNoHangup === 1,        // 总开关：开启后对方永不主动挂断
        resume:   g.callResume === 0 ? 0 : 1,  // 崩溃恢复
        mini:     g.callMini !== 0              // 显示最小化胶囊
    };
}

/* ---------------- 通话流程 ---------------- */
/** ★ 我打过去：先把通话窗显示出来「正在连接」，再掷骰子判定 */
function startOutgoing() {
    if (S.active) return;
    fill(); applyBg(); positionWindow();
    S.active = true; S.isPartnerCall = false;
    S.startTime = 0; S.elapsed = 0; S.minimized = false;
    R.win.classList.remove('immersive', 'hide-avatar');
    R.win.classList.add('visible');
    R.connState.style.display = '';
    R.bodyState.style.display = 'none';
    R.connSub.innerHTML = icon('video', 11) + ' 正在连接…';
    R.timer.textContent = '正在连接';

    const nm = partnerName();
    // ★ v41：判定拆成三档，全部走设置（照 mochi call-busy/call-reject/call-pickup）。
    //   以前只有一个写死的 35% 拒接，用户没法调，而且「忙线」和「拒接」混在一起。
    //   注意判定仍然发生在**通话窗已经显示之后**（用户 2026-10-17 明确要求：
    //   「我打过去，然后判定」）。
    const cfg0 = callCfg();
    const roll = Math.random() * 100;
    // 总开关关掉「我打过去」时，一律直接接通（不做忙线/拒接判定）
    if (!cfg0.pickupOn) {
        connTimer = setTimeout(() => {
            if (!S.active) return;
            R.connState.style.display = 'none';
            R.bodyState.style.display = '';
            startTimer();
            startHeartbeat();
            rollPartnerHangup();
        }, 1400 + Math.random() * 1200);
        return;
    }
    if (roll < cfg0.busy + cfg0.reject) {
        const isBusy = roll < cfg0.busy;
        const rejectDelay = 1500 + Math.random() * 1500;
        connTimer = setTimeout(() => {
            if (!S.active) return;
            const lbl = isBusy
                ? pick([nm + ' 正在忙，无法接听', nm + ' 占线中', nm + ' 通话中被占用'])
                : pick([nm + ' 未接听', nm + ' 拒绝了通话', nm + ' 暂时无法接听']);
            closeAll();
            S.active = false;
            stopTimer();
            sendCallEvent(lbl, null);          // ★ 记录写进聊天
            toast(lbl, 'warn', 2600);
        }, rejectDelay);
        return;
    }
    // 其余 = 接通
    connTimer = setTimeout(() => {
        if (!S.active) return;
        R.connState.style.display = 'none';
        R.bodyState.style.display = '';
        startTimer();
        startHeartbeat();                       // ★ v36 崩溃恢复心跳
        rollPartnerHangup();                    // ★ 通话中也可能对方主动挂
    }, 1400 + Math.random() * 1200);
}

/** 对方来电 */
function showIncoming() {
    if (S.active) return;
    fill(); applyBg();
    R.overlay.classList.add('visible');
    S.active = true; S.isPartnerCall = true;
    notifyIncoming(c.name);                     // ★ v36 系统级来电通知
    // 30% 自动未接（4~10 秒）
    if (Math.random() < 0.30) {
        incTimer = setTimeout(() => {
            if (!R.overlay.classList.contains('visible')) return;
            R.overlay.classList.remove('visible');
            S.active = false;
            const nm = partnerName();
            const lbl = pick([
                nm + ' 的来电，' + myName() + '未接听',
                myName() + '拒绝了 ' + nm + ' 的通话',
                '错过了 ' + nm + ' 的来电',
                myName() + '暂时无法接听 ' + nm + ' 的通话'
            ]);
            sendCallEvent(lbl, null);            // ★ 记录写进聊天
            toast(lbl, 'warn', 2600);
        }, 4000 + Math.random() * 6000);
    }
}

/** 接听 */
function acceptCall() {
    clearTimeout(incTimer); incTimer = null;
    R.overlay.classList.remove('visible');
    fill(); applyBg(); positionWindow();
    S.active = true; S.isPartnerCall = true;
    S.minimized = false; S.elapsed = 0;
    R.win.classList.remove('immersive', 'hide-avatar');
    R.win.classList.add('visible');
    R.connState.style.display = '';
    R.bodyState.style.display = 'none';
    R.connSub.innerHTML = icon('video', 11) + ' 正在连接…';
    R.timer.textContent = '正在连接';
    connTimer = setTimeout(() => {
        if (!S.active) return;
        R.connState.style.display = 'none';
        R.bodyState.style.display = '';
        startTimer();
        startHeartbeat();                       // ★ v36 崩溃恢复心跳
        rollPartnerHangup();
    }, 1400 + Math.random() * 1200);
}

/** 我拒绝来电 */
function rejectIncoming() {
    clearTimeout(incTimer); incTimer = null;
    R.overlay.classList.remove('visible');
    S.active = false;
    sendCallEvent(myName() + '拒绝了 ' + partnerName() + ' 的通话', null);
}

/** ★ 通话中对方主动挂断（3%，10~120 秒后） */
function rollPartnerHangup() {
    clearTimeout(partnerHangupTimer);
    const cfg = callCfg();
    // ★ v41：照 mochi bug #200 —— 「禁止对方挂断」总开关开启，或挂断率=0 时，
    //   必须硬拦一道。否则用户明明关了还会被挂断（设置读取异常回落默认值也会）。
    if (cfg.nohangup || cfg.hangup <= 0) return;
    if (Math.random() * 100 >= cfg.hangup) return;
    partnerHangupTimer = setTimeout(() => {
        if (!S.active) return;
        const dur = S.elapsed;
        closeAll();
        S.active = false;
        stopTimer();
        sendCallEvent('对方有事忙，主动结束了通话', fmt(dur));   // ★ 记录写进聊天
        toast(partnerName() + ' 主动挂断了通话', 'info', 2800);
    }, 10000 + Math.random() * 110000);
}

/** 我挂断 */
function endCall() {
    if (!S.active) return;
    const dur = S.elapsed;
    closeAll();
    S.active = false;
    stopTimer();
    if (dur > 0) sendCallEvent('视频通话已结束', fmt(dur));    // ★ 记录写进聊天
}

/* 恢复上次的位置/大小
   ★ v37：改尺寸后必须把窗口**拉回可视区**。以前迷你(160x240)时若上次的
   left/top 是按大窗算的，缩小后窗口大半跑到屏幕外 -> 只剩一条边/一个角，
   顶栏（拖动区）够不着，就「无法移动悬浮窗」（用户 v37 反馈）。 */
function positionWindow() {
    try {
        const sz = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
        if (sz && sz.w) setSize(sz.w, sz.h);
        const ps = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
        if (ps && ps.x) {
            R.win.style.left = ps.x;
            R.win.style.top = ps.y;
            R.win.style.right = 'auto';
            R.win.style.bottom = 'auto';
        }
    } catch (e) {}
    keepInViewport();
}

/** 把浮窗拉回可视范围内（保证顶栏还能被拖） */
function keepInViewport() {
    if (!R.win) return;
    const w = R.win.offsetWidth || 280, h = R.win.offsetHeight || 440;
    const st = safeTop();
    const maxL = Math.max(0, window.innerWidth - w);
    const maxT = Math.max(st, window.innerHeight - h);
    let l = parseFloat(R.win.style.left);
    let t = parseFloat(R.win.style.top);
    if (isNaN(l)) l = maxL;
    if (isNaN(t)) t = Math.max(st, window.innerHeight - h - 90);
    R.win.style.left = clamp(l, 0, maxL) + 'px';
    R.win.style.top = clamp(t, st, maxT) + 'px';
    R.win.style.right = 'auto';
    R.win.style.bottom = 'auto';
}

/* ---------------- 随机来电（15~60 分钟） ---------------- */
function scheduleRandom(waitMin) {
    if (randTimer) clearTimeout(randTimer);
    if (waitMin) S.randWait = waitMin * 60000;
    randTimer = setTimeout(() => {
        if (!S.active && Session.current() && !document.hidden) {
            // ★ v41：概率与间隔都走设置（以前 25% / 15~60min 全是硬编码）
            const cfg = callCfg();
            const lo = Number(Settings.g().callEveryMin) || 15;
            const hi = Number(Settings.g().callEveryMax) || 60;
            if (cfg.incomingOn && Math.random() * 100 < cfg.incoming) showIncoming();
            scheduleRandom(Math.max(1, lo + Math.random() * Math.max(1, hi - lo)));
        } else {
            scheduleRandom();
        }
    }, S.randWait || ((15 + Math.random() * 45) * 60000));
}

export const Call = {
    init() {
        build(); loadBg(); scheduleRandom();
        // ★ v41：崩溃恢复可关（照 mochi call-resume）
        if (callCfg().resume) setTimeout(checkRecover, 1200);
    },
    startOutgoing,
    showIncoming,
    endCall,
    _test: {
        acceptCall, rejectIncoming, rollPartnerHangup, sendCallEvent,
        restore, minimize,
        // 模拟一次真实指针拖动（供无头测试驱动）
        drag(target, dx, dy) {
            const el = typeof target === 'string' ? document.querySelector(target) : target;
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const x = r.left + r.width / 2, y = r.top + Math.min(14, r.height / 2);
            const opt = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y };
            el.dispatchEvent(new PointerEvent('pointerdown', opt));
            const steps = 6;
            for (let i = 1; i <= steps; i++) {
                const m = Object.assign({}, opt, { clientX: x + dx * i / steps, clientY: y + dy * i / steps });
                el.dispatchEvent(new PointerEvent('pointermove', m));
            }
            const up = Object.assign({}, opt, { clientX: x + dx, clientY: y + dy });
            el.dispatchEvent(new PointerEvent('pointerup', up));
            return true;
        }
    }
};