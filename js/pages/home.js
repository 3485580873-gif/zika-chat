/* ============================================================
   home.js — 主界面（mochi 式手机桌面）
   ------------------------------------------------------------
   结构（参照 mochi 手机桌面）：
     ① 顶部：时钟 + 日期 + 当前联系人卡片（点了直接进聊天）
     ② 图标宫格：4 列，多页横向翻页（可左右滑，也可点指示点）
     ③ 底部 dock：传讯 / 联系人 / 字卡库 / 设置

   功能清单参照 evanlu + mochi 两个站点。
   已经做完的能直接进；还没做的点一下给明确提示，不放死链接。
   ============================================================ */

import { Session } from '../core/session.js';
import { Cards } from '../core/cards.js';
import { Settings, applyThemePreset } from '../core/settings.js';
import { Avatars } from '../core/avatars.js';
import { Page } from '../ui/page.js';
import { Store } from '../core/store.js';
import { IDB } from '../core/idb.js';
import { icon } from '../ui/icon.js';
import { toast } from '../ui/toast.js';
import { esc, delegate } from '../ui/dom.js';

/* ready: true 表示这一版已经做完，可以进 */
const APPS = [
    { id: 'chat',      name: '传讯',   ico: 'chat',     c1: '#4cd964', c2: '#16a34a', ready: true },
    { id: 'contacts',  name: '联系人', ico: 'users',    c1: '#5ac8fa', c2: '#0a84ff', ready: true },
    { id: 'cards',     name: '字卡库', ico: 'cards',    c1: '#ffcc4d', c2: '#ff9f0a', ready: true },
    { id: 'moments',   name: '朋友圈', ico: 'moments',  c1: '#ff9a9e', c2: '#f0724d', ready: false },
    { id: 'album',     name: '相册',   ico: 'album',    c1: '#a5d8ff', c2: '#3b82f6', ready: false },
    { id: 'diary',     name: '日记',   ico: 'book',     c1: '#c4b5fd', c2: '#7c3aed', ready: false },
    { id: 'anniversary', name: '纪念日', ico: 'heart',  c1: '#ff8fab', c2: '#ef4444', ready: false },
    { id: 'period',    name: '经期',   ico: 'calendar', c1: '#ffb3c1', c2: '#f43f5e', ready: false },
    { id: 'music',     name: '音乐',   ico: 'music',    c1: '#7dd3fc', c2: '#0ea5e9', ready: false },
    { id: 'mail',      name: '信封',   ico: 'mail',     c1: '#a7f3d0', c2: '#10b981', ready: false },
    { id: 'tarot',     name: '塔罗',   ico: 'star',     c1: '#e9d5ff', c2: '#a855f7', ready: false },
    { id: 'gift',      name: '礼物',   ico: 'gift',     c1: '#fed7aa', c2: '#f97316', ready: false },
    { id: 'game',      name: '小游戏', ico: 'gamepad',  c1: '#bbf7d0', c2: '#22c55e', ready: false },
    { id: 'stats',     name: '统计',   ico: 'chart',    c1: '#fde68a', c2: '#f59e0b', ready: false },
    { id: 'look',      name: '装扮',   ico: 'palette',  c1: '#fbcfe8', c2: '#ec4899', ready: true },
    { id: 'data',      name: '数据',   ico: 'database', c1: '#cbd5e1', c2: '#64748b', ready: false }
];

const PER_PAGE = 12;   // 每页 12 个（4 列 × 3 行）

export function HomePage(root) {
    const ui = {};
    let pageIdx = 0;
    let pageCount = 1;
    const clockTimer = { t: null };

    /* ---------------- 时钟 ---------------- */
    function clockText() {
        const d = new Date();
        const p = (n) => ('0' + n).slice(-2);
        const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
        return {
            hm: p(d.getHours()) + ':' + p(d.getMinutes()),
            date: (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + WEEK[d.getDay()]
        };
    }

    /** 应用主界面背景图 + 不透明度。
     *  ★ 背景图存 IndexedDB（zika-chat:blobs → 'homeBg'）——
     *    之前存 localStorage，1200px dataURL 一塞就爆 5MB 配额，
     *    Store.set 静默失败 = 用户说的「上传了没用没效果」。
     *    旧数据仍在 localStorage 里，读不到 IDB 时回落兼容。
     *  ★ 只认字符串：IDB 里万一混进非字符串（历史上 get() 返过 true），
     *    直接忽略，绝不拿它当 URL（否则 background-image:url("true") 404）。 */
    function applyHomeBg() {
        const g = Settings.g();
        const paint = (bg) => {
            bg = (typeof bg === 'string' && /^(data:|https?:|blob:)/i.test(bg.trim())) ? bg.trim() : '';
            const op = Math.max(30, Math.min(100, g.homeBgOpacity || 82));
            if (bg) {
                // ★ dataURL 不能截断（原来 slice(0,2000) 把图切坏了 = 「背景没效果」的根因）
                ui.wrap.style.backgroundImage = 'url("' + bg + '")';
                ui.wrap.style.backgroundSize = 'cover';
                ui.wrap.style.backgroundPosition = 'center';
            } else {
                ui.wrap.style.backgroundImage = '';
            }
            ui.wrap.classList.toggle('has-bg', !!bg);
            // 不透明度用一层白色遮罩实现（不用 filter，会把子元素一起洗白）
            ui.veil.style.opacity = bg ? String((100 - op) / 100) : '0';
        };
        IDB.get('homeBg').then((v) => {
            paint(v || Store.get('homeBgImg', '', { scope: 'global' }) || '');
        }).catch(() => paint(Store.get('homeBgImg', '', { scope: 'global' }) || ''));
    }

    /* ---------------- 构建 ---------------- */
    function build() {
        root.innerHTML =
            '<div class="home-wrap" data-wrap>' +
                '<div class="home-bgveil" data-veil></div>' +
                '<header class="home-nav">' +
                    '<div class="home-clock">' +
                        '<b data-clockhm></b>' +
                        '<span data-clockdate></span>' +
                    '</div>' +
                    // 右上角：主题键 + 设置键（底部导航栏已承载 主界面/发信息/字卡管理）
                    '<nav class="home-navbtns">' +
                        '<button class="home-navbtn" data-nav="settings" aria-label="设置">' + icon('sliders', 20) + '</button>' +
                        '<button class="home-navbtn" data-act="theme" aria-label="主题" data-theme></button>' +
                    '</nav>' +
                '</header>' +
                // ★ 仿小手机：整个内容区横向翻页（小组件页 + 应用宫格页），不再有固定的 TA 横条
                '<div class="home-pages" data-pages>' +
                    '<div class="home-track" data-track></div>' +
                '</div>' +
                '<div class="home-dots" data-dots></div>' +
            '</div>';

        ui.wrap = root.querySelector('[data-wrap]');
        ui.veil = root.querySelector('[data-veil]');
        ui.pages = root.querySelector('[data-pages]');
        ui.track = root.querySelector('[data-track]');
        ui.dots = root.querySelector('[data-dots]');
        ui.clockHm = root.querySelector('[data-clockhm]');
        ui.clockDate = root.querySelector('[data-clockdate]');
        ui.themeBtn = root.querySelector('[data-theme]');
    }

    function appBtn(a) {
        return '<button class="home-app' + (a.ready ? '' : ' soon') + '" data-app="' + a.id + '">' +
            '<span class="home-ico" style="--c1:' + a.c1 + ';--c2:' + a.c2 + '">' +
                icon(a.ico, 26) +
            '</span>' +
            '<span class="home-nm">' + esc(a.name) + '</span>' +
            (a.ready ? '' : '<i class="home-soon">soon</i>') +
        '</button>';
    }

    /* ---------------- 小组件页（仿小手机第 1 页） ---------------- */
    /** 在一起天数（纪念日存 global，默认 2022-05-21，点卡片可改） */
    function anniv() {
        const d = Store.get('annivDate', '2022-05-21', { scope: 'global' }) || '2022-05-21';
        const t = new Date(d + 'T00:00:00');
        if (isNaN(t.getTime())) return { date: d, days: 0, label: d };
        const days = Math.max(1, Math.floor((Date.now() - t.getTime()) / 86400000) + 1);
        const m = t.getMonth() + 1, day = t.getDate(), y = t.getFullYear();
        return { date: d, days, label: m + '月' + day + '日 ' + y };
    }

    function avatarBg(id) {
        try { return String(Avatars.get(id, { withFallback: true }) || '').split("'").join(''); }
        catch { return ''; }
    }

    function widgetsPage() {
        const c = Session.current();
        const a = anniv();
        return '<div class="home-page widgets">' +
            '<button class="w-couple" data-act="anniv">' +
                '<span class="w-avs">' +
                    '<i class="w-av" style="background-image:url(\'' + esc(avatarBg('me')) + '\')"></i>' +
                    '<i class="w-heart">' + icon('heart', 16) + '</i>' +
                    '<i class="w-av" style="background-image:url(\'' + esc(c ? avatarBg(c.id) : '') + '\')"></i>' +
                '</span>' +
                '<b class="w-days">' + a.days + '</b>' +
                '<span class="w-sub">在一起 · ' + esc(a.label) + '</span>' +
                '<span class="w-edit">点按修改纪念日</span>' +
            '</button>' +
            '<div class="w-status">' +
                '<b class="w-stt">' + icon('sparkle', 13) + '状态</b>' +
                '<div class="w-strow">' +
                    '<i class="avatar sm" style="background-image:url(\'' + esc(avatarBg('me')) + '\')"></i>' +
                    '<span>我</span><em>在线</em>' +
                '</div>' +
                '<div class="w-strow">' +
                    '<i class="avatar sm" style="background-image:url(\'' + esc(c ? avatarBg(c.id) : '') + '\')"></i>' +
                    '<span>' + esc(c ? c.name : 'TA') + '</span><em>在线</em>' +
                '</div>' +
            '</div>' +
        '</div>';
    }

    /* ---------------- 渲染 ---------------- */
    function render() {
        applyThemePreset(Settings.g().themeKey);
        applyHomeBg();

        /* 应用宫格分页（小组件先不做，用户后续会指定要什么组件） */
        pageCount = Math.max(1, Math.ceil(APPS.length / PER_PAGE));
        let html = '';
        for (let p = 0; p < pageCount; p++) {
            const slice = APPS.slice(p * PER_PAGE, (p + 1) * PER_PAGE);
            html += '<div class="home-page">' + slice.map(appBtn).join('') + '</div>';
        }
        ui.track.innerHTML = html;
        // ★ 宽度用像素：百分比在 flex 里会循环解析（300% 被压缩成 687px 那种怪结果）
        const pw = (ui.pages.clientWidth || root.clientWidth || 390);
        ui.track.style.width = (pw * pageCount) + 'px';
        Array.from(ui.track.children).forEach((el) => { el.style.width = pw + 'px'; el.style.flex = 'none'; });

        ui.dots.innerHTML = pageCount > 1
            ? Array.from({ length: pageCount }, (_, i) =>
                '<i class="home-dot' + (i === pageIdx ? ' on' : '') + '" data-dot="' + i + '"></i>').join('')
            : '';

        gotoPage(Math.min(pageIdx, pageCount - 1), false);
        tickClock();
    }

    function heroAvatar() {
        const c = Session.current();
        if (!c) return '';
        try { return String(Avatars.get(c.id, { withFallback: true }) || '').split("'").join(''); }
        catch { return ''; }
    }

    function tickClock() {
        const t = clockText();
        if (ui.clockHm) ui.clockHm.textContent = t.hm;
        if (ui.clockDate) ui.clockDate.textContent = t.date;
    }

    /* ---------------- 翻页 ---------------- */
    function gotoPage(i, animate = true) {
        pageIdx = Math.max(0, Math.min(pageCount - 1, i));
        ui.track.style.transition = animate ? 'transform .28s cubic-bezier(.32,.72,0,1)' : 'none';
        ui.track.style.transform = 'translateX(-' + (pageIdx * 100 / pageCount) + '%)';
        ui.dots.querySelectorAll('[data-dot]').forEach((d) => {
            d.classList.toggle('on', Number(d.getAttribute('data-dot')) === pageIdx);
        });
    }

    function bindSwipe() {
        let sx = 0, sy = 0, moved = false;
        ui.pages.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            sx = e.touches[0].clientX; sy = e.touches[0].clientY; moved = false;
        }, { passive: true });
        ui.pages.addEventListener('touchmove', (e) => {
            if (Math.abs(e.touches[0].clientX - sx) > 10) moved = true;
        }, { passive: true });
        ui.pages.addEventListener('touchend', (e) => {
            if (!moved) return;
            const dx = e.changedTouches[0].clientX - sx;
            if (Math.abs(dx) < 40) return;
            gotoPage(pageIdx + (dx < 0 ? 1 : -1));
        }, { passive: true });
        // 桌面鼠标拖拽也能翻页
        let mdx = 0, mdown = false;
        ui.pages.addEventListener('mousedown', (e) => { mdown = true; mdx = e.clientX; });
        ui.pages.addEventListener('mousemove', (e) => { if (mdown && Math.abs(e.clientX - mdx) > 10) moved = true; });
        window.addEventListener('mouseup', (e) => {
            if (!mdown) return;
            mdown = false;
            const dx = e.clientX - mdx;
            if (Math.abs(dx) >= 40) gotoPage(pageIdx + (dx < 0 ? 1 : -1));
        });
    }

    /* ---------------- 装扮 = 独立主题网格页（look.js），不再用 sheet ---------------- */

    /* ---------------- 动作 ---------------- */
    function openApp(id) {
        const app = APPS.find((a) => a.id === id);
        if (!app) return;
        if (!app.ready) { toast(app.name + ' 还没做，下一轮实现', 'warn', 1600); return; }
        if (id === 'chat') { try { Page.open('chat'); } catch (e) { console.error(e); } }
        else if (id === 'contacts') { try { Page.open('contacts'); } catch (e) { console.error(e); } }
        else if (id === 'cards') { try { Page.open('cards'); } catch (e) { console.error(e); } }
        else if (id === 'look') { try { Page.open('look'); } catch (e) { console.error(e); } }
    }

    function openNav(id) {
        // 「返回主界面」= 已经就在主界面，给个轻提示而不是跳转
        if (id === 'home') { toast('已经在主界面了', 'ok', 1200); return; }
        if (id === 'cards') { try { Page.open('cards'); } catch (e) { console.error(e); } return; }
        if (id === 'settings') {
            // 全局设置页（还没做内容，先给个占位，别把聊天设置当全局设置用）
            try { Page.open('settings'); } catch (e) { console.error(e); }
            return;
        }
        openApp(id);
    }

    function syncThemeBtn() {
        const dark = document.documentElement.getAttribute('data-theme') === 'dark';
        ui.themeBtn.innerHTML = icon(dark ? 'sun' : 'moon', 20);
    }

    /* ---------------- 事件 ---------------- */
    function bind() {
        delegate(root, 'click', '[data-app]', (e, t) => openApp(t.getAttribute('data-app')));
        delegate(root, 'click', '[data-nav]', (e, t) => openNav(t.getAttribute('data-nav')));
        delegate(root, 'click', '[data-dot]', (e, t) => gotoPage(Number(t.getAttribute('data-dot'))));
        // 小组件：点纪念日卡改日期
        delegate(root, 'click', '[data-act="anniv"]', () => {
            const cur = Store.get('annivDate', '2022-05-21', { scope: 'global' }) || '2022-05-21';
            const v = window.prompt('在一起纪念日（格式 YYYY-MM-DD）', cur);
            if (!v) return;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) { toast('格式：YYYY-MM-DD，比如 2022-05-21', 'warn', 2200); return; }
            Store.set('annivDate', v.trim(), { scope: 'global' });
            render();
            toast('纪念日已更新', 'ok', 1400);
        });
        ui.themeBtn.addEventListener('click', () => {
            const cur = document.documentElement.getAttribute('data-theme');
            const next = cur === 'dark' ? 'light' : 'dark';
            if (window.__zika && window.__zika.theme) window.__zika.theme.set(next);
            applyThemePreset(Settings.g().themeKey);
            syncThemeBtn();
        });
        bindSwipe();
    }

    build();
    bind();
    render();
    syncThemeBtn();
    clockTimer.t = setInterval(tickClock, 20000);

    return {
        resume() { render(); },
        destroy() { clearInterval(clockTimer.t); }
    };
}
