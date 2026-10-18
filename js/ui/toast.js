/* ============================================================
   toast.js — 轻提示
   mochi 风格：底部胶囊，黑底白字，无阴影，不打断操作。
   ============================================================ */

import { fromHTML } from './dom.js';

let host = null;
let timer = null;

function ensureHost() {
    if (host && document.body.contains(host)) return host;
    host = fromHTML('<div class="toast-host" aria-live="polite"></div>');
    document.body.appendChild(host);
    return host;
}

/**
 * @param text 文案
 * @param type 'default' | 'ok' | 'warn' | 'err'
 * @param ms   停留时长
 */
export function toast(text, type = 'default', ms = 1800) {
    const box = ensureHost();
    box.innerHTML = '';
    const t = fromHTML('<div class="toast ' + type + '">' + String(text) + '</div>');
    box.appendChild(t);
    // 强制回流后再加 show，保证过渡动画每次都跑
    void t.offsetWidth;
    t.classList.add('show');

    clearTimeout(timer);
    timer = setTimeout(() => {
        t.classList.remove('show');
        setTimeout(() => { try { t.remove(); } catch { /* noop */ } }, 260);
    }, ms);
}

export const Toast = {
    ok: (t, ms) => toast(t, 'ok', ms),
    warn: (t, ms) => toast(t, 'warn', ms),
    err: (t, ms) => toast(t, 'err', ms),
    show: toast
};
