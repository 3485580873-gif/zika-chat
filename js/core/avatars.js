/* ============================================================
   avatars.js — 头像唯一数据源
   ------------------------------------------------------------
   以前的问题是「三套写入路径互相覆盖」：头像库写 DOM、数据管理写
   设置、聊天设置写 conv 字段，谁最后执行谁生效，于是「换了头像
   聊天界面没反应」。

   这里只有一条路：所有读写都必须经过 Avatars。
     · 我的头像    → global 键 meAvatar（全站统一，不随会话变）
     · 联系人头像  → 存在该联系人记录里（天然按人隔离）
     · 群聊头像    → 由成员头像合成，不单独存
   ============================================================ */

import { Store } from './store.js';
import { Session } from './session.js';
import { bus, EV } from './bus.js';

const ME_KEY = 'meAvatar';   // global

/** 生成默认头像：首字母 + 稳定色，避免又是「空白灰人」 */
const PALETTE = ['#a8d5f2', '#f7b2b9', '#c3e8d5', '#e8d5f5', '#ffd6a5', '#d6f0e0', '#ede0ff', '#ffe8cc'];
function stableHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
}
function fallbackDataUrl(label, seed) {
    const ch = String(label || '?').trim().charAt(0).toUpperCase() || '?';
    const hue = stableHash(String(seed || ch));
    const bg = PALETTE[hue % PALETTE.length];
    const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">' +
        '<rect width="200" height="200" fill="' + bg + '"/>' +
        '<text x="100" y="100" font-size="88" font-family="-apple-system,sans-serif" ' +
        'font-weight="600" text-anchor="middle" dominant-baseline="central" ' +
        'fill="rgba(0,0,0,.55)">' + ch + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/* URL 里可能带 & 等字符，进属性前必须转义 */
const AMP = '&' + 'amp;';
const QUOT = '&' + 'quot;';
function escUrl(u) {
    return String(u || '').split('&').join(AMP).split('"').join(QUOT);
}

export const Avatars = {
    /**
     * 取头像 URL。
     * @param who 'me' | 联系人 id
     * @param opts.withFallback 是否在没有头像时返回生成的默认头像
     */
    get(who, opts = {}) {
        if (who === 'me') {
            const src = Store.get(ME_KEY, '', { scope: 'global' });
            return src || (opts.withFallback ? fallbackDataUrl('我', 'me') : '');
        }
        const c = Session.get(who);
        if (!c) return opts.withFallback ? fallbackDataUrl('?', who) : '';

        if (c.kind === 'group') {
            const members = Session.membersOf(c);
            // 群里有人就有图；都没有才走兜底
            const first = members.map((m) => m.avatar).find(Boolean);
            return first || (opts.withFallback ? fallbackDataUrl(c.name || '群', c.id) : '');
        }
        return c.avatar || (opts.withFallback ? fallbackDataUrl(c.name, c.id) : '');
    },

    /**
     * 设置头像 —— 唯一写入口。
     * @param who 'me' | 联系人 id
     * @returns 新的头像 URL
     */
    set(who, src) {
        src = String(src || '').trim();
        if (who === 'me') {
            Store.set(ME_KEY, src, { scope: 'global' });
        } else {
            const c = Session.get(who);
            if (!c) return '';
            Session.update(who, { avatar: src });
        }
        bus.emit(EV.AVATAR_CHANGED, { who, src });
        return src;
    },

    /** 清除（回到默认头像） */
    clear(who) { return Avatars.set(who, ''); },

    /**
     * 生成头像 HTML 片段。
     * 统一走这里，界面上就不会出现「同一个人在两处头像不一致」。
     */
    html(who, cls = '', opts = {}) {
        const src = Avatars.get(who, { withFallback: true });
        const clsTxt = cls ? ' ' + cls : '';
        return '<i class="avatar' + clsTxt + '" style="background-image:url(\'' + escUrl(src) + '\')"></i>';
    },

    /** 群聊头像：取最多 4 个成员合成九宫格 */
    groupParts(contact) {
        if (!contact || contact.kind !== 'group') return [];
        return Session.membersOf(contact)
            .slice(0, 4)
            .map((m) => m.avatar || fallbackDataUrl(m.name, m.id));
    },

    /** 供调试/导出 */
    _fallback: fallbackDataUrl
};
