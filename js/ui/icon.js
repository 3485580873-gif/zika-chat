/* ============================================================
   icon.js — 内联 SVG 图标（iOS / iMessage 语汇）
   描边图标走 currentColor；实心图标（发送键）单独一组。
   ============================================================ */

const PATHS = {
    /* ---- 顶栏 ---- */
    chevronLeft: '<path d="M15 4.5 L8 12 L15 19.5"/>',
    chevronUp: '<path d="M4.5 15 L12 8 L19.5 15"/>',
    sliders: '<path d="M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9"/>' +
              '<circle cx="15" cy="7.5" r="2.2"/><circle cx="7" cy="16.5" r="2.2"/>',
    close: '<path d="M6 6 L18 18 M18 6 L6 18"/>',
    more: '<circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/>' +
          '<circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>' +
          '<circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/>',

    /* ---- 输入栏 ---- */
    camera: '<path d="M4 8.5h3l1.6-2.2h6.8L17 8.5h3V19H4z"/><circle cx="12" cy="13.4" r="3.4"/>',
    smile: '<circle cx="12" cy="12" r="9"/>' +
           '<path d="M8.4 14.2a4.6 4.6 0 0 0 7.2 0"/>' +
           '<circle cx="9.2" cy="9.6" r="1" fill="currentColor" stroke="none"/>' +
           '<circle cx="14.8" cy="9.6" r="1" fill="currentColor" stroke="none"/>',
    grid: '<circle cx="6" cy="6" r="1.7" fill="currentColor" stroke="none"/>' +
          '<circle cx="12" cy="6" r="1.7" fill="currentColor" stroke="none"/>' +
          '<circle cx="18" cy="6" r="1.7" fill="currentColor" stroke="none"/>' +
          '<circle cx="6" cy="12" r="1.7" fill="currentColor" stroke="none"/>' +
          '<circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/>' +
          '<circle cx="18" cy="12" r="1.7" fill="currentColor" stroke="none"/>' +
          '<circle cx="6" cy="18" r="1.7" fill="currentColor" stroke="none"/>' +
          '<circle cx="12" cy="18" r="1.7" fill="currentColor" stroke="none"/>' +
          '<circle cx="18" cy="18" r="1.7" fill="currentColor" stroke="none"/>',
    mic: '<path d="M12 3.2a3 3 0 0 0-3 3v5.6a3 3 0 0 0 6 0V6.2a3 3 0 0 0-3-3z"/>' +
         '<path d="M5.4 11.6a6.6 6.6 0 0 0 13.2 0"/><path d="M12 18.6v2.4"/>',

    /* ---- 收纳工具 ---- */
    video: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h8A2.5 2.5 0 0 1 16 7.5v9A2.5 2.5 0 0 1 13.5 19h-8A2.5 2.5 0 0 1 3 16.5z"/>' +
           '<path d="M16 10.5l5-3v9l-5-3z"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="3.5"/><circle cx="8.6" cy="9.6" r="1.6"/>' +
           '<path d="M4 17.4l4.6-4.6 3.4 3.4 3-3 5 5"/>',
    card: '<path d="M5 4h14v13H9l-4 4V4z"/>',
    star: '<path d="M12 3.2l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.4l5.9-.8z"/>',
    yen: '<circle cx="12" cy="12" r="9"/><path d="M8 7l4 5 4-5"/><path d="M8.6 12.5h6.8M8.6 15.4h6.8M12 12.5v4"/>',
    listCheck: '<path d="M9 6h11M9 12h11M9 18h11"/>' +
               '<path d="M3.5 6l1.2 1.2L6.5 5.5M3.5 12l1.2 1.2L6.5 11.5M3.5 18l1.2 1.2L6.5 17.5"/>',
    avatars: '<circle cx="8.5" cy="9" r="3.2"/><path d="M3 19v-1a4 4 0 0 1 4-4h3a4 4 0 0 1 4 4v1"/>' +
             '<path d="M16 6.2a3.2 3.2 0 0 1 0 6"/><path d="M18.5 14.2A4 4 0 0 1 21 18v1"/>',

    /* ---- 主页宫格 ---- */
    chat: '<path d="M20.5 11.6a8.3 8.3 0 0 1-8.9 8.3 8.6 8.6 0 0 1-3.8-.9L3 21l2.1-4.7a8.3 8.3 0 0 1-.9-3.8 8.5 8.5 0 0 1 8.4-8.4h.4a8.5 8.5 0 0 1 7.5 7.5z"/>',
    cards: '<rect x="3.5" y="6" width="14" height="13" rx="2.6"/><path d="M6.5 3.5h11A2.6 2.6 0 0 1 20 6.1v9.4"/>' +
           '<path d="M7 10h7M7 13.5h4.5"/>',
    users: '<path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1"/><circle cx="9" cy="7" r="3.2"/>' +
           '<path d="M17 11a3 3 0 1 0 0-6"/><path d="M22 19v-1a4 4 0 0 0-3-3.87"/>',
    moments: '<path d="M4 8.5h3l1.6-2.2h6.8L17 8.5h3V19H4z"/><circle cx="12" cy="13.4" r="3.4"/>',
    album: '<rect x="3" y="4.5" width="18" height="15" rx="3.2"/><circle cx="8.8" cy="10" r="1.7"/>' +
           '<path d="M4 16.8l4.4-4.4 3.2 3.2 2.8-2.8 5.6 5.6"/>',
    book: '<path d="M5 4.5A2 2 0 0 1 7 3h12v15H7a2 2 0 0 0-2 2z"/><path d="M5 20a2 2 0 0 1 2-1.5h12V21H7A2 2 0 0 1 5 20z"/>',
    heart: '<path d="M12 20s-7.5-4.6-7.5-9.6A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 7.5 2.8c0 5-7.5 9.6-7.5 9.6z"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17"/>' +
              '<path d="M8 3v3.5M16 3v3.5"/>',
    music: '<path d="M9 18V6.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
    mail: '<rect x="3" y="5.5" width="18" height="13" rx="3"/><path d="M3.6 7l8.4 6 8.4-6"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    palette: '<path d="M12 3a9 9 0 0 0 0 18c1.4 0 2-1 1.4-2-.6-1 .2-2 1.4-2h2A4 4 0 0 0 21 13 9 9 0 0 0 12 3z"/>' +
             '<circle cx="8" cy="9.6" r="1.1" fill="currentColor" stroke="none"/>' +
             '<circle cx="12" cy="7.6" r="1.1" fill="currentColor" stroke="none"/>' +
             '<circle cx="16" cy="9.6" r="1.1" fill="currentColor" stroke="none"/>',
    database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/>' +
              '<path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    gift: '<rect x="3.5" y="9" width="17" height="11" rx="2"/><path d="M3.5 13.5h17M12 9v11"/>' +
          '<path d="M12 9S9.5 4 7.5 5.5 9 9 12 9zM12 9s2.5-5 4.5-3.5S15 9 12 9z"/>',
    gamepad: '<path d="M7.5 10h9a5.5 5.5 0 0 1 5.4 4.5l.6 4a2.6 2.6 0 0 1-4.7 1.8l-1.4-2h-4.8l-1.4 2A2.6 2.6 0 0 1 5.5 18.5l.6-4A5.5 5.5 0 0 1 7.5 10z"/>' +
             '<path d="M8 13.5v2M7 14.5h2"/><circle cx="16" cy="14" r="1" fill="currentColor" stroke="none"/>',

    /* ---- 通用 ---- */
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
    pen: '<path d="M4 20h4l10-10-4-4L4 16v4z"/><path d="M14 6l4 4"/>',
    check: '<path d="M5 13 L10 18 L19 7"/>',
    plus: '<path d="M12 5 L12 19 M5 12 L19 12"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',

    /* ---- 补充：设置页 / 互动 / 导入导出 ---- */
    download: '<path d="M12 4v11"/><path d="M7.6 10.6L12 15l4.4-4.4"/><path d="M4.5 19.5h15"/>',
    upload: '<path d="M12 15V4"/><path d="M7.6 8.4L12 4l4.4 4.4"/><path d="M4.5 19.5h15"/>',
    sparkle: '<path d="M12 3.5l1.7 4.6 4.6 1.7-4.6 1.7L12 16.1l-1.7-4.6L5.7 9.8l4.6-1.7z"/>' +
             '<path d="M18.4 15.6l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
    hand: '<path d="M8 12.5V5.8a1.6 1.6 0 0 1 3.2 0v5.2"/>' +
          '<path d="M11.2 11V4.6a1.6 1.6 0 0 1 3.2 0V11"/>' +
          '<path d="M14.4 11.6V6.8a1.6 1.6 0 0 1 3.2 0v6"/>' +
          '<path d="M17.6 12.8v-1.4a1.6 1.6 0 0 1 2.4 1.4v3.4a6.4 6.4 0 0 1-6.4 6.4h-1.2a5.6 5.6 0 0 1-4.3-2l-2.6-3.1a1.7 1.7 0 0 1 2.5-2.3L8 14.4"/>',
    bellOff: '<path d="M8.7 5.2A6 6 0 0 1 18 9v4l2 2.6H7"/><path d="M10.3 19a2 2 0 0 0 3.4 0"/>' +
             '<path d="M4 3.5l16 17"/>',
    home: '<path d="M4 11.2 L12 4.2 L20 11.2"/><path d="M6.2 9.6 V19.4 H17.8 V9.6"/><path d="M10 19.4 V13.6 H14 V19.4"/>'
};

/* 实心图标（不能用描边画） */
const FILLED = {
    send: '<circle cx="12" cy="12" r="10.6" fill="currentColor"/>' +
          '<path d="M12 7.4v9.2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>' +
          '<path d="M7.7 11.6L12 7.4l4.3 4.2" fill="none" stroke="#fff" stroke-width="2" ' +
          'stroke-linecap="round" stroke-linejoin="round"/>'
};

function wrap(body, size, filled) {
    return '<svg class="ico' + (filled ? ' ico-fill' : '') + '" viewBox="0 0 24 24" width="' + size +
        '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.9" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
}

export function icon(name, size = 22) { return wrap(PATHS[name] || '', size, false); }
export function iconFilled(name, size = 22) { return wrap(FILLED[name] || '', size, true); }

export const ICONS = PATHS;
