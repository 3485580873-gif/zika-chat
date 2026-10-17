/* ============================================================
   app.js — 启动编排
   ------------------------------------------------------------
   只做三件事：装好页面、准备好会话、开键盘适配。
   业务逻辑一律在 pages/ 里，不往这里堆。
   ============================================================ */

import { Store } from './core/store.js';
import { Session } from './core/session.js';
import { Settings, applyThemePreset } from './core/settings.js';
import { Cards } from './core/cards.js';
import { Media } from './core/media.js';
import { Page } from './ui/page.js';
import { initDock, dockKeyboard } from './ui/dock.js';
import { HomePage } from './pages/home.js';
import { ChatPage } from './pages/chat.js';
import { ContactsPage } from './pages/contacts.js';
import { ChatSettingsPage } from './pages/chat-settings.js';
import { SettingsPage } from './pages/settings.js';
import { CardsPage } from './pages/cards.js';
import { LookPage } from './pages/look.js';
import { KeepAlive, setOnChatPage } from './core/bg.js';

/* ---------------- 主题 ---------------- */
function initTheme() {
    const saved = Store.get('theme', 'auto', { scope: 'global' });
    const apply = (mode) => {
        let real = mode;
        if (mode === 'auto') {
            real = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
                ? 'dark' : 'light';
        }
        document.documentElement.setAttribute('data-theme', real);
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', real === 'dark' ? '#101010' : '#f6f6f4');
    };
    apply(saved);
    try {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (Store.get('theme', 'auto', { scope: 'global' }) === 'auto') apply('auto');
        });
    } catch { /* 老浏览器不支持 */ }

    return {
        set(mode) { Store.set('theme', mode, { scope: 'global' }); apply(mode); },
        get() { return Store.get('theme', 'auto', { scope: 'global' }); }
    };
}

/* ---------------- 键盘适配 ----------------
   iOS 主屏（standalone）曾经踩过的坑，这里从第一行就做对：
     · 只用窗口高度差判断键盘，不用元素 rect 反推（会自反馈振荡）
     · 小于 100px 的抖动一律忽略
     · 收起后把视口偏移复位到「原点」(0,0)，不是滚到偏移处

   ★ 两种 WebView 的键盘行为都要兼容（2026-10-17 用户实机反馈「输入法盖住输入框」）：
     a) iOS Safari / 微信 X5(iOS)：键盘弹起时 window.innerHeight **不变**，
        visualViewport.height 变小 → 差 = 键盘高。
     b) 微信 X5 / 安卓 WebView：键盘弹起时 window.innerHeight **也跟着缩**，
        visualViewport.height ≈ innerHeight → 差 = 0，原来那套算法直接失效。
     解法：记住「键盘收起时的基准高度」，键盘高 = max(两个环境的差)。

   ★ 消费侧（css/app.css 的 .page）：bottom: var(--kb-shift)
     · 环境 a：布局视口没缩，页底抬到键盘顶部（页高缩短，顶栏不动）
     · 环境 b：布局视口本身就缩到键盘上方，--kb-shift = 0，页高自动正确
     **不再整页 translateY** —— 上抬会把顶栏一起顶出 #stage（overflow:hidden）裁掉，
     就是用户说的「点输入框整个画面被卡出去」。
   ------------------------------------------------ */
function initKeyboard() {
    const root = document.documentElement;
    let baselineH = window.innerHeight;     // 键盘收起时的窗口高度基准

    /**
     * @param kb    键盘高度（页面里想知道「键盘多高」的用它）
     * @param shift 页面底边该抬多少（= 键盘占据的高度）
     *   · 环境 a（iOS Safari）：布局视口没缩，只是视觉视口被键盘挤小 → 底边必须抬 shift=kb
     *   · 环境 b（微信 X5 / 安卓 WebView）：布局视口本身就缩到了键盘上方 →
     *     页底已经在键盘上方，**不能再抬**（否则输入条被顶出屏幕），shift=0
     */
    const set = (kb, shift) => {
        root.style.setProperty('--kb', (kb > 0 ? kb : 0) + 'px');
        root.style.setProperty('--kb-shift', (shift > 0 ? shift : 0) + 'px');
        root.classList.toggle('kb-open', kb > 0);
        if (kb <= 0) root.classList.remove('kb-focus');
    };
    if (!window.visualViewport) {
        // 没有 visualViewport 的老环境：退化成监听 resize + innerHeight 对比
        window.addEventListener('resize', () => {
            const kb = Math.max(0, baselineH - Math.min(window.innerHeight, baselineH));
            set(kb > 100 ? kb : 0, kb > 100 ? kb : 0);
        });
        return;
    }

    const vv = window.visualViewport;
    const apply = () => {
        const vvGap = window.innerHeight - vv.height;   // 环境 a 的键盘高
        const winGap = baselineH - window.innerHeight;   // 环境 b 的键盘高
        const kbRaw = Math.max(vvGap, winGap);
        const kb = kbRaw > 100 ? Math.round(kbRaw) : 0;
        // 只有「布局视口没缩」（环境 a）才需要抬页底
        const shift = (winGap <= 100) ? kb : 0;
        set(kb, shift);
        if (kb === 0 && window.innerHeight > baselineH) baselineH = window.innerHeight;  // 防基准漂移
        if (kb === 0 && (Math.abs(vv.offsetTop) > 1 || Math.abs(vv.offsetLeft) > 1)) {
            window.scrollTo(0, 0);
            setTimeout(() => window.scrollTo(0, 0), 80);
            setTimeout(() => window.scrollTo(0, 0), 240);
        }
    };
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', () => {
        // 转屏：基准失效，等稳定后重新取
        setTimeout(() => { baselineH = window.innerHeight; apply(); }, 350);
    });
}

/* ---------------- 启动 ---------------- */
function boot() {
    const stage = document.getElementById('stage');
    if (!stage) { console.error('[app] 缺少 #stage'); return; }

    const theme = initTheme();
    initKeyboard();

    Page.mount(stage);
    Page.register('home', HomePage);
    Page.register('chat', ChatPage);
    Page.register('contacts', ContactsPage);
    Page.register('chatSettings', ChatSettingsPage);
    Page.register('settings', SettingsPage);
    Page.register('cards', CardsPage);
    Page.register('look', LookPage);

    // 首次运行给一个示例联系人，避免开局空白
    Session.ensureSeed();

    // 全局样式（字体 / 字号 / 头像形状 / 时间戳）先落地一次
    Settings.apply();
    // 全局主题配色（设置 → 美化设置 里挑的白粉/白蓝等）
    applyThemePreset(Settings.g().themeKey);
    // 字体本体在 IndexedDB（localStorage 存不下几个 MB 的 ttf），异步读出注册
    Settings.loadFontBlob();

    // 桌面主页是根页面，聊天从宫格进
    Page.open('home');

    initDock();
    // 键盘弹出时藏起 dock（输入别被顶住）
    setInterval(() => { dockKeyboard(document.documentElement.classList.contains('kb-open')); }, 300);

    // 后台模拟：离开聊天页 / 页面不可见时，TA 仍按「主动发送」间隔继续发消息
    KeepAlive.start();
    // 页面栈变化 → 告诉后台「现在是不是在聊天页」
    const topPage = () => {
        const el = document.querySelector('.page:not(.behind)');
        return el ? el.getAttribute('data-page') : '';
    };
    const syncKa = () => {
        const onChat = topPage() === 'chat';
        setOnChatPage(onChat);
        KeepAlive.syncWithPage(!document.hidden, onChat);
    };
    const mo = new MutationObserver(syncKa);
    mo.observe(document.getElementById('stage'), { subtree: true, attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', syncKa);
    syncKa();

    // 调试入口（不影响正常使用）
    window.__zika = { Store, Session, Page, theme, Settings, Cards, Media, KeepAlive };
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
