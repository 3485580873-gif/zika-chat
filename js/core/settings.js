/* ============================================================
   settings.js — 聊天设置（数据层）
   ------------------------------------------------------------
   分两层的原则（用户拍板）：
     · 全局层   scope:'global'  —— 字体、字号、字色、时间戳、输入习惯
     · 会话层   scope:'session' —— 背景、头像框、气泡 CSS、已读不回、免打扰、拉黑
       会话层随联系人自动切换，切换联系人不可能互相污染。

   界面只读 Settings，不直接碰 localStorage。
   ============================================================ */

import { Store } from './store.js';
import { bus, EV } from './bus.js';
import { IDB } from './idb.js';

const G_KEY = 'chatStyleGlobal';   // global
const S_KEY = 'chatStyle';         // session（按联系人隔离）

/* ---------------- 默认值 ---------------- */
const G_DEFAULT = {
    fontSize: 16,          // 正文字号 px
    fontColorMe: '',       // 我方字体颜色（空 = 跟随主题）
    fontColorTa: '',       // 对方字体颜色（空 = 跟随主题）
    fontName: '',          // 已上传字体的名字
    fontBlob: 0,           // 字体文件在 IDB 里（1 = 有，localStorage 只存标记，dataURL 太大存不下）
    fontUrl: '',           // 字体文件 URL（粘贴链接）
    stampShow: 1,          // 是否显示时间戳
    stampFormat: 'rel',    // 见 STAMP_FORMATS（12 档，默认智能相对）
    stampStyle: 'under-av',// 时间戳位置（mochi 七种，见 STAMP_STYLES）
    avatarShape: 'circle', // circle | rounded | square
    /* 头像框大小/位置：我方与对方各自一套（原来共用一个值，用户明确要求分开调） */
    frameSizeMe: 30,       // 我的头像框大小 px
    frameSizeTa: 30,       // 对方头像框大小 px
    frameXMe: 0,           // 我的：水平偏移 px（正=右移）
    frameYMe: 0,           // 我的：垂直偏移 px（正=下移）
    frameXTa: 0,           // 对方：水平偏移 px
    frameYTa: 0,           // 对方：垂直偏移 px
    chatAvatarSize: 38,    // 聊天界面里头像大小 px（与头像框分开调）
    frosting: 'normal',    // 顶栏底栏磨砂强度 light | normal | strong
    enterSend: 1,          // 回车发送
    voiceInput: 1,         // 输入框旁边「语音图标」显示开关
    readReceipt: 0,        // 已读回执
    readReceiptStyle: 'icon', // text 文字（已读/未读） | icon 图形（✓ / ✓✓）
    typingShow: 1,         // 正在输入
    quoteReply: 1,         // 引用回复（长按消息后可引用原消息）
    /* 底栏图标配色（空 = 跟随主题） */
    barIconInput: '',      // 输入框
    barIconVoice: '',      // 语音
    barIconSticker: '',    // 表情包
    barIconTools: '',      // 工具栏
    barIconSend: '',       // 发送键

    /* ---- 全局美化（主界面） ---- */
    homeBg: '',             // 主界面背景图
    homeBgOpacity: 82,      // 主界面背景不透明度 %
    themeKey: 'mist-pink',  // 主题配色（见 THEME_PRESETS，淡色系）

    /* ---- 节奏（全局） ---- */
    replyDelayMin: 2,       // 对方回复最快几秒
    replyDelayMax: 20,      // 对方回复最慢几秒（上限可到 600）
    replyCountMin: 1,       // 回复条数最少
    replyCountMax: 2,       // 回复条数最多
    pushEnabled: 0,        // 对方主动发消息总开关
    pushProb: 30,          // 主动发送概率 %
    pushMinM: 5,           // 主动发消息最短间隔（分钟）
    pushMaxM: 10,          // 主动发消息最长间隔（分钟，上限 720）
    pushCountMin: 1,       // 主动发送条数最少
    pushCountMax: 2,       // 主动发送条数最多
    pushBadge: 1,          // 主动发送标识开关
    pushBadgeList: ['❤️', '⭐', '🌙', '✦', '🐾'],  // 标识池（前五个系统自带可开关；自定义追加在后）

    pinyinCard: 1,         // 拼字卡：对方发言时按概率抽几张拼成一条（不是"我"的工具）
    pinyinCardProb: 35,    // 触发概率 %
    pinyinCardMin: 1,      // 最少几条
    pinyinCardMax: 3,      // 最多几条

    /* ---- 对方行为概率（全部全局，对应 mochi 节奏页） ---- */
    pokeProb: 5,           // 拍一拍概率 %
    taStickerProb: 10,     // 表情包概率 %（总开关不再单列，概率 0 即关）
    emojiProb: 5,          // emoji 附加概率 %
    photoProb: 5,          // 图片概率 %
    voiceProb: 10,         // 语音概率 %
    kaomojiProb: 5,        // 颜文字附加概率 %
    quoteProb: 30,         // 引用概率 %
    taRecallProb: 6,        // TA 撤回自己消息的概率 %
    recallResend: 1,        // 撤回后补发一条
    recallResendProb: 35,   // 撤回后补发的概率 %

    /* ---------- 视频通话（★ v41 新增，键名与 mochi 对齐） ----------
       以前这些概率全部硬编码在 call.js 里（25% 来电 / 35% 拒接 / 3% 挂断），
       用户没法调。现在全部走设置：
         总开关用 1/0；其余为百分比 0~100，间隔单位分钟。 */
    callIncomingOn: 1,      // 对方来电总开关
    callIncoming: 25,       // 来电概率 %
    callEveryMin: 15,       // 最短间隔（分钟）
    callEveryMax: 60,       // 最长间隔（分钟）
    callPickupOn: 1,        // 我打过去总开关（关掉=一律直接接通）
    callPickup: 60,         // 接通概率 %（其余为未接听）
    callBusy: 10,           // 忙线 %
    callReject: 25,         // 拒接 %
    callHangProb: 3,        // 通话中对方主动挂断 %
    callNoHangup: 0,        // 1 = 禁止对方挂断（总开关，硬拦）
    callMini: 1,            // 最小化胶囊
    callResume: 1,          // 闪退/刷新后问是否继续通话

    /* 已读不回（回信）默认：新联系人没单独设过时跟随这个全局值 */
    noReplyDefault: 0,     // 0 = 默认会回；1 = 默认已读不回
    noReplyProb: 20,       // 已读不回概率 %（全局）

    /* ---- 聊天头像显示（用户 2026-10-17 拍板，图二三个开关） ---- */
    avatarShow: 1,         // 显示聊天头像（0 = 消息旁不显示头像）
    avatarEvery: 0,        // 每条消息都显示头像（0 = 仅首条消息显示）
    showTaName: 0,         // 单人模式显示对方名字（0 = 不显示）

    /* ---- 消息提醒与通知（用户 2026-10-17 新增，默认全关） ---- */
    soundMsg: 0,           // 角色回复播放提示音（还要自己上传音频才有声音）
    soundRing: 0           // 来电响铃（还要自己上传音频才有声音）
};

const S_DEFAULT = {
    bg: '',                // 背景图 dataURL
    bgColor: '',           // 纯色背景（与 bg 二选一）
    bubbleCss: '',         // 自定义气泡 CSS（已应用，整体一段，evanlu 格式）
    bubbleCssDraft: '',    // 气泡 CSS 草稿（文本框里的内容，点「应用」才写入 bubbleCss）
    bubbleColorMe: '',     // 我方气泡颜色（空 = 跟随主题）
    bubbleColorTa: '',     // 对方气泡颜色（空 = 跟随主题）
    frameMe: '',           // 我的头像框
    frameTa: '',           // TA 头像框
    noReply: null,         // 已读不回开关（null = 跟随全局 noReplyDefault）
    noReplyProb: 30,       // 已读不回概率 %
    muted: 0,              // 消息免打扰
    blocked: 0             // 拉黑
};

/** 时间戳样式（mochi 的七种） */
export const STAMP_STYLES = [
    { v: 'under-av',    name: '头像下方' },
    { v: 'under-bubble', name: '气泡下方' },
    { v: 'bubble',      name: '时间气泡' },
    { v: 'float',       name: '气泡外侧悬浮' },
    { v: 'center',      name: '消息上方居中' },
    { v: 'divider',     name: '时间分隔线' },
    { v: 'hidden',      name: '隐藏' }
];

/** 磨砂强度档位 */
export const FROSTINGS = [
    { v: 'light',  name: '淡' },
    { v: 'normal', name: '中' },
    { v: 'strong', name: '浓' }
];

/** 时间戳格式（evanlu 五档，每档真的有区别） */
/**
 * 时间戳格式（12 档，每档输出真的不一样 —— 用户明确投诉过"写这么多有啥用，都一样"）
 * hint 就是界面上的示例，所见即所得。
 * 分隔条用 stampText（完整），消息旁小字用 miniStamp（短版），
 * 两边都按同一套 v 值走，切换后立刻能看出差别。
 */
export const STAMP_FORMATS = [
    { v: 'rel',    name: '智能相对',   hint: '刚刚 · 3分钟前 · 昨天 14:30 · 10月2日' },
    { v: 'hm',     name: '24小时制',   hint: '14:30' },
    { v: 'hms',    name: '时分秒',     hint: '14:30:05' },
    { v: 'hma',    name: '12小时制',   hint: '2:30 PM' },
    { v: 'hmsa',   name: '12小时带秒', hint: '2:30:05 PM' },
    { v: 'md',     name: '月日 + 时分', hint: '10-13 14:30' },
    { v: 'slash',  name: '斜杠 + 时分', hint: '10/13 14:30' },
    { v: 'cn',     name: '中文月日',   hint: '10月13日 14:30' },
    { v: 'dot',    name: '点分隔',     hint: '10.13 14:30' },
    { v: 'week',   name: '星期 + 时分', hint: '周一 14:30' },
    { v: 'ymd',    name: '完整年月日', hint: '2026-10-13 14:30' },
    { v: 'ymd_cn', name: '中文年月日', hint: '2026年10月13日' },
    { v: 'off',    name: '不显示',     hint: '只留开关，彻底不显示' }
];

/* 上传字体注册后的家族名统一叫这个，避免每次不同 */
export const FONT_FAMILY = 'ZikaUserFont';

function merge(def, cur) {
    const out = Object.assign({}, def);
    if (cur && typeof cur === 'object') {
        // ★ v41 修正（重要）：以前只遍历 Object.keys(def)，
        //   意味着**凡是 G_DEFAULT 里没登记的键，localStorage 里存了也会被丢掉**。
        //   症状：新增设置项（v41 的 9 个通话设置就是这样）点 +/- 有 setG 调用、
        //   localStorage 里也真写进去了，但 Settings.g() 读回来是 undefined
        //   → 界面永远显示默认值、点了不起作用，而且没有任何报错。
        //   现在两段都跑：
        //     ① 有默认值的键 → 按默认值做类型清洗（防历史脏数据）
        //     ② 没默认值的键 → 原样保留（以后新增设置项不会再踩这个坑）
        Object.keys(def).forEach((k) => {
            const v = cur[k];
            if (v === undefined || v === null) return;
            // 类型要和默认值一致，避免历史脏数据
            if (typeof def[k] === 'number') {
                const n = Number(v);
                if (!Number.isNaN(n)) out[k] = n;
            } else if (typeof def[k] === 'string') {
                out[k] = String(v);
            } else {
                out[k] = v;
            }
        });
        Object.keys(cur).forEach((k) => {
            if (k in def) return;                       // 上面已处理
            if (cur[k] === undefined) return;
            out[k] = cur[k];                             // 未登记的键：原样带过
        });
    }
    return out;
}

/* ---------------- 字体注册 ----------------
   之前用 `new FontFace(name, 'url(<dataURL>)')`，dataURL 里带分号/逗号/加号，
   部分浏览器在 url() 无引号形式下解析失败（表现为「字体上传没效果」）。
   改成先把 dataURL 解码成 ArrayBuffer 再喂给 FontFace —— 这是最稳的路径。 */
let fontToken = 0;
let fontMem = '';        // IDB 里的字体 dataURL 内存缓存（避免每次 apply 都读库）

function dataUrlToBuffer(dataUrl) {
    const s = String(dataUrl || '');
    const i = s.indexOf(',');
    if (i < 0) return null;
    const bin = atob(s.slice(i + 1));
    const buf = new ArrayBuffer(bin.length);
    const view = new Uint8Array(buf);
    for (let j = 0; j < bin.length; j++) view[j] = bin.charCodeAt(j);
    return buf;
}

function registerFont(data) {
    return new Promise((resolve) => {
        try {
            if (!data || !window.FontFace) { resolve(false); return; }
            const buf = dataUrlToBuffer(data);
            if (!buf) { resolve(false); return; }

            // 移除旧的（同名只能有一个）
            try {
                const old = Array.from(document.fonts).find((f) => f.family === FONT_FAMILY);
                if (old) document.fonts.delete(old);
            } catch { /* noop */ }

            const token = ++fontToken;
            const face = new FontFace(FONT_FAMILY, buf);
            face.load().then(() => {
                if (token !== fontToken) { resolve(false); return; }  // 已有更新的字体在加载
                document.fonts.add(face);
                resolve(true);
            }).catch((err) => {
                console.warn('[字体] 加载失败', err);
                resolve(false);
            });
        } catch (err) {
            console.warn('[字体] 注册异常', err);
            resolve(false);
        }
    });
}

/** 从 URL 注册字体（跨源需对方服务器允许 CORS） */
function registerFontFromUrl(url) {
    return new Promise((resolve) => {
        try {
            if (!url || !window.FontFace) { resolve(false); return; }
            const token = ++fontToken;
            const face = new FontFace(FONT_FAMILY, 'url("' + url + '")');
            face.load().then(() => {
                if (token !== fontToken) { resolve(false); return; }
                try {
                    const old = Array.from(document.fonts).find((f) => f.family === FONT_FAMILY);
                    if (old) document.fonts.delete(old);
                } catch { /* noop */ }
                document.fonts.add(face);
                resolve(true);
            }).catch((err) => {
                console.warn('[字体] URL 加载失败（可能跨源被拦）', err);
                resolve(false);
            });
        } catch (err) {
            console.warn('[字体] URL 注册异常', err);
            resolve(false);
        }
    });
}

/* ★ 读缓存：g()/s() 老实现每次调用都 JSON.parse 一整个设置对象
   （Store.get → localStorage.getItem → JSON.parse）。
   发送一条消息的链路里 Settings.g() 要被调七八次，聊天页 render 又调几次，
   几百次/秒的 parse 就是「发消息卡一下」的主因之一（2026-10-17 抓到）。
   现在同一会话内缓存一份，写入（setG/setS/setK）时失效；
   跨标签页/后台写入靠 storage 事件 + apply() 兜底刷新。 */
let _gCache = null;
let _gRaw = null;
let _sCache = null;
let _sRaw = null;

function bustCache() { _gCache = _gRaw = _sCache = _sRaw = null; }

/* 导入备份 / 别的标签页改设置 → 缓存必须失效，否则「导入后界面没反应」。
   storage 事件只在**别的标签页**写入时触发；同页导入走 bus 事件。
   实际键名（见本文件顶部）：global = zika_chatStyleGlobal，session = zika_<联系人id>:chatStyle */
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('storage', (e) => {
        const k = e.key || '';
        if (k.indexOf('chatStyle') >= 0 || k.indexOf('zika_') === 0) bustCache();
    });
}

export const Settings = {
    /* ---------- 全局层 ---------- */
    g() {
        Settings._migrate();
        const raw = Store.get(G_KEY, null, { scope: 'global' });
        if (_gCache && raw === _gRaw) return _gCache;
        _gRaw = raw;
        _gCache = merge(G_DEFAULT, raw);
        return _gCache;
    },

    /* 旧版单字色 → 我方/对方拆分 + 旧版 fontData（localStorage）→ IDB */
    _migrate() {
        if (Settings._migrated) return;
        Settings._migrated = true;
        try {
            const cur = Store.get(G_KEY, null, { scope: 'global' });
            if (!cur) return;
            let dirty = false;
            if (cur.fontColor && cur.fontColorMe == null && cur.fontColorTa == null) {
                cur.fontColorMe = cur.fontColor;
                cur.fontColorTa = cur.fontColor;
                dirty = true;
            }
            // 老时间戳档位名 → v13 的 12 档（不然老用户停在已删除的档上，界面看着没反应）
            const STAMP_OLD_MAP = {
                auto: 'rel', ios: 'slash', md_cn: 'cn', full: 'ymd', date: 'ymd'
            };
            if (cur.stampFormat && STAMP_OLD_MAP[cur.stampFormat]) {
                cur.stampFormat = STAMP_OLD_MAP[cur.stampFormat];
                dirty = true;
            }
            // 老版字体 dataURL 存在 localStorage 里（爆配额风险）→ 搬 IDB
            if (cur.fontData) {
                IDB.set('fontBlob', cur.fontData).then(() => {
                    delete cur.fontData;
                    cur.fontBlob = 1;
                    Store.set(G_KEY, cur, { scope: 'global' });
                    Settings.apply();
                });
                return;
            }
            if (dirty) Store.set(G_KEY, cur, { scope: 'global' });
        } catch { /* noop */ }
    },

    setG(key, value) {
        const cur = Settings.g();
        cur[key] = value;
        Store.set(G_KEY, cur, { scope: 'global' });
        bustCache();
        Settings.apply();
        bus.emit(EV.STYLE_CHANGED, { scope: 'global', key, value });
        return cur;
    },

    patchG(patch) {
        const cur = Object.assign(Settings.g(), patch || {});
        Store.set(G_KEY, cur, { scope: 'global' });
        bustCache();
        Settings.apply();
        bus.emit(EV.STYLE_CHANGED, { scope: 'global' });
        return cur;
    },

    /* ---------- 会话层 ---------- */
    s() {
        const raw = Store.get(S_KEY, null, { scope: 'session' });
        if (_sCache && raw === _sRaw) return _sCache;
        _sRaw = raw;
        _sCache = merge(S_DEFAULT, raw);
        return _sCache;
    },

    setS(key, value) {
        const cur = Settings.s();
        cur[key] = value;
        Store.set(S_KEY, cur, { scope: 'session' });
        bustCache();
        Settings.apply();
        bus.emit(EV.STYLE_CHANGED, { scope: 'session', key, value });
        return cur;
    },

    patchS(patch) {
        const cur = Object.assign(Settings.s(), patch || {});
        Store.set(S_KEY, cur, { scope: 'session' });
        bustCache();
        Settings.apply();
        bus.emit(EV.STYLE_CHANGED, { scope: 'session' });
        return cur;
    },

    /* ---------- 应用到 DOM ---------- */
    apply() {
        const g = Settings.g();
        const s = Settings.s();
        const r = document.documentElement;

        r.style.setProperty('--msg-font-size', Math.max(10, Math.min(32, g.fontSize)) + 'px');
        // 字体：先挂 family，字体异步加载完浏览器会自动套上。
        // 注意回退值必须是合法 family 名（sans-serif），写 inherit 整条声明会被浏览器丢弃
        // 字体本体在 IDB（fontBlob=1），dataURL 太大 localStorage 存不下
        const hasFont = !!(g.fontBlob || g.fontUrl || fontMem);
        r.style.setProperty('--msg-font-family', hasFont ? ('"' + FONT_FAMILY + '", sans-serif') : 'inherit');
        // 字色：我方 / 对方分开（空则跟随主题）
        r.style.setProperty('--msg-me-text', g.fontColorMe || 'var(--me-fg, var(--text))');
        r.style.setProperty('--msg-ta-text', g.fontColorTa || 'var(--ta-fg, var(--text))');

        // 头像形状
        const radius = g.avatarShape === 'square' ? '6px'
            : g.avatarShape === 'rounded' ? '10px' : '50%';
        r.style.setProperty('--avatar-radius', radius);

        // 聊天界面头像大小（与头像框分开调）
        r.style.setProperty('--chat-avatar-size', Math.max(20, Math.min(80, g.chatAvatarSize)) + 'px');
        // 底栏图标配色（空值不写，CSS 侧回落到主题色）
        ['Input', 'Voice', 'Sticker', 'Tools', 'Send'].forEach((n) => {
            const v = g['barIcon' + n];
            if (v) r.style.setProperty('--bar-icon-' + n.toLowerCase(), v);
        });
        // 头像框：叠加在头像外圈，可调大小 + 偏移位置
        const cl = (n, lo, hi) => Math.max(lo, Math.min(hi, n || lo)) + 'px';
        r.style.setProperty('--frame-size-me', cl(g.frameSizeMe, 20, 96));
        r.style.setProperty('--frame-size-ta', cl(g.frameSizeTa, 20, 96));
        r.style.setProperty('--frame-x-me', (g.frameXMe || 0) + 'px');
        r.style.setProperty('--frame-y-me', (g.frameYMe || 0) + 'px');
        r.style.setProperty('--frame-x-ta', (g.frameXTa || 0) + 'px');
        r.style.setProperty('--frame-y-ta', (g.frameYTa || 0) + 'px');
        r.style.setProperty('--frame-me', s.frameMe ? 'url("' + s.frameMe + '")' : 'none');
        r.style.setProperty('--frame-ta', s.frameTa ? 'url("' + s.frameTa + '")' : 'none');

        // 气泡颜色：我方 / 对方分开（空则跟随主题）
        r.style.setProperty('--bubble-me', s.bubbleColorMe || 'var(--me-bg)');
        r.style.setProperty('--bubble-ta', s.bubbleColorTa || 'var(--ta-bg)');

        // 磨砂强度（顶栏 / 底栏）
        const frost = {
            light:  { a: '0.10', b: '12px' },
            normal: { a: '0.22', b: '24px' },
            strong: { a: '0.36', b: '34px' }
        }[g.frosting] || { a: '0.22', b: '24px' };
        r.style.setProperty('--bar-alpha', frost.a);
        r.style.setProperty('--bar-blur', frost.b);

        // 背景（会话层）
        if (s.bg) {
            r.style.setProperty('--chat-bg-image', 'url("' + s.bg + '")');
            r.style.setProperty('--chat-bg-color', s.bgColor || 'transparent');
        } else {
            r.style.setProperty('--chat-bg-image', 'none');
            r.style.setProperty('--chat-bg-color', s.bgColor || 'var(--bg)');
        }

        // 时间戳样式：body 上挂类（mochi 的做法，纯 CSS 生效）
        // 总开关关掉时等同于「隐藏」
        const stampStyle = g.stampShow ? g.stampStyle : 'hidden';
        STAMP_STYLES.forEach((x) => document.body.classList.remove('cs-time-' + x.v));
        if (stampStyle !== 'under-av') document.body.classList.add('cs-time-' + stampStyle);

        // 气泡自定义 CSS（会话层，整体一段）
        Settings.applyBubbleCss(s.bubbleCss);

        // 字体异步注册（成功后再触发一次重排，让气泡立刻用上新字体）
        // 本体可能在 IDB（内存缓存 fontMem）或 URL；都没有才跳过
        const blobData = fontMem;
        if (blobData) {
            registerFont(blobData).then((ok) => {
                if (ok && document.fonts && document.fonts.ready) {
                    document.fonts.ready.then(() => {
                        bus.emit(EV.STYLE_CHANGED, { scope: 'global', key: 'fontReady' });
                    });
                }
            });
        } else if (g.fontUrl) {
            registerFontFromUrl(g.fontUrl).then((ok) => {
                if (ok && document.fonts && document.fonts.ready) {
                    document.fonts.ready.then(() => {
                        bus.emit(EV.STYLE_CHANGED, { scope: 'global', key: 'fontReady' });
                    });
                }
            });
        }
    },

    /**
     * 注入气泡 CSS（evanlu 的格式：整段一起写，不分开）。
     * 注入两份：
     *   ① 用户原样；
     *   ② 加权版 —— 每条规则自动加作用域前缀 + !important，
     *      这样即使和主题里的 !important 撞上，用户写的也能赢。
     */
    applyBubbleCss(css) {
        let el = document.getElementById('zk-bubble-css');
        if (!el) {
            el = document.createElement('style');
            el.id = 'zk-bubble-css';
            document.head.appendChild(el);
        }
        if (!String(css || '').trim()) { el.textContent = ''; return; }
        // ★ 注入前先比内容：样式没变就别重新写 textContent。
        //   重写 <style> 会让浏览器整份重解析，evanlu 那种几百行的气泡 CSS
        //   每次输入都重解析一次，主线程直接卡住半屏（用户报过）。
        const next = String(css) + '\n' + Settings.boostCss(css, '.chat-msgs');
        if (el.getAttribute('data-zika-css') === next) return;
        el.setAttribute('data-zika-css', next);
        el.textContent = next;
    },

    /**
     * 给一段用户 CSS 加权（evanlu 的 boostUserCss 思路）。
     * 选择器统一加作用域前缀；声明里的每条都补 !important（已有则不重复）。
     * @-规则（@media / @font-face …）原样保留，不乱动。
     */
    boostCss(css, scopeSel) {
        const text = String(css || '').trim();
        if (!text) return '';

        // 按顶层 { } 切块，@ 块整块保留
        const blocks = [];
        let i = 0;
        while (i < text.length) {
            const open = text.indexOf('{', i);
            if (open < 0) break;
            const close = text.indexOf('}', open);
            if (close < 0) break;
            blocks.push({ sel: text.slice(i, open), body: text.slice(open + 1, close) });
            i = close + 1;
        }
        if (!blocks.length) return '';

        return blocks.map((b) => {
            const sel = b.sel.trim();
            if (!sel) return '';
            if (sel.startsWith('@')) return sel + '{' + b.body + '}';

            const scoped = sel.split(',').map((x) => {
                const t = x.trim();
                if (!t) return '';
                // 已经带作用域前缀的不再重复加
                if (t.indexOf(scopeSel) === 0) return t;
                return scopeSel + ' ' + t;
            }).filter(Boolean).join(', ');

            const body = b.body.split(';').map((d) => {
                const t = d.trim();
                if (!t) return '';
                return /!\s*important\s*$/i.test(t) ? t : (t + ' !important');
            }).filter(Boolean).join(';');

            return scoped + '{' + body + '}';
        }).filter(Boolean).join('\n');
    },

    /** 设置页预览用：把 CSS 限制在预览框里 */
    previewCss(css, scopeSel) {
        return Settings.boostCss(css, scopeSel);
    },

    /* ---------- 时间戳 ---------- */

    /** 把时间戳算成所有档位都用得到的中间量 */
    _stampParts(ts) {
        const d = new Date(ts);
        const now = new Date();
        const p = (n) => ('0' + n).slice(-2);
        const h24 = d.getHours();
        const h12 = (h24 % 12) || 12;
        const ap = h24 < 12 ? 'AM' : 'PM';
        const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        return {
            hm: p(h24) + ':' + p(d.getMinutes()),
            hms: p(h24) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()),
            hma: h12 + ':' + p(d.getMinutes()) + ' ' + ap,
            hmsa: h12 + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + ' ' + ap,
            md: (d.getMonth() + 1) + '-' + p(d.getDate()),
            slash: (d.getMonth() + 1) + '/' + p(d.getDate()),
            dot: (d.getMonth() + 1) + '.' + p(d.getDate()),
            cn: (d.getMonth() + 1) + '月' + d.getDate() + '日',
            ymd: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()),
            ymdCn: d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日',
            week: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()],
            days: Math.round((dayStart(now) - dayStart(d)) / 86400000),
            mins: Math.round((now.getTime() - ts) / 60000),
            y: d.getFullYear()
        };
    },

    /**
     * 分隔条上的完整时间（divider 模式用）。
     * 12 档每档输出都不同，不再出现"选了跟没选一样"。
     */
    stampText(ts) {
        const g = Settings.g();
        if (!g.stampShow || g.stampFormat === 'off') return '';
        const x = Settings._stampParts(ts);
        switch (g.stampFormat) {
            case 'hm':     return x.hm;
            case 'hms':    return x.hms;
            case 'hma':    return x.hma;
            case 'hmsa':   return x.hmsa;
            case 'md':     return x.md + ' ' + x.hm;
            case 'slash':  return x.slash + ' ' + x.hm;
            case 'dot':    return x.dot + ' ' + x.hm;
            case 'cn':     return x.cn + ' ' + x.hm;
            case 'week':   return x.week + ' ' + x.hm;
            case 'ymd':    return x.ymd + ' ' + x.hm;
            case 'ymd_cn': return x.ymdCn + ' ' + x.hm;
            default: {                        // rel 智能相对
                if (x.days === 0) {
                    if (x.mins < 1) return '刚刚';
                    if (x.mins < 60) return x.mins + '分钟前';
                    return '今天 ' + x.hm;
                }
                if (x.days === 1) return '昨天 ' + x.hm;
                if (x.days === 2) return '前天 ' + x.hm;
                if (x.days < 7) return x.week + ' ' + x.hm;
                if (x.y === new Date().getFullYear()) return x.cn + ' ' + x.hm;
                return x.ymdCn;
            }
        }
    },

    /** 每条消息旁的小时间戳（比分隔条短，但仍逐档不同） */
    miniStamp(ts) {
        const g = Settings.g();
        if (!g.stampShow || g.stampFormat === 'off') return '';
        const x = Settings._stampParts(ts);
        switch (g.stampFormat) {
            case 'hm':     return x.hm;
            case 'hms':    return x.hms;
            case 'hma':    return x.hma;
            case 'hmsa':   return x.hmsa;
            case 'md':     return x.md;
            case 'slash':  return x.slash;
            case 'dot':    return x.dot;
            case 'cn':     return x.cn;
            case 'week':   return x.week;
            case 'ymd':    return x.ymd;
            case 'ymd_cn': return x.ymdCn;
            default: {                        // rel
                if (x.mins < 1) return '刚刚';
                if (x.mins < 60) return x.mins + '分前';
                if (x.days === 0) return '今天 ' + x.hm;
                if (x.days === 1) return '昨天 ' + x.hm;
                if (x.days < 7) return x.week + ' ' + x.hm;
                return x.md;
            }
        }
    },

    /** 字体是否已上传（IDB 或链接） */
    hasFont() { return !!(Settings.g().fontBlob || Settings.g().fontUrl); },

    /** 从 URL 注册字体（供聊天设置调用） */
    loadFontFromUrl(url) { return registerFontFromUrl(url); },

    /**
     * 上传本地字体文件：大块头进 IndexedDB，localStorage 只留标记位。
     * @returns Promise<boolean> 是否注册成功
     */
    uploadFontBlob(data, name) {
        return IDB.set('fontBlob', data).then((ok) => {
            if (!ok) return false;
            Settings.patchG({ fontBlob: 1, fontName: name || '', fontUrl: '' });
            return registerFont(data).then((ok2) => {
                if (ok2) bus.emit(EV.STYLE_CHANGED, { scope: 'global', key: 'fontReady' });
                return ok2;
            });
        });
    },

    /** 移除本地字体（IDB + 标记一起清） */
    removeFontBlob() {
        return IDB.del('fontBlob').then(() => {
            Settings.patchG({ fontBlob: 0, fontName: '', fontUrl: '' });
            try {
                const old = Array.from(document.fonts).find((f) => f.family === FONT_FAMILY);
                if (old) document.fonts.delete(old);
            } catch { /* noop */ }
            bus.emit(EV.STYLE_CHANGED, { scope: 'global', key: 'fontReady' });
        });
    },

    /** 启动时调用：把 IDB 里的字体读出来注册（内存缓存，后续 apply 不再读库） */
    loadFontBlob() {
        return IDB.get('fontBlob').then((data) => {
            if (!data) return false;
            fontMem = data;
            return registerFont(data).then((ok) => {
                if (ok) bus.emit(EV.STYLE_CHANGED, { scope: 'global', key: 'fontReady' });
                return ok;
            });
        });
    }
};

/**
 * 主题配色预设（全局，用户在桌面「装扮」App 里挑）
 * 全部是清新淡色系：白底 + 一个柔和主色，导航/图标统一用它，
 * 配合 backdrop-filter 磨砂就是 iOS 那种观感。
 *   accent     主色（按钮、选中态、图标）
 *   accentSoft 主色淡底（标签、选中背景）
 *   surface    磨砂层底色（半透明，透出背景图）
 *   onAccent   主色上的文字色
 */
/**
 * 主题配色预设（用户 2026-10-17 拍板）：
 *   · **全部浅色系** —— 名字就用「浅粉 / 浅蓝 / 浅黄…」这种，
 *     不要抄外部 App 的名字（原话：「颜色名字不要抄，我说了我只要这种类似的展示效果」）。
 *   · 展示框 = 一整块该主题的渐变色（iOS 墙纸缩略图那样铺满），
 *     不再是「大方块 + 一堆说明字」。
 */
export const THEME_PRESETS = [
    { k: 'mist-pink',  name: '浅粉', accent: '#e3a7b9', accentSoft: '#fae4eb', surface: 'rgba(255,250,252,.72)', onAccent: '#fff', c1: '#fbe4ec', c2: '#eeb1c6' },
    { k: 'mist-blue',  name: '浅蓝', accent: '#8fb4dc', accentSoft: '#e1edf8', surface: 'rgba(250,252,255,.72)', onAccent: '#fff', c1: '#dfedfa', c2: '#aac9e8' },
    { k: 'cream',      name: '浅黄', accent: '#d9b96a', accentSoft: '#f7eed8', surface: 'rgba(255,253,248,.72)', onAccent: '#fff', c1: '#faf0d9', c2: '#e6ce93' },
    { k: 'sage',       name: '浅绿', accent: '#94b892', accentSoft: '#e3f0e0', surface: 'rgba(250,255,250,.72)', onAccent: '#fff', c1: '#e6f2e3', c2: '#b0d3aa' },
    { k: 'dusk-purple',name: '浅紫', accent: '#a89bd4', accentSoft: '#ebe6f7', surface: 'rgba(252,251,255,.72)', onAccent: '#fff', c1: '#ece6f9', c2: '#bfb2e5' },
    { k: 'apricot',    name: '浅橙', accent: '#e2a483', accentSoft: '#f9e7da', surface: 'rgba(255,252,249,.72)', onAccent: '#fff', c1: '#fce8da', c2: '#eeb694' },
    { k: 'cinnabar',   name: '浅米', accent: '#c9b294', accentSoft: '#f5eee2', surface: 'rgba(255,254,250,.72)', onAccent: '#fff', c1: '#f7f0e4', c2: '#dfcdb0' },
    { k: 'init',       name: '浅灰', accent: '#a9a9b2', accentSoft: '#efeff2', surface: 'rgba(252,252,253,.72)', onAccent: '#fff', c1: '#f6f6f8', c2: '#d9d9df' }
];

/** 取主题预设；找不到回落浅粉。旧键名（white-* / 早期那套）自动映射 */
export function themePreset(k) {
    const MAP = {
        'white-rose': 'mist-pink', 'white-peach': 'apricot', 'white-butter': 'cream',
        'white-mint': 'sage', 'white-blue': 'mist-blue', 'white-purple': 'dusk-purple',
        'white-grey': 'init', 'white-black': 'init',
        /* v27 的旧命名 → 现在的浅色系名字 */
        'night': 'init', 'mono': 'init', 'init-old': 'init',
        /* v26 的中文名也可能被存进来 */
        '雾粉': 'mist-pink', '雾蓝': 'mist-blue', '奶油黄': 'cream', '鼠尾草': 'sage',
        '暮紫': 'dusk-purple', '杏桃': 'apricot', '古风·宣纸朱砂': 'cinnabar',
        '初始': 'init', '夜间': 'init', '黑白': 'init'
    };
    const key = MAP[k] || k;
    return THEME_PRESETS.find((t) => t.k === key) || THEME_PRESETS[0];
}

/** hex → 'r,g,b'（非法输入回落白粉） */
function hexRgb(hex) {
    const h = String(hex || '').replace('#', '');
    if (h.length !== 6) return { r: 253, g: 238, b: 243 };
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** 把主题写到 :root（磨砂 surface + 主色 + 全站玻璃着色）；夜间预设顺带切深色模式 */
export function applyThemePreset(k) {
    const p = themePreset(k);
    const r = document.documentElement;
    r.setAttribute('data-theme', p.dark ? 'dark' : 'light');
    r.style.setProperty('--accent', p.accent);
    r.style.setProperty('--surface-soft', p.accentSoft);
    r.style.setProperty('--on-accent', p.onAccent);
    // ★ 只改「主界面那几层」的磨砂底色，绝不直接覆盖全局 --surface ——
    //   之前无条件覆盖 --surface，深色模式下整个界面会突然变浅色（用户看着像崩了）。
    const dark = r.getAttribute('data-theme') === 'dark';
    r.style.setProperty('--theme-surface', dark ? rgbaDark(p.accent) : p.surface);
    // ★ v30（用户 2026-10-18 纠正）：
    //   「你为什么**总让设置跟着主题颜色走**」
    //   以前这里把 --glass / --glass-strong / --glass-bg 染成主题色（清透染色），
    //   结果设置页、外观装扮页的**分区标题条、顶栏、标签栏全是粉的** ——
    //   用户要的是「和聊天设置一样的磨砂玻璃」，磨砂就该是**中性透白**，
    //   主题色只体现在 --accent（按钮/选中/强调），不该染色玻璃。
    //   现在玻璃一律回到 base.css 里的中性值，主题只管主色。
    if (!dark) {
        r.style.setProperty('--glass', 'rgba(255,255,255,.62)');
        r.style.setProperty('--glass-strong', 'rgba(255,255,255,.82)');
        r.style.setProperty('--glass-bg', 'rgba(255,255,255,.55)');
    } else {
        r.style.setProperty('--glass', 'rgba(28,28,30,.52)');
        r.style.setProperty('--glass-strong', 'rgba(28,28,30,.74)');
        r.style.setProperty('--glass-bg', 'rgba(28,28,30,.62)');
    }
    return p;
}

/** 深色模式下配套的半透明磨砂底色 */
function rgbaDark(accent) {
    const hex = String(accent || '#f2789f').replace('#', '');
    if (hex.length !== 6) return 'rgba(28,28,30,.78)';
    const n = parseInt(hex, 16);
    const r0 = (n >> 16) & 255, g0 = (n >> 8) & 255, b0 = n & 255;
    return 'rgba(' + r0 + ',' + g0 + ',' + b0 + ',.18)';
}
