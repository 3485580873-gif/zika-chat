/* ============================================================
   contacts.js — 联系人 / 群聊
   ------------------------------------------------------------
   · 每个人是一个独立会话，聊天记录互不共通
   · 群聊 = 多个联系人聚合，抽字卡时任一成员的专属卡都算可用

   交互约定（用户明确要求）：
   · 新建联系人：名字旁边直接有「确认 / 取消」，不用非得按回车
   · 新建群聊：右上角 + → 选人 → 页面底部出现「取消 / 确认」，
     列表页不显示这两个按钮（避免误导）
   ============================================================ */

import { Session } from '../core/session.js';
import { Avatars } from '../core/avatars.js';
import { Cards } from '../core/cards.js';
import { bus, EV } from '../core/bus.js';
import { esc, delegate, pickImage } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { Page } from '../ui/page.js';
import { icon } from '../ui/icon.js';
import { sheet } from '../ui/sheet.js';

export function ContactsPage(root, params) {
    let mode = 'list';          // 'list' | 'pick' | 'new'
    const picked = new Set();
    let list = [];
    const ui = {};

    function build() {
        root.innerHTML =
            '<header class="bar">' +
                '<button class="bar-btn" data-act="back" aria-label="返回">' + icon('chevronLeft', 23) + '</button>' +
                '<div class="bar-mid static"><span class="bar-nm" data-title>联系人</span></div>' +
                '<button class="bar-btn" data-act="add" aria-label="添加">' + icon('plus', 21) + '</button>' +
            '</header>' +
            '<div class="page-scroll" data-scroll>' +
                '<div class="ct-list" data-list></div>' +
            '</div>' +
            '<footer class="bar-foot" data-foot hidden>' +
                '<button class="btn ghost" data-act="cancel">取消</button>' +
                '<button class="btn solid" data-act="confirm" data-confirm>确认</button>' +
            '</footer>';

        ui.scroll = root.querySelector('[data-scroll]');
        ui.list = root.querySelector('[data-list]');
        ui.title = root.querySelector('[data-title]');
        ui.foot = root.querySelector('[data-foot]');
        ui.confirm = root.querySelector('[data-confirm]');
    }

    /* ---------- 新建联系人行（内联在列表末尾） ---------- */
    function newRowHtml() {
        return '<div class="ct-newbox">' +
            '<b class="ct-newlb">新建联系人</b>' +
            '<input class="ct-input" data-newname placeholder="名字" maxlength="24">' +
            '<div class="ct-newbtns">' +
                '<button class="ct-newbtn ghost" data-act="cancelnew">取消</button>' +
                '<button class="ct-newbtn solid" data-act="createnew">确认</button>' +
            '</div>' +
        '</div>';
    }

    function render() {
        const curId = Session.currentId();

        /* ---- 选人建群 ---- */
        if (mode === 'pick') {
            ui.title.textContent = '选择成员';
            ui.foot.hidden = false;
            ui.confirm.textContent = '确认（' + picked.size + '）';
            const friends = list.filter((c) => c.kind === 'friend');
            ui.list.innerHTML = friends.length ? friends.map((c) =>
                '<button class="ct-row pick' + (picked.has(c.id) ? ' on' : '') + '" data-pick="' + esc(c.id) + '">' +
                    Avatars.html(c.id) +
                    '<span class="ct-nm">' + esc(c.name) + '</span>' +
                    '<i class="ct-tick">' + icon('check', 16) + '</i>' +
                '</button>'
            ).join('') : '<div class="ct-empty">还没有联系人可选</div>';
            return;
        }

        /* ---- 列表 ---- */
        ui.title.textContent = '联系人';
        ui.foot.hidden = true;

        let html = '';
        if (!list.length) {
            html = '<div class="ct-empty">' + icon('users', 32) +
                '<p>还没有联系人</p><span>点右上角 + 添加第一个</span></div>';
        } else {
            html = list.map((c) => {
                const isCur = c.id === curId;
                const sub = c.kind === 'group'
                    ? Session.membersOf(c).length + ' 位成员'
                    : (c.sign || ('可用字卡 ' + Cards.countFor(c.id) + ' 条'));
                return '<div class="ct-row' + (isCur ? ' cur' : '') + '" data-open="' + esc(c.id) + '">' +
                    Avatars.html(c.id) +
                    '<span class="ct-main"><b class="ct-nm">' + esc(c.name) + '</b>' +
                    '<i class="ct-sub">' + esc(sub) + '</i></span>' +
                    (isCur ? '<i class="ct-cur">当前</i>' : '') +
                    '<button class="ct-more" data-more="' + esc(c.id) + '" aria-label="更多">' + icon('more', 18) + '</button>' +
                    '</div>';
            }).join('');
        }

        // 新建联系人：内联在列表下方，带确认 / 取消
        if (mode === 'new') html += newRowHtml();
        ui.list.innerHTML = html;

        if (mode === 'new') {
            const input = ui.list.querySelector('[data-newname]');
            if (input) {
                input.focus();
                requestAnimationFrame(() => { ui.scroll.scrollTop = ui.scroll.scrollHeight; });
            }
        }
    }

    function reload() {
        list = Session.all();
        render();
    }

    function backToList() {
        mode = 'list';
        picked.clear();
        render();
    }

    /* ---------- 新建联系人 ---------- */
    function startCreate() {
        mode = 'new';
        render();
    }

    function createFriend() {
        const input = ui.list.querySelector('[data-newname]');
        if (!input) return;
        const name = (input.value || '').trim();
        if (!name) { toast('先写个名字', 'warn'); return; }
        const c = Session.add({ name, kind: 'friend' });
        mode = 'list';
        Session.activate(c.id);
        toast('已添加 ' + name, 'ok');
        try { Page.back(); } catch { /* noop */ }
    }

    /* ---------- 群聊 ---------- */
    function startGroup() {
        if (list.filter((c) => c.kind === 'friend').length < 2) {
            toast('至少需要 2 个联系人才能建群', 'warn');
            return;
        }
        mode = 'pick';
        picked.clear();
        render();
    }

    function createGroup() {
        const ids = Array.from(picked);
        if (ids.length < 2) { toast('至少选 2 个人', 'warn'); return; }
        const names = ids.map((id) => (Session.get(id) || {}).name).filter(Boolean);
        const c = Session.add({
            name: names.slice(0, 3).join('、') + (names.length > 3 ? ' 等' : ''),
            kind: 'group',
            members: ids
        });
        mode = 'list';
        picked.clear();
        Session.activate(c.id);
        toast('群聊已创建', 'ok');
        try { Page.back(); } catch { /* noop */ }
    }

    function openMore(id) {
        const c = Session.get(id);
        if (!c) return;
        sheet(c.name, [
            {
                label: '切换到这个会话', icon: icon('card', 18),
                onSelect: () => { Session.activate(id); try { Page.back(); } catch { /* noop */ } }
            },
            {
                label: '改名字', icon: icon('pen', 18),
                onSelect: () => {
                    const v = window.prompt('新名字', c.name);
                    if (v === null) return;
                    const t = String(v).trim();
                    if (!t) { toast('名字不能为空', 'warn'); return; }
                    Session.update(id, { name: t });
                    toast('已改名', 'ok');
                }
            },
            {
                label: '改签名', icon: icon('pen', 18),
                onSelect: () => {
                    const v = window.prompt('签名（显示在顶栏）', c.sign || '');
                    if (v === null) return;
                    Session.update(id, { sign: String(v).trim() });
                    toast('已更新', 'ok');
                }
            },
            {
                label: c.kind === 'group' ? '群头像是成员合成的' : '换头像',
                icon: icon('image', 18),
                onSelect: async () => {
                    if (c.kind === 'group') { toast('群头像由成员头像合成', 'warn'); return; }
                    const src = await pickImage(600);
                    if (!src) return;
                    Avatars.set(id, src);
                    toast('已更新头像', 'ok');
                }
            },
            {
                label: '删除', icon: icon('trash', 18), danger: true,
                onSelect: () => {
                    if (!window.confirm('删除「' + c.name + '」？聊天记录会一起删掉。')) return;
                    Session.remove(id);
                    toast('已删除', 'ok');
                }
            }
        ]);
    }

    function bind() {
        delegate(root, 'click', '[data-act]', (e, t) => {
            const act = t.getAttribute('data-act');
            if (act === 'back') {
                // 在任何子模式里按返回，先退回列表，再按一次才离开页面
                if (mode !== 'list') { backToList(); return; }
                try { Page.back(); } catch { /* noop */ }
            }
            else if (act === 'add') {
                sheet('添加', [
                    { label: '新建联系人', icon: icon('users', 18), onSelect: startCreate },
                    { label: '新建群聊', icon: icon('plus', 18), onSelect: startGroup }
                ]);
            }
            else if (act === 'cancel') backToList();
            else if (act === 'confirm') { if (mode === 'pick') createGroup(); }
            else if (act === 'cancelnew') backToList();
            else if (act === 'createnew') createFriend();
        });

        delegate(root, 'click', '[data-open]', (e, t) => {
            const id = t.getAttribute('data-open');
            // 点联系人 → 直接进聊天（用户要求：传讯入口一步到位，不要中间的列表层）
            if (Session.activate(id)) {
                try { Page.open('chat'); } catch (err) { console.error(err); }
            }
        });

        delegate(root, 'click', '[data-more]', (e, t) => {
            e.stopPropagation();
            openMore(t.getAttribute('data-more'));
        });

        delegate(root, 'click', '[data-pick]', (e, t) => {
            const id = t.getAttribute('data-pick');
            if (picked.has(id)) picked.delete(id); else picked.add(id);
            t.classList.toggle('on', picked.has(id));
            if (ui.confirm) ui.confirm.textContent = '确认（' + picked.size + '）';
        });

        // 回车也能创建（但不再是唯一方式）
        delegate(root, 'keydown', '[data-newname]', (e, t) => {
            if (e.key === 'Enter') { e.preventDefault(); createFriend(); }
        });
    }

    const offs = [
        bus.on(EV.CONTACTS_CHANGED, reload),
        bus.on(EV.AVATAR_CHANGED, reload),
        bus.on(EV.CARDS_CHANGED, render)
    ];

    build();
    bind();
    reload();

    return {
        resume: reload,
        destroy() { offs.forEach((off) => { try { off(); } catch { /* noop */ } }); }
    };
}
