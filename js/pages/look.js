/* ============================================================
   look.js — 外观装扮（桌面「装扮」App）
   ------------------------------------------------------------
   用户 2026-10-17 拍板：原来散在「设置 → 美化设置」里的东西
   **整体搬到这个独立 App**，设置页从此只剩「通信设置 / 数据管理」两个栏目。

   本页三块：
     ① 主界面   —— 背景图（存 IndexedDB）+ 不透明度
     ② 主题配色 —— 颜色展示框网格（THEME_PRESETS）
     ③ 桌面图标 —— 自定义图标图

   ★ 硬要求：功能区下面**不要挂任何说明文字**
     （用户原话：「你能不能别把我说的话，放在功能下面当说明？」）
   ============================================================ */

import { Store } from '../core/store.js';
import { Settings, THEME_PRESETS, applyThemePreset, themePreset } from '../core/settings.js';
import { Page } from '../ui/page.js';
import { icon } from '../ui/icon.js';
import { toast } from '../ui/toast.js';
import { esc, delegate, pickImage } from '../ui/dom.js';
import { IDB } from '../core/idb.js';
import { applyPageBg } from '../ui/pagebg.js';

const HOME_BG_KEY = 'homeBgImg';      // 主界面背景图（★大图走 IDB：'homeBg'；此键只作旧数据回落）
const ICON_IMG_KEY = 'homeIconImgs';  // 图标自定义图 id → dataURL

/**
 * 主题网格（设置页和装扮页共用）
 * 用户 2026-10-17 拍板：**要的是「颜色展示框」，不是放个文字**。
 * 每张卡 = 一整块该主题的渐变色（像 iOS 墙纸缩略图那样铺满），
 * 底部压一条小标签写名字，选中态右上角一个对勾。
 */
export function gridHtml() {
    const cur = themePreset(Settings.g().themeKey).k;
    return '<div class="look-grid">' +
        THEME_PRESETS.map((p) =>
            '<button class="look-card' + (p.k === cur ? ' on' : '') + '" data-look="' + p.k + '" ' +
                'style="--lc1:' + p.c1 + ';--lc2:' + p.c2 + ';--lac:' + p.accent + '" ' +
                'aria-label="' + esc(p.name) + '">' +
                // 整块就是颜色本身（用户：要呈现颜色的展示框）
                '<span class="look-fill"></span>' +
                // 里面再放三个小色片，让人看出这套主题由哪些颜色组成
                '<span class="look-chips">' +
                    '<i style="background:' + p.accent + '"></i>' +
                    '<i style="background:' + p.accentSoft + '"></i>' +
                    '<i style="background:' + p.c2 + '"></i>' +
                '</span>' +
                '<b class="look-nm">' + esc(p.name) + '</b>' +
                (p.k === cur
                    ? '<i class="look-tick">' + icon('check', 13) + '</i>'
                    : '') +
            '</button>'
        ).join('') +
        '</div>';
}

export function LookPage(root) {
    const ui = {};
    let homeBgCache = null;   // IDB 里的背景图缓存（异步读，读到了就刷新预览）

    /* ---------------- 片段 ---------------- */
    function section(title, body) {
        return '<section class="gs-sec">' +
            (title ? '<button class="gs-sect" type="button"><span>' + esc(title) + '</span></button>' : '') +
            '<div class="gs-secbd">' + body + '</div>' +
        '</section>';
    }
    function row(label, right) {
        return '<div class="gs-row"><div class="gs-lbcol"><span class="gs-lb">' + esc(label) + '</span></div>' +
            '<span class="gs-rr">' + right + '</span></div>';
    }
    function btn(label, act, cls) {
        return '<button class="gs-btn' + (cls ? ' ' + cls : '') + '" data-act="' + act + '">' + esc(label) + '</button>';
    }
    function num(label, path, val, unit, min, max) {
        return row(label,
            '<button class="gs-btn sm" data-numdec="' + path + '" data-min="' + min + '" data-max="' + max + '" data-step="1">−</button>' +
            '<input class="gs-numinput" type="number" data-numinput="' + path + '" data-min="' + min + '" data-max="' + max + '" value="' + val + '">' +
            (unit ? '<span class="gs-unit">' + esc(unit) + '</span>' : '') +
            '<button class="gs-btn sm" data-numinc="' + path + '" data-min="' + min + '" data-max="' + max + '" data-step="1">+</button>');
    }

    /* ---------------- 三块内容 ---------------- */
    /**
     * 主界面背景（用户 2026-10-17 重做）
     * ★ 原来是一整块 120px 高的大图预视放在功能名**下面**，
     *   用户原话：「不要在字下面贴个背景图！丑的要死」。
     *   改成：预览缩略图（40px 小方块）跟功能名**并排在同一行**里，
     *   按钮也在同一行 —— 整块高度压到一行，不占地方。
     */
    function homeSec() {
        const g = Settings.g();
        // 只认字符串 URL（IDB 里混进非字符串时忽略，别渲染出 url("true")）
        const raw = homeBgCache || Store.get(HOME_BG_KEY, '', { scope: 'global' });
        const bg = (typeof raw === 'string' && /^(data:|https?:|blob:)/i.test(raw.trim())) ? raw.trim() : '';
        const thumb = '<i class="gs-bgthumb' + (bg ? ' has' : '') + '"' +
            (bg ? ' style="background-image:url(\'' + bg + '\')"' : '') + '></i>';
        return section('主界面',
            '<div class="gs-row gs-bgrow">' +
                '<span class="gs-bgcell">' + thumb +
                    '<span class="gs-lbcol"><span class="gs-lb">主界面背景</span></span>' +
                '</span>' +
                '<span class="gs-rr">' +
                    btn(bg ? '换一张' : '上传', 'homebg', 'ghost') +
                    (bg ? btn('清除', 'homebgclr', 'ghost') : '') +
                '</span>' +
            '</div>' +
            num('背景不透明度', 'g.homeBgOpacity', g.homeBgOpacity, '%', 30, 100));
    }

    function themeSec() {
        return section('主题配色', gridHtml());
    }

    function iconSec() {
        return section('桌面图标', row('桌面图标样式', btn('自定义图标', 'icons')));
    }

    /* ---------------- 构建 / 渲染 ---------------- */
    function build() {
        root.innerHTML =
            '<header class="bar">' +
                '<button class="bar-btn" data-act="back" aria-label="返回">' + icon('chevronLeft', 23) + '</button>' +
                '<span class="bar-title">外观装扮</span>' +
                '<span class="bar-btn"></span>' +
            '</header>' +
            '<div class="page-scroll look-body" data-body></div>';
        ui.body = root.querySelector('[data-body]');
    }

    function render(keepScroll) {
        // ★ v38/v39：同 settings.js —— 重渲染后恢复滚动（rAF 里写，避免闪屏）
        const keepTop = keepScroll && ui.body ? ui.body.scrollTop : 0;
        ui.body.innerHTML = homeSec() + themeSec() + iconSec();
        if (keepTop) {
            requestAnimationFrame(() => { if (ui.body) ui.body.scrollTop = keepTop; });
        }
        // ★ v29 修正：背景刷在滚动内容容器上（不是页面根），磨砂卡片直接盖在上面。
        applyPageBg(ui.body);
    }

    /* ---------------- 事件 ---------------- */
    function bind() {
        delegate(root, 'click', '[data-act="back"]', () => { try { Page.back(); } catch { /* noop */ } });

        delegate(root, 'click', '[data-look]', (e, t) => {
            const k = t.getAttribute('data-look');
            Settings.setG('themeKey', k);
            applyThemePreset(k);
            render(true);
            const p = THEME_PRESETS.find((x) => x.k === k) || {};
            toast('主题：' + (p.name || ''), 'ok', 1200);
        });

        /* 数字 − / + */
        const step = (t) => {
            const p = t.getAttribute('data-numinc') || t.getAttribute('data-numdec');
            const min = Number(t.getAttribute('data-min') || 0);
            const max = Number(t.getAttribute('data-max') || 999);
            const cur = Number(Settings.g()[p.split('.')[1]] || min);
            const st = Number(t.getAttribute('data-step') || 1);
            const d = (t.getAttribute('data-numinc') ? 1 : -1) * st;
            Settings.setG(p.split('.')[1], Math.max(min, Math.min(max, cur + d)));
            render(true);
        };
        delegate(root, 'click', '[data-numinc]', step);
        delegate(root, 'click', '[data-numdec]', step);
        delegate(root, 'change', '[data-numinput]', (e, t) => {
            const p = t.getAttribute('data-numinput');
            const min = Number(t.getAttribute('data-min') || 0);
            const max = Number(t.getAttribute('data-max') || 999);
            let v = Number(t.value);
            if (isNaN(v)) v = min;
            v = Math.max(min, Math.min(max, v));
            Settings.setG(p.split('.')[1], v);
            t.value = v;
        });

        delegate(root, 'click', '[data-act]', (e, t) => {
            const act = t.getAttribute('data-act');
            if (act === 'homebg') return pickHomeBg();
            if (act === 'homebgclr') {
                IDB.del('homeBg');
                Store.remove(HOME_BG_KEY, { scope: 'global' });
                homeBgCache = null;
                render(true);
                toast('已清除主界面背景', 'ok');
                return;
            }
            if (act === 'icons') return pickAppIcons();
        });
    }

    /* ---------------- 主界面背景 ----------------
     * ★ 只存 IndexedDB（'homeBg'）。**绝不回写 localStorage**：
     *   一张背景图 dataURL 就几百 KB～几 MB，塞进去立刻顶爆 localStorage 5MB 配额，
     *   之后所有设置写入全部静默失败 →「保存完刷新就没了」就是这个原因（2026-10-17 抓到）。
     *   旧 localStorage 数据仍可读（回落），读到了就顺手搬进 IDB 并清掉。 */
    async function pickHomeBg() {
        const data = await pickImage(1200);
        if (!data) return;
        const ok = await IDB.set('homeBg', data);
        if (!ok) { toast('背景图存储失败，换一张小一点的试试', 'warn', 2600); return; }
        // 旧兜底数据清掉，防止它继续占着配额
        if (Store.get(HOME_BG_KEY, '', { scope: 'global' })) Store.remove(HOME_BG_KEY, { scope: 'global' });
        homeBgCache = data;
        render(true);
        toast('主界面背景已更新', 'ok');
    }

    /* ---------------- 桌面图标自定义 ---------------- */
    async function pickAppIcons() {
        const data = await pickImage(256);
        if (!data) return;
        const cur = Store.get(ICON_IMG_KEY, {}, { scope: 'global' }) || {};
        cur.__last = data;
        Store.set(ICON_IMG_KEY, cur, { scope: 'global' });
        if (window.__zika && window.__zika.Home && window.__zika.Home.refreshBg) window.__zika.Home.refreshBg();
        toast('图标图已保存', 'ok', 2000);
    }

    build();
    bind();
    render();

    // 背景图在 IDB 里（异步）：读到了刷新一下预览
    IDB.get('homeBg').then((v) => {
        if (v && typeof v === 'string' && v !== homeBgCache) { homeBgCache = v; render(); }
    });

    return {
        resume() { render(); },
        destroy() { /* 无残留 */ }
    };
}
