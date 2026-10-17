/* ============================================================
   page.js — 全屏页栈
   ------------------------------------------------------------
   以前站里「全屏页 / modal / 内联面板」三种范式混用，
   于是点开一个功能是居中卡片、点开另一个是全屏，观感割裂。
   这里只有一种：全屏页。所有功能都是一页，进栈/出栈统一管理。

   页面契约：
     factory(stage, params) → { el, destroy?(), resume?() }
   ============================================================ */

import { fromHTML } from './dom.js';

let stage = null;
const registry = new Map();   // id -> factory
const stack = [];             // [{ id, el, inst }]
const changeCbs = [];         // 页面栈变化回调（底部导航等全局 UI 用）
let depth = 0;
let selfPop = false;          // 标记：这次 popstate 是我们主动 history.back() 引起的

function notifyChange() {
    const id = stack.length ? stack[stack.length - 1].id : null;
    changeCbs.forEach((cb) => { try { cb(id); } catch { /* noop */ } });
}

function pushHistory(id) {
    try {
        depth += 1;
        history.pushState({ zkPage: id, zkDepth: depth }, '');
    } catch { /* file:// 下可能不可用，忽略 */ }
}

function isRoot() { return stack.length <= 1; }

export const Page = {
    /** 挂载舞台（只调用一次） */
    mount(container) {
        stage = container;
        window.addEventListener('popstate', () => {
            // 自己调用 history.back() 引起的这一次要忽略，
            // 否则「返回」会连退两层（踩过：设置页返回直接跳回主页）
            if (selfPop) { selfPop = false; return; }
            // 浏览器/安卓返回键
            if (stack.length > 1) Page.back(true);
        });
    },

    /** 注册页面工厂 */
    register(id, factory) { registry.set(id, factory); },

    /** 当前页 id */
    current() { return stack.length ? stack[stack.length - 1].id : null; },

    /** 当前页实例 */
    instance() { return stack.length ? stack[stack.length - 1].inst : null; },

    /**
     * 打开一页（进栈）
     * @returns 页面实例或 null
     */
    open(id, params = {}) {
        const factory = registry.get(id);
        if (!factory) { console.error('[page] 未注册的页面:', id); return null; }
        if (!stage) { console.error('[page] 舞台未挂载'); return null; }

        const el = fromHTML('<section class="page" data-page="' + id + '"></section>');
        stage.appendChild(el);

        let inst = null;
        try {
            inst = factory(el, params) || null;
        } catch (err) {
            console.error('[page] 页面构建失败:', id, err);
            el.remove();
            return null;
        }

        stack.push({ id, el, inst });
        pushHistory(id);

        // 入场动画
        void el.offsetWidth;
        el.classList.add('in');
        // 上一页退到幕后（保留 DOM，返回时不用重建）
        if (stack.length > 1) stack[stack.length - 2].el.classList.add('behind');
        notifyChange();
        return inst;
    },

    /**
     * 替换当前页（不增加栈深度）—— 例如「切换联系人」后回到聊天。
     */
    replace(id, params = {}) {
        if (!stack.length) return Page.open(id, params);
        const factory = registry.get(id);
        if (!factory) return null;

        const top = stack[stack.length - 1];
        try { if (top.inst && typeof top.inst.destroy === 'function') top.inst.destroy(); }
        catch (err) { console.error('[page] destroy 失败', err); }
        top.el.remove();
        stack.pop();

        return Page.open(id, params);
    },

    /**
     * 只刷新当前页（切联系人后重渲染同一页面时用）。
     */
    refresh(params = {}) {
        const id = Page.current();
        if (!id) return null;
        return Page.replace(id, params);
    },

    /** 返回上一页 */
    back(skipHistory = false) {
        if (stack.length <= 1) return false;
        const top = stack[stack.length - 1];
        top.el.classList.remove('in');
        top.el.classList.add('out');
        const done = () => {
            try { if (top.inst && typeof top.inst.destroy === 'function') top.inst.destroy(); }
            catch (err) { console.error('[page] destroy 失败', err); }
            try { top.el.remove(); } catch { /* noop */ }
        };
        setTimeout(done, 220);
        stack.pop();

        const now = stack[stack.length - 1];
        if (now) {
            now.el.classList.remove('behind');
            if (now.inst && typeof now.inst.resume === 'function') {
                try { now.inst.resume(); } catch (err) { console.error('[page] resume 失败', err); }
            }
        }
        if (!skipHistory) {
            selfPop = true;
            try { history.back(); } catch { /* noop */ }
        }
        notifyChange();
        return true;
    },

    /** 回到根页 */
    home() {
        while (stack.length > 1) Page.back(true);
        notifyChange();
        return true;
    },

    /** 订阅页面栈变化（底部导航显隐/高亮用），返回取消函数 */
    onChange(cb) {
        changeCbs.push(cb);
        return () => {
            const i = changeCbs.indexOf(cb);
            if (i >= 0) changeCbs.splice(i, 1);
        };
    },

    /** 销毁全部（切换会话等场景） */
    reset() {
        while (stack.length) {
            const top = stack.pop();
            try { if (top.inst && typeof top.inst.destroy === 'function') top.inst.destroy(); }
            catch { /* noop */ }
            try { top.el.remove(); } catch { /* noop */ }
        }
        notifyChange();
        return true;
    }
};
