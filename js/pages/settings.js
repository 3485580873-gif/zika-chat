/* ============================================================
   settings.js — 全局设置页（主界面导航栏 → 设置）
   ------------------------------------------------------------
   ★ 用户 2026-10-17 拍板（大重构）：
       设置页**只留两个栏目**：
         ① 通信设置 —— 输入 / 已读回执 / 已读不回 / 回复设置 /
            回复花样概率 / 撤回 / 主动发送 / 拼字卡
         ② 聊天数据 —— 顶部「存储用量」/ 后台保活（静音音频循环）/
            消息提醒与通知（提示音 + 响铃，需上传音频，默认关）/
            备份 / 后台通知 / 阿里云云端存储
       原来的「美化设置」整体搬到桌面「装扮」App（look.js）。
   ★ 另一条硬要求：**功能区下面不要再挂任何说明文字**
     （用户原话：「你能不能别把我说的话，放在功能下面当说明？」）
     —— 所以这里所有 hint / desc 一律不写，UI 自己说话。
   ============================================================ */

import { Store } from '../core/store.js';
import { Session } from '../core/session.js';
import { Settings, THEME_PRESETS, applyThemePreset } from '../core/settings.js';
import { OSS } from '../cloud/oss.js';
import { esc, delegate, download, pickFile } from '../ui/dom.js';
import { applyPageBg } from '../ui/pagebg.js';
import { toast } from '../ui/toast.js';
import { Page } from '../ui/page.js';
import { icon } from '../ui/icon.js';
import { KeepAlive } from '../core/bg.js';
import { Sound } from '../core/sound.js';
import { IDB } from '../core/idb.js';

const KEEPALIVE_KEY = 'keepAlive';   // 兼容旧键名：真正的读写都在 core/bg.js 里

export function SettingsPage(root, params) {
    let tab = 'comms';        // comms 通信设置 | data 聊天数据
    const ui = {};
    let docClickOff = null;   // 云端同步浮层的 document 级点击监听（destroy 时摘掉）
    // 音频文件是否已上传（IndexedDB，异步读；读到就补渲染）
    const snd = { msg: null, ring: null };

    /* ---------------- 通用片段 ---------------- */
    /**
     * 分区。折叠规则（用户 2026-10-17 拍板）：
     *   · 只有**长分区**（明确传 fold=1）才默认收起 —— 头像/背景/气泡/形状这些
     *     一眼能看完的**永远展开**，不然点一下「头像形状」就缩回去，操作太别扭。
     *   · 收起态也只收「身体」，标题永远看得见、点得动。
     *   · hint 参数保留但不传值：用户明确要求功能区下面不要说明文字。
     */
    function section(title, body, hint, fold) {
        const willFold = !!fold;
        // ★ v29：分区默认**展开**（用户：「都不要折叠了」），点标题可收起/再展开。
        const head = title
            ? ('<button class="gs-sect" type="button"' + (willFold ? ' data-secfold' : '') + '>' +
                    '<span>' + esc(title) + '</span>' +
                    (willFold ? '<i class="gs-chev">' + icon('chevronLeft', 14) + '</i>' : '') +
               '</button>')
            : '';
        return '<section class="gs-sec' + (willFold ? ' fold open' : '') + '">' +
            head +
            '<div class="gs-secbd">' +
                body +
                (hint ? '<p class="gs-hint">' + esc(hint) + '</p>' : '') +
            '</div>' +
        '</section>';
    }
    /** 一行：左标题，右控件（desc 说明位保留但不传 —— 用户不要功能下面的小字） */
    function row(label, right, desc) {
        return '<div class="gs-row"><div class="gs-lbcol">' +
            '<span class="gs-lb">' + esc(label) + '</span>' +
            (desc ? '<span class="gs-desc">' + esc(desc) + '</span>' : '') +
            '</div><span class="gs-rr">' + right + '</span></div>';
    }
    function btn(label, act, cls) {
        return '<button class="gs-btn' + (cls ? ' ' + cls : '') + '" data-act="' + act + '">' + esc(label) + '</button>';
    }
    function num(label, path, val, unit, min, max, stepBy) {
        // 数字直接可输入（用户拍板）：中间是 input，± 只是辅助
        return row(label,
            '<button class="gs-btn sm" data-numdec="' + path + '" data-min="' + min + '" data-max="' + max + '" data-step="' + (stepBy || 1) + '">−</button>' +
            '<input class="gs-numinput" type="number" data-numinput="' + path + '" data-min="' + min + '" data-max="' + max + '" value="' + val + '">' +
            (unit ? '<span class="gs-unit">' + esc(unit) + '</span>' : '') +
            '<button class="gs-btn sm" data-numinc="' + path + '" data-min="' + min + '" data-max="' + max + '" data-step="' + (stepBy || 1) + '">+</button>');
    }
    function sw(path, on) {
        return '<button class="gs-sw' + (on ? ' on' : '') + '" data-path="' + path + '" data-val="' + (on ? '0' : '1') + '">' +
            '<i></i></button>';
    }
    function seg(items, active, attr, extra) {
        return '<div class="gs-segrow' + (extra ? ' ' + extra : '') + '">' + items.map((it) =>
            '<button class="gs-seg' + (it.v === active ? ' on' : '') + '" data-' + attr + '="' + esc(it.v) + '">' +
            esc(it.name) + '</button>').join('') + '</div>';
    }

    /* ---------------- ① 通信设置 ----------------
       用户 2026-10-17：原来散在「通信设置 / 数据设置」两处的
       输入 / 已读回执 / 已读不回 / 回复设置 / 各类概率 / 撤回 / 主动发送 / 拼字卡
       全部合并到这一个栏目里。 */
    function tabComms() {
        const g = Settings.g();

        const input =
            section('输入',
                row('回车发送', sw('g.enterSend', !!g.enterSend)) +
                row('语音图标', sw('g.voiceInput', !!g.voiceInput)) +
                row('引用回复', sw('g.quoteReply', !!g.quoteReply)) +
                row('正在输入', sw('g.typingShow', !!g.typingShow)));

        const receipt =
            section('已读回执',
                row('已读回执', sw('g.readReceipt', !!g.readReceipt)) +
                (g.readReceipt
                    ? '<div class="gs-prob">' +
                        '<b class="gs-blockt">显示方式</b>' +
                        seg([{ name: '文字', v: 'text' }, { name: '图形', v: 'icon' }], g.readReceiptStyle, 'rrstyle') +
                      '</div>'
                    : ''));

        const noreply =
            section('已读不回',
                row('默认已读不回', sw('g.noReplyDefault', !!g.noReplyDefault)) +
                num('已读不回概率', 'g.noReplyProb', g.noReplyProb, '%', 0, 100));

        const reply =
            section('回复设置',
                num('回复速度最短（秒）', 'g.replyDelayMin', g.replyDelayMin, '', 1, 600) +
                num('回复速度最长（秒）', 'g.replyDelayMax', Math.max(g.replyDelayMin, g.replyDelayMax || 20), '', 1, 600) +
                num('回复条数最少', 'g.replyCountMin', g.replyCountMin, '', 1, 10) +
                num('回复条数最多', 'g.replyCountMax', g.replyCountMax, '', 1, 10),
                '', 1);

        const probs =
            section('回复花样概率',
                num('拍一拍概率', 'g.pokeProb', g.pokeProb, '%', 0, 100) +
                num('表情包概率', 'g.taStickerProb', g.taStickerProb, '%', 0, 100) +
                num('emoji 概率', 'g.emojiProb', g.emojiProb, '%', 0, 100) +
                num('图片概率', 'g.photoProb', g.photoProb, '%', 0, 100) +
                num('语音概率', 'g.voiceProb', g.voiceProb, '%', 0, 100) +
                num('颜文字附加概率', 'g.kaomojiProb', g.kaomojiProb, '%', 0, 100) +
                num('引用概率', 'g.quoteProb', g.quoteProb, '%', 0, 100),
                '', 1);

        const recall =
            section('撤回',
                num('TA 撤回概率', 'g.taRecallProb', g.taRecallProb, '%', 0, 100) +
                row('撤回后补发消息', sw('g.recallResend', !!g.recallResend)) +
                (g.recallResend ? num('补发概率', 'g.recallResendProb', g.recallResendProb, '%', 0, 100) : ''),
                '', 1);

        const push =
            section('主动发送',
                row('主动发送', sw('g.pushEnabled', !!g.pushEnabled)) +
                (g.pushEnabled
                    ? num('主动发送概率', 'g.pushProb', g.pushProb, '%', 0, 100) +
                      num('发送间隔最短（分钟）', 'g.pushMinM', g.pushMinM, '', 1, 720) +
                      num('发送间隔最长（分钟）', 'g.pushMaxM', g.pushMaxM, '', 1, 720) +
                      num('发送条数最少', 'g.pushCountMin', g.pushCountMin, '', 1, 10) +
                      num('发送条数最多', 'g.pushCountMax', g.pushCountMax, '', 1, 10)
                    : '') +
                row('主动发送标识', sw('g.pushBadge', !!g.pushBadge)) +
                (g.pushBadge ? badgeBox() : ''),
                '', 1);

        const pinyin =
            section('拼字卡',
                row('拼字卡', sw('g.pinyinCard', !!g.pinyinCard)) +
                (g.pinyinCard
                    ? num('触发概率', 'g.pinyinCardProb', g.pinyinCardProb, '%', 0, 100) +
                      num('最少条数', 'g.pinyinCardMin', g.pinyinCardMin, '', 1, 10) +
                      num('最多条数', 'g.pinyinCardMax', g.pinyinCardMax, '', 1, 10)
                    : ''),
                '', 1);

        return input + receipt + noreply + reply + probs + recall + push + pinyin;
    }

    /** ★ v40：主动发送标识 —— 用户 2026-10-18 明确「把图三这里去掉，固定用 ❤️」。
       原来这里是一排可点选的标识池，但聊天页从来没渲染过它（空设置），
       现在统一固定 ❤️，这排按钮直接删掉。 */
    function badgeBox() {
        return '<div class="gs-block"><p class="gs-note">对方主动发来的消息会在左上角显示 ❤️</p></div>';
    }

    /* ---------------- ② 聊天数据 ----------------
       用户 2026-10-17 拍板：栏目名从「数据管理」改成**「聊天数据」**，
       里面从上到下：
         ① 存储用量（顶部一张卡）
         ② 后台保活（静音音频循环 —— 真在跑，状态实时显示）
         ③ 消息提醒与通知（新增：提示音 / 响铃，需上传音频，默认关）
         ④ 备份
         ⑤ 后台通知
         ⑥ 阿里云云端存储 */
    const OSS_REGIONS = [
        ['oss-cn-hangzhou.aliyuncs.com', '华东1（杭州）'],
        ['oss-cn-shanghai.aliyuncs.com', '华东2（上海）'],
        ['oss-cn-beijing.aliyuncs.com', '华北2（北京）'],
        ['oss-cn-shenzhen.aliyuncs.com', '华南1（深圳）'],
        ['oss-cn-chengdu.aliyuncs.com', '西南1（成都）'],
        ['oss-cn-hongkong.aliyuncs.com', '中国香港'],
        ['oss-ap-southeast-1.aliyuncs.com', '新加坡']
    ];

    /** 数据管理大卡（图标 + 主文案 + 副文案 + 右侧） */
    function dmCard(ico, title, sub, right, act, cls) {
        return '<button class="dm-card' + (cls ? ' ' + cls : '') + '"' + (act ? ' data-act="' + act + '"' : '') + '>' +
                '<span class="dm-ico">' + icon(ico, 21) + '</span>' +
                '<span class="dm-tx">' +
                    '<b>' + esc(title) + '</b>' +
                    (sub ? '<i>' + esc(sub) + '</i>' : '') +
                '</span>' +
                (right ? '<span class="dm-rr">' + right + '</span>' : '') +
            '</button>';
    }
    function dmBadge(on, txt) {
        return '<span class="dm-badge' + (on ? ' ok' : '') + '">' + esc(txt) + '</span>';
    }

    /** 存储用量（顶部卡）：浏览器真实配额 + 本站已用 + 分项明细 + 一键清理
     *  ★ v30 重做（用户 2026-10-18：「把功能真真正正用在这个网站，而不是空架子」）：
     *    不只显示一个总数 —— 列出「消息图片 / 表情包 / 背景图 / 字体 / 音频 / 其它」各占多少，
     *    再给能真删的清理按钮（清图片缓存、清背景图、清字体），点了立刻释放空间。 */
    function usageCard() {
        return '<div class="dm-card usage" data-usage>' +
                '<span class="dm-ico">' + icon('database', 21) + '</span>' +
                '<span class="dm-tx">' +
                    '<b>存储用量</b>' +
                    '<i data-usagetx>正在统计…</i>' +
                '</span>' +
                '<span class="dm-rr"><button class="gs-btn ghost" data-act="mediaStat">刷新</button></span>' +
                '<div class="dm-usage-bar"><div class="dm-usage-fill" data-usagefill style="width:0%"></div></div>' +
                '<div class="dm-break" data-usagebreak hidden>' +
                    '<div class="dm-break-row"><span>消息图片</span><em data-bk="img">—</em></div>' +
                    '<div class="dm-break-row"><span>表情包素材</span><em data-bk="media">—</em></div>' +
                    '<div class="dm-break-row"><span>主界面背景图</span><em data-bk="bg">—</em></div>' +
                    '<div class="dm-break-row"><span>字体</span><em data-bk="font">—</em></div>' +
                    '<div class="dm-break-row"><span>提示音</span><em data-bk="snd">—</em></div>' +
                    '<div class="dm-break-row"><span>文字设置数据</span><em data-bk="ls">—</em></div>' +
                    '<div class="dm-break-actions">' +
                        '<button class="gs-btn ghost" data-act="clearImg">清图片缓存</button>' +
                        '<button class="gs-btn ghost" data-act="clearBg">清背景图</button>' +
                        '<button class="gs-btn ghost" data-act="clearFont">清字体</button>' +
                    '</div>' +
                '</div>' +
            '</div>';
    }

    /* ---------- 后台保活：静音音频循环 ---------- */
    /** 静音循环实时状态 → 徽章文案 */
    function kaBadge() {
        const on = !!KeepAlive.cfg().on;
        if (!on) return dmBadge(false, '未开启');
        const st = KeepAlive.loopState();
        if (st === 'on') return dmBadge(true, '循环播放中');
        if (st === 'blocked') return dmBadge(false, '被浏览器拦了');
        return dmBadge(false, '等待播放');
    }
    function kaSec() {
        const ka = KeepAlive.cfg();
        return section('后台保活',
            row('静音循环', sw('ka.on', !!ka.on)) +
            row('运行状态', kaBadge() +
                btn('立即尝试', 'kapoke', 'ghost')) +
            row('离开聊天后', ka.on
                ? dmBadge(true, '对方照常发消息')
                : dmBadge(false, '只在前台回复')));
    }

    /* ---------- 消息提醒与通知（新增） ---------- */
    /** 一条声音：标题 + 开关 + 上传/试听/清除 */
    function soundRow(label, path, kind) {
        const g = Settings.g();
        const on = !!g[path];
        const has = snd[kind];                      // null = 还没读，true/false = 有/没有
        const fileRow = row(label + '音频',
            (has === true ? dmBadge(true, '已上传') : (has === false ? dmBadge(false, '未上传') : '')) +
            btn('上传', 'sndupload:' + kind, 'ghost') +
            (has === true ? btn('试听', 'sndtest:' + kind, 'ghost') : '') +
            (has === true ? btn('清除', 'sndclear:' + kind, 'ghost') : ''));
        return row(label, sw(path, on)) + (on ? fileRow : '');
    }
    function soundSec() {
        return section('消息提醒与通知',
            soundRow('角色回复提示音', 'g.soundMsg', 'msg') +
            soundRow('来电响铃', 'g.soundRing', 'ring'));
    }

    function tabData() {
        const cfg = OSS.getConfig();
        const ka = KeepAlive.cfg();
        const connected = !!cfg.connectedAt;
        const notifState = (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';

        /* ① 存储用量（顶部一张卡） */
        const usageSec = section('', usageCard());

        /* ② 后台保活（静音音频循环） */
        const kaSecHtml = kaSec();

        /* ③ 消息提醒与通知 */
        const sndSec = soundSec();

        /* ④ 备份 */
        const backupSec =
            section('备份',
                dmCard('download', '全量备份', '所有设置与数据', icon('chevronRight', 16), 'expAll') +
                dmCard('chat', '聊天记录', '消息内容单独备份', icon('chevronRight', 16), 'expChat') +
                row('导入备份', btn('从文件导入', 'impAll', 'ghost')));

        /* ⑤ 后台通知 */
        const notifSec =
            section('后台通知',
                row('后台消息推送',
                    (ka.notify && notifState === 'granted')
                        ? dmBadge(true, '已开启')
                        : (notifState === 'denied' ? dmBadge(false, '被浏览器拦截') : dmBadge(false, '未开启')) +
                          btn('开启', 'notify', 'ghost') +
                          (ka.notify ? btn('关闭', 'notifyOff', 'ghost') : '')));

        /* ⑥ 阿里云云端存储 */
        const lastUp = cfg.lastUpload
            ? new Date(cfg.lastUpload).toLocaleString('zh-CN', { hour12: false })
            : '还没备份过';
        const ossSub = connected
            ? ((cfg.bucket || '未命名') + ' · 上次同步：' + lastUp)
            : '连接阿里云 OSS，把整包数据备份到云端';
        const cloudSec =
            section('阿里云云端存储',
                dmCard('cloud', '阿里云 OSS', ossSub,
                    connected ? dmBadge(true, '已连接') : dmBadge(false, '未连接'), 'ossOpen'));

        return usageSec + kaSecHtml + sndSec + backupSec + notifSec + cloudSec;
    }

    /** 读 IndexedDB 里有没有上传过音频，读到就补渲染出「试听/清除」 */
    async function refreshSound(silent) {
        const out = {};
        await Promise.all(['msg', 'ring'].map(async (k) => {
            try { out[k] = await Sound.has(k); } catch { out[k] = false; }
        }));
        let changed = false;
        ['msg', 'ring'].forEach((k) => {
            if (snd[k] === null || snd[k] !== out[k]) changed = true;
            snd[k] = out[k];
        });
        if (changed && !silent) render();
        return out;
    }

    /** 算一遍占用并回填到顶部卡（Toast 也留一份，刷新按钮走这里）
     *  ★ v29：改用浏览器原生配额 API（navigator.storage.estimate），
     *    拿到的是「本站点（含 localStorage + IndexedDB）真实占用的字节数」
     *    + 浏览器给本源的总配额（通常 GB 级）。
     *    用户原话：「网站所依赖的浏览器有多少 g 的存储空间，然后我这个字卡网站…用了多少空间」。
     *    不再用 base64 长度瞎估、也不再写死 5MB 上限。 */
    async function refreshUsage(silent) {
        const fmt = (b) => {
            if (!b) return '0 B';
            if (b < 1024) return b + ' B';
            if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
            if (b < 1073741824) return (b / 1048576).toFixed(2) + ' MB';
            return (b / 1073741824).toFixed(2) + ' GB';
        };
        let usage = 0, quota = 0, pct = 0, tx = '';
        try {
            if (navigator.storage && navigator.storage.estimate) {
                const est = await navigator.storage.estimate();
                usage = est.usage || 0;
                quota = est.quota || 0;
                if (quota > 0) {
                    pct = Math.min(100, usage / quota * 100);
                    tx = '已用 ' + fmt(usage) + ' / 浏览器共 ' + fmt(quota);
                } else {
                    tx = '已用 ' + fmt(usage) + '（浏览器未提供总配额）';
                }
            }
        } catch { /* 不支持 estimate 就走回落 */ }
        if (!quota) {
            let ls = 0;
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i) || '';
                ls += k.length + (localStorage.getItem(k) || '').length;
            }
            usage = ls * 2;
            pct = Math.min(100, usage / (5 * 1048576) * 100);
            tx = '已用 ' + fmt(usage) + ' / 约 5 MB（浏览器未提供配额）';
        }
        const txEl = root.querySelector('[data-usagetx]');
        if (txEl) txEl.textContent = tx;
        const fill = root.querySelector('[data-usagefill]');
        if (fill) fill.style.width = Math.max(pct, usage > 0 ? 1.5 : 0).toFixed(1) + '%';

        /* ---- 分项明细：把 IDB 里每个 blob 按用途归类 ---- */
        const buckets = { img: 0, media: 0, bg: 0, font: 0, snd: 0 };
        try {
            const items = await IDB.usage();
            items.forEach((it) => {
                const k = it.key;
                if (k.indexOf('img_') === 0) buckets.img += it.bytes;
                else if (k.indexOf('media:') === 0) buckets.media += it.bytes;
                else if (k === 'homeBg') buckets.bg += it.bytes;
                else if (k === 'fontBlob') buckets.font += it.bytes;
                else if (k.indexOf('snd:') === 0) buckets.snd += it.bytes;
            });
        } catch { /* 读不到就只显示 0 */ }
        let lsBytes = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i) || '';
            lsBytes += (k.length + (localStorage.getItem(k) || '').length) * 2;
        }
        buckets.ls = lsBytes;

        const brk = root.querySelector('[data-usagebreak]');
        if (brk) {
            brk.hidden = false;
            Object.keys(buckets).forEach((k) => {
                const el = root.querySelector('[data-bk="' + k + '"]');
                if (el) el.textContent = fmt(buckets[k]);
            });
        }
        if (!silent) toast('存储：' + tx, 'ok', 2600);
        return { usage, quota, pct, buckets };
    }

    /** 清图片缓存：删掉所有 idb:img_* 的真身（下次翻到旧图会重新报错占位，不影响数据） */
    async function clearImgCache() {
        const items = await IDB.usage();
        const imgKeys = items.filter((x) => x.key.indexOf('img_') === 0);
        if (!imgKeys.length) { toast('没有可清理的图片缓存', 'warn'); return; }
        const freed = imgKeys.reduce((a, b) => a + b.bytes, 0);
        for (const it of imgKeys) await IDB.del(it.key);
        toast('已清理 ' + imgKeys.length + ' 张图片缓存', 'ok');
        refreshUsage(true);
        return freed;
    }

    /** 清主界面背景图 */
    async function clearHomeBg() {
        await IDB.del('homeBg');
        Store.remove('homeBgImg', { scope: 'global' });
        toast('已清除主界面背景图', 'ok');
        refreshUsage(true);
    }

    /** 清上传字体 */
    async function clearFont() {
        await IDB.del('fontBlob');
        toast('已清除上传的字体', 'ok');
        refreshUsage(true);
    }

    /* ---------------- 存取 ---------------- */
    function getPath(path) {
        const [layer, key] = String(path).split('.');
        if (layer === 'g') return Settings.g()[key];
        if (layer === 'ka') return KeepAlive.cfg().on;
        return Store.get(key, null, { scope: 'global' });
    }
    function setPath(path, val) {
        const [layer, key] = String(path).split('.');
        if (layer === 'g') { Settings.setG(key, val); return; }
        if (layer === 'ka') {
            // ★ 走 KeepAlive.saveCfg：它会顺带启停静音音频循环 + 广播 ka:changed
            KeepAlive.saveCfg({ on: !!Number(val) });
            return;
        }
        Store.set(key, val, { scope: 'global' });
    }

    /* ---------------- 数据操作 ---------------- */
    function dumpAll() {
        return { at: new Date().toISOString(), v: 20, data: Store.snapshot() };
    }
    function nameOf() {
        return 'zika-' + new Date().toISOString().slice(0, 10);
    }
    async function pickCssOrJson(accept) {
        const f = await pickFile(accept);
        if (!f || !f.data) return null;
        try {
            const comma = f.data.indexOf(',');
            const body = f.data.slice(comma + 1);
            const meta = f.data.slice(0, comma);
            const text = /base64/i.test(meta)
                ? decodeURIComponent(escape(atob(body)))
                : decodeURIComponent(body);
            return JSON.parse(text);
        } catch { toast('文件读不出来，确认是本站导出的 json', 'warn', 2600); return null; }
    }

    /* ---------------- 渲染 ---------------- */
    function currentTab() {
        return (tab === 'data') ? tabData() : tabComms();
    }

    /**
     * @param keepScroll true = 同 tab 内重渲染（改开关/数字），恢复滚动位置；
     *                    不传 = 切 tab / 首次进入，回到顶部。
     * ★ v39：v38 无条件恢复 scrollTop，导致**切 tab 时也保留了上一页的滚动量**
     *   → 切过去看到的是页面中段（用户截图里「回复设置」标题被切掉一半）。
     *   另外每帧都写 scrollTop 会触发额外重排 → 用户说的「互动之后会闪屏」。
     *   现在只在真正需要时写一次。
     */
    function render(keepScroll) {
        const keepTop = keepScroll && ui.body ? ui.body.scrollTop : 0;
        // ★ 用户 2026-10-17：只留两个栏目。美化设置已搬到桌面「装扮」App（look.js）。
        const TABS = [['comms', '通信设置'], ['data', '聊天数据']];
        root.innerHTML =
            '<header class="bar">' +
                '<button class="bar-btn" data-act="back" aria-label="返回">' + icon('chevronLeft', 23) + '</button>' +
                '<span class="bar-title">设置</span>' +
                '<span class="bar-spacer"></span>' +
            '</header>' +
            '<div class="gs-tabs">' +
                TABS.map((x) => '<button class="gs-tab' + (x[0] === tab ? ' on' : '') + '" data-tab="' + x[0] + '">' +
                    esc(x[1]) + '</button>').join('') +
            '</div>' +
            '<div class="page-scroll gs-body" data-body>' + currentTab() + '</div>';

        ui.body = root.querySelector('[data-body]');
        // ★ v29 修正：背景刷在滚动内容容器上（不是页面根），
        //   这样不会被别处的底色盖住，磨砂卡片直接盖在主界面背景图上。
        applyPageBg(ui.body);
        // ★ v39：滚动位置要**等布局稳定后再写**。
        //   v38 在 innerHTML 替换后同步写 scrollTop，此时新内容还没完成布局，
        //   浏览器会先滚到一个无效位置再重排 —— 用户看到的「互动之后闪屏」。
        //   放到 rAF 里写，等于「内容已布局」，不会再闪。
        if (keepTop) {
            requestAnimationFrame(() => { if (ui.body) ui.body.scrollTop = keepTop; });
        }
        // 聊天数据 tab → 顶部「存储用量」异步统计 + 音频是否已上传
        if (tab === 'data') { refreshUsage(true); refreshSound(true); }
    }

    /* ---------------- 事件 ---------------- */
    function bind() {
        delegate(root, 'click', '[data-act="back"]', () => { try { Page.back(); } catch (e) { console.error(e); } });
        // ★ 切 tab = 换内容，回到顶部（不传 keepScroll）
        delegate(root, 'click', '[data-tab]', (e, t) => { tab = t.getAttribute('data-tab'); render(); });

        /* 分区折叠：点标题开/合（不重渲染） */
        delegate(root, 'click', '[data-secfold]', (e, t) => {
            const sec = t.closest('.gs-sec');
            if (sec) sec.classList.toggle('open');
        });

        /* 开关 / 主题 / 数字加减 */
        delegate(root, 'click', '[data-path]', (e, t) => {
            const p = t.getAttribute('data-path');
            const v = t.getAttribute('data-val');
            const before = JSON.stringify(getPath(p));
            setPath(p, (/^\d+$/.test(v) ? Number(v) : v));
            // ★ 写完立刻回读校验：写失败（多半是 localStorage 配额爆了）必须告诉用户，
            //   不然「保存完刷新就没了」，用户只会以为网站有 bug。
            const after = JSON.stringify(getPath(p));
            if (before === after) {
                toast('这项没保存上，可能是浏览器存储满了。去「数据设置 → 备份」导出一份再清理', 'warn', 3600);
            }
            render(true);
        });
        const step = (t, dir) => {
            const p = t.getAttribute('data-numinc') || t.getAttribute('data-numdec');
            const min = Number(t.getAttribute('data-min') || 0);
            const max = Number(t.getAttribute('data-max') || 999);
            const cur = Number(getPath(p) || min);
            const st = Number(t.getAttribute('data-step') || 1);
            const d = (t.getAttribute('data-numinc') ? 1 : -1) * st;
            setPath(p, Math.max(min, Math.min(max, cur + d)));
            render(true);
        };
        delegate(root, 'click', '[data-numinc]', (e, t) => step(t, 1));
        delegate(root, 'click', '[data-numdec]', (e, t) => step(t, -1));

        /* 数字直接输入（点中间的数字自己改） */
        delegate(root, 'change', '[data-numinput]', (e, t) => {
            const p = t.getAttribute('data-numinput');
            const min = Number(t.getAttribute('data-min') || 0);
            const max = Number(t.getAttribute('data-max') || 999);
            let v = Number(t.value);
            if (isNaN(v)) v = min;
            v = Math.max(min, Math.min(max, v));
            setPath(p, v);
            t.value = v;
            if (Number(getPath(p)) !== v) {
                toast('这项没保存上，可能是浏览器存储满了。去「数据设置 → 备份」导出一份再清理', 'warn', 3600);
            }
        });

        /* 主题网格（与装扮页同一套，look.js 渲染） */
        delegate(root, 'click', '[data-look]', (e, t) => {
            const k = t.getAttribute('data-look');
            Settings.setG('themeKey', k);
            applyThemePreset(k);
            render();
            toast('主题已切换', 'ok', 1000);
        });

        /* 主动发送标识：点 = 启用/停用（系统的五个可开关；「＋」加自定义） */
        delegate(root, 'click', '[data-badge]', (e, t) => {
            const b = t.getAttribute('data-badge');
            const cur = (Settings.g().pushBadgeList || []).slice();
            const i = cur.indexOf(b);
            if (i >= 0) {
                if (cur.length <= 1) { toast('至少留一个标识', 'warn', 1400); return; }
                cur.splice(i, 1);
            } else {
                if (cur.length >= 8) { toast('最多 8 个标识', 'warn', 1400); return; }
                cur.push(b);
            }
            Settings.setG('pushBadgeList', cur);
            render(true);
        });

        /* OSS 输入 */
        delegate(root, 'change', '[data-oss]', (e, t) => {
            const cur = OSS.getConfig();
            cur[t.getAttribute('data-oss')] = (t.value || '').trim();
            OSS.saveConfig(cur);
            toast('已保存', 'ok', 1200);
        });

        /* 云端同步浮层挂在 body 上（不在 root 里），必须用 document 级委托 */
        const onDocClick = async (e) => {
            if (!ossSheet) return;
            const t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
            if (!t || !ossSheet.contains(t)) return;
            const act = t.getAttribute('data-act');
            if (act === 'osscancel') { closeOssSheet(); return; }
            if (act === 'osssave') {
                const c = ossSheetCfg();
                if (!ossReady(c)) { toast('四项都要填', 'warn', 2200); return; }
                OSS.saveConfig(c);
                toast('正在连接…', 'ok', 1200);
                const r = await OSS.testConnection();
                toast(r.ok ? '已连接' : ('连接失败：' + String(r.message || '').slice(0, 80)), r.ok ? 'ok' : 'warn', 3400);
                closeOssSheet(); render();
                return;
            }
            if (act === 'osstest') {
                const c = ossSheetCfg();
                if (!ossReady(c)) { toast('四项都要填', 'warn', 2200); return; }
                OSS.saveConfig(c);
                toast('正在测试连接…', 'ok', 1200);
                const r = await OSS.testConnection(c);
                toast(r.ok ? (r.hasBackup ? '已连接，云端已有备份' : '已连接，云端还没有备份')
                            : ('连接失败：' + String(r.message || '').slice(0, 80)),
                        r.ok ? 'ok' : 'warn', 3400);
                return;
            }
            if (act === 'ossdisconnect') {
                const c = OSS.getConfig();
                delete c.connectedAt; delete c.lastUpload;
                OSS.saveConfig(c);
                toast('已断开连接', 'ok'); closeOssSheet(); render();
                return;
            }
            if (act === 'ossrestore') {
                const c = ossSheetCfg();
                if (!ossReady(c)) { toast('四项都要填', 'warn', 2200); return; }
                OSS.saveConfig(c);
                closeOssSheet();
                await ossGet();
                return;
            }
            if (act === 'ossmigrate') {
                const c = ossSheetCfg();
                if (!ossReady(c)) { toast('四项都要填', 'warn', 2200); return; }
                OSS.saveConfig(c);
                closeOssSheet();
                await ossMigrateImages();
                return;
            }
        };
        docClickOff = onDocClick;
        document.addEventListener('click', onDocClick);

        /* 各操作 */
        delegate(root, 'click', '[data-act]', (e, t) => {
            const act = t.getAttribute('data-act');
            if (act === 'badgeadd') {
                const v = window.prompt('自定义标识（最长 4 个字符，可以是 emoji）', '');
                if (!v) return;
                const s = v.trim().slice(0, 4);
                if (!s) return;
                const cur = (Settings.g().pushBadgeList || []).slice();
                if (cur.indexOf(s) >= 0) { toast('已经有这个标识了', 'warn', 1400); return; }
                if (cur.length >= 8) { toast('最多 8 个标识', 'warn', 1400); return; }
                cur.push(s);
                Settings.setG('pushBadgeList', cur);
                render();
                return;
            }
            if (act === 'expAll') {
                if (download(nameOf() + '-全站备份.json', JSON.stringify(dumpAll(), null, 2), 'application/json')) {
                    toast('已导出全站备份', 'ok');
                } else toast('导出失败', 'warn');
                return;
            }
            if (act === 'impAll') return importAll();
            if (act === 'expChat') return exportChat();
            if (act === 'clearImg') return clearImgCache();
            if (act === 'clearBg') return clearHomeBg();
            if (act === 'clearFont') return clearFont();
            if (act === 'ossOpen') return openOssSheet();
            if (act === 'mediaStat') return refreshUsage(false);
            if (act === 'ossTest') return ossTest();
            if (act === 'ossUp') return ossPut();
            if (act === 'ossDown') return ossGet();
            if (act === 'kapoke') {
                // 手动重试一次播放（浏览器 autoplay 拦过之后，点一下就能补上）
                KeepAlive.saveCfg({ on: true });
                setTimeout(() => {
                    const st = KeepAlive.loopState();
                    toast(st === 'on' ? '静音循环已在播放'
                        : (st === 'blocked' ? '浏览器还是拦着，切出去再回来试试' : '这个浏览器不支持后台音频'),
                        st === 'on' ? 'ok' : 'warn', 2600);
                    render();
                }, 400);
                return;
            }
            if (act && act.indexOf('sndupload:') === 0) return uploadSound(act.split(':')[1]);
            if (act && act.indexOf('sndtest:') === 0) return testSound(act.split(':')[1]);
            if (act && act.indexOf('sndclear:') === 0) return clearSound(act.split(':')[1]);
            if (act === 'notify') {
                KeepAlive.askNotifyPermission().then((ok) => {
                    KeepAlive.saveCfg({ notify: !!ok });
                    render();
                });
                return;
            }
            if (act === 'notifyOff') {
                KeepAlive.saveCfg({ notify: false });
                render();
                toast('已关闭后台通知', 'ok');
                return;
            }
        });
    }

    /* ---------------- 声音：上传 / 试听 / 清除 ---------------- */
    /** 音频文件走 IndexedDB；本地只留 dataURL 引用（在 IDB 里，不占 localStorage 配额） */
    async function uploadSound(kind) {
        const f = await pickFile('audio/*');
        if (!f || !f.data) return;
        if (String(f.data).indexOf('data:audio') !== 0 && String(f.data).indexOf('data:') !== 0) {
            toast('这不是音频文件', 'warn'); return;
        }
        const ok = await Sound.set(kind, f.data);
        if (!ok) { toast('音频存不下来，换个小一点的文件试试', 'warn', 2800); return; }
        snd[kind] = true;
        render();
        toast('音频已保存', 'ok');
        Sound.test(kind);
    }
    async function testSound(kind) {
        const ok = await Sound.test(kind);
        toast(ok ? '试听中' : '还没有音频，先上传一个', ok ? 'ok' : 'warn', 1800);
    }
    async function clearSound(kind) {
        await Sound.clear(kind);
        snd[kind] = false;
        render();
        toast('已清除', 'ok');
    }

    /* ---------------- 备份 ---------------- */
    async function importAll() {
        const json = await pickCssOrJson('.json,application/json');
        if (!json) return;
        // 导出时整包是 {at, v, data: snapshot}，也可能直接是裸 snapshot
        const snap = (json && json.data && json.data.global) ? json.data : json;
        if (!Store.restore(snap)) { toast('恢复失败', 'warn'); return; }
        applyThemePreset(Settings.g().themeKey);
        toast('已恢复，正在刷新…', 'ok');
        setTimeout(() => { try { location.reload(); } catch { /* noop */ } }, 800);
    }

    function exportChat() {
        const sid = Store.sessionId();
        const data = Store.get('messages', [], { scope: 'session' });
        const c = window.__zika.Session.get(sid);
        if (!data || !data.length) { toast('这个会话还没有消息', 'warn'); return; }
        const payload = {
            contact: c ? { id: c.id, name: c.name, avatar: c.avatar } : { id: sid },
            exportedAt: new Date().toISOString(),
            messages: data
        };
        const nm = 'zika-聊天记录-' + ((c && c.name) || sid) + '-' + new Date().toISOString().slice(0, 10) + '.json';
        if (download(nm, JSON.stringify(payload, null, 2), 'application/json')) toast('已导出 ' + data.length + ' 条消息', 'ok');
        else toast('导出失败', 'warn');
    }

    /* ---------------- OSS（真实直连，纯前端 V4 签名） ---------------- */
    /* ---------------- 云端同步设置浮层（图二样式） ----------------
       用户 2026-10-17 拍板：点「云端同步」卡弹出这个浮层 ——
       Bucket 名称 / 地区下拉 / AccessKey ID / AccessKey Secret（密码框）
       + 三个动作（断开连接 / 从云端恢复 / 迁移本地图片到云端）
       + 底部三按钮（取消 / 测试连接 / 保存并连接）。 */
    let ossSheet = null;
    function openOssSheet() {
        if (ossSheet) { closeOssSheet(); return; }
        const cfg = OSS.getConfig();
        const regionOpts = OSS_REGIONS.map(([ep, nm]) =>
            '<option value="' + esc(ep) + '"' + (cfg.endpoint === ep ? ' selected' : '') + '>' + esc(nm) + '</option>'
        ).join('');

        const el = document.createElement('div');
        el.className = 'oss-sheet';
        el.innerHTML =
            '<div class="oss-mask" data-act="osscancel"></div>' +
            '<div class="oss-panel" role="dialog" aria-modal="true">' +
                '<header class="oss-hd">' +
                    '<span class="oss-ico">' + icon('cloud', 22) + '</span>' +
                    '<b>云端同步设置</b>' +
                '</header>' +
                '<div class="oss-bd">' +
                    '<a class="oss-help" href="https://help.aliyun.com/zh/ram/user-guide/create-an-accesskey-pair" target="_blank" rel="noopener">如何申请阿里云密钥？</a>' +
                    '<label class="oss-fld"><span>Bucket 名称</span>' +
                        '<input data-ossf="bucket" value="' + esc(cfg.bucket || '') + '" placeholder="你的 bucket 名" autocomplete="off"></label>' +
                    '<label class="oss-fld"><span>地区</span>' +
                        '<select data-ossf="endpoint">' + regionOpts + '</select>' +
                        '<i class="oss-tip">与创建 Bucket 时选择的地区保持一致</i></label>' +
                    '<label class="oss-fld"><span>AccessKey ID</span>' +
                        '<input data-ossf="ak" value="' + esc(cfg.ak || '') + '" placeholder="RAM 子用户 AccessKeyId" autocomplete="off"></label>' +
                    '<label class="oss-fld"><span>AccessKey Secret</span>' +
                        '<input data-ossf="sk" type="password" value="' + esc(cfg.sk || '') + '" placeholder="AccessKeySecret" autocomplete="off"></label>' +
                    '<i class="oss-tip">密钥仅保存在你的浏览器本地，不会上传到任何服务器（除了阿里云本身）。</i>' +
                    '<div class="oss-acts">' +
                        '<button class="oss-act danger" data-act="ossdisconnect">断开连接</button>' +
                        '<button class="oss-act" data-act="ossrestore">从云端恢复梦梦到浏览器</button>' +
                        '<button class="oss-act" data-act="ossmigrate">迁移本地图片到云端（省空间）</button>' +
                    '</div>' +
                '</div>' +
                '<footer class="oss-ft">' +
                    '<button class="oss-btn ghost" data-act="osscancel">取消</button>' +
                    '<button class="oss-btn" data-act="osstest">测试连接</button>' +
                    '<button class="oss-btn primary" data-act="osssave">保存并连接</button>' +
                '</footer>' +
            '</div>';
        document.body.appendChild(el);
        ossSheet = el;
        requestAnimationFrame(() => el.classList.add('in'));
    }
    function closeOssSheet() {
        if (!ossSheet) return;
        const el = ossSheet;
        ossSheet = null;
        el.classList.remove('in');
        setTimeout(() => el.remove(), 220);
    }
    function ossSheetCfg() {
        const out = OSS.getConfig();
        ossSheet.querySelectorAll('[data-ossf]').forEach((i) => { out[i.getAttribute('data-ossf')] = (i.value || '').trim(); });
        return out;
    }
    function ossReady(c) {
        return !!(c && c.endpoint && c.bucket && c.ak && c.sk);
    }

    async function ossTest() {
        if (!OSS.isConfigured()) { toast('先把 Endpoint / Bucket / AccessKey / Secret 填好', 'warn', 2600); return; }
        toast('正在测试连接…', 'ok', 1400);
        const r = await OSS.testConnection();
        toast(r.ok
            ? (r.hasBackup ? '已连接，云端已有备份' : '已连接，云端还没有备份')
            : ('连接失败：' + String(r.message || '').slice(0, 80)),
            r.ok ? 'ok' : 'warn', 3400);
        render();
    }
    async function ossPut() {
        if (!OSS.isConfigured()) { toast('先把 OSS 四项填好', 'warn', 2400); return; }
        toast('正在上传到云端…', 'ok', 1400);
        try {
            await OSS.uploadSnapshot(JSON.stringify({ at: new Date().toISOString(), v: 20, data: Store.snapshot() }));
            toast('已上传云端备份', 'ok');
        } catch (e) {
            toast('上传失败：' + String(e && e.message || e).slice(0, 90), 'warn', 3800);
        }
        render();
    }
    async function ossGet() {
        if (!OSS.isConfigured()) { toast('先把 OSS 四项填好', 'warn', 2400); return; }
        toast('正在从云端拉取…', 'ok', 1400);
        try {
            const dump = await OSS.downloadSnapshot();
            if (!dump) { toast('云端还没有备份', 'warn', 2600); return; }
            const snap = (dump && dump.data && dump.data.global) ? dump.data : dump;
            if (!Store.restore(snap)) { toast('恢复失败', 'warn'); return; }
            applyThemePreset(Settings.g().themeKey);
            toast('已从云端恢复，正在刷新…', 'ok');
            setTimeout(() => { try { location.reload(); } catch { /* noop */ } }, 800);
        } catch (e) {
            toast('拉取失败：' + String(e && e.message || e).slice(0, 90), 'warn', 3800);
        }
    }

    /**
     * 迁移本地图片到云端（省空间）：
     * 把 IndexedDB 里的图片素材（表情包/头像/头像框）逐个上传到 OSS，
     * 上传成功后把本地 dataURL 换成云端 URL，再触发一次全量备份。
     * 注：静态站没有「删掉本地图」的服务端能力，这里做的是「换成 URL 引用」，
     *     本地只留一条短链接，占用从几百 KB 降到几十字节。
     */
    async function ossMigrateImages() {
        if (!OSS.isConfigured()) { toast('先把 OSS 四项填好', 'warn', 2400); return; }
        toast('正在统计本地图片…', 'ok', 1400);
        let migrated = 0;
        let failed = 0;
        const sessions = [null].concat(Session.all().map((c) => c.id));
        for (const sid of sessions) {
            const raw = sid ? Store.getFor(sid, 'media', null, { scope: 'session' })
                            : Store.get('media', null, { scope: 'session' });
            if (!raw || typeof raw !== 'object') continue;
            let dirty = false;
            const kinds = Object.keys(raw);
            for (const kind of kinds) {
                const list = raw[kind];
                if (!Array.isArray(list)) continue;
                for (const it of list) {
                    if (!it || !it.src || /^https?:\/\//.test(it.src)) continue;   // 已是 URL 就跳过
                    try {
                        const url = await OSS.uploadFile(it.src, (it.name || kind) + '.jpg');
                        if (url) { it.src = url; migrated++; dirty = true; }
                        else failed++;
                    } catch { failed++; }
                }
            }
            if (dirty) {
                if (sid) Store.setFor(sid, 'media', raw, { scope: 'session' });
                else Store.set('media', raw, { scope: 'session' });
            }
        }
        // 顺手把整包数据再备份一次，让云端和本地一致
        try {
            await OSS.uploadSnapshot(JSON.stringify({ at: new Date().toISOString(), v: 20, data: Store.snapshot() }));
        } catch { /* 备份失败不阻塞迁移结果提示 */ }
        render();
        toast(migrated
            ? ('已迁移 ' + migrated + ' 张图片到云端' + (failed ? ('，' + failed + ' 张失败') : ''))
            : (failed ? ('迁移失败 ' + failed + ' 张') : '没有需要迁移的图片'),
            migrated ? 'ok' : 'warn', 3200);
    }

    render();
    bind();

    return {
        resume() { render(); },
        destroy() {
            // 云端同步浮层挂在 body 上，离开设置页必须收掉并摘掉 document 监听
            closeOssSheet();
            if (docClickOff) document.removeEventListener('click', docClickOff);
        }
    };
}