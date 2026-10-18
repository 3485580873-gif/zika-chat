/* ============================================================
   dom.js — 最小 DOM 工具集
   不引入框架，但把「拼 HTML / 委托事件」这两件最容易写乱的事收口。
   ============================================================ */

/* 注意：这里必须逐个拼出实体，不能写原义字符 */
const AMP = '&' + 'amp;';
const LT = '&' + 'lt;';
const GT = '&' + 'gt;';
const QUOT = '&' + 'quot;';
const APOS = '&' + '#39;';

/** HTML 转义：任何用户输入进 innerHTML 前都必须过一遍 */
export function esc(s) {
    return String(s === null || s === undefined ? '' : s)
        .split('&').join(AMP)
        .split('<').join(LT)
        .split('>').join(GT)
        .split('"').join(QUOT)
        .split("'").join(APOS);
}

/** 把 HTML 字符串转成元素（单根） */
export function fromHTML(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html).trim();
    return tpl.content.firstElementChild;
}

/** 查询 */
export function qs(sel, root = document) { return root.querySelector(sel); }
export function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

/**
 * 事件委托。
 * @param root  容器
 * @param type  事件名
 * @param sel   目标选择器
 * @param fn    回调 (event, matchedElement)
 */
export function delegate(root, type, sel, fn) {
    root.addEventListener(type, (e) => {
        const target = e.target && e.target.closest ? e.target.closest(sel) : null;
        if (target && root.contains(target)) fn(e, target);
    });
}

/** 绑定一次性的输入变化 */
export function onInput(el, fn) {
    if (!el) return () => {};
    el.addEventListener('input', fn);
    return () => el.removeEventListener('input', fn);
}

/* ---------------- 图片压缩（保透明） ----------------
   以前的坑：无脑 toDataURL('image/jpeg') —— JPEG 没有 alpha 通道，
   透明 PNG 一压就变黑底（头像框上传后一圈黑边就是这个原因）。
   现在先扫一遍 alpha 通道，真有透明才输出 PNG，否则输出 JPEG 省体积。 */
function shrinkToDataUrl(img, maxSide, quality) {
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    let hasAlpha = false;
    try {
        const data = ctx.getImageData(0, 0, w, h).data;
        // 抽检：四角 + 边缘 + 隔行扫描，够用且不至于太慢
        const pts = [0, w - 1, (h >> 1) * w, (h - 1) * w + w - 1];
        for (let i = 3; i < data.length; i += 4 * 97) { if (data[i] < 250) { hasAlpha = true; break; } }
        if (!hasAlpha) {
            for (let j = 0; j < pts.length; j++) {
                if (data[pts[j] * 4 + 3] < 250) { hasAlpha = true; break; }
            }
        }
    } catch { hasAlpha = false; }
    return hasAlpha ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', quality || 0.85);
}

/** 读文件 → dataURL（原样，不解码） */
function readFileAsDataUrl(file) {
    return new Promise((res) => {
        const rd = new FileReader();
        rd.onload = () => res(String(rd.result || ''));
        rd.onerror = () => res('');
        rd.readAsDataURL(file);
    });
}

/** dataURL → Image 元素（解码失败 resolve(null)） */
function loadImage(dataUrl) {
    return new Promise((res) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => res(null);
        img.src = String(dataUrl || '');
    });
}

/**
 * 压缩一张已解码或未解码的图（对外暴露，表情包发送前再收一刀用）。
 * @param dataUrl 原图 dataURL
 * @param maxSide 最长边上限
 * @returns dataURL（保透明）
 */
export async function shrinkImage(dataUrl, maxSide = 400) {
    const img = await loadImage(dataUrl);
    if (!img) return String(dataUrl || '');
    try { return shrinkToDataUrl(img, maxSide, 0.82); }
    catch { return String(dataUrl || ''); }
}

/**
 * 文件选择 → dataURL（头像/图片用，自动压缩，保留透明通道）
 * @param maxSide 最长边上限 px
 */
export function pickImage(maxSide = 800) {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.style.display = 'none';
        document.body.appendChild(input);
        const cleanup = () => { try { input.remove(); } catch { /* noop */ } };
        input.addEventListener('change', async () => {
            const file = (input.files || [])[0];
            if (!file) { cleanup(); resolve(''); return; }
            const dataUrl = await readFileAsDataUrl(file);
            if (!dataUrl) { cleanup(); resolve(''); return; }
            const img = await loadImage(dataUrl);
            cleanup();
            if (!img) { resolve(dataUrl); return; }
            try { resolve(shrinkToDataUrl(img, maxSide, 0.85)); }
            catch { resolve(dataUrl); }
        });
        input.click();
    });
}

/**
 * 选一个文件 → { name, data }（dataURL，不压缩，原样返回）
 * 用于字体这类不能走 canvas 压缩的资源。
 * @param accept 如 '.ttf,.otf,.woff,.woff2' 或 'image/*'
 */
export function pickFile(accept = '*/*') {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.style.display = 'none';
        document.body.appendChild(input);
        const cleanup = () => { try { input.remove(); } catch { /* noop */ } };
        input.addEventListener('change', () => {
            const file = (input.files || [])[0];
            if (!file) { cleanup(); resolve(null); return; }
            const reader = new FileReader();
            reader.onload = () => {
                cleanup();
                resolve({ name: file.name, size: file.size, data: String(reader.result || '') });
            };
            reader.onerror = () => { cleanup(); resolve(null); };
            reader.readAsDataURL(file);
        });
        input.click();
    });
}

/**
 * 发图片的三条路（用户要求分开）：
 *   file   本地文件
 *   album  相册
 *   camera 拍照（capture=environment，移动端直接开摄像头）
 * @returns dataURL（压缩到 maxSide）或 ''
 */
export function pickImageFrom(source = 'file', maxSide = 1200) {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        if (source === 'camera') {
            input.setAttribute('capture', 'environment');
            // 部分浏览器只认这个属性写法
            input.capture = 'environment';
        }
        // album / file 都不加 capture，交给系统选择器
        input.style.display = 'none';
        document.body.appendChild(input);
        const cleanup = () => { try { input.remove(); } catch { /* noop */ } };
        input.addEventListener('change', async () => {
            const file = (input.files || [])[0];
            if (!file) { cleanup(); resolve(''); return; }
            const dataUrl = await readFileAsDataUrl(file);
            if (!dataUrl) { cleanup(); resolve(''); return; }
            const img = await loadImage(dataUrl);
            cleanup();
            if (!img) { resolve(dataUrl); return; }
            try { resolve(shrinkToDataUrl(img, maxSide, 0.82)); }
            catch { resolve(dataUrl); }
        });
        input.click();
    });
}

/**
 * 一次选多张图 → dataURL 数组（表情包这种要批量加的场景）
 * @param maxSide 最长边上限（默认 512：表情包要清晰，但再大就撑爆 localStorage）
 */
export function pickImages(maxSide = 512, max = 30) {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = true;
        input.style.display = 'none';
        document.body.appendChild(input);
        const cleanup = () => { try { input.remove(); } catch { /* noop */ } };

        const shrink = async (dataUrl) => {
            const img = await loadImage(dataUrl);
            if (!img) return String(dataUrl || '');
            try { return shrinkToDataUrl(img, maxSide, 0.85); }
            catch { return String(dataUrl || ''); }
        };

        input.addEventListener('change', async () => {
            const files = Array.from(input.files || []).slice(0, max);
            if (!files.length) { cleanup(); resolve([]); return; }
            const out = [];
            for (let i = 0; i < files.length; i++) {
                const dataUrl = await readFileAsDataUrl(files[i]);
                if (!dataUrl) continue;
                out.push({ name: files[i].name, src: await shrink(dataUrl) });
            }
            cleanup();
            resolve(out);
        });
        input.click();
    });
}

/** 触发下载（导出用） */
export function download(name, text, mime = 'application/json') {
    try {
        const blob = new Blob([text], { type: mime + ';charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { try { a.remove(); URL.revokeObjectURL(url); } catch { /* noop */ } }, 200);
        return true;
    } catch {
        return false;
    }
}

/** 相对时间 */
export function timeAgo(ts) {
    const d = new Date(ts);
    const s = Math.floor((Date.now() - d) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    const now = new Date();
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

/** 时钟 HH:MM */
export function clock(ts) {
    const d = new Date(ts);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

/** 会话分隔时间：今天/昨天/日期 + 时间 */
export function stamp(ts) {
    const d = new Date(ts), now = new Date();
    const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diffDay = Math.round((dayStart(now) - dayStart(d)) / 86400000);
    if (diffDay === 0) return clock(ts);
    if (diffDay === 1) return '昨天 ' + clock(ts);
    if (d.getFullYear() === now.getFullYear()) {
        return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + clock(ts);
    }
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}
