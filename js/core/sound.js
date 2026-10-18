/* ============================================================
   sound.js — 声音三件套
   ------------------------------------------------------------
   用户 2026-10-17 要求：
     ① 后台保活 = **占用音频播放一段 1 分钟静音音频并循环**，
        尝试维持后台音频会话（不录音、纯静音占位）。
        · 首次手动开启后记住选择 → 开关存在 localStorage（bg.js 的 keepalive）
        · 重新打开或中断后尝试恢复 → start() 时若开关是开的就自动播
        · 被浏览器 autoplay 策略拦下时记为 blocked，等用户下一次
          点按（pointerdown/touchstart/keydown）立刻重试
     ② 消息提醒与通知：角色回复播放提示音、来电响铃，**默认关闭**，
        仅在网页运行时生效，**需要用户自己上传音频文件才有声音**。

   音频文件存 IndexedDB（'snd:msg' / 'snd:ring'），localStorage 只存开关。
   ============================================================ */

import { IDB } from './idb.js';

const K_MSG = 'snd:msg';        // 角色回复提示音
const K_RING = 'snd:ring';      // 来电响铃
const LOOP_SEC = 60;            // 静音音频时长：1 分钟（用户要求）

/* ============================================================
   ① 静音占位音频（后台保活）
   ------------------------------------------------------------
   运行时生成 60 秒 8bit/8kHz 单声道静音 WAV：
   RIFF 头用 DataView 手写，采样点全部填 128（8bit 的 0 振幅）。
   之所以自己生成而不是带一个 mp3 文件：
     · 零网络请求、零体积、不会被缓存策略干扰
     · 8kHz/8bit × 60s ≈ 480KB，纯内存 Blob，用完即弃
   ============================================================ */
let loopUrl = '';
let loopAudio = null;
let loopState = 'off';          // off | on | blocked
let loopWanted = false;         // 用户想不想开着（开关状态）

/** 生成 60 秒静音 WAV 的 Blob URL（懒生成，全站只生成一次） */
function silentWavUrl() {
    if (loopUrl) return loopUrl;
    try {
        const rate = 8000;                 // 采样率：够低，体积小
        const bytes = rate * LOOP_SEC;     // 8bit 单声道 = 每秒 rate 字节
        const buf = new ArrayBuffer(44 + bytes);
        const dv = new DataView(buf);
        const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
        str(0, 'RIFF');
        dv.setUint32(4, 36 + bytes, true);
        str(8, 'WAVE');
        str(12, 'fmt ');
        dv.setUint32(16, 16, true);        // fmt chunk 大小
        dv.setUint16(20, 1, true);         // PCM
        dv.setUint16(22, 1, true);         // 单声道
        dv.setUint32(24, rate, true);      // 采样率
        dv.setUint32(28, rate, true);      // 字节率
        dv.setUint16(32, 1, true);         // block align
        dv.setUint16(34, 8, true);         // 位深
        str(36, 'data');
        dv.setUint32(40, bytes, true);
        for (let i = 0; i < bytes; i++) dv.setUint8(44 + i, 128);   // 128 = 静音
        loopUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    } catch {
        loopUrl = '';
    }
    return loopUrl;
}

function audio() {
    if (loopAudio) return loopAudio;
    const url = silentWavUrl();
    if (!url) return null;
    try {
        const a = new Audio(url);
        a.loop = true;                 // 循环播放 1 分钟静音
        a.preload = 'auto';
        a.volume = 0.0001;             // 极小声：音频本身全静音，这里只是防止浏览器把静音流当"没在播"优化掉
        loopAudio = a;
        // 播放中断（被系统暂停/来电/切后台被回收）→ 尝试恢复
        a.addEventListener('pause', () => {
            if (loopWanted && !a.ended) setTimeout(() => { if (loopWanted) playLoop(); }, 800);
        });
        a.addEventListener('error', () => { loopState = 'off'; });
    } catch {
        loopAudio = null;
    }
    return loopAudio;
}

function playLoop() {
    const a = audio();
    if (!a) { loopState = 'off'; return false; }
    try {
        const p = a.play();
        if (p && typeof p.then === 'function') {
            p.then(() => { loopState = 'on'; })
             .catch(() => {
                 // 被浏览器 autoplay 拦下：记 blocked，等下一次用户手势再试
                 loopState = 'blocked';
             });
        } else {
            loopState = 'on';
        }
    } catch {
        loopState = 'blocked';
    }
    return loopState !== 'off';
}

/** 挂一次性手势监听：用户第一次点按屏幕时把被拦下的循环补上 */
let gestureHooked = false;
function hookGesture() {
    if (gestureHooked) return;
    gestureHooked = true;
    const retry = () => {
        if (loopWanted && loopState !== 'on') playLoop();
        if (loopState === 'on') {
            document.removeEventListener('pointerdown', retry, true);
            document.removeEventListener('touchstart', retry, true);
            document.removeEventListener('keydown', retry, true);
        }
    };
    document.addEventListener('pointerdown', retry, true);
    document.addEventListener('touchstart', retry, true);
    document.addEventListener('keydown', retry, true);
}

export const SilentLoop = {
    /** 开启静音循环（记住选择由调用方写 localStorage，这里只管播） */
    start() {
        loopWanted = true;
        const ok = playLoop();
        if (loopState !== 'on') hookGesture();
        return ok;
    },
    /** 关闭 */
    stop() {
        loopWanted = false;
        loopState = 'off';
        if (loopAudio) { try { loopAudio.pause(); } catch { /* noop */ } }
    },
    /** 页面重新可见 / 从后台回来 → 尝试恢复（用户要求「中断后会尝试恢复」） */
    resume() {
        if (loopWanted && (!loopAudio || loopAudio.paused)) {
            const ok = playLoop();
            if (!ok) hookGesture();
        }
    },
    set(on) { if (on) this.start(); else this.stop(); },
    on() { return loopWanted; },
    /** off 未开 | on 正在播 | blocked 被浏览器拦了（等一次点按） */
    state() { return loopState; },
    /** 调试：立刻自己播一次（不管开关） */
    poke() { loopWanted = true; const ok = playLoop(); hookGesture(); return ok; }
};

/* ============================================================
   ② 提示音 / 响铃（用户上传）
   ============================================================ */
const cache = { msg: undefined, ring: undefined };   // undefined = 还没读

async function load(kind) {
    const key = kind === 'ring' ? K_RING : K_MSG;
    if (cache[kind] !== undefined) return cache[kind];
    try {
        const v = await IDB.get(key);
        cache[kind] = (typeof v === 'string' && v.indexOf('data:') === 0) ? v : '';
    } catch { cache[kind] = ''; }
    return cache[kind];
}

function play(src) {
    if (!src) return false;
    try {
        const a = new Audio(src);
        a.volume = 1;
        a.play().catch(() => { /* 浏览器拦了就算了，不弹错 */ });
        return true;
    } catch { return false; }
}

export const Sound = {
    MSG: K_MSG,
    RING: K_RING,

    async has(kind) { return !!(await load(kind)); },
    async src(kind) { return load(kind); },

    /** 保存上传的音频（dataURL）；kind: 'msg' | 'ring' */
    async set(kind, dataUrl) {
        const key = kind === 'ring' ? K_RING : K_MSG;
        if (!dataUrl || String(dataUrl).indexOf('data:') !== 0) return false;
        cache[kind] = String(dataUrl);
        const ok = await IDB.set(key, cache[kind]);
        if (!ok) cache[kind] = undefined;   // 写失败就别缓存脏值
        return ok;
    },
    async clear(kind) {
        const key = kind === 'ring' ? K_RING : K_MSG;
        cache[kind] = '';
        return IDB.del(key);
    },

    /** 角色回复提示音 */
    async playMsg() { return play(await load('msg')); },
    /** 来电响铃 */
    async playRing() { return play(await load('ring')); },

    /** 试听 */
    async test(kind) {
        const s = await load(kind);
        if (!s) return false;
        return play(s);
    }
};
