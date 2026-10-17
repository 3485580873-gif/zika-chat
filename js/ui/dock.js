/* ============================================================
   dock.js — 全局底部导航（用户拍板的 5 入口）
   ------------------------------------------------------------
   样式参照用户截图（Instagram 风）：磨砂悬浮胶囊，
   5 个入口：主界面 / 发信息 / 字卡管理 / 音乐(待做) / 朋友圈(待做)。

   显隐规则：主界面、字卡管理上显示；聊天等全屏功能页自动藏起
   （聊天有输入栏，再压一条 dock 会互相顶）。
   ============================================================ */

import { Page } from './page.js';
import { icon } from './icon.js';
import { toast } from './toast.js';

/* dock 上常驻的 5 个入口。ready:false = 占位（点了提示下一版上线） */
const ITEMS = [
    { id: 'home',    name: '主界面',  ico: 'home',    ready: true },
    { id: 'chat',    name: '发信息',  ico: 'chat',    ready: true },
    { id: 'cards',   name: '字卡管理', ico: 'cards',  ready: true },
    { id: 'music',   name: '音乐',    ico: 'music',   ready: false },
    { id: 'moments', name: '朋友圈',  ico: 'moments', ready: false }
];

/* 只在主界面显示；字卡库等全屏功能页有自己的底部操作键，
   dock 压上去会把它们挡住（2026-10-17 用户反馈） */
const SHOW_ON = ['home'];

let el = null;
let offChange = null;

/** 发消息 / 字卡管理：先回根，再进目标页（保持栈干净不叠加） */
function goto(id) {
    const cur = Page.current();
    if (cur === id) return;
    try {
        if (cur !== 'home') Page.home();
        Page.open(id);
    } catch (err) { console.error('[dock]', err); }
}

function sync(currentId) {
    if (!el) return;
    const show = SHOW_ON.indexOf(currentId) >= 0;
    el.classList.toggle('show', show);
    el.querySelectorAll('[data-dock]').forEach((b) => {
        b.classList.toggle('on', b.getAttribute('data-dock') === currentId);
    });
}

function onClick(e) {
    const btn = e.target.closest('[data-dock]');
    if (!btn) return;
    const id = btn.getAttribute('data-dock');
    const it = ITEMS.find((x) => x.id === id);
    if (!it) return;
    if (!it.ready) { toast(it.name + ' 功能下一版上线', 'warn', 1500); return; }
    if (id === 'home') { Page.home(); return; }
    goto(id);
}

export function initDock() {
    if (el) return;
    el = document.createElement('nav');
    el.className = 'dock';
    el.innerHTML = ITEMS.map((it) =>
        '<button class="dock-btn" data-dock="' + it.id + '" aria-label="' + it.name + '">' +
            '<i class="dock-ico">' + icon(it.ico, 24) + '</i>' +
            '<span>' + it.name + '</span>' +
        '</button>'
    ).join('');
    el.addEventListener('click', onClick);
    document.body.appendChild(el);
    offChange = Page.onChange(sync);
    sync(Page.current());
}

/** 键盘弹出时藏起 dock（输入别被顶住） */
export function dockKeyboard(open) {
    if (el) el.classList.toggle('kb', open);
}
