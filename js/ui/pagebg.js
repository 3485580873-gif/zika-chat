/* ============================================================
   pagebg.js — 让「设置 / 外观装扮」等整页背景跟随主界面背景图
   ------------------------------------------------------------
   ★ v29 修正（用户 2026-10-18 明确纠正）：
     「你为什么总让设置跟着主题颜色走」——
     之前有两个错：
       ① 背景图刷在**页面根 .page** 上，被 .gs-body 自己的
          --glass-bg（粉蓝绿渐变）整块盖住 → 永远看不到主界面背景图；
       ② 那层 --glass-bg 渐变就是「跟着主题颜色走」的元凶。
     正确做法（对齐 chat-settings 的做法）：
       · 背景图刷到**可滚动的内容容器**（ui.body）上；
       · .gs-body / .look-body 背景设为透明，让图片透出来；
       · 磨砂玻璃卡片（.gs-sec）直接盖在图片上面 = 用户要的
         「磨砂的，直接在上面」。
     不透明度沿用主界面 g.homeBgOpacity（白色遮罩实现，字永远可读）。
   ============================================================ */

import { IDB } from '../core/idb.js';
import { Store } from '../core/store.js';
import { Settings } from '../core/settings.js';

/**
 * 把主界面背景图铺到「内容容器」（通常是 page 里的滚动 body）上。
 * 没有背景图时清空，让页面底色（与主界面一致的 --bg）露出来。
 */
export function applyPageBg(el) {
    if (!el || !el.style) return;
    const paint = (bg) => {
        bg = (typeof bg === 'string' && /^(data:|https?:|blob:)/i.test(bg.trim())) ? bg.trim() : '';
        if (bg) {
            const op = Math.max(30, Math.min(100, Settings.g().homeBgOpacity || 82));
            const a = ((100 - op) / 100).toFixed(3);
            el.style.backgroundImage =
                'linear-gradient(rgba(255,255,255,' + a + '),rgba(255,255,255,' + a + ')),url("' + bg + '")';
            el.style.backgroundSize = 'cover';
            el.style.backgroundPosition = 'center';
            el.style.backgroundAttachment = 'fixed';
        } else {
            el.style.backgroundImage = '';
        }
    };
    IDB.get('homeBg').then((v) => {
        paint(v || Store.get('homeBgImg', '', { scope: 'global' }) || '');
    }).catch(() => paint(Store.get('homeBgImg', '', { scope: 'global' }) || ''));
}