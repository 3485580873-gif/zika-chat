/* ============================================================
   chat-settings.js — 聊天设置（全屏页）
   ------------------------------------------------------------
   顶栏三点进来。三个栏目：
     美化设置 / 功能设置 / 数据管理

   分层（用户拍板）：
     全局层  —— 字体、字号、字色（我方/对方分开）、时间戳、
                头像形状/大小、头像框（大小/位置）、磨砂、输入习惯
     会话层  —— 背景、气泡颜色（我方/对方分开）、气泡 CSS、头像框图、
                已读不回、免打扰、拉黑（按联系人隔离）

   气泡 CSS：textarea 里写的是「草稿」，边写边在预览框里预览；
   点「应用」才真正写进聊天（和清除键并排）。
   ============================================================ */

import { Store } from '../core/store.js';
import { Session } from '../core/session.js';
import { Avatars } from '../core/avatars.js';
import { Settings, STAMP_STYLES, STAMP_FORMATS, FROSTINGS, FONT_FAMILY } from '../core/settings.js';
import { bus, EV } from '../core/bus.js';
import { IDB } from '../core/idb.js';
import { esc, delegate, pickImage, pickFile, download } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { Page } from '../ui/page.js';
import { icon } from '../ui/icon.js';

const MSG_KEY = 'messages';

/* 预设：背景纯色。之前有一堆差别极小的深色（墨黑/深灰/深蓝/炭棕），
   肉眼看不出区别，已经合并掉，只留有区分度的。 */
const BG_SWATCHES = [
    { name: '默认',   v: ''        },
    { name: '米白',   v: '#f5f2ee' },
    { name: '浅灰',   v: '#e9e9eb' },
    { name: '淡蓝',   v: '#dceaf7' },
    { name: '淡粉',   v: '#fbe4e8' },
    { name: '浅绿',   v: '#e2f1e6' },
    { name: '浅紫',   v: '#ebe4f7' },
    { name: '淡黄',   v: '#f9f2d8' },
    { name: '奶咖',   v: '#ede0d4' },
    { name: '天青',   v: '#d7ecec' },
    { name: '墨黑',   v: '#1c1c1e' },
    { name: '藏青',   v: '#1e2a38' },
    { name: '黛紫',   v: '#2a2438' },
    { name: '墨绿',   v: '#1f2d24' },
    { name: '酒红',   v: '#341f24' }
];

/* 颜色预设（字色 / 气泡色共用） */
const COLOR_SWATCHES = [
    { name: '跟随主题', v: ''        },
    { name: '黑',   v: '#111111' },
    { name: '灰',   v: '#6b6b70' },
    { name: '蓝',   v: '#0a84ff' },
    { name: '粉',   v: '#ff2d55' },
    { name: '紫',   v: '#8e44ec' },
    { name: '绿',   v: '#1e9e5a' },
    { name: '橙',   v: '#e8883a' },
    { name: '白',   v: '#ffffff' }
];

/* 字号快捷档 */
const FONT_SIZES = [13, 14, 15, 16, 17, 18, 20, 22];
/* 头像框快捷档（px） */
const FRAME_SIZES = [30, 34, 38, 44, 50, 58];
/* 聊天头像快捷档（px） */
const AVATAR_SIZES = [28, 32, 36, 38, 42, 48, 56];

export function ChatSettingsPage(root, params) {
    const contactId = (params && params.contactId) || (Session.current() || {}).id || '';
    let tab = (params && params.tab) || 'look';
    const ui = {};
    const foldOpen = new Set();   // 展开着的折叠块

    function contact() { return Session.get(contactId); }

    /* ---------------- 片段 ---------------- */
    /** 开关：data-sw = 层.键（g.enterSend / s.noReply） */
    function sw(path, on, label) {
        return '<button class="cs-sw' + (on ? ' on' : '') + '" data-sw="' + path + '"' +
            ' role="switch" aria-checked="' + (on ? 'true' : 'false') + '" aria-label="' + esc(label || '') + '">' +
            '<i></i></button>';
    }

    /** 一行：左标题+说明，右控件 */
    function row(title, desc, ctrl, cls) {
        return '<div class="cs-row' + (cls ? ' ' + cls : '') + '">' +
            '<div class="cs-txt"><b>' + esc(title) + '</b>' +
            (desc ? '<span>' + esc(desc) + '</span>' : '') + '</div>' +
            '<div class="cs-ctrl">' + ctrl + '</div>' +
            '</div>';
    }

    /** 分段选择（多个按钮选一个） */
    function seg(items, active, attr, extra) {
        return '<div class="cs-seg' + (extra || '') + '">' + items.map((it) =>
            '<button class="cs-segbtn' + (it.v === active ? ' on' : '') + '" data-' + attr + '="' + esc(it.v) + '">' +
            esc(it.name) + '</button>'
        ).join('') + '</div>';
    }

    /** 数字：− 输入 + 单位 */
    function numRow(attr, val, unit, min, max) {
        return '<div class="cs-numrow">' +
            '<button class="cs-mini" data-' + attr + '="-1">−</button>' +
            '<input class="cs-num" data-' + attr + 'input type="number" min="' + min + '" max="' + max + '" value="' + val + '">' +
            '<button class="cs-mini" data-' + attr + '="1">+</button>' +
            '<span class="cs-unit">' + esc(unit) + '</span>' +
            '</div>';
    }

    /** 胶囊档位 */
    function chips(items, active, attr) {
        return '<div class="cs-chips">' + items.map((n) =>
            '<button class="cs-chip' + (active === n ? ' on' : '') + '" data-' + attr + '="' + n + '">' + n + '</button>'
        ).join('') + '</div>';
    }

    /**
     * 分区。折叠规则（用户 2026-10-17 拍板）：**默认全展开**，
     * 只有明确传 fold=1 的长分区才默认收起（点标题仍可开合）。
     * 之前按「内容行数猜」会把头像/形状这种常用区也折起来，点一下就缩回去，很别扭。
     */
    function section(title, html, tip, fold) {
        const willFold = !!fold;
        const head = '<button class="cs-h3" type="button"' + (willFold ? ' data-secfold' : '') + '>' +
                '<span>' + esc(title) + '</span>' +
                (willFold ? '<i class="cs-chev">' + icon('chevronLeft', 14) + '</i>' : '') +
            '</button>';
        return '<section class="cs-sec' + (willFold ? ' fold' : '') + '">' +
            head +
            '<div class="cs-secbd">' +
                (tip ? '<p class="cs-tip">' + esc(tip) + '</p>' : '') +
                html +
            '</div>' +
        '</section>';
    }

    /** 色板（跟随主题 + 预设 + 自定义颜色） */
    function swatches(active, attr) {
        return '<div class="cs-swatches">' + COLOR_SWATCHES.map((c) =>
            '<button class="cs-sw' + (active === c.v ? ' at on' : '') + '" ' +
            'data-' + attr + '="' + esc(c.v) + '" title="' + esc(c.name) + '" aria-label="' + esc(c.name) + '">' +
            '<i style="background:' + (c.v || 'linear-gradient(135deg,#fff,#888)') + '"></i></button>'
        ).join('') + '</div>' +
        '<label class="cs-colorrow">自定义' +
            '<input type="color" data-' + attr + '2 value="' + esc(active || '#111111') + '">' +
        '</label>';
    }

    /** 折叠块：标题一点展开，里面放「我方 / 对方」两套色板 */
    function colorFold(key, title, valMe, valTa) {
        const open = foldOpen.has(key);
        return '<button class="cs-fold' + (open ? ' on' : '') + '" data-fold="' + esc(key) + '">' +
                '<span>' + esc(title) + '</span><i></i></button>' +
            '<div class="cs-foldbd' + (open ? ' on' : '') + '">' +
                '<b class="cs-subt">我方</b>' + swatches(valMe, 'cme_' + key) +
                '<b class="cs-subt">对方</b>' + swatches(valTa, 'cta_' + key) +
            '</div>';
    }

    /* ---------------- 栏目一：美化 ---------------- */
    /** 我方昵称（全局一份，聊天页顶栏/字卡库都用它） */
    function meName() {
        return Store.get('meName', '我', { scope: 'global' }) || '我';
    }

    function avatarCard(who) {
        const c = contact();
        const g = Settings.g();           // 头像框预览用的全局尺寸/偏移
        const isMe = who === 'me';
        const name = isMe ? meName() : (c ? c.name : '对方');
        const src = isMe ? Avatars.get('me', { withFallback: true }) : Avatars.get(contactId, { withFallback: true });
        const frame = isMe ? Settings.s().frameMe : Settings.s().frameTa;
        const fs = Settings.g().frameSize;
        const lb = isMe ? '我的昵称' : '对方名字';

        // 预览只显示头像本身，不叠头像框（用户要求：气泡 CSS 预览框里不要头像框）
        const fsz = isMe ? g.frameSizeMe : g.frameSizeTa;
        const fx = isMe ? g.frameXMe : g.frameXTa;
        const fy = isMe ? g.frameYMe : g.frameYTa;
        return '<div class="cs-avcard">' +
            '<div class="cs-avprev" style="width:' + (fs + 16) + 'px;height:' + (fs + 16) + 'px;' +
                '--cs-frame-size:' + fsz + 'px;--cs-frame-x:' + fx + 'px;--cs-frame-y:' + fy + 'px">' +
                '<i class="cs-avimg" style="background-image:url(\'' + esc(String(src).split("'").join('')) + '\')"></i>' +
            '</div>' +
            '<div class="cs-avside">' +
                '<div class="cs-name">' +
                    '<span class="cs-namelb">' + esc(lb) + '</span>' +
                    '<input class="cs-nameinput" ' + (isMe ? 'data-mename' : 'data-name') +
                        ' value="' + esc(isMe ? name : (c ? c.name : '')) + '" maxlength="20" ' +
                        'placeholder="' + esc(lb) + '">' +
                '</div>' +
                '<div class="cs-avbtns">' +
                    '<button class="cs-btn" data-upav="' + who + '">' + icon('image', 15) + '上传头像</button>' +
                    '<button class="cs-btn" data-upframe="' + who + '">' + icon('star', 15) + '头像框</button>' +
                    (frame ? '<button class="cs-btn ghost" data-clrframe="' + who + '">去框</button>' : '') +
                '</div>' +
            '</div>' +
        '</div>';
    }

    /** 头像框调节：我方 / 对方 各一套，不共用 */
    function frameCtl(who, g, s) {
        const isMe = who === 'me';
        const sizeKey = isMe ? 'g.frameSizeMe' : 'g.frameSizeTa';
        const xKey = isMe ? 'g.frameXMe' : 'g.frameXTa';
        const yKey = isMe ? 'g.frameYMe' : 'g.frameYTa';
        const has = isMe ? !!s.frameMe : !!s.frameTa;
        return '<div class="cs-framebox' + (has ? '' : ' off') + '">' +
            '<b class="cs-blockt">' + (isMe ? '我的头像框' : '对方头像框') +
                (has ? '' : '（没上传）') + '</b>' +
            row('大小', '', numRow('f' + who + 'size', isMe ? g.frameSizeMe : g.frameSizeTa, 'px', 20, 72)) +
            '<div class="cs-block"><div class="cs-chips">' +
                FRAME_SIZES.map((v) =>
                    '<button class="cs-chip' + ((isMe ? g.frameSizeMe : g.frameSizeTa) === v ? ' on' : '') + '" ' +
                    'data-path="' + sizeKey + '" data-val="' + v + '">' + v + '</button>'
                ).join('') +
            '</div></div>' +
            row('左右', '', numRow('f' + who + 'x', isMe ? g.frameXMe : g.frameXTa, 'px', -30, 30)) +
            row('上下', '', numRow('f' + who + 'y', isMe ? g.frameYMe : g.frameYTa, 'px', -30, 30)) +
        '</div>';
    }

    function tabLook() {
        const g = Settings.g();
        const s = Settings.s();

        /* 头像（我和对方各一张卡） */
        const avatars =
            section('头像', avatarCard('me') + avatarCard('ta'),
                            '');

        /* 头像形状 + 头像框大小/位置 + 聊天头像大小 */
        const shape =
            section('头像与头像框',
                /* ★ 用户 2026-10-17 拍板（图二）：三个头像显示开关放在本区最顶部 */
                row('显示聊天头像', '', sw('g.avatarShow', !!g.avatarShow, '显示聊天头像')) +
                row('每条消息都显示头像', '', sw('g.avatarEvery', !!g.avatarEvery, '每条消息都显示头像')) +
                row('单人模式显示对方名字', '', sw('g.showTaName', !!g.showTaName, '单人模式显示对方名字')) +
                row('形状', '', seg([
                        { name: '圆形', v: 'circle' },
                        { name: '圆角', v: 'rounded' },
                        { name: '方形', v: 'square' }
                    ], g.avatarShape, 'shape')) +
                row('聊天头像大小', '', numRow('avsize', g.chatAvatarSize, 'px', 20, 80)) +
                '<div class="cs-block">' +
                    '<b class="cs-blockt">头像快捷档位</b>' +
                    chips(AVATAR_SIZES, g.chatAvatarSize, 'avsize2') +
                '</div>' +
                frameCtl('me', g, s) +
                frameCtl('ta', g, s),
                '');
        /* ★ 2026-10-17：本区不再默认折叠 —— 用户新加的三个头像显示开关就在最顶部，
           折起来等于把新功能藏了。想看形状/头像框细节照样能点标题收起。 */

        /* 时间戳（位置七种 + 格式八档） */
        const stamp =
            section('时间戳',
                row('显示时间戳', '', sw('g.stampShow', !!g.stampShow, '显示时间戳')) +
                '<div class="cs-block">' +
                    '<b class="cs-blockt">位置</b>' +
                    '<div class="cs-chips">' + STAMP_STYLES.map((x) =>
                        '<button class="cs-chip' + (g.stampStyle === x.v ? ' on' : '') + '" ' +
                        'data-stamp="' + esc(x.v) + '">' + esc(x.name) + '</button>'
                    ).join('') + '</div>' +
                '</div>' +
                '<div class="cs-block">' +
                    '<b class="cs-blockt">格式</b>' +
                    '<div class="cs-chips">' + STAMP_FORMATS.map((x) =>
                        '<button class="cs-chip' + (g.stampFormat === x.v ? ' on' : '') + '" ' +
                        'data-stampfmt="' + esc(x.v) + '" title="' + esc(x.hint || '') + '">' + esc(x.name) + '</button>'
                    ).join('') + '</div>' +
                '</div>' +
                '<div class="cs-demo"><span class="cs-demo-lb">预览</span>' +
                    '<span class="msg-time">' + esc(Settings.miniStamp(Date.now())) + '</span>' +
                '</div>');

        /* 底栏图标颜色：已按用户要求取消（2026-10-17）——图标统一灰调，不再单独配色 */

        /* 背景（按联系人） */
        const bg =
            section('聊天背景',
                '<div class="cs-bgprev" data-bgprev>' +
                    '<span>这是和「' + esc((contact() || {}).name || '对方') + '」的背景预览</span>' +
                '</div>' +
                row('上传图片', '', '<button class="cs-btn" data-act="upbg">' + icon('image', 15) + '选图</button>' +
                    (s.bg ? '<button class="cs-btn ghost" data-act="clrbg">清除</button>' : '')) +
                '<div class="cs-block">' +
                    '<b class="cs-blockt">纯色背景</b>' +
                    '<div class="cs-swatches">' + BG_SWATCHES.map((c) =>
                        '<button class="cs-sw' + (s.bgColor === c.v ? ' at on' : '') + '" ' +
                        'data-bgcolor="' + esc(c.v) + '" title="' + esc(c.name) + '" aria-label="' + esc(c.name) + '">' +
                        '<i style="background:' + (c.v || 'transparent') + '"></i></button>'
                    ).join('') + '</div>' +
                '</div>');

        /* 字体 */
        const hasBlob = !!g.fontBlob;
        const hasFont = hasBlob || !!g.fontUrl;
        const fontPreviewStyle = hasFont ? ' style="font-family:\'' + FONT_FAMILY + '\',sans-serif"' : '';
        const font =
            section('字体',
                row('上传字体', hasBlob ? ('当前：' + (g.fontName || '已上传')) : '',
                    '<button class="cs-btn" data-act="upfont">' + icon('plus', 15) + '本地文件</button>' +
                    (hasBlob ? '<button class="cs-btn ghost" data-act="clrfont">移除</button>' : '')) +
                '<div class="cs-block">' +
                    '<b class="cs-blockt">用链接（粘贴字体文件 URL）</b>' +
                    '<div class="cs-row2">' +
                        '<input class="cs-input" data-fonturl placeholder="https://…/font.ttf" value="' + esc(g.fontUrl || '') + '">' +
                        '<button class="cs-btn primary" data-act="usefonturl">用链接</button>' +
                    '</div>' +
                '</div>' +
                '<div class="cs-fontprev"' + fontPreviewStyle + '>' +
                    '<b>系统预览</b>' +
                    '<p>字卡传讯 · 简体中文示例 ABCabc 123</p>' +
                '</div>' +
                row('字体大小', '', numRow('fontsz', g.fontSize, 'px', 10, 32)) +
                '<div class="cs-block">' +
                    '<b class="cs-blockt">快捷档位</b>' +
                    chips(FONT_SIZES, g.fontSize, 'fontsz2') +
                '</div>' +
                '<div class="cs-block">' +
                    colorFold('fcolor', '字体颜色（我方 / 对方分开）', g.fontColorMe, g.fontColorTa) +
                '</div>',
                            '');

        /* 气泡颜色（我方 / 对方分开，折叠） */
        const bubbleColor =
            section('气泡颜色',
                colorFold('bcolor', '我方 / 对方气泡颜色', s.bubbleColorMe, s.bubbleColorTa),
                            '', 1);

        /* 气泡 CSS：导入文件 / 粘贴草稿 + 应用 / 清除 */
        const draft = s.bubbleCssDraft || '';
        const bubble =
            section('自定义气泡 CSS',
                '<div class="cs-bubprev" data-bubprev>' +
                    '<div class="msg me"><div class="msg-side"><i class="avatar"></i></div>' +
                        '<div class="msg-main"><div class="bubble message-sent">这是我发的消息</div></div></div>' +
                    '<div class="msg ta"><div class="msg-side"><i class="avatar"></i></div>' +
                        '<div class="msg-main"><div class="bubble message-received">这是对方发的消息</div></div></div>' +
                '</div>' +
                '<div class="cs-block">' +
                    '<b class="cs-blockt">气泡代码（草稿，点「应用」才生效）</b>' +
                    '<textarea class="cs-css" data-cssdraft rows="7" ' +
                        'placeholder=".message-sent { border-radius: 18px; }&#10;.message-received { background: #fff; }&#10;.message-sent::after { 尾巴图 }">' +
                        esc(draft) + '</textarea>' +
                    '<div class="cs-row2">' +
                        '<button class="cs-btn primary" data-act="applycss">' + icon('check', 15) + '应用</button>' +
                        '<button class="cs-btn ghost" data-act="clrcss">' + icon('close', 15) + '清除</button>' +
                        '<button class="cs-btn" data-act="importcss">' + icon('upload', 15) + '导入文件</button>' +
                        (s.bubbleCss ? '<span class="cs-applied">已应用</span>' : '<span class="cs-applied off">未应用</span>') +
                    '</div>' +
                '</div>',
                            '');

        return avatars + shape + stamp + bg + font + bubbleColor + bubble;
    }

    /* ---------------- 栏目二：功能 ---------------- */
    function tabFunc() {
        const g = Settings.g();
        const s = Settings.s();
        const c = contact();
        const isGroup = c && c.kind === 'group';

        const input =
            section('输入',
                row('回车发送', '', sw('g.enterSend', !!g.enterSend, '回车发送')) +
                row('语音图标', '', sw('g.voiceInput', !!g.voiceInput, '语音输入')) +
                row('引用回复', '', sw('g.quoteReply', !!g.quoteReply, '引用回复')));

        const talk =
            section('消息与回执',
                row('已读回执', '', sw('g.readReceipt', !!g.readReceipt, '已读回执')) +
                (g.readReceipt
                    ? '<div class="cs-prob">' +
                        '<b class="cs-blockt">显示方式</b>' +
                        seg([{ name: '文字', v: 'text' }, { name: '图形', v: 'icon' }], g.readReceiptStyle, 'rrstyle', 'wide') +
                      '</div>'
                    : '') +
                row('正在输入', '', sw('g.typingShow', !!g.typingShow, '正在输入')));

        /* 拼字卡/回复条数/各类概率都挪到桌面「设置 → 通信设置」了（用户拍板去重）。
           已读不回（含概率）也一并搬到那里 —— 用户明确要求「图中的已读不回放到通信设置里」。
           这里只留联系人自己的管理开关。 */

        const manage =
            section('联系人',
                row('置顶聊天', '', sw('c.pinned', !!(c && c.pinned), '置顶聊天')) +
                row('消息免打扰', '', sw('s.muted', !!s.muted, '消息免打扰')) +
                row('拉黑联系人', '', sw('s.blocked', !!s.blocked, '拉黑联系人')) +
                (isGroup ? '' :
                    '<div class="cs-danger">' +
                        '<button class="cs-del" data-act="delcontact">' + icon('trash', 15) + '删除联系人</button>' +
                    '</div>'));

        return input + talk + manage;
    }

    /* ---------------- 栏目三：数据 ---------------- */
    function tabData() {
        const list = Store.get(MSG_KEY, [], { scope: 'session' });
        const n = Array.isArray(list) ? list.length : 0;
        const c = contact();

        // ★ 用户 2026-10-17：图三那张「字卡与素材」说明卡整块删掉。
        return section('聊天记录',
            '<div class="cs-databox">' +
                '<b>' + n + '</b><span>条消息 · ' + esc(c ? c.name : '当前会话') + '</span>' +
            '</div>' +
            row('导出聊天记录', '', '<button class="cs-btn" data-act="export">' + icon('download', 15) + '导出</button>') +
            row('导入聊天记录', '', '<button class="cs-btn" data-act="import">' + icon('upload', 15) + '导入</button>') +
            '<div class="cs-danger">' +
                '<button class="cs-del" data-act="clearchat">' + icon('trash', 15) + '清除聊天记录</button>' +
            '</div>');
    }

    /* ---------------- 渲染 ---------------- */
    function render() {
        const html = tab === 'look' ? tabLook() : (tab === 'func' ? tabFunc() : tabData());
        ui.body.innerHTML = html;
        ui.tabs.querySelectorAll('[data-tab]').forEach((b) => {
            b.classList.toggle('on', b.getAttribute('data-tab') === tab);
        });
        applyPreview();
        // 名字框 / CSS 草稿框要直接绑（走委托会在每次输入都重新触发，丢焦点）
        bindNameInput();
        bindCssDraft();
    }

    /** 背景预览 + 气泡预览（气泡预览看的是「草稿」，未应用也能看效果） */
    function applyPreview() {
        const s = Settings.s();
        // 设置页背景跟随聊天背景（用户拍板）：传了图就铺同一张
        if (s.bg) {
            ui.body.style.backgroundImage = 'url("' + s.bg + '")';
            ui.body.style.backgroundSize = 'cover';
            ui.body.style.backgroundPosition = 'center';
            ui.body.style.backgroundAttachment = 'fixed';
        } else if (s.bgColor) {
            ui.body.style.backgroundImage = 'none';
            ui.body.style.backgroundColor = s.bgColor;
        } else {
            ui.body.style.backgroundImage = '';
            ui.body.style.backgroundColor = '';
        }
        const prev = ui.body.querySelector('[data-bgprev]');
        if (prev) {
            prev.style.backgroundImage = s.bg ? 'url("' + s.bg + '")' : 'none';
            prev.style.backgroundColor = s.bg || s.bgColor || '';
        }
        const bub = ui.body.querySelector('[data-bubprev]');
        if (bub) {
            let el = document.getElementById('cs-bub-css');
            if (!el) {
                el = document.createElement('style');
                el.id = 'cs-bub-css';
                document.head.appendChild(el);
            }
            // 预览只看草稿；没草稿时回看已应用的，保持预览不空
            const css = s.bubbleCssDraft || s.bubbleCss || '';
            // 预览只在预览框内生效，不污染真实聊天；
            // 内容没变就不重写（重写会触发整份重解析 causing 卡顿）
            const next = Settings.previewCss(css, '.cs-bubprev');
            if (el.getAttribute('data-zika-css') === next) return;
            el.setAttribute('data-zika-css', next);
            el.textContent = next;
        }
    }

    /* ---------------- 开关取值/写入 ---------------- */
    function getPath(path) {
        const [layer, key] = String(path).split('.');
        if (layer === 'g') return Settings.g()[key];
        if (layer === 's') return Settings.s()[key];
        if (layer === 'c') { const c = contact(); return c ? c[key] : false; }
        return false;
    }
    function setPath(path, val) {
        const [layer, key] = String(path).split('.');
        if (layer === 'g') Settings.setG(key, val);
        else if (layer === 's') Settings.setS(key, val);
        else if (layer === 'c') {
            const c = contact();
            if (!c) return;
            Session.update(c.id, { [key]: val });
            bus.emit(EV.CONTACTS_CHANGED, { type: 'update', contact: c });
        }
    }

    /* ---------------- 交互 ---------------- */
    async function uploadAvatar(who) {
        const src = await pickImage(600);
        if (!src) return;
        if (who === 'me') Avatars.set('me', src);
        else Avatars.set(contactId, src);
        render();
        toast('头像已更新', 'ok');
    }

    async function uploadFrame(who) {
        // 头像框要保透明（PNG 输出），dom.js 的 pickImage 已按 alpha 通道自动选格式
        const src = await pickImage(400);
        if (!src) return;
        Settings.setS(who === 'me' ? 'frameMe' : 'frameTa', src);
        render();
        toast('头像框已应用', 'ok');
    }

    async function uploadBg() {
        const src = await pickImage(1400);
        if (!src) return;
        // 图片和纯色互斥：传图就清掉纯色
        Settings.patchS({ bg: src, bgColor: '' });
        render();
        toast('背景已应用（全屏铺满）', 'ok');
    }

    async function uploadFont() {
        const f = await pickFile('.ttf,.otf,.woff,.woff2,font/*');
        if (!f || !f.data) return;
        toast('正在载入字体…', 'ok', 1500);
        const ok = await Settings.uploadFontBlob(f.data, f.name);
        render();
        toast(ok ? '字体已应用（存本地索引库，刷新不丢）' : '字体加载失败：文件可能损坏或格式不支持', ok ? 'ok' : 'warn', 3000);
    }

    async function clearFont() {
        await Settings.removeFontBlob();
        render();
        toast('字体已移除', 'ok');
    }

    /** 用粘贴的 URL 加载字体（跨源需对方允许 CORS） */
    async function useFontUrl() {
        const el = ui.body.querySelector('[data-fonturl]');
        const url = (el && el.value || '').trim();
        if (!url) { toast('先粘贴字体文件链接', 'warn'); return; }
        // 用链接就清掉 IDB 里的本地字体，避免两个来源打架
        await IDB.del('fontBlob');
        Settings.patchG({ fontUrl: url, fontBlob: 0, fontName: '' });
        render();
        toast('正在从链接加载字体…', 'ok', 1600);
        Settings.loadFontFromUrl(url).then((ok) => {
            toast(ok ? '字体链接已应用' : '链接字体加载失败（可能跨源被拦，换本地文件）', ok ? 'ok' : 'warn', 2600);
        });
    }

    function exportChat() {
        const list = Store.get(MSG_KEY, [], { scope: 'session' });
        const c = contact();
        const payload = {
            app: 'zika-chat',
            type: 'chat-history',
            exportedAt: new Date().toISOString(),
            contact: c ? { id: c.id, name: c.name, kind: c.kind } : null,
            messages: Array.isArray(list) ? list : []
        };
        const name = '聊天记录_' + (c ? c.name : '会话') + '_' + new Date().toISOString().slice(0, 10) + '.json';
        if (download(name, JSON.stringify(payload, null, 2))) toast('已导出 ' + payload.messages.length + ' 条', 'ok');
        else toast('导出失败', 'warn');
    }

    async function importChat() {
        const f = await pickFile('.json,application/json');
        if (!f || !f.data) return;
        try {
            const text = f.data.split(',').slice(1).join(',');   // 去掉 dataURL 前缀
            const json = JSON.parse(decodeURIComponent(escape(atob(text))));
            const msgs = Array.isArray(json.messages) ? json.messages : null;
            if (!msgs) { toast('文件里没有聊天记录', 'warn'); return; }
            Store.set(MSG_KEY, msgs, { scope: 'session' });
            bus.emit(EV.MESSAGE_ADDED, { contactId, imported: true });
            render();
            toast('已导入 ' + msgs.length + ' 条', 'ok');
        } catch (err) {
            console.error(err);
            toast('导入失败：不是有效的备份文件', 'warn', 2400);
        }
    }

    function clearChat() {
        if (!window.confirm('确定清除和「' + ((contact() || {}).name || '对方') + '」的全部聊天记录？')) return;
        Store.set(MSG_KEY, [], { scope: 'session' });
        bus.emit(EV.MESSAGE_ADDED, { contactId, cleared: true });
        render();
        toast('已清除', 'ok');
    }

    function deleteContact() {
        const c = contact();
        if (!c) return;
        if (!window.confirm('删除「' + c.name + '」？聊天记录会一起清除，无法恢复。')) return;
        Store.remove(MSG_KEY, { scope: 'session' });
        Session.remove(c.id);
        toast('已删除', 'ok');
        try { Page.back(); } catch { /* noop */ }
    }

    /* ---------------- 构建 ---------------- */
    function build() {
        root.innerHTML =
            '<header class="bar">' +
                '<button class="bar-btn" data-act="back" aria-label="返回">' + icon('chevronLeft', 23) + '</button>' +
                '<span class="bar-title">聊天设置</span>' +
                '<button class="bar-btn plain" data-act="done" aria-label="完成">' + icon('check', 22) + '</button>' +
            '</header>' +
            '<div class="cs-tabs" data-tabs>' +
                '<button class="cs-tab" data-tab="look">美化设置</button>' +
                '<button class="cs-tab" data-tab="func">功能设置</button>' +
                '<button class="cs-tab" data-tab="data">数据管理</button>' +
            '</div>' +
            '<div class="page-scroll cs-body" data-body></div>' +
            '<footer class="cs-foot">' +
                '<button class="cs-footbtn" data-act="done">完成</button>' +
            '</footer>';

        ui.body = root.querySelector('[data-body]');
        ui.tabs = root.querySelector('[data-tabs]');
    }

    /* ---------------- 改名（input 实时保存） ---------------- */
    let nameTimer = null;
    function bindNameInput() {
        const el = ui.body.querySelector('[data-name]');
        if (el) {
            el.addEventListener('input', () => {
                const c = contact();
                if (!c) return;
                const v = (el.value || '').trim();
                clearTimeout(nameTimer);
                nameTimer = setTimeout(() => {
                    if (!v) return;   // 清空不保存，失焦时再还原
                    if (v === c.name) return;
                    Session.update(c.id, { name: v });
                }, 300);
            });
            el.addEventListener('blur', () => {
                clearTimeout(nameTimer);
                const c = contact();
                if (!c) return;
                const v = (el.value || '').trim();
                if (!v) { el.value = c.name; return; }
                if (v !== c.name) { Session.update(c.id, { name: v }); toast('已改名为「' + v + '」', 'ok'); }
            });
        }

        /* 我的昵称（全局一份，不分联系人） */
        const me = ui.body.querySelector('[data-mename]');
        if (!me) return;
        me.addEventListener('input', () => {
            const v = (me.value || '').trim();
            clearTimeout(nameTimer);
            nameTimer = setTimeout(() => {
                if (!v) return;
                if (v === meName()) return;
                Store.set('meName', v, { scope: 'global' });
                bus.emit(EV.AVATAR_CHANGED, { who: 'me' });
            }, 300);
        });
        me.addEventListener('blur', () => {
            clearTimeout(nameTimer);
            const v = (me.value || '').trim();
            if (!v) { me.value = meName(); return; }
            if (v !== meName()) {
                Store.set('meName', v, { scope: 'global' });
                bus.emit(EV.AVATAR_CHANGED, { who: 'me' });
                toast('你的昵称改成「' + v + '」了', 'ok');
            }
        });
    }

    /* ---------------- 气泡 CSS 草稿（input 只写草稿 + 预览，不应用） ---------------- */
    function bindCssDraft() {
        const ta = ui.body.querySelector('[data-cssdraft]');
        if (!ta) return;
        ta.addEventListener('input', () => {
            Settings.setS('bubbleCssDraft', ta.value);
            applyPreview();   // 只刷预览框，不 render（保焦点）
        });
    }

    function applyCssDraft() {
        const ta = ui.body.querySelector('[data-cssdraft]');
        const v = ta ? ta.value : '';
        Settings.patchS({ bubbleCss: v, bubbleCssDraft: v });
        render();
        toast(v.trim() ? '气泡代码已应用' : '代码是空的，已恢复默认气泡', 'ok');
    }

    function clearCssDraft() {
        Settings.patchS({ bubbleCss: '', bubbleCssDraft: '' });
        render();
        toast('已清除气泡代码', 'ok');
    }

    /** 导入 .css 文件 → 读文本 → 填进草稿 → 立刻预览（不自动应用） */
    async function importCssFile() {
        const f = await pickFile('.css,text/css');
        if (!f || !f.data) return;
        // pickFile 给的是 dataURL，解出文本
        let text = '';
        try {
            const comma = f.data.indexOf(',');
            const meta = f.data.slice(0, comma);
            const body = f.data.slice(comma + 1);
            text = /base64/i.test(meta)
                ? decodeURIComponent(escape(atob(body)))
                : decodeURIComponent(body);
        } catch {
            toast('这个文件读不出来，确认是 .css 文本', 'warn', 2600);
            return;
        }
        if (!text.trim()) { toast('文件是空的', 'warn'); return; }
        Settings.setS('bubbleCssDraft', text);
        render();
        toast('已导入「' + f.name + '」，看下预览，满意再点应用', 'ok', 2800);
    }

    function bind() {
        /* 分区折叠：点标题开/合（不重渲染，避免输入框丢焦点） */
        delegate(root, 'click', '[data-secfold]', (e, t) => {
            const sec = t.closest('.cs-sec');
            if (sec) sec.classList.toggle('open');
        });

        /* 栏目切换 */
        delegate(root, 'click', '[data-tab]', (e, t) => {
            tab = t.getAttribute('data-tab');
            render();
            ui.body.scrollTop = 0;
        });

        /* 返回 / 完成 / 区块动作 */
        delegate(root, 'click', '[data-act]', (e, t) => {
            const act = t.getAttribute('data-act');
            if (act === 'back' || act === 'done') { try { Page.back(); } catch { /* noop */ } }
            else if (act === 'upbg') uploadBg();
            else if (act === 'clrbg') { Settings.patchS({ bg: '', bgColor: '' }); render(); toast('已恢复默认背景', 'ok'); }
            else if (act === 'upfont') uploadFont();
            else if (act === 'usefonturl') useFontUrl();
            else if (act === 'clrfont') clearFont();
            else if (act === 'applycss') applyCssDraft();
            else if (act === 'clrcss') clearCssDraft();
            else if (act === 'importcss') importCssFile();
            else if (act === 'export') exportChat();
            else if (act === 'import') importChat();
            else if (act === 'clearchat') clearChat();
            else if (act === 'delcontact') deleteContact();
        });

        /* 开关 */
        delegate(root, 'click', '[data-sw]', (e, t) => {
            const path = t.getAttribute('data-sw');
            const next = !getPath(path);
            setPath(path, next);
            render();
        });

        /* 折叠 */
        delegate(root, 'click', '[data-fold]', (e, t) => {
            const key = t.getAttribute('data-fold');
            if (foldOpen.has(key)) foldOpen.delete(key); else foldOpen.add(key);
            render();
        });

        /* 分段：头像形状 / 磨砂 / 回执样式 */
        delegate(root, 'click', '[data-shape]', (e, t) => {
            Settings.setG('avatarShape', t.getAttribute('data-shape')); render();
        });
        delegate(root, 'click', '[data-frost]', (e, t) => {
            Settings.setG('frosting', t.getAttribute('data-frost')); render();
        });
        delegate(root, 'click', '[data-rrstyle]', (e, t) => {
            Settings.setG('readReceiptStyle', t.getAttribute('data-rrstyle')); render();
        });

        /* 时间戳位置 / 格式 */
        delegate(root, 'click', '[data-stamp]', (e, t) => {
            Settings.setG('stampStyle', t.getAttribute('data-stamp')); render();
        });
        delegate(root, 'click', '[data-stampfmt]', (e, t) => {
            Settings.setG('stampFormat', t.getAttribute('data-stampfmt')); render();
        });

        /* 背景纯色 */
        delegate(root, 'click', '[data-bgcolor]', (e, t) => {
            Settings.patchS({ bg: '', bgColor: t.getAttribute('data-bgcolor') });
            render();
        });

        /* 字号 / 头像框大小 / 头像框 XY / 聊天头像大小 / 拼字卡条数（数字行） */
        delegate(root, 'click', '[data-fontsz]', (e, t) => {
            const n = Math.max(10, Math.min(32, Settings.g().fontSize + Number(t.getAttribute('data-fontsz'))));
            Settings.setG('fontSize', n); render();
        });
        delegate(root, 'click', '[data-fontsz2]', (e, t) => {
            Settings.setG('fontSize', Number(t.getAttribute('data-fontsz2'))); render();
        });
        delegate(root, 'change', '[data-fontszinput]', (e, t) => {
            Settings.setG('fontSize', Math.max(10, Math.min(32, Number(t.value) || 16))); render();
        });

        delegate(root, 'click', '[data-fsize]', (e, t) => {
            const n = Math.max(20, Math.min(72, Settings.g().frameSize + Number(t.getAttribute('data-fsize'))));
            Settings.setG('frameSize', n); render();
        });
        delegate(root, 'click', '[data-fsize2]', (e, t) => {
            Settings.setG('frameSize', Number(t.getAttribute('data-fsize2'))); render();
        });
        delegate(root, 'change', '[data-fsizeinput]', (e, t) => {
            Settings.setG('frameSize', Math.max(20, Math.min(72, Number(t.value) || 30))); render();
        });

        delegate(root, 'click', '[data-fx]', (e, t) => {
            const n = Math.max(-30, Math.min(30, (Settings.g().frameX || 0) + Number(t.getAttribute('data-fx'))));
            Settings.setG('frameX', n); render();
        });
        delegate(root, 'change', '[data-fxinput]', (e, t) => {
            Settings.setG('frameX', Math.max(-30, Math.min(30, Number(t.value) || 0))); render();
        });
        delegate(root, 'click', '[data-fy]', (e, t) => {
            const n = Math.max(-30, Math.min(30, (Settings.g().frameY || 0) + Number(t.getAttribute('data-fy'))));
            Settings.setG('frameY', n); render();
        });
        delegate(root, 'change', '[data-fyinput]', (e, t) => {
            Settings.setG('frameY', Math.max(-30, Math.min(30, Number(t.value) || 0))); render();
        });

        delegate(root, 'click', '[data-avsize]', (e, t) => {
            const n = Math.max(20, Math.min(80, Settings.g().chatAvatarSize + Number(t.getAttribute('data-avsize'))));
            Settings.setG('chatAvatarSize', n); render();
        });
        delegate(root, 'click', '[data-avsize2]', (e, t) => {
            Settings.setG('chatAvatarSize', Number(t.getAttribute('data-avsize2'))); render();
        });
        delegate(root, 'change', '[data-avsizeinput]', (e, t) => {
            Settings.setG('chatAvatarSize', Math.max(20, Math.min(80, Number(t.value) || 38))); render();
        });

        /* 字色：我方 / 对方（cme_fcolor / cta_fcolor） */
        delegate(root, 'click', '[data-cme_fcolor]', (e, t) => {
            Settings.setG('fontColorMe', t.getAttribute('data-cme_fcolor')); render();
        });
        delegate(root, 'click', '[data-cta_fcolor]', (e, t) => {
            Settings.setG('fontColorTa', t.getAttribute('data-cta_fcolor')); render();
        });
        delegate(root, 'input', '[data-cme_fcolor2]', (e, t) => { Settings.setG('fontColorMe', t.value); });
        delegate(root, 'input', '[data-cta_fcolor2]', (e, t) => { Settings.setG('fontColorTa', t.value); });

        /* 气泡色：我方 / 对方（cme_bcolor / cta_bcolor） */
        delegate(root, 'click', '[data-cme_bcolor]', (e, t) => {
            Settings.setS('bubbleColorMe', t.getAttribute('data-cme_bcolor')); render();
        });
        delegate(root, 'click', '[data-cta_bcolor]', (e, t) => {
            Settings.setS('bubbleColorTa', t.getAttribute('data-cta_bcolor')); render();
        });
        delegate(root, 'input', '[data-cme_bcolor2]', (e, t) => { Settings.setS('bubbleColorMe', t.value); });
        delegate(root, 'input', '[data-cta_bcolor2]', (e, t) => { Settings.setS('bubbleColorTa', t.value); });

        /* 已读不回概率挪到桌面「数据设置」，这里不再重复 */

        /* 头像 / 头像框 */
        delegate(root, 'click', '[data-upav]', (e, t) => uploadAvatar(t.getAttribute('data-upav')));
        delegate(root, 'click', '[data-upframe]', (e, t) => uploadFrame(t.getAttribute('data-upframe')));
        delegate(root, 'click', '[data-clrframe]', (e, t) => {
            const who = t.getAttribute('data-clrframe');
            Settings.setS(who === 'me' ? 'frameMe' : 'frameTa', '');
            render();
            toast('已去掉头像框', 'ok');
        });

        /* 改名字：input 实时保存（bindNameInput 里另绑） */
        delegate(root, 'change', '[data-name]', (e, t) => {
            const c = contact();
            if (!c) return;
            const v = (t.value || '').trim();
            if (!v) { t.value = c.name; return; }
            if (v !== c.name) { Session.update(c.id, { name: v }); toast('已改名为「' + v + '」', 'ok'); }
        });

        /* 气泡 CSS 草稿：input 只写草稿 + 预览（bindCssDraft 里另绑） */
    }

    const offs = [];
    offs.push(bus.on(EV.CONTACTS_CHANGED, () => render()));
    offs.push(bus.on(EV.AVATAR_CHANGED, () => render()));

    build();
    bind();
    render();

    return {
        resume() { render(); },
        destroy() {
            offs.forEach((o) => { try { o(); } catch { /* noop */ } });
            clearTimeout(nameTimer);
            const el = document.getElementById('cs-bub-css');
            if (el) el.remove();
        }
    };
}
