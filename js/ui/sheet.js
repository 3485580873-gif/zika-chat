/* ============================================================
   sheet.js — 底部动作面板
   用于「更多 / 长按菜单」这类临时操作，不做成全屏页。
   ============================================================ */

import { fromHTML } from './dom.js';

let current = null;

function close() {
    if (!current) return;
    const { mask, box } = current;
    current = null;
    box.classList.remove('in');
    mask.classList.remove('in');
    setTimeout(() => {
        try { mask.remove(); } catch { /* noop */ }
    }, 220);
}

/**
 * @param title  标题
 * @param items  [{ label, icon?, danger?, onSelect }]
 */
export function sheet(title, items) {
    close();

    const mask = fromHTML('<div class="sheet-mask"></div>');
    const box = fromHTML(
        '<div class="sheet-box">' +
        (title ? '<div class="sheet-title"></div>' : '') +
        '<div class="sheet-items"></div>' +
        '<div class="sheet-cancel">取消</div>' +
        '</div>'
    );
    if (title) box.querySelector('.sheet-title').textContent = title;

    const list = box.querySelector('.sheet-items');
    (items || []).forEach((it) => {
        const row = document.createElement('button');
        row.className = 'sheet-item' + (it.danger ? ' danger' : '');
        if (it.icon) row.insertAdjacentHTML('afterbegin', it.icon);
        const span = document.createElement('span');
        span.textContent = it.label;
        row.appendChild(span);
        row.addEventListener('click', () => {
            close();
            setTimeout(() => { try { it.onSelect && it.onSelect(); } catch (e) { console.error(e); } }, 40);
        });
        list.appendChild(row);
    });

    box.querySelector('.sheet-cancel').addEventListener('click', close);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });

    mask.appendChild(box);
    document.body.appendChild(mask);
    void box.offsetWidth;
    mask.classList.add('in');
    box.classList.add('in');
    current = { mask, box };
    return close;
}

export const Sheet = { open: sheet, close };
