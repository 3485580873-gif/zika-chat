/* ============================================================
   chat.js — 聊天页（iMessage 结构）
   ------------------------------------------------------------
   顶栏：返回 · 头像+名字 · 三点（打开聊天设置页）
   底部：语音 · 输入框 · 表情 · 收纳 · 发送（同位切换）

   要点：
     · 消息按会话隔离（Store scope:'session'）
     · 头像一律走 Avatars 唯一数据源
     · TA 说的话一律走字卡库（Replier），抽不到就不说话
     · 表情包 / 颜文字 / emoji / 拍一拍 一律走 Media 素材库
     · 样式（背景/字体/气泡/时间戳）一律走 Settings

   消息能力：
     · 长按 / 右键消息 → 菜单（引用 · 复制 · 收藏 · 撤回 · 删除）
     · 撤回：气泡变成「XX 撤回了一条消息」，原文保留但不显示
     · 引用回复：引用条挂在输入框上方，发送后气泡里带原消息摘要
     · 已读回执：文字（已读/未读）或图形（✓ / ✓✓）
   ============================================================ */

import { Store } from '../core/store.js';
import { Session } from '../core/session.js';
import { Avatars } from '../core/avatars.js';
import { Cards } from '../core/cards.js';
import { Media, KINDS, ME_SID } from '../core/media.js';
import { Settings } from '../core/settings.js';
import { Replier } from '../core/replier.js';
import { KeepAlive } from '../core/bg.js';
import { Sound } from '../core/sound.js';
import { bus, EV } from '../core/bus.js';
import { esc, delegate, pickImageFrom, pickImages, shrinkImage } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { Page } from '../ui/page.js';
import { sheet } from '../ui/sheet.js';
import { icon, iconFilled } from '../ui/icon.js';

const MSG_KEY = 'messages';
const FAV_KEY = 'favorites';              // global：收藏的消息
const DIVIDER_GAP = 5 * 60 * 1000;
const RENDER_WINDOW = 400;                 // 聊天记录懒渲染：首屏只渲染最近 N 条，往上翻再增量加载
                                           // （400 = 正常聊天量一次全渲染，「查看更早」按钮基本不再出现；
                                           //   上千条时兜底保护仍在，防止打开聊天闪退）
const LONG_PRESS_MS = 480;                // 长按多久弹菜单
const MOVE_CANCEL = 8;                    // 手指移动超过这个距离就不算长按

/* 收纳键里的工具
   注意：「拼字卡」已移除——那是对方（TA）回复时才用的功能，
   聊天页是我在用，工具栏里不该有对方的功能（用户 2026-10-17 明确要求）。
   拼字卡逻辑本身保留在 spliceCards()，由 taSpeak() 调用。 */
const TOOLS = [
    { id: 'video',    name: '视频通话', ico: 'video' },
    { id: 'image',    name: '发图片',   ico: 'image' },
    { id: 'sticker',  name: '表情包',   ico: 'smile' },
    { id: 'interact', name: '互动',     ico: 'sparkle' },
    { id: 'continue', name: '继续说',   ico: 'card' },
    { id: 'tarot',    name: '塔罗',     ico: 'star' },
    { id: 'transfer', name: '转账',     ico: 'yen' },
    { id: 'avatars',  name: '头像库',   ico: 'avatars' },
    { id: 'survey',   name: '问卷',     ico: 'listCheck' }
];

/* 互动三栏目（emoji 已按用户要求改名，可就地添加） */
const INTERACT = ['poke', 'kaomoji', 'emoji'];

/* ---------------- 收藏 ---------------- */
function loadFav() {
    const raw = Store.get(FAV_KEY, [], { scope: 'global' });
    return Array.isArray(raw) ? raw : [];
}
function saveFav(list) { Store.set(FAV_KEY, list, { scope: 'global' }); }

/* ---------------- 数据 ---------------- */
function normalize(m) {
    if (!m || typeof m !== 'object') return null;
    const type = (m.type === 'image') ? 'image' : (m.type === 'system' ? 'system' : 'text');
    if (!m.retracted && type === 'text' && !String(m.text || '').trim()) return null;
    if (!m.retracted && type === 'image' && !m.src) return null;
    if (!m.retracted && type === 'system' && !String(m.text || '').trim()) return null;
    return {
        id: m.id || ('m_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        role: m.role === 'me' ? 'me' : 'ta',
        type,
        text: String(m.text || ''),
        src: m.src || '',
        stk: m.stk ? 1 : 0,
        ts: m.ts || Date.now(),
        uid: m.uid || null,
        retracted: m.retracted ? 1 : 0,
        orig: m.orig || '',
        revealed: m.revealed ? 1 : 0,   // 撤回后是否已展开过原文
        quote: m.quote || null,      // { who, text }
        status: m.status || 'sent'   // sent | read
    };
}
function loadMessages() {
    const raw = Store.get(MSG_KEY, [], { scope: 'session' });
    const arr = Array.isArray(raw) ? raw : [];
    return arr.map(normalize).filter(Boolean);
}
function saveMessages(list) {
    return Store.set(MSG_KEY, list, { scope: 'session' });
}

/* ---------------- 页面 ---------------- */
export function ChatPage(root, params) {
    let contact = Session.current();
    // ★ 兜底：当前会话指向「已删除 / 不存在」的联系人时（常见于建了又删、或在
    //   字卡库切过人），Session.current() 会是 null，聊天界面就会一直空白打不开。
    //   这里自动落到第一个可用联系人，保证「传讯」永远能进到一个真实会话。
    if (!contact) {
        const all = Session.all();
        if (all.length) { contact = all[0]; try { Session.activate(contact.id); } catch { /* noop */ } }
    }
    let messages = [];
    let shown = 0;                         // 懒渲染窗口：当前已渲染「最近 N 条」的大小
    let typing = false;
    let drawer = null;                 // 'tools' | 'sticker' | 'interact' | null
    let interactTab = 'poke';          // 互动栏目
    let stickerGroup = '__mine';       // 表情包分组：__mine 我的私货(心形) | 字卡库分组名
    let stickerManage = false;         // 表情包管理模式：开 → 每张右上角出❌，点❌即删
    // 注意：已移除 stickerSendAs（发送身份）。本页是「我」在用，
    // 表情包一律由我发出；对方的表情包由 taSpeak() 自己从字卡库随机挑。
    let quote = null;                  // 当前引用的消息 { who, text }
    const timers = { typing: null, reply: null, read: null, recall: null, recall2: null, extra: null };
    const ui = {};

    /* ---------- 构建 ---------- */
    function build() {
        root.innerHTML =
            // 图二式顶栏：悬浮玻璃圆钮，不再是通栏 bar
            '<header class="chat-top">' +
                '<button class="fl-btn" data-act="back" aria-label="返回">' + icon('chevronLeft', 22) + '</button>' +
                '<div class="chat-topmid">' +
                    '<span class="chat-topav" data-avtop2></span>' +
                    '<b class="chat-topnm" data-nm></b>' +
                    '<i class="chat-topmute" data-mute hidden></i>' +
                '</div>' +
                '<div class="chat-topright">' +
                    '<button class="fl-btn" data-act="chatset" aria-label="设置">' + icon('more', 20) + '</button>' +
                '</div>' +
            '</header>' +
            '<div class="chat-body" data-body>' +
                '<div class="chat-msgs" data-msgs></div>' +
            '</div>' +
            '<div class="quote-bar" data-quotebar hidden>' +
                '<i class="quote-line"></i>' +
                '<div class="quote-txt"><b data-qwho></b><span data-qtext></span></div>' +
                '<button class="quote-x" data-act="unquote" aria-label="取消引用">' + icon('close', 15) + '</button>' +
            '</div>' +
            // 图二式底栏：悬浮「＋ + 玻璃药丸输入条 + ↑」，不再是通栏
            '<footer class="composer" data-composer>' +
                '<button class="fl-btn" data-act="drawer" aria-label="工具">' + icon('plus', 22) + '</button>' +
                '<div class="cp-pillwrap">' +
                    '<button class="cp-side" data-act="voice" aria-label="语音" data-voice hidden>' + icon('mic', 20) + '</button>' +
                    '<textarea class="cp-input" data-input rows="1" placeholder="Message..."></textarea>' +
                    '<button class="cp-side" data-act="sticker" aria-label="表情包">' + icon('smile', 20) + '</button>' +
                    '<button class="cp-send" data-act="send" aria-label="发送">' + icon('chevronUp', 20) + '</button>' +
                '</div>' +
            '</footer>' +
            // ★ 工具面板独立图层：悬浮在聊天之上（带遮罩），不再和聊天挤在一层里互相顶
            '<div class="panel-mask" data-panelmask hidden></div>' +
            '<div class="chat-panel" data-panel hidden></div>';

        // ★ 消息菜单挂到 body，不放 root 里：
        //   它是 position:fixed，root 一旦带 transform 就会变成它的包含块，
        //   菜单跟着页面一起飘，而 openMenu() 用 getBoundingClientRect()（视口坐标）
        //   算 left/top → 两边坐标系不一致 → 菜单跑偏、按钮点不到。
        //   （v27 起 .page 已不用 transform 位移，这里继续保持挂 body，双保险。）
        const menuEl = document.createElement('div');
        menuEl.className = 'msg-menu';
        menuEl.setAttribute('data-menu', '');
        menuEl.hidden = true;
        document.body.appendChild(menuEl);

        ui.body = root.querySelector('[data-body]');
        ui.msgs = root.querySelector('[data-msgs]');
        ui.panel = root.querySelector('[data-panel]');
        ui.pmask = root.querySelector('[data-panelmask]');
        ui.input = root.querySelector('[data-input]');
        ui.nm = root.querySelector('[data-nm]');
        ui.sub = root.querySelector('[data-sub]');
        ui.avTop = root.querySelector('[data-avtop]');
        ui.avTop2 = root.querySelector('[data-avtop2]');
        ui.mute = root.querySelector('[data-mute]');
        ui.send = root.querySelector('[data-act="send"]');
        ui.stickerBtn = root.querySelector('[data-act="sticker"]');
        ui.drawerBtn = root.querySelector('[data-act="drawer"]');
        ui.voiceBtn = root.querySelector('[data-voice]');
        ui.quoteBar = root.querySelector('[data-quotebar]');
        ui.qWho = root.querySelector('[data-qwho]');
        ui.qText = root.querySelector('[data-qtext]');
        ui.menu = menuEl;
        ui.composer = root.querySelector('[data-composer]');
    }

    /* ---------- 输入法适配 ----------
       用户 2026-10-17：点输入框时输入法会盖住输入框、看不到自己打的字。
       主方案在 app.js + app.css：键盘高度算准后，**页面的底边抬到键盘顶部**
       （.page{bottom:var(--kb-shift)}）—— 不整页上抬，顶栏不会被顶出屏幕。
       这里是**兜底**：focus 后如果输入条底边仍低于「可视区底边」（说明还没顶到位），
       直接给 composer 加内联 margin-bottom 顶上去。测的是输入条相对视口的位置，
       root 自己不参与位移计算 → 不会自反馈振荡（踩过的坑）。 */
    function bindKeyboard() {
        if (!ui.input || !ui.composer) return;
        const lift = () => {
            root.classList.add('kb-focus');
            try { ui.input.scrollIntoView({ block: 'nearest' }); } catch { /* noop */ }
            // 等键盘动画基本稳定后再量（iOS 上 focus 时键盘还没弹完）
            setTimeout(() => {
                if (!root.classList.contains('kb-focus')) return;
                const kb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kb')) || 0;
                if (kb <= 0) { ui.composer.style.marginBottom = ''; return; }
                // 可视区底边 = 键盘顶部。用 visualViewport 的真底边算：
                //   · iOS：vv.height 缩到键盘上方，offsetTop=0 → 底边就是键盘顶
                //   · 安卓：布局视口本身就缩了，vv.height 就是键盘上方的视口高度
                //   （以前用 window.innerHeight - kb 算，安卓下会减两次，反而多顶一格）
                const vv = window.visualViewport;
                const visibleBottom = vv ? (vv.height + (vv.offsetTop || 0)) : window.innerHeight;
                const cpBox = ui.composer.getBoundingClientRect();
                const over = cpBox.bottom - visibleBottom;          // >0 = 还被压着
                const fix = Math.max(0, Math.min(kb, Math.round(over)));
                ui.composer.style.marginBottom = fix ? (fix + 'px') : '';
            }, 260);
        };
        const drop = () => {
            root.classList.remove('kb-focus');
            if (ui.composer) ui.composer.style.marginBottom = '';
        };
        ui.input.addEventListener('focus', lift);
        ui.input.addEventListener('blur', drop);
        ui.input.addEventListener('touchstart', lift, { passive: true });
        // 键盘高度变化时重算（分屏/旋转/切换键盘）
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', () => {
                if (root.classList.contains('kb-focus')) lift();
            });
        }
    }

    /* ---------- 样式（一律走 Settings） ---------- */
    function applyStyle() {
        Settings.apply();
        const s = Settings.s();
        const g = Settings.g();
        root.classList.toggle('has-bg', !!(s.bg || s.bgColor));
        // 语音图标显示开关
        if (ui.voiceBtn) ui.voiceBtn.hidden = !g.voiceInput;
        // 「显示聊天头像」关掉 → 整列收掉（见 css .no-chat-av）
        root.classList.toggle('no-chat-av', !g.avatarShow);
    }

    /* ---------- 顶栏（悬浮式） ---------- */
    function renderBar() {
        if (!contact) {
            ui.nm.textContent = '还没有联系人';
            if (ui.avTop) ui.avTop.style.backgroundImage = '';
            if (ui.avTop2) ui.avTop2.style.backgroundImage = '';
            if (ui.mute) ui.mute.hidden = true;
            return;
        }
        ui.nm.textContent = contact.name;
        // 顶栏小头像（用户 2026-10-17：顶部只要「头像+名字」，不要在线状态）
        try {
            const src = String(Avatars.get(contact.id, { withFallback: true }) || '').split("'").join('');
            const url = src ? 'url(\'' + src + '\')' : '';
            if (ui.avTop) ui.avTop.style.backgroundImage = url;
            if (ui.avTop2) ui.avTop2.style.backgroundImage = url;
        } catch { /* 头像读不到就留空底 */ }
        // 免打扰铃铛（唯一的附加标记）
        if (ui.mute) {
            const muted = !!Settings.s().muted;
            ui.mute.hidden = !muted;
            if (muted && !ui.mute.innerHTML) ui.mute.innerHTML = icon('bellOff', 12);
        }
    }

    /* ---------- 消息 ---------- */
    function readRow(m) {
        const g = Settings.g();
        if (!g.readReceipt) return '';
        const read = m.status === 'read';
        if (g.readReceiptStyle === 'text') {
            return '<div class="msg-read' + (read ? ' on' : '') + '">' + (read ? '已读' : '未读') + '</div>';
        }
        return '<div class="msg-read' + (read ? ' on' : '') + '">' +
            '<i class="tick' + (read ? ' dbl' : '') + '"></i></div>';
    }

    /** 我的昵称（全局一份，聊天设置里改） */
    function myName() { return Store.get('meName', '我', { scope: 'global' }) || '我'; }

    /**
     * 气泡类名：除 .bubble 外同时挂 evanlu 体系的 message-sent / message-received，
     * 用户从 evanlu 抄来的气泡 CSS（.message-sent{...}）贴进来直接生效。
     * 注意：撤回条（gone）和 typing 圆点不能挂 —— 用户 CSS 里 .message-received{background:...}
     * 会误中它们，给灰字条加上白底阴影。
     */
    function bubCls(role) { return role === 'me' ? 'message-sent' : 'message-received'; }

    function msgInner(m) {
        if (m.retracted) {
            // ★ 用户 2026-10-17 重做撤回：
            //   · 气泡里就一句「XX撤回了一条消息」，**不要再挂「查看」标签**（用户原话）
            //   · 点这个气泡 → 气泡内显示被撤回的内容（图片/表情包显示**原图本身**，
            //     不是"[图片]"三个字；用户原话「点开是什么就是什么」）
            //   · 再点一下 → 收回。整个过程都在同一个气泡里，不新开一层。
            const who = m.role === 'me' ? myName() : (contact ? contact.name : '对方');
            if (m.revealed) {
                let body;
                if (m.type === 'image' && m.orig) {
                    // 图片/表情包：直接把原图渲染出来
                    body = '<span class="msg-text gone-text">' + esc(who) + '撤回了一条图片</span>' +
                        '<span class="gone-pic' + (m.stk ? ' stk' : '') + '">' +
                            '<img src="' + esc(m.orig) + '" alt="撤回的图片" loading="lazy" decoding="async"></span>' +
                        '<i class="gone-tag">点此收回</i>';
                } else if (m.orig) {
                    body = '<span class="msg-text gone-text">' + esc(m.orig) + '</span>' +
                        '<i class="gone-tag">点此收回</i>';
                } else {
                    body = '<span class="msg-text gone-text">这条消息没有文字内容</span>' +
                        '<i class="gone-tag">点此收回</i>';
                }
                return '<div class="bubble gone open" data-act="toggleRecall">' + body + '</div>';
            }
            return '<div class="bubble gone" data-act="toggleRecall">' +
                    '<span>' + esc(who) + '撤回了一条消息</span>' +
                '</div>';
        }
        // ★ 引用在上、消息气泡在下（用户 2026-10-17 拍板，参考图三）
        //   原来引用是塞在气泡里面当小字，看不出来是引用。
        if (m.quote) {
            return '<div class="msg-quote-out" data-act="quotejump">' +
                    '<b>' + esc(m.quote.who || '') + '</b>' +
                    '<span>' + esc(m.quote.text || '') + '</span>' +
                '</div>' +
                '<div class="bubble ' + bubCls(m.role) + '">' +
                    '<span class="msg-text">' + esc(m.text).split('\n').join('<br>') + '</span></div>';
        }
        if (m.type === 'image') {
            // 表情包/图片不套气泡（用户拍板）：直接一张圆角图
            return '<div class="msg-img' + (m.stk ? ' stk' : '') + '">' +
                '<img src="' + esc(m.src) + '" alt="图片" loading="lazy" decoding="async"></div>';
        }
        return '<div class="bubble ' + bubCls(m.role) + '">' +
            '<span class="msg-text">' + esc(m.text).split('\n').join('<br>') + '</span></div>';
    }

    function msgHtml(m, prev) {
        const mine = m.role === 'me';
        // 系统提示（拍一拍）：微信式居中灰字，没有头像没有气泡
        if (m.type === 'system') {
            return '<div class="msg sys" data-mid="' + esc(m.id) + '">' +
                '<span class="msg-sys">' + esc(m.text) + '</span></div>';
        }
        const g = Settings.g();
        /* ---- 头像显示三态（用户 2026-10-17 拍板，聊天设置 → 头像与头像框） ----
           ① 显示聊天头像（avatarShow）：关 → 整条不渲染头像位
           ② 每条消息都显示头像（avatarEvery）：开 → 每条都有；关 → 只有连续同一人的第一条有
           ③ 单人模式显示对方名字（showTaName）：开 → 对方气泡上方加名字（群聊本来就显示） */
        const showAv = !!g.avatarShow && (!!g.avatarEvery || !prev || prev.role !== m.role || prev.type === 'system');
        const av = mine
            ? Avatars.html('me')
            : Avatars.html(m.uid || (contact ? contact.id : ''));
        const stamp = g.stampShow ? Settings.miniStamp(m.ts) : '';
        const nameRow = (!mine && contact && (contact.kind === 'group' || g.showTaName))
            ? '<div class="msg-who">' + esc((m.uid && (Session.get(m.uid) || {}).name) || (contact ? contact.name : '对方')) + '</div>'
            : '';

        return '<div class="msg ' + (mine ? 'me' : 'ta') + '" data-mid="' + esc(m.id) + '">' +
            (showAv
                ? '<div class="msg-side">' + av + (stamp ? '<span class="msg-time">' + esc(stamp) + '</span>' : '') + '</div>'
                : '<div class="msg-side blank"></div>') +
            '<div class="msg-main">' + nameRow + msgInner(m) +
                (mine ? readRow(m) : '') +
            '</div>' +
            '</div>';
    }

    function typingHtml() {
        const g = Settings.g();
        const av = g.avatarShow ? Avatars.html(contact ? contact.id : '') : '';
        return '<div class="msg ta typing">' +
            (av ? '<div class="msg-side">' + av + '</div>' : '<div class="msg-side blank"></div>') +
            '<div class="msg-main"><div class="bubble dots"><i></i><i></i><i></i></div></div></div>';
    }

    function render(opts) {
        if (!ui.msgs) return;
        // ★ 全站兜底：渲染里任何一处出错都不能让页面变白屏 ——
        //   手机 Safari 上一个异常会连带整棵页面挂掉，用户看到就是「崩溃」。
        try {
            renderInner(opts);
        } catch (err) {
            console.error('[chat] render 出错', err);
            try {
                ui.msgs.innerHTML = '<div class="chat-empty"><p>界面出了点问题</p>' +
                    '<span>清一下缓存再试：关掉页面重新打开</span></div>';
            } catch { /* 连兜底都失败就算了 */ }
        }
    }

    function renderInner(opts) {
        opts = opts || {};
        renderBar();
        applyStyle();

        if (!contact) {
            ui.msgs.innerHTML =
                '<div class="chat-empty">' + icon('users', 34) +
                '<p>还没有联系人</p><span>点上方返回，先添加一个联系人</span></div>';
            syncComposer();
            return;
        }

        // ★ 懒渲染：只把「最近 shown 条」一次性拼进 DOM。
        //   历史几千条也不会卡主线程 / 爆内存 —— 这是修「打开聊天就闪退」的关键。
        const total = messages.length;
        const start = Math.max(0, total - shown);
        const slice = messages.slice(start);

        const dividerMode = Settings.g().stampShow && Settings.g().stampStyle === 'divider';
        let html = '<div class="chat-intro">我们的对话</div>';
        if (start > 0) {
            html += '<button class="chat-loadmore" data-act="loadEarlier" type="button">↑ 查看更早的消息（' + start + '）</button>';
        }
        let prev = start > 0 ? messages[start - 1] : null;
        slice.forEach((m) => {
            if (dividerMode && (!prev || (m.ts - prev.ts) > DIVIDER_GAP)) {
                const t = Settings.stampText(m.ts);
                if (t) html += '<div class="msg-time-divider"><span>' + esc(t) + '</span></div>';
            }
            html += msgHtml(m, prev);
            prev = m;
        });

        if (!total) {
            html = '<div class="chat-empty">' + icon('card', 32) +
                '<p>还没有消息</p><span>说一句，或者点右侧工具让 TA 开口</span></div>';
        }

        // 跨 innerHTML 替换时记录旧高度，便于「查看更早」后停在原来位置
        const prevH = ui.body ? ui.body.scrollHeight : 0;
        const prevTop = ui.body ? ui.body.scrollTop : 0;
        ui.msgs.innerHTML = html;
        if (typing) ui.msgs.insertAdjacentHTML('beforeend', typingHtml());

        if (opts.toBottom) scrollBottom();
        else if (opts.keepScroll && ui.body) ui.body.scrollTop = prevTop + (ui.body.scrollHeight - prevH);
        else if (ui.body) ui.body.scrollTop = 0;

        syncComposer();
    }

    function scrollBottom(smooth) {
        if (!ui.body) return;
        try {
            ui.body.scrollTo({ top: ui.body.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
        } catch {
            ui.body.scrollTop = ui.body.scrollHeight;
        }
    }

    /** 懒渲染：把已渲染窗口向上扩一截（点「查看更早」时） */
    function loadEarlier() {
        shown = Math.min(messages.length, shown + RENDER_WINDOW);
        render({ keepScroll: true });
    }

    function push(msg) {
        const m = normalize(msg);
        if (!m) return null;
        messages.push(m);
        queueSave();
        // ★ 角色回复提示音（用户 2026-10-17 新增；默认关，且要用户自己上传音频）
        if (m.role === 'ta' && Settings.g().soundMsg) { try { Sound.playMsg(); } catch { /* noop */ } }
        // ★ 增量追加：能在末尾直接挂一条时，绝不重建整段 innerHTML。
        //   全量重建会让所有气泡重排 + 滚动位置跳一下 → 用户看到的「发送时屏幕闪一下」。
        // ★ 对方发消息一律滚到底部（用户 2026-10-17 要求）：新消息必须看得见。
        //   我方消息、以及「查看更早」加载时才保持用户当前滚动位置。
        const forceBottom = m.role === 'ta';
        if (appendIfPossible(m, forceBottom)) {
            bus.emit(EV.MESSAGE_ADDED, { contactId: contact ? contact.id : null, message: m });
            return m;
        }
        const atBottom = forceBottom ||
            (ui.body ? (ui.body.scrollHeight - ui.body.scrollTop - ui.body.clientHeight < 80) : true);
        render({ toBottom: atBottom, keepScroll: !atBottom });
        bus.emit(EV.MESSAGE_ADDED, { contactId: contact ? contact.id : null, message: m });
        return m;
    }

    /**
     * 尝试「只追加一个新节点」而不重建整个消息区。
     * 条件：已渲染到最新一条（没有「查看更早」缺口）、没有正在输入气泡占位、到底部。
     * 返回 true = 已经处理完，调用方不用再 render。
     */
    function appendIfPossible(m, forceBottom) {
        if (!ui.msgs || !ui.body) return false;
        if (typing) return false;                       // 正在输入气泡在末尾，先走全量重渲染
        if (messages.length > shown) return false;      // 有更早的没渲染，末尾不是最后一条
        const atBottom = forceBottom ||
            ((ui.body.scrollHeight - ui.body.scrollTop - ui.body.clientHeight) < 120);
        if (!atBottom) return false;                    // 用户往上翻着，别动他的位置
        // 空会话态/空态提示要先摘掉
        const empty = ui.msgs.querySelector('.chat-empty');
        if (empty) return false;
        ui.msgs.insertAdjacentHTML('beforeend', msgHtml(m, messages[messages.length - 2]));
        scrollBottom(true);
        return true;
    }

    /** 改一条消息并落盘 + 重渲染 */
    function patch(id, fn) {
        const i = messages.findIndex((x) => x.id === id);
        if (i < 0) return;
        fn(messages[i]);
        flushSave();
        render({ keepScroll: true });
    }

    /* ---------- 已读 ---------- */
    function markRead(delay) {
        clearTimeout(timers.read);
        // 对方「看到」了我的最后一条消息。
        // 回调里重新从存储读一遍：这个定时器可能跨过「切会话 / 退出聊天」才触发，
        // 直接改内存里的旧数组会把另一个人的记录整段写回去。
        timers.read = setTimeout(() => {
            const list = loadMessages();
            let hit = false;
            for (let i = list.length - 1; i >= 0; i--) {
                if (list[i].role !== 'me') break;
                if (list[i].status === 'read') continue;
                list[i].status = 'read';
                hit = true;
            }
            if (!hit) return;
            messages = list;
            saveMessages(messages);
            render({ keepScroll: true });
        }, delay || (500 + Math.random() * 900));
    }

    /* ---------- TA 说话 ---------- */
    /** 只清「回复」相关：准备说下一句时用，已读标记不该被带掉 */
    function clearTimers() {
        clearTimeout(timers.typing);
        clearTimeout(timers.reply);
        if (timers.extra) { timers.extra.forEach(clearTimeout); timers.extra = null; }
    }

    /** 全清：离开页面 / 切换会话时用。
        之前漏了 timers.read —— 退出聊天后那个延迟回调还拿着旧的消息数组，
        一触发就把当前会话的数据整体覆盖回去（实测真的会）。 */
    function clearAllTimers() {
        clearTimers();
        clearTimeout(timers.read);
        clearTimeout(timers.recall);
        clearTimeout(timers.recall2);
        // ★ 离开页面必须把攒着的数据落盘，否则去抖窗口内的消息会丢
        flushSave();
    }

    /* ★ 写盘去抖：每发一条都同步序列化整个消息数组写 localStorage，
       几百条时一次 JSON.stringify 就要几十毫秒，主线程被卡住 → 「发送时卡一下」。
       改成攒 400ms 再写一次；离开页面（clearAllTimers）时 flush 兜底。 */
    let saveTimer = null;
    let saveFailed = false;
    function queueSave() {
        if (saveTimer) return;
        saveTimer = setTimeout(() => { saveTimer = null; flushSave(); }, 400);
    }
    function flushSave() {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        const ok = saveMessages(messages);
        if (!ok && !saveFailed) {
            saveFailed = true;
            toast('存储空间不足，最新消息可能没存上。去设置里清些旧图片/表情包', 'warn', 3200);
        } else if (ok) {
            saveFailed = false;
        }
        return ok;
    }

    function showTyping(on) {
        if (typing === on) return;
        typing = on;
        if (!ui.msgs) return;
        const old = ui.msgs.querySelector('.typing');
        if (old) old.remove();
        if (on) {
            // 增量追加，不重建整段（重建会闪）
            const empty = ui.msgs.querySelector('.chat-empty');
            if (empty) { render(); return; }
            ui.msgs.insertAdjacentHTML('beforeend', typingHtml());
            scrollBottom(true);
        }
    }

    /**
     * 拼字卡：随机抽 1~N 条拼成一句。
    /**
     * 拼字卡（我用的功能，工具栏「拼字卡」按钮触发）：
     * 池子 = 主字卡（当前会话可用，专用优先分层）+ 颜文字 + emoji，
     * 主字卡占大头，颜文字/emoji 有概率混进来。拼完整句由我发出。
     * 注意：这些互动内容只归我使用，绝不进对方的回复池。
     */
    function spliceCards(contactId) {
        const g = Settings.g();
        const min = Math.max(1, g.pinyinCardMin || 1);
        const max = Math.max(min, Math.min(3, g.pinyinCardMax || 3));   // 最多 3 张
        const n = min + Math.floor(Math.random() * (max - min + 1));

        const pool = [];
        // 主字卡（可用的，含启用分组过滤）
        Cards.usable(contactId).forEach((k) => pool.push({ w: 10, text: k.text }));
        // 颜文字 / emoji（公用 + 当前联系人专属）
        ['kaomoji', 'emoji'].forEach((kind) => {
            Media.forChat(kind, contactId).forEach((it) => pool.push({ w: 3, text: it.text }));
        });
        if (!pool.length) return '';

        const bag = pool.slice();
        const out = [];
        for (let i = 0; i < n && bag.length; i++) {
            // 按权重抽（不放回：抽出来的从袋里删掉）
            let total = 0;
            bag.forEach((x) => { total += x.w; });
            let r = Math.random() * total;
            let idx = bag.length - 1;
            for (let j = 0; j < bag.length; j++) {
                r -= bag[j].w;
                if (r <= 0) { idx = j; break; }
            }
            out.push(bag.splice(idx, 1)[0]);
        }
        return out.map((x) => x.text).join(' ');
    }

    /** 按概率掷骰 */
    function roll(prob, def) {
        const p = Number(prob == null ? def : prob);
        if (!(p > 0)) return false;
        return Math.random() * 100 < p;
    }

    /**
     * TA 的一条内容：从字卡库抽（唯一内容来源）。
     * 抽不到就返回 null —— 没卡就沉默，绝不编。
     */
    function drawTaLine() {
        const g = Settings.g();
        // 拼字卡：抽 1~3 张拼成一条
        if (g.pinyinCard && roll(g.pinyinCardProb, 35)) {
            const merged = spliceCards(contact.id);
            if (merged) return merged;
        }
        if (!Replier.ready(contact.id)) return null;
        const got = Replier.pick(contact.id);
        return got ? got.text : null;
    }

    /** 从字卡库的某个素材桶抽一条（拍一拍/颜文字/emoji/表情包共用）。
     *  ★ 用户 2026-10-17 拍板：TA 发的所有内容只能从字卡库来，
     *    没有内容就发不了 —— 不许有任何硬编码兜底文案。
     *  桶里没有就返回 null，调用方据此跳过这一项。 */
    function drawTaMedia(kind) {
        const pool = Media.forChat(kind, contact.id);
        if (!pool.length) return null;
        const one = pool[Math.floor(Math.random() * pool.length)];
        return one ? (one.text || one.src || null) : null;
    }

    function taSpeak(forceText) {
        if (!contact) return;
        clearTimers();

        const s = Settings.s();
        const g = Settings.g();
        if (s.blocked) { toast('已拉黑：对方无法给你发消息', 'warn', 1800); return; }
        // 已读不回：联系人没单独设过（null）就跟随全局默认
        const noReplyOn = (s.noReply != null)
            ? (s.noReply === 1 || s.noReply === '1' || s.noReply === true)
            : (!!g.noReplyDefault);
        if (noReplyOn && roll(s.noReplyProb, 30)) return;   // 已读不回

        const spk = Replier.speaker(contact);
        const uid = spk ? spk.id : null;

        /* ① 拍一拍（系统提示，居中灰字，没有气泡）—— 只从字卡库「拍一拍」桶抽 */
        if (roll(g.pokeProb, 5)) {
            const poke = drawTaMedia('poke');
            if (poke) push({ role: 'ta', type: 'system', text: poke, ts: Date.now(), uid });
        }

        /* ② 表情包：只从字卡库的表情包分组抽，绝不碰 __mine（我的私货） */
        let stickerSrc = null;
        if (roll(g.taStickerProb, 10)) {
            const pool = Media.forChat('sticker', contact.id)
                .filter((it) => it.src && (it.group || '') !== '__mine');
            if (pool.length) stickerSrc = pool[Math.floor(Math.random() * pool.length)].src;
        }

        /* ③ 文字：拼字卡 / 字卡库抽一条 */
        let text = forceText || '';
        if (!text && !stickerSrc) {
            text = drawTaLine();
            if (!text) {
                if (!Replier.ready(contact.id)) toast('字卡库是空的，去字卡库添加内容', 'warn', 2400);
                return;
            }
        }

        /* ④ 附加花样：引用上一条我的消息 / emoji / 颜文字 */
        let quote = null;
        if (!forceText && roll(g.quoteProb, 30)) {
            const lastMine = [...messages].reverse().find((x) => x.role === 'me' && !x.retracted && x.type === 'text');
            if (lastMine) quote = { who: myName(), text: lastMine.text };
        }
        let tail = '';
        if (!forceText && roll(g.kaomojiProb, 5)) {
            const km = drawTaMedia('kaomoji');
            if (km) tail = km;
        }
        if (!forceText && !tail && roll(g.emojiProb, 5)) {
            const em = drawTaMedia('emoji');
            if (em) tail = em;
        }
        if (tail) text = text + ' ' + tail;

        const showType = !!g.typingShow;
        const react = Replier.reactionTime();
        const dur = stickerSrc ? 900 : Replier.typingTime(text);

        /* 回复条数：设置 → 数据设置 → 回复条数最少/最多 */
        let count = 1;
        if (!forceText && !stickerSrc && !quote) {
            const mn = Math.max(1, g.replyCountMin || 1);
            const mx = Math.max(mn, g.replyCountMax || 1);
            if (mx > 1) count = mn + Math.floor(Math.random() * (mx - mn + 1));
        }

        const emit = () => {
            if (stickerSrc) {
                return push({ role: 'ta', type: 'image', src: stickerSrc, stk: 1, ts: Date.now(), uid });
            }
            const first = push({ role: 'ta', type: 'text', text, ts: Date.now(), uid, quote: quote || undefined });
            // 第 2~N 条：间隔 400~1400ms 连着发，像真人连发
            let last = first;
            for (let i = 1; i < count; i++) {
                timers.extra = timers.extra || [];
                timers.extra.push(setTimeout(() => {
                    const more = drawTaLine();
                    if (!more) return;
                    last = push({ role: 'ta', type: 'text', text: more, ts: Date.now(), uid });
                }, 400 + Math.round(Math.random() * 1000)));
            }
            return first;
        };

        if (showType) {
            // 「正在输入」要早点冒出来（最迟 1.5 秒），不然用户根本等不到看到
            const tShow = Math.min(react, 1500);
            timers.typing = setTimeout(() => showTyping(true), tShow);
            timers.reply = setTimeout(() => {
                showTyping(false);
                const sent = emit();
                // ★ 对方也会撤回：按概率在自己刚发的消息冒出来后延时撤回，
                //   就像微信里 TA 突然「反悔」了一条。概率在 设置 → 数据设置 调。
                scheduleTaRecall(sent);
            }, react + dur);
        } else {
            timers.reply = setTimeout(() => scheduleTaRecall(emit()), react);
        }
    }

    /**
     * TA 撤回自己的上一条消息。
     * 概率 = taRecallProb（默认 6%）；2.5~10.5 秒后撤。
     * 撤回后按 recallResend 概率再发一条（微信里那种「撤回了一条消息」）。
     */
    function scheduleTaRecall(m) {
        if (!m || m.role !== 'ta') return;
        const g = Settings.g();
        if (!roll(g.taRecallProb, 6)) return;
        // 只在「这条是 TA 最新一条」时才撤，避免把更早的也翻了
        const lastTa = [...messages].reverse().find((x) => x.role === 'ta');
        if (!lastTa || lastTa.id !== m.id) return;
        const wait = 2500 + Math.round(Math.random() * 8000);
        clearTimeout(timers.recall);
        timers.recall = setTimeout(() => {
            timers.recall = null;
            if (!messages.some((x) => x.id === m.id && !x.retracted)) return;
            patch(m.id, (x) => {
                x.retracted = 1;
                x.revealed = 0;
                x.orig = x.type === 'image' ? x.src : x.text;
            });
            // 撤回后补发一条
            if (g.recallResend && roll(g.recallResendProb, 35)) {
                clearTimeout(timers.recall2);
                timers.recall2 = setTimeout(() => {
                    timers.recall2 = null;
                    const more = drawTaLine();
                    if (more) push({ role: 'ta', type: 'text', text: more, ts: Date.now(), uid: (Replier.speaker(contact) || {}).id || null });
                }, 1200 + Math.round(Math.random() * 1600));
            }
        }, wait);
    }

    /* ---------- 输入 ---------- */
    function send() {
        const text = (ui.input.value || '').trim();
        if (!text || !contact) return;
        closeDrawer();   // 发送时收起工具栏，避免面板压住聊天区（#98）
        ui.input.value = '';
        autosize();
        syncComposer();
        const q = quote;
        setQuote(null);
        push({ role: 'me', type: 'text', text, ts: Date.now(), quote: q });
        scrollBottom(true);
        markRead();
        taSpeak();
    }

    function setQuote(q) {
        quote = q || null;
        if (!ui.quoteBar) return;
        ui.quoteBar.hidden = !quote;
        if (quote) {
            ui.qWho.textContent = quote.who || '';
            ui.qText.textContent = quote.text || '';
        }
        syncComposer();
    }

    function autosize() {
        if (!ui.input) return;
        ui.input.style.height = 'auto';
        ui.input.style.height = Math.min(100, ui.input.scrollHeight) + 'px';
    }

    function syncComposer() {
        if (!ui.input || !ui.send) return;
        const has = !!(ui.input.value || '').trim() || !!quote;
        ui.send.classList.toggle('off', !has);
    }

    /* ---------- 抽屉 ---------- */
    function seg(items, active, attr, cls) {
        return '<div class="cs-seg' + (cls ? ' ' + cls : '') + '">' + items.map((it) =>
            '<button class="cs-segbtn' + (it.v === active ? ' on' : '') + '" data-' + attr + '="' + esc(it.v) + '">' +
            esc(it.name) + '</button>'
        ).join('') + '</div>';
    }

    /**
     * 表情包面板（微信式版式，用户 2026-10-17 定案）：
     *   顶部横排分组条：
     *     第一格 = 心形「我的表情」——我单方面上传的私货贴图，
     *              只属于我，不进字卡库，对方（TA）永远抽不到、也发不出这里的图。
     *     其后   = 字卡库「表情包」分类下的各个分组，横着排、多了横滑，
     *              点开就是该分组内的整套表情（微信里的整套表情包）。
     *   下方网格显示所选分组的表情：
     *     · 第一格永远是**虚线 ＋ 框**（图六）→ 点它就地选图上传进当前分组
     *     · 点表情 = 由「我」发出
     *     · 点「管理」→ 每张右上角浮出 ❌（图七），点 ❌ 立即删除
     *   末尾「+」直接就地选图上传进当前分组。
     */
    function stickerHtml() {
        const contactId = contact ? contact.id : null;
        const all = Media.forChat('sticker', contactId);
        // 心形「我上传的」永远在第一位；分组条显示全部声明的分组（空组也显示）
        const groups = [{ name: '__mine', enabled: true }].concat(
            Media.groups('sticker', contactId).filter((g) => g.name && g.name !== '__mine'));

        const cnt = (name) => all.filter((it) => (it.group || '') === name).length;
        const gname = (n) => (n === '__mine' ? '我的表情' : n);

        if (stickerGroup !== '__mine' && !groups.some((g) => g.name === stickerGroup)) {
            stickerGroup = '__mine';
        }

        const gbar = '<div class="cp-stkbar">' +
            groups.map((g) => {
                const first = all.find((x) => (x.group || '') === g.name && x.src);
                const isMine = g.name === '__mine';
                const inner = (isMine || !first)
                    ? icon(isMine ? 'heart' : 'smile', 20)
                    : '<img src="' + esc(first.src) + '" alt="">';
                return '<button class="cp-stkchip ico' + (stickerGroup === g.name ? ' on' : '') +
                    (g.enabled === false ? ' off' : '') + '" data-stkg="' + esc(g.name) + '" ' +
                    'title="' + esc(gname(g.name)) + '">' +
                    '<i>' + inner + '</i><span>' + esc(gname(g.name)) + '</span></button>';
            }).join('') +
            '<button class="cp-stkchip ico add" data-stkadd="1" title="上传表情包"><i>' + icon('plus', 18) + '</i><span>上传</span></button>' +
            '</div>';

        const show = all.filter((it) => (it.group || '') === stickerGroup);

        /* 网格第一格：虚线加号框（图六）—— 添加表情包的入口 */
        const addTile =
            '<button class="cp-stk add-tile" data-stkadd="1" title="添加表情包">' +
                '<i class="add-plus">' + icon('plus', 26) + '</i>' +
            '</button>';

        const tiles = show.map((it) =>
            '<button class="cp-stk' + (stickerManage ? ' mgr' : '') + '" data-stk="' + esc(it.id) + '">' +
                '<img src="' + esc(it.src) + '" alt="" loading="lazy">' +
                (stickerManage
                    ? '<i class="cp-stk-del" data-stkdel="' + esc(it.id) + '" title="删除">' + icon('close', 13) + '</i>'
                    : '') +
            '</button>').join('');

        const body = '<div class="cp-list sticker' + (stickerManage ? ' manage' : '') + '">' +
                addTile + tiles + '</div>';

        const emptyTip = show.length ? '' :
            '<p class="cp-stkempty">「' + esc(gname(stickerGroup)) + '」还没有表情包<br>' +
            '<span>点左上角虚线框，或右上角「上传」往里加</span></p>';

        /* 底部：字卡库入口 + 管理（删除）开关 */
        const foot =
            '<div class="cp-add">' +
                '<span class="cp-sendasnote">点表情包即由「我」发出</span>' +
                '<span class="cp-addbtns">' +
                    '<button class="cp-addbtn' + (stickerManage ? ' danger on' : ' ghost') + '" data-act="stkmanage">' +
                        (stickerManage ? '完成' : '管理') + '</button>' +
                    '<button class="cp-addbtn ghost" data-act="gocards">字卡库</button>' +
                '</span>' +
            '</div>';
        return gbar + '<div class="cp-scroll">' + body + emptyTip + '</div>' + foot;
    }

    /** 互动抽屉：拍一拍 / 颜文字 / emoji（公用 + 当前联系人专属，可就地添加） */
    function interactHtml() {
        // ★ 互动（拍一拍/颜文字/emoji）走「我的」全局桶 ME_SID，
        //   不读字卡库也不读当前联系人桶 —— 这是我单方面上传、单方面用的（用户拍板）。
        const list = Media.forChat(interactTab, ME_SID);
        const nm = KINDS[interactTab].name;
        const head =
            '<div class="cp-head">' +
                seg(INTERACT.map((k) => ({ name: KINDS[k].name, v: k })), interactTab, 'itab', 'wide') +
            '</div>';
        const body = list.length
            ? '<div class="cp-list chips">' + list.map((it) =>
                '<button class="cp-chip" data-media="' + esc(it.id) + '">' + esc(it.text) + '</button>'
              ).join('') + '</div>'
            : '<div class="cp-empty">还没有' + nm + '<br>' +
              '<span>在下面输入框里一行一条添加（默认存为公用）</span></div>';
        const foot =
            '<div class="cp-add col">' +
                '<textarea class="cp-addinput" data-newmedia rows="2" ' +
                    'placeholder="添加' + esc(nm) + '…一行一条（回车换行）"></textarea>' +
                '<div class="cp-addbtns">' +
                    '<button class="cp-addbtn ghost" data-act="cancelmedia">取消</button>' +
                    '<button class="cp-addbtn" data-act="addmedia">确认</button>' +
                '</div>' +
            '</div>';
        return head + '<div class="cp-scroll">' + body + '</div>' + foot;
    }

    /** 工具抽屉（收纳键）：就只是工具栏，不挂字卡、不放随机一句 */
    function toolsHtml() {
        return '<div class="cp-head"><span class="cp-title">工具</span></div>' +
            '<div class="cp-scroll"><div class="cp-tools">' + TOOLS.map((t) =>
                '<button class="cp-tool" data-tool="' + t.id + '">' +
                    '<i class="cp-tool-ico">' + icon(t.ico, 23) + '</i>' +
                    '<span>' + esc(t.name) + '</span>' +
                '</button>'
            ).join('') + '</div></div>';
    }

    function renderDrawer() {
        if (!ui.panel) return;
        if (drawer === 'sticker') { ui.panel.innerHTML = stickerHtml(); return; }
        if (drawer === 'interact') { ui.panel.innerHTML = interactHtml(); return; }
        ui.panel.innerHTML = toolsHtml();
    }

    /** 工具点击 */
    function runTool(id) {
        const t = TOOLS.find((x) => x.id === id);
        if (!t) return;

        if (id === 'image')    { closeDrawer(); askImageSource(); return; }
        if (id === 'continue') { closeDrawer(); taSpeak(); return; }
        if (id === 'sticker')  { openDrawer('sticker'); return; }
        if (id === 'interact') { openDrawer('interact'); return; }

        toast(t.name + ' 还没做，下一轮实现', 'warn', 1500);
    }

    /** 发图片：本地文件 / 相册 / 拍照 */
    function askImageSource() {
        if (!contact) { toast('先添加一个联系人', 'warn'); return; }
        sheet('发送图片', [
            {
                label: '本地文件', icon: icon('image', 19),
                onSelect: async () => { const src = await pickImageFrom('file', 1400); if (src) doSendImage(src); }
            },
            {
                label: '相册', icon: icon('album', 19),
                onSelect: async () => { const src = await pickImageFrom('album', 1400); if (src) doSendImage(src); }
            },
            {
                label: '拍照', icon: icon('camera', 19),
                onSelect: async () => { const src = await pickImageFrom('camera', 1400); if (src) doSendImage(src); }
            }
        ]);
    }

    function doSendImage(src) {
        push({ role: 'me', type: 'image', src, ts: Date.now(), quote: quote });
        setQuote(null);
        scrollBottom(true);
        markRead();
        // ★ 用户 2026-10-17 明确要求：发图片**只是发给对方**，
        //   不自动收进表情包面板（以前的自动收藏行为很莫名）。
        //   想存表情包请去「表情包 → 我的表情 → 上传」或字卡库。
        taSpeak();
    }

    function openDrawer(mode) {
        if (!contact) { toast('先添加一个联系人', 'warn'); return; }
        if (drawer === mode) { closeDrawer(); return; }
        drawer = mode;
        if (mode !== 'sticker') stickerManage = false;
        renderDrawer();
        ui.panel.hidden = false;
        if (ui.pmask) ui.pmask.hidden = false;
        void ui.panel.offsetWidth;
        ui.panel.classList.add('in');
        if (ui.pmask) ui.pmask.classList.add('in');
        ui.drawerBtn.classList.toggle('on', mode === 'tools');
        ui.stickerBtn.classList.toggle('on', mode === 'sticker' || mode === 'interact');
    }

    function closeDrawer() {
        drawer = null;
        if (!ui.panel) return;
        ui.panel.classList.remove('in');
        if (ui.pmask) ui.pmask.classList.remove('in');
        ui.drawerBtn.classList.remove('on');
        ui.stickerBtn.classList.remove('on');
        setTimeout(() => {
            if (!drawer) {
                ui.panel.hidden = true;
                if (ui.pmask) ui.pmask.hidden = true;
            }
        }, 200);
    }

    /** 互动：就地添加「我的」内容（确认按钮触发，回车是换行） */
    function addMediaFromPanel() {
        const input = ui.panel.querySelector('[data-newmedia]');
        if (!input) return;
        const text = (input.value || '').trim();
        if (!text) { toast('先写点内容', 'warn'); return; }
        const n = Media.add(interactTab, text, ME_SID);
        input.value = '';
        renderDrawer();
        toast(n ? ('已添加 ' + n + ' 条') : '这些已经加过了', n ? 'ok' : 'warn');
    }

    function cancelMediaInput() {
        const input = ui.panel.querySelector('[data-newmedia]');
        if (input) input.value = '';
        closeDrawer();
    }

    /* ---------- 消息菜单 ---------- */
    function menuItems(m) {
        const g = Settings.g();
        const items = [];
        if (g.quoteReply) items.push({ a: 'quote', t: '引用', i: 'card' });
        if (!m.retracted && m.type === 'text') items.push({ a: 'copy', t: '复制', i: 'cards' });
        items.push({ a: 'fav', t: '收藏', i: 'star' });
        // ★ 用户 2026-10-17：「不要这个互动，你怎么加一些莫名其妙的，这个是工具栏里的」
        //   —— 互动只保留工具栏（收纳键）入口，长按菜单里不再出现。
        if (m.role === 'me' && !m.retracted) items.push({ a: 'recall', t: '撤回', i: 'upload' });
        items.push({ a: 'del', t: '删除', i: 'trash' });
        return items;
    }

    /** 长按菜单：渲染 + 定位（优先放气泡上方，放不下就放下方） */
    function openMenu(m, bubbleEl) {
        const items = menuItems(m);
        ui.menu.innerHTML = items.map((it) =>
            '<button class="mm-btn' + (it.a === 'del' ? ' danger' : '') + '" data-ma="' + it.a + '">' +
                icon(it.i, 17) + '<span>' + esc(it.t) + '</span></button>'
        ).join('');
        ui.menu.hidden = false;
        ui.menu.dataset.mid = m.id;

        // 定位：优先放气泡上方，放不下就放下方
        const r = bubbleEl.getBoundingClientRect();
        const w = ui.menu.offsetWidth || 150;
        const h = ui.menu.offsetHeight || 60;
        const vw = window.innerWidth;
        let x = r.left + r.width / 2 - w / 2;
        x = Math.max(8, Math.min(vw - w - 8, x));
        let y = r.top - h - 6;
        if (y < 54) y = Math.min(window.innerHeight - h - 8, r.bottom + 6);
        ui.menu.style.left = x + 'px';
        ui.menu.style.top = y + 'px';
    }

    function closeMenu() {
        if (!ui.menu) return;
        ui.menu.hidden = true;
        ui.menu.removeAttribute('data-mid');
    }

    function runMenuAction(a) {
        const id = ui.menu.dataset.mid;
        const m = messages.find((x) => x.id === id);
        closeMenu();
        if (!m) return;

        if (a === 'copy') {
            const txt = m.type === 'image' ? '' : (m.text || '');
            if (!txt) { toast('这条没有可复制的文字', 'warn'); return; }
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(txt)
                    .then(() => toast('已复制', 'ok'))
                    .catch(() => toast('复制失败', 'warn'));
            } else {
                const ta = document.createElement('textarea');
                ta.value = txt;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); toast('已复制', 'ok'); }
                catch { toast('复制失败', 'warn'); }
                ta.remove();
            }
            return;
        }

        if (a === 'fav') {
            const list = loadFav();
            if (list.some((f) => f.id === m.id)) { toast('已经收藏过这条', 'warn'); return; }
            list.push({
                id: m.id,
                role: m.role,
                text: m.type === 'image' ? '[图片]' : m.text,
                type: m.type,
                src: m.src || '',
                ts: m.ts,
                quote: m.quote || null
            });
            saveFav(list);
            toast('已收藏', 'ok');
            return;
        }

        if (a === 'quote') {
            const who = m.role === 'me' ? myName() : ((Session.get(m.uid) || {}).name || (contact ? contact.name : '对方'));
            const text = m.retracted ? '[已撤回]' : (m.type === 'image' ? '[图片]' : m.text);
            setQuote({ who, text });
            try { ui.input.focus(); } catch { /* noop */ }
            return;
        }

        if (a === 'recall') {
            patch(m.id, (x) => {
                x.retracted = 1;
                x.orig = x.type === 'image' ? x.src : x.text;
            });
            toast('已撤回', 'ok');
            return;
        }

        if (a === 'del') {
            messages = messages.filter((x) => x.id !== m.id);
            saveMessages(messages);
            render();
            toast('已删除', 'ok');
        }
    }

    /** 长按 / 右键 → 菜单 */
    function bindLongPress() {
        let timer = null;
        let sx = 0, sy = 0;
        let suppressClick = false;

        const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };

        // 图片/表情包也允许长按出菜单（用户明确要求），只是不用它的 position 定位
        const eligible = (t) => {
            if (!t || !t.closest) return null;
            const item = t.closest('.msg');
            if (!item || item.classList.contains('typing')) return null;
            if (t.closest('.msg-quote')) return null;
            const b = t.closest('.bubble');
            if (b && b.classList.contains('gone')) return null;
            // 图片气泡也返回（定位用 .msg 整行），保证长按图片能出菜单
            const anchor = b || item.querySelector('.bubble') || item;
            return { item, b: anchor };
        };

        root.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            const t = e.touches[0];
            sx = t.clientX; sy = t.clientY;
            const hit = eligible(e.target);
            clear();
            if (!hit) { closeMenu(); return; }
            timer = setTimeout(() => {
                timer = null;
                suppressClick = true;
                setTimeout(() => { suppressClick = false; }, 400);
                const m = messages.find((x) => x.id === hit.item.getAttribute('data-mid'));
                if (m) openMenu(m, hit.b);
                try { if (navigator.vibrate) navigator.vibrate(15); } catch { /* noop */ }
            }, LONG_PRESS_MS);
        }, { passive: true });

        root.addEventListener('touchmove', (e) => {
            if (!timer) return;
            const t = e.touches[0];
            if (!t) return;
            if (Math.abs(t.clientX - sx) > MOVE_CANCEL || Math.abs(t.clientY - sy) > MOVE_CANCEL) clear();
        }, { passive: true });

        root.addEventListener('touchend', clear, { passive: true });
        root.addEventListener('touchcancel', clear, { passive: true });

        // 一律拦掉系统菜单（图片/表情包也要拦，否则弹出手机自带「复制/保存图片」）
        root.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const hit = eligible(e.target);
            if (!hit) return;
            const m = messages.find((x) => x.id === hit.item.getAttribute('data-mid'));
            if (m) openMenu(m, hit.b);
        });
        root.addEventListener('selectstart', (e) => {
            if (e.target.closest && e.target.closest('.bubble')) e.preventDefault();
        });
        root.addEventListener('dragstart', (e) => e.preventDefault());

        /**
         * 长按后系统会补一个 click，那个要吞掉，否则菜单刚弹就被自己点的那一下关掉。
         * ★ 但只吞「不在菜单上」的那次 —— 之前一律 stopPropagation（捕获阶段），
         *   事件根本到不了按钮，导致引用/收藏/撤回/删除全点了没反应。
         */
        root.addEventListener('click', (e) => {
            const inMenu = !!(ui.menu && !ui.menu.hidden && ui.menu.contains(e.target));
            if (suppressClick) {
                suppressClick = false;          // 只拦这一次
                if (inMenu) return;              // 落在菜单上：放行，用户是要操作菜单
                e.stopPropagation();
                e.preventDefault();
                return;
            }
            if (!inMenu && ui.menu && !ui.menu.hidden) closeMenu();
        }, true);

        if (ui.menu) {
            ui.menu.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-ma]');
                if (!btn) return;
                runMenuAction(btn.getAttribute('data-ma'));
            });
        }
    }

    /* ---------- 聊天设置（三点 → 全屏页） ---------- */
    function openChatSettings() {
        if (!contact) { toast('先添加一个联系人', 'warn'); return; }
        try {
            Page.open('chatSettings', { contactId: contact.id });
        } catch (err) {
            console.error(err);
            toast('打不开设置页', 'warn');
        }
    }

    /* ---------- 事件 ---------- */
    function bind() {
        delegate(root, 'click', '[data-act]', (e, t) => {
            const act = t.getAttribute('data-act');
            if (act === 'back') { try { Page.back(); } catch { /* 已在首页 */ } }
            else if (act === 'chatset') openChatSettings();
            else if (act === 'sticker') openDrawer('sticker');
            else if (act === 'drawer') {
                // 在子抽屉里再点收纳键 → 回到工具栅格（再点一次才收起）
                if (drawer && drawer !== 'tools') openDrawer('tools');
                else if (drawer === 'tools') closeDrawer();
                else openDrawer('tools');
            }
            else if (act === 'voice') toast('语音消息即将上线', 'warn', 1400);
            else if (act === 'send') { if (ui.send && ui.send.classList.contains('off')) return; send(); }
            else if (act === 'addmedia') addMediaFromPanel();
            else if (act === 'cancelmedia') cancelMediaInput();
            else if (act === 'unquote') setQuote(null);
            else if (act === 'gocards') { closeDrawer(); try { Page.open('cards'); } catch (err) { console.error(err); } }
            else if (act === 'loadEarlier') { try { loadEarlier(); } catch { /* noop */ } }
            else if (act === 'toggleRecall') {
                // 点撤回气泡 → 气泡内展开原文/原图；再点 → 收回
                const mid = t.closest('[data-mid]');
                const id = mid ? mid.getAttribute('data-mid') : '';
                const i = messages.findIndex((x) => x.id === id);
                if (i < 0 || !messages[i].retracted) return;
                messages[i].revealed = messages[i].revealed ? 0 : 1;
                flushSave();
                // ★ 原地替换这一个气泡的 msg-main，**不整段重渲染**
                //   （用户 2026-10-17：「点开收回会抽搐」——根就是 patch() 全量重建）
                const main = mid.querySelector('.msg-main');
                if (main) {
                    const m = messages[i];
                    let inner = msgInner(m);
                    if (m.role === 'me') inner += readRow(m);
                    main.innerHTML = inner;
                } else {
                    render({ keepScroll: true });
                }
            }
        });

        delegate(root, 'click', '[data-tool]', (e, t) => runTool(t.getAttribute('data-tool')));

        /* 互动子栏目 */
        delegate(root, 'click', '[data-itab]', (e, t) => {
            interactTab = t.getAttribute('data-itab');
            renderDrawer();
        });

        /* 表情包分组（心形=我上传的 + 字卡库分组，横排可滑） */
        delegate(root, 'click', '[data-stkg]', (e, t) => {
            stickerGroup = t.getAttribute('data-stkg');
            stickerManage = false;      // 换分组就退出管理模式
            renderDrawer();
        });

        /* 就地上传表情包进当前分组 */
        delegate(root, 'click', '[data-stkadd]', async () => {
            const files = await pickImages(512, 20);
            if (!files.length) return;
            const g = (stickerGroup === '__mine') ? '__mine' : stickerGroup;
            const n = Media.addMany('sticker', files.map((f) => ({ src: f.src, name: f.name })), g);
            renderDrawer();
            toast(n ? ('已上传 ' + n + ' 张') : '没有可上传的图', n ? 'ok' : 'warn');
        });

        /**
         * 点表情包：一律由「我」发出（没有发送身份切换了）。
         * 管理模式下不发送，只做「选中看❌」——❌ 在 [data-stkdel] 上，见下。
         * 发送前压一刀，防止旧 localStorage 时代配额爆掉（现在存 IndexedDB，双保险）。
         */
        delegate(root, 'click', '[data-stk]', async (e, t) => {
            if (stickerManage) return;                 // 管理模式：不发送
            const id = t.getAttribute('data-stk');
            const contactId = contact ? contact.id : null;
            const list = Media.forChat('sticker', contactId);
            const it = list.find((x) => x.id === id);
            if (!it) return;
            const src = await shrinkImage(it.src, 240);
            closeDrawer();
            push({ role: 'me', type: 'image', src, stk: 1, ts: Date.now(), quote: quote });
            setQuote(null);
            scrollBottom(true);
            markRead();
            taSpeak();
        });

        /* 管理模式下点表情右上角的 ❌ → 删除（用户 2026-10-17，图七） */
        delegate(root, 'click', '[data-stkdel]', (e, t) => {
            e.stopPropagation();
            const id = t.getAttribute('data-stkdel');
            // 表情包面板读的是当前联系人的桶（进聊天时已 activate 对齐），这里直接删当前桶
            const ok = Media.remove('sticker', id);
            renderDrawer();
            toast(ok ? '已删除' : '这条已经不在了', ok ? 'ok' : 'warn', 1400);
        });

        /* 管理（删除）开关 */
        delegate(root, 'click', '[data-act="stkmanage"]', () => {
            stickerManage = !stickerManage;
            renderDrawer();
        });

        /* 点互动内容 → 插入输入框（拍一拍直接发系统提示） */
        delegate(root, 'click', '[data-media]', (e, t) => {
            const id = t.getAttribute('data-media');
            // ★ 互动内容读「我的」全局桶 ME_SID（我单方面上传使用的，不同步字卡库）
            const list = Media.forChat(interactTab, ME_SID);
            const it = list.find((x) => x.id === id);
            if (!it) return;
            if (interactTab === 'poke') {
                closeDrawer();
                const nm = contact ? contact.name : '对方';
                // 拍一拍要显示具体内容（evanlu 做法），不是干巴巴一句"拍了拍对方"
                push({
                    role: 'me',
                    type: 'system',
                    text: myName() + ' 拍了拍 ' + nm + '，' + it.text,
                    ts: Date.now()
                });
                scrollBottom(true);
                taSpeak();
                return;
            }
            ui.input.value = (ui.input.value || '') + it.text;
            autosize();
            syncComposer();
            ui.input.focus();
        });

        delegate(root, 'click', '.bubble.img img', (e, t) => {
            const mask = document.createElement('div');
            mask.className = 'img-viewer';
            mask.innerHTML = '<img src="' + esc(t.getAttribute('src')) + '" alt="">';
            mask.addEventListener('click', () => mask.remove());
            document.body.appendChild(mask);
        });

        ui.input.addEventListener('input', () => { autosize(); syncComposer(); });
        ui.input.addEventListener('focus', closeDrawer);
        // 点聊天消息区（滚动区/气泡）时收起工具栏，避免面板与聊天界面互相顶住（#98）
        ui.body.addEventListener('click', () => { if (drawer) closeDrawer(); });
        ui.input.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || e.shiftKey) return;
            e.preventDefault();
            if (Settings.g().enterSend) send();
            else { /* 回车换行：交给 textarea 默认行为 */ }
        });

        // 互动输入框：回车 = 换行，绝不当成提交
        ui.panel.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.hasAttribute && e.target.hasAttribute('data-newmedia')) {
                e.stopPropagation();
            }
        });

        // 点遮罩收起工具面板（面板是独立图层，聊天不被顶走）
        if (ui.pmask) ui.pmask.addEventListener('click', closeDrawer);

        bindLongPress();
        bindKeyboard();
    }

    /* ---------- 订阅 ---------- */
    const offs = [];
    offs.push(bus.on(EV.SESSION_CHANGED, () => {
        clearAllTimers();
        typing = false;
        drawer = null;
        setQuote(null);
        closeMenu();
        contact = Session.current();
        messages = loadMessages();
        if (ui.panel) { ui.panel.hidden = true; ui.panel.classList.remove('in'); }
        if (ui.pmask) { ui.pmask.hidden = true; ui.pmask.classList.remove('in'); }
        render();
    }));
    offs.push(bus.on(EV.CONTACTS_CHANGED, () => {
        contact = Session.current();
        if (contact && Store.sessionId() !== contact.id) Session.activate(contact.id);
        messages = loadMessages();
        shown = RENDER_WINDOW;   // 固定窗口：不能用 min(总条数)，空会话时 shown=0，发第一条会把「查看更早」顶出来且气泡被切掉
        render({ toBottom: true });
    }));
    offs.push(bus.on(EV.AVATAR_CHANGED, () => render()));
    offs.push(bus.on(EV.STYLE_CHANGED, () => { applyStyle(); render(); }));
    // 素材桶是异步从 IndexedDB 加载的，加载完成时把打开着的抽屉补渲染
    offs.push(bus.on(EV.MEDIA_CHANGED, () => {
        if (drawer && ui.panel && !ui.panel.hidden) { try { renderDrawer(); } catch { /* noop */ } }
    }));
    offs.push(bus.on(EV.MESSAGE_ADDED, (p) => {
        if (p && (p.imported || p.cleared)) { messages = loadMessages(); render(); return; }
        // ★ 后台保活写进来的消息（fromBg）：哪怕人正在这个会话里，也要立刻补上并滚到底部
        //   （用户 2026-10-17：「对方发消息给我自动滚到聊天底部」）
        if (p && p.fromBg && p.contactId === (contact ? contact.id : null)) {
            messages = loadMessages();
            render({ toBottom: true });
        }
    }));

    /* ---------- 初始化 ---------- */
    build();
    bind();
    // 关键：从桌面/字卡库直接进来时，「当前桶」未必是这个联系人
    // （字卡库切过人 / 上次 activate 的是别人），这里强制对齐一次，
    // 否则聊天记录和字卡都会读到别人的桶。
    // ★ 整段用 try 包住：任何初始化异常都绝不能让页面变白屏 / 打不开。
    try {
        if (contact && Store.sessionId() !== contact.id) Session.activate(contact.id);
        if (contact) Media._migrate(contact.id);   // 素材桶（IndexedDB）异步加载
        messages = loadMessages();
        shown = RENDER_WINDOW;   // 固定窗口：不能用 min(总条数)，空会话时 shown=0，发第一条会把「查看更早」顶出来且气泡被切掉
        render({ toBottom: true });
    } catch (err) {
        console.error('[chat] 初始化出错', err);
        try { render(); } catch { /* 连兜底都失败，至少页面壳已出来 */ }
    }
    if (params && params.focus) { try { ui.input.focus(); } catch { /* noop */ } }

    return {
        resume() {
            contact = Session.current();
            if (contact && Store.sessionId() !== contact.id) Session.activate(contact.id);
            if (contact) Media._migrate(contact.id);
            messages = loadMessages();
            shown = RENDER_WINDOW;   // 固定窗口：不能用 min(总条数)，空会话时 shown=0，发第一条会把「查看更早」顶出来且气泡被切掉
            render({ toBottom: true });
        },
        destroy() {
            // ★ 用户 2026-10-17：「退出聊天界面对方不发信息依旧没解决」。
            //   根因就是这一行 clearAllTimers() 把「还没说出口的那句」掐掉了。
            //   现在：退出前把这笔欠账交给后台（KeepAlive.armPending），
            //   由它在原来的时间点补发；重新进聊天页时 loadMessages 就能读到。
            //   没开静音循环时不交接 —— 用户原话「未开启静音循环时，字卡只在前台回复」。
            const sid = contact ? contact.id : null;
            const oweReply = !!(timers.reply || timers.typing || (timers.extra && timers.extra.length));
            if (sid && oweReply) {
                const g = Settings.g();
                const lo = Math.max(1, g.replyDelayMin || 2) * 1000;
                const hi = Math.max(lo, (g.replyDelayMax || 20) * 1000);
                KeepAlive.armPending(sid, contact.name, lo + Math.random() * (hi - lo));
            }
            clearAllTimers();
            closeMenu();
            // 菜单挂在 body 上，离开页面必须摘掉，不然会残留一个幽灵菜单
            if (ui.menu && ui.menu.parentNode) ui.menu.parentNode.removeChild(ui.menu);
            ui.menu = null;
            offs.forEach((off) => { try { off(); } catch { /* noop */ } });
        }    };
}
