/* ============================================================
   cards.js — 字卡库（全屏页）
   ------------------------------------------------------------
   页面结构（从上到下）：

     ① 五大栏目 tabs：主字卡 / 互动 / 表情包 / 氛围感 / 朋友圈
     ② 工具栏（可收起，点顶栏筛选键往下展开）：
        归属行 —— 全部 · 专用 · 公用（专用可切联系人）
        小栏目行 —— 只有「有小栏目」的大栏目才有
                     互动 → 颜文字 / emoji / 拍一拍
                     朋友圈 → 个性签名 / 网名 / 路人评论 / 路人帖子
                     氛围感 → 对方状态 / 他的位置
                     主字卡 / 表情包 没有小栏目，这行不显示
        分组行 —— 全部 + 各分组 + 新建 + 管理
     ③ 搜索框
     ④ 添加框（常驻在搜索下面，文字/图片都能就地加）
     ⑤ 内容区：按分组折叠，字卡竖排往下滑
     ⑥ 底部：管理 / 去重 / 导出字卡 / 导出表情包 / 导入

   ★ 归属规则（v13 重做，参照 dunian）：
     不再有「公用 / 专属」。每个联系人各自持有一整套字卡，
     存储按联系人分桶（core/cards.js + core/media.js 都改成了 scope:'session'）。
     顶栏第二个横条就是「切换看谁的字卡」，切谁就只显示谁的库。
     主字卡走 Cards；其余走 Media。

   ★ v28：聊天抽屉里的「我上传的」保留组（__mine）**在字卡库里不出现**
     （条目和分组都隐藏，数据本身不动）—— 只在聊天表情包里增删。
     导出也拆成两个按钮：导出字卡（dunian 格式）/ 导出表情包（可原样导回）。

   导入兼容：
     纯文本（一行一条，[专属] 前缀自动识别）/ JSON（items+groups /
     纯数组 / 本站备份格式）。图片类导入保留分组。
   ============================================================ */

import { Cards } from '../core/cards.js';
import { Media, KINDS, CATEGORIES } from '../core/media.js';
import { Session } from '../core/session.js';
import { Store } from '../core/store.js';
import { bus, EV } from '../core/bus.js';
import { esc, delegate, pickImages, pickFile, download } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { Page } from '../ui/page.js';
import { sheet } from '../ui/sheet.js';
import { icon } from '../ui/icon.js';

const FALLBACK_CAT = 'text';

export function CardsPage(root, params) {
    /* ---------------- 状态 ---------------- */
    let cat = (params && params.cat) || FALLBACK_CAT;   // 大栏目
    if (!CATEGORIES.some((c) => c.id === cat) || cat === 'all') cat = FALLBACK_CAT;

    let who = (Session.current() || {}).id || '';   // 当前在看谁的字卡
    let kind = '';            // 当前小栏目（仅多栏目的大栏目用）
    let group = 'all';        // 分组：all 全部 | 分组名
    let toolOpen = true;      // 工具栏展开 / 收起

    const expanded = new Set();   // 展开的分组（默认全折叠，只露名字）
    const blockCache = {};         // key → 该组条目（懒渲染用）
    const shownAll = new Set();    // 已点「显示全部」的组
    let manage = false;            // 多选管理模式
    let groupManage = false;       // 分组管理面板
    let editing = null;            // { kind, id }
    let kw = '';
    const selected = new Set();    // kind + '|' + id
    const ui = {};

    const selKey = (k, id) => k + '|' + id;

    /* ---------------- 取值 ---------------- */
    function category() {
        return CATEGORIES.find((c) => c.id === cat) || CATEGORIES.find((c) => c.id === FALLBACK_CAT);
    }
    function kinds() { return category().kinds; }
    function hasKinds() { return kinds().length > 1; }
    function isTextKind(k) { return k === 'text'; }
    function isImageKind(k) { return !!(KINDS[k] && KINDS[k].image); }

    /* ---------------- 数据适配（text 走 Cards，其余走 Media） ---------------- */
    /**
     * ★ 用户 2026-10-17：「字卡库不要搞那个我上传的表情包分组，
     *   这个只需要在聊天界面的表情包里面进行添加删除。」
     *   __mine 是聊天抽屉里「我上传的」保留组，只在聊天里增删，
     *   字卡库这边一律隐藏（条目和分组都藏），不去改数据本身。
     */
    const HIDDEN_GROUPS = ['__mine'];

    function listOfKind(k) {
        if (isTextKind(k)) {
            return Cards.all()
                .filter((x) => HIDDEN_GROUPS.indexOf(x.group || '') < 0)
                .map((x) => ({ id: x.id, text: x.text, group: x.group }));
        }
        return Media.list(k)
            .filter((it) => HIDDEN_GROUPS.indexOf(it.group || '') < 0)
            .map((it) => ({
                id: it.id, text: it.text, src: it.src, name: it.name, group: it.group
            }));
    }

    function allOfKind(k) { return listOfKind(k); }

    function groupsOfKind(k) { return isTextKind(k) ? Cards.groups() : Media.groups(k); }

    /* ---------------- 当前联系人（谁）的条目 ---------------- */
    /** 切到谁：改 Store 的当前分桶，字卡/素材随之整库切换 */
    function switchWho(id) {
        if (!id || id === who) return;
        who = id;
        Store.setSessionId(id);
        Cards._migrate();
        Media._migrate();
        group = 'all';
        expanded.clear();
    }

    /** 当前小栏目的条目（已经天然只含当前联系人的库） */
    function scopedItems(k) {
        const kk = k || kind;
        if (!kk) return [];
        return listOfKind(kk);
    }

    /** 分组条上的分组：声明的全显示（空组也要显示，用户明确要求），
        另外把条目里实际出现过的分组自动补齐。
        ★ 隐藏组（__mine）不出现 —— 只在聊天表情包里管 */
    function visibleGroups() {
        const items = scopedItems();
        const declared = groupsOfKind(kind).filter((g) => g && HIDDEN_GROUPS.indexOf(g.name) < 0);
        const out = declared.slice();
        items.forEach((x) => {
            const g = x.group || '';
            if (g && HIDDEN_GROUPS.indexOf(g) < 0 && !out.some((y) => y.name === g)) out.push({ name: g, enabled: true });
        });
        return out;
    }

    /** 分组显示名：__mine 是保留组，字卡库不显示它 */
    function groupName(g) { return g; }

    /* ---------------- 增删改（按 kind 分派） ---------------- */
    function addGroupOfKind(k, name) {
        const ok = isTextKind(k) ? Cards.addGroup(name) : Media.addGroup(k, name);
        // 新建的组立刻选中：图片类这样能马上往这个组上传，不用再点一次分组
        if (ok) group = name;
        return ok;
    }
    function renameGroupOfKind(k, o, n) { return isTextKind(k) ? Cards.renameGroup(o, n) : Media.renameGroup(k, o, n); }
    function removeGroupOfKind(k, name) { return isTextKind(k) ? Cards.removeGroup(name) : Media.removeGroup(k, name); }
    function toggleGroupOfKind(k, name) { return isTextKind(k) ? Cards.toggleGroup(name) : Media.toggleGroup(k, name); }
    function moveToGroupOfKind(k, ids, g) { return isTextKind(k) ? Cards.moveToGroup(ids, g) : Media.moveToGroup(k, ids, g); }
    function removeManyOfKind(k, ids) { return isTextKind(k) ? Cards.removeMany(ids) : Media.removeMany(k, ids); }
    function dedupeOfKind(k) { return isTextKind(k) ? Cards.dedupe() : Media.dedupe(k); }
    function updateItemOfKind(k, id, patch) { return isTextKind(k) ? Cards.update(id, patch) : Media.update(k, id, patch); }
    function addItemOfKind(k, value, name, groupV) {
        return isTextKind(k)
            ? Cards.addMany(value, groupV)
            : Media.add(k, value, name, groupV);
    }
    function addItemsOfKind(k, arr, groupV) {
        if (isTextKind(k)) {
            const texts = arr.map((x) => (typeof x === 'string' ? x : (x.text || ''))).filter(Boolean).join('\n');
            return Cards.addMany(texts, groupV);
        }
        return Media.addMany(k, arr, groupV);
    }

    /* ---------------- 片段 ---------------- */
    function emptyBox(title, desc) {
        return '<div class="ck-empty">' + icon('cards', 30) +
            '<p>' + esc(title) + '</p><span>' + esc(desc) + '</span></div>';
    }

    /* ---------------- ① 五大栏目 tabs ---------------- */
    function tabCount(c) {
        let n = 0;
        c.kinds.forEach((k) => { n += listOfKind(k).length; });
        return n;
    }
    function renderTabs() {
        ui.tabs.innerHTML = CATEGORIES.filter((c) => c.id !== 'all').map((c) =>
            '<button class="ck-tab' + (c.id === cat ? ' on' : '') + '" data-cat="' + c.id + '">' +
            esc(c.name) + '<i>' + tabCount(c) + '</i></button>'
        ).join('');
    }

    /* ---------------- ② 切换看谁的字卡（每个联系人一套，互不干扰） ---------------- */
    function whoChipsHtml() {
        const cs = Session.all();
        if (!cs.length) {
            return '<div class="ck-whobar"><span class="ck-whohint">先添加联系人，才能给他配字卡</span></div>';
        }
        return '<div class="ck-whobar">' + cs.map((c) => {
            const cur = c.id === who;
            let n = 0;
            if (cur) kinds().forEach((k) => { n += listOfKind(k).length; });
            return '<button class="ck-whochip' + (cur ? ' on' : '') + '" data-who="' + esc(c.id) + '">' +
                '<i class="ck-whoav" style="' + (c.avatar ? 'background-image:url(' + JSON.stringify(c.avatar) + ')' : '') + '"></i>' +
                esc(c.name) + (cur ? '<em>' + n + '</em>' : '') + '</button>';
        }).join('') + '</div>';
    }

    /* ---------------- ③ 小栏目切换（仅多栏目的大栏目） ---------------- */
    function kindBarHtml() {
        return kinds().map((k) => {
            const n = listOfKind(k).length;
            return '<button class="ck-kchip' + (k === kind ? ' on' : '') + '" data-kind="' + k + '">' +
                esc(KINDS[k].name) + '<em>' + n + '</em></button>';
        }).join('');
    }

    /* ---------------- ④ 分组切换 ---------------- */
    function groupBarHtml() {
        const gs = visibleGroups();
        const items = scopedItems();
        const cnt = (name) => items.filter((x) => (x.group || '') === name).length;
        const isImg = isImageKind(kind);

        /* 表情包（图片类）：按 dunian 的做法 —— 圆形图标横排，组图标取组内第一张图，
           末尾一个虚线圆「+」建新组。文字标签在图片场景下完全看不清（用户报「没显示分组名」）。 */
        if (isImg) {
            return '<div class="ck-gnav">' +
                '<button class="ck-gicon all' + (group === 'all' ? ' active' : '') + '" data-group="all">' +
                    '<span class="ck-gicon-tx">全部</span><i>' + items.length + '</i>' +
                '</button>' +
                gs.map((g) => {
                    const first = items.find((x) => x.group === g.name && x.src);
                    const bg = first
                        ? 'background-image:url(' + JSON.stringify(String(first.src).slice(0, 200)) + ')'
                        : '';
                    // 空组显示组名首字（原来纯空白圆，用户以为「分组没显示出来」）
                    const ch = g.name ? groupName(g.name).slice(0, 1) : '?';
                    return '<button class="ck-gicon' + (group === g.name ? ' active' : '') +
                        (g.enabled ? '' : ' off') + (first ? '' : ' empty') + '" data-group="' + esc(g.name) + '" ' +
                        'style="' + bg + '" title="' + esc(groupName(g.name)) + '">' +
                        (first ? '' : '<b class="ck-gicon-ch">' + esc(ch) + '</b>') +
                        '<span class="ck-gicon-tx">' + esc(groupName(g.name)) + '</span>' +
                        '<i>' + cnt(g.name) + '</i></button>';
                }).join('') +
                '<button class="ck-gicon add" data-act="newgroup" title="新建分组">' + icon('plus', 18) + '</button>' +
                '<button class="ck-gicon mgr' + (groupManage ? ' active' : '') + '" data-act="groupmanage" title="管理分组">' +
                    icon('sliders', 16) + '</button>' +
            '</div>';
        }

        /* 文本类：文字标签横排 */
        return '<button class="ck-gchip' + (group === 'all' ? ' on' : '') + '" data-group="all">' +
                '全部<em>' + items.length + '</em></button>' +
            gs.map((g) =>
                '<button class="ck-gchip' + (group === g.name ? ' on' : '') + (g.enabled ? '' : ' off') + '" ' +
                'data-group="' + esc(g.name) + '">' + esc(groupName(g.name)) + '<em>' + cnt(g.name) + '</em></button>'
            ).join('') +
            '<button class="ck-gchip add" data-act="newgroup">' + icon('plus', 13) + '分组</button>' +
            '<button class="ck-gchip mgr' + (groupManage ? ' on' : '') + '" data-act="groupmanage">管理</button>';
    }

    /* ---------------- 分组管理面板 ---------------- */
    function groupPanelHtml() {
        const gs = visibleGroups();
        const items = scopedItems();
        const cnt = (name) => items.filter((x) => (x.group || '') === name).length;

        const head = '<section class="ck-gpanel">' +
            '<b class="ck-blockt">「' + esc(KINDS[kind].name) + '」的分组</b>';

        if (!gs.length) {
            return head + '<p class="ck-tip">这个归属下还没有分组。点上面「+ 分组」新建，比如「日常」「睡前」。</p></section>';
        }

        return head + gs.map((g) =>
            '<div class="ck-grow">' +
                '<b>' + esc(groupName(g.name)) + '</b>' +
                '<span class="ck-gcount">' + cnt(g.name) + ' 条</span>' +
                '<div class="ck-gbtns">' +
                    '<button class="ck-mini' + (g.enabled ? ' on' : '') + '" data-toggleg="' + esc(g.name) + '">' +
                        (g.enabled ? '启用中' : '已停用') + '</button>' +
                    '<button class="ck-mini" data-reng="' + esc(g.name) + '">重命名</button>' +
                    '<button class="ck-mini danger" data-delg="' + esc(g.name) + '">删除</button>' +
                '</div>' +
            '</div>'
        ).join('') + '</section>';
    }

    /* ---------------- 内容：竖排条目 ---------------- */
    function itemsStrip(k, list, isImg) {
        if (!list.length) return '';
        if (isImg) {
            return list.map((it) => {
                const key = selKey(k, it.id);
                return '<div class="ck-stk' + (selected.has(key) ? ' sel' : '') + '" data-pick="' + k + '|' + esc(it.id) + '">' +
                    '<img src="' + esc(it.src) + '" alt="' + esc(it.name || '') + '">' +
                    (manage ? '<i class="ck-check' + (selected.has(key) ? ' on' : '') + '"></i>'
                            : '<button class="ck-stkdel" data-del="' + key + '" aria-label="删除">' + icon('trash', 12) + '</button>') +
                '</div>';
            }).join('');
        }
        return list.map((it) => {
            const key = selKey(k, it.id);
            if (editing && editing.kind === k && editing.id === it.id) {
                return '<div class="ck-chip editing">' +
                    '<input class="ck-editinput" data-editinput value="' + esc(it.text) + '">' +
                    '<button class="ck-mini" data-actsave="' + k + '|' + esc(it.id) + '">存</button>' +
                    '<button class="ck-mini" data-act="canceledit">×</button></div>';
            }
            const gTag = it.group ? '<span class="ck-tag">' + esc(it.group) + '</span>' : '';
            return '<div class="ck-chip' + (selected.has(key) ? ' sel' : '') + '" data-pick="' + key + '">' +
                (manage ? '<i class="ck-check' + (selected.has(key) ? ' on' : '') + '"></i>' : '') +
                '<span class="ck-txt">' + esc(it.text) + '</span>' + gTag +
                (manage ? '' :
                    '<button class="ck-del" data-edit="' + key + '" aria-label="编辑">' + icon('pen', 12) + '</button>' +
                    '<button class="ck-del" data-del="' + key + '" aria-label="删除">' + icon('trash', 12) + '</button>') +
            '</div>';
        }).join('');
    }

    /* ---------------- 内容：分组折叠块 ---------------- */
    /**
     * 分组折叠块。
     * ★ 折叠时只渲染标题、不渲染内容 —— dunian 那种 1470 条字卡的文件导入后
     *   把每条都塞进 DOM 会直接把页面卡死（用户报「导入后崩」就是这个）。
     *   展开那一刻才把该组内容真正生成，同样支持（导出要看全部但那只读文本，不碰 DOM）。
     */
    function groupBlockHtml(key, label, list, isImg, enabled) {
        const open = expanded.has(key);
        blockCache[key] = list;
        return '<section class="ck-gblk' + (open ? ' open' : '') + '" data-blk="' + esc(key) + '">' +
            '<button class="ck-ghd" data-fold="' + esc(key) + '">' +
                '<i class="ck-chev"></i>' +
                '<span class="ck-ghn">' + esc(label) +
                    (enabled === false ? '<i class="ck-goff">已停用</i>' : '') + '</span>' +
                '<em>' + list.length + '</em>' +
            '</button>' +
            '<div class="ck-gbd">' +
                (open ? renderBlockBody(key, list, isImg) : '') +
            '</div>' +
        '</section>';
    }

    /** 折叠块的内容（只在展开时生成） */
    function renderBlockBody(key, list, isImg) {
        if (!list || !list.length) return '<p class="ck-subempty">展开后从上面添加框往这个分组加</p>';
        // 单组超过 200 条时先只渲染前 200 条，底部给「显示全部」——避免一次生成上千个节点卡死
        const CAP = 200;
        const sliced = (list.length > CAP && !shownAll.has(key)) ? list.slice(0, CAP) : list;
        const more = list.length > CAP && !shownAll.has(key)
            ? '<div class="ck-loadmore"><button class="cs-btn" data-loadmore="' + esc(key) + '">' +
              '显示全部（' + list.length + ' 条，先显示 ' + CAP + '）</button></div>'
            : '';
        return '<div class="ck-strip">' + itemsStrip(kind, sliced, isImg) + '</div>' + more;
    }

    /* ---------------- 添加框（常驻在搜索下面） ---------------- */
    function adderHtml() {
        const k = kind;
        const meta = KINDS[k];
        const isImg = isImageKind(k);
        const gs = groupsOfKind(k);

        const defGroup = (group !== 'all') ? group : '';

        const groupCtrl =
            '<select class="ck-select" data-newgroup>' +
                '<option value="">未分组</option>' +
                gs.map((g) => '<option value="' + esc(g.name) + '"' + (defGroup === g.name ? ' selected' : '') + '>' +
                    esc(groupName(g.name)) + '</option>').join('') +
            '</select>';

        const whoName = (Session.get(who) || {}).name || '';

        if (isImg) {
            return '<div class="ck-add">' +
                '<div class="ck-row2">' + groupCtrl + '</div>' +
                '<button class="ck-btn primary wide" data-act="import" data-for="' + k + '">' +
                    icon('image', 15) + '选择图片（可多选）</button>' +
            '</div>';
        }

        return '<div class="ck-add">' +
            '<textarea class="ck-ta" data-newtext rows="2" placeholder="一行一条，加给「' + esc(whoName) + '」的' + esc(meta.name) + '"></textarea>' +
            '<div class="ck-row2">' + groupCtrl +
                '<button class="ck-btn primary" data-act="addtext" data-for="' + k + '">' + icon('plus', 15) + '添加</button>' +
            '</div>' +
        '</div>';
    }

    /* ---------------- 搜索 ---------------- */
    function searchHtml() {
        const hits = [];
        kinds().forEach((k) => {
            listOfKind(k).forEach((it) => {
                const hay = ((it.text || '') + ' ' + (it.name || '')).toLowerCase();
                if (hay.indexOf(kw.toLowerCase()) >= 0) hits.push({ k, it });
            });
        });
        if (!hits.length) return emptyBox('没有匹配的内容', '换个关键词试试');

        const byKind = {};
        hits.forEach((h) => { (byKind[h.k] = byKind[h.k] || []).push(h.it); });

        return Object.keys(byKind).map((k) =>
            '<section class="ck-gblk open"><div class="ck-ghd static">' +
                '<span class="ck-ghn">' + esc(KINDS[k].name) + '</span><em>' + byKind[k].length + '</em>' +
            '</div>' +
            '<div class="ck-gbd"><div class="ck-strip">' + itemsStrip(k, byKind[k], isImageKind(k)) + '</div></div>' +
            '</section>'
        ).join('');
    }

    /* ---------------- 渲染主体 ---------------- */
    function bodyHtml() {
        if (kw) return searchHtml();

        const isImg = isImageKind(kind);
        const items = scopedItems();
        const gs = visibleGroups();

        // 选中了某个分组 → 只显示该分组
        if (group !== 'all') {
            const list = items.filter((x) => (x.group || '') === group);
            return (list.length
                ? '<div class="ck-gblock"><div class="ck-strip">' + itemsStrip(kind, list, isImg) + '</div></div>'
                : emptyBox('「' + groupName(group) + '」还没有内容', '用上面的输入框往这个分组添加')
            );
        }

        // 全部 → 按分组折叠（默认折叠，只露名字）
        let html = '';
        const un = items.filter((x) => !x.group);
        if (un.length) html += groupBlockHtml('', '未分组', un, isImg, true);
        gs.forEach((g) => {
            const list = items.filter((x) => (x.group || '') === g.name);
            html += groupBlockHtml(g.name, groupName(g.name), list, isImg, !!g.enabled);
        });

        // 一个字都没有、也没有任何分组 → 给一句提示
        if (!items.length && !gs.length) {
            html = emptyBox('「' + KINDS[kind].name + '」还是空的',
                '在上面添加，或点底部「导入」从备份文件恢复') + html;
        }
        return html;
    }

    function render() {
        // 兜底：字卡库渲染出错时不要白屏（导入大文件后尤其要防）
        try { renderInner(); }
        catch (err) {
            console.error('[cards] render 出错', err);
            try {
                ui.body.innerHTML = '<div class="ck-empty"><p>字卡库出了点问题</p>' +
                    '<span>数据还在，关掉页面重新打开即可</span></div>';
            } catch { /* noop */ }
        }
    }

    function renderInner() {
        const ks = kinds();
        if (ks.indexOf(kind) < 0) kind = ks[0];
        if (group !== 'all' && !groupsOfKind(kind).some((g) => g.name === group)) group = 'all';
        if (!who) who = (Session.current() || {}).id || (Session.all()[0] || {}).id || '';

        renderTabs();
        ui.toolWrap.classList.toggle('open', toolOpen);
        ui.filterBtn.innerHTML = toolOpen ? icon('chevronUp', 19) : icon('sliders', 19);
        ui.who.innerHTML = whoChipsHtml();
        ui.kindrow.hidden = !hasKinds();
        ui.kindrow.innerHTML = hasKinds() ? kindBarHtml() : '';
        ui.grouprow.innerHTML = groupBarHtml();
        ui.adder.innerHTML = adderHtml();

        ui.body.innerHTML = (groupManage ? groupPanelHtml() : '') + bodyHtml();
        renderFoot();
    }

    /* ---------------- 底部操作条 ---------------- */
    function visibleItemKeys() {
        const set = new Set();
        scopedItems().forEach((it) => {
            if (group !== 'all' && (it.group || '') !== group) return;
            set.add(selKey(kind, it.id));
        });
        return set;
    }

    function renderFoot() {
        if (manage) {
            const total = visibleItemKeys().size;
            ui.foot.innerHTML =
                '<button class="ck-fbtn ghost" data-act="selectall">' +
                    (selected.size === total && total ? '取消全选' : '全选') + '</button>' +
                '<button class="ck-fbtn" data-act="moveto">移动到分组 (' + selected.size + ')</button>' +
                '<button class="ck-fbtn danger" data-act="delselected">删除 (' + selected.size + ')</button>' +
                '<button class="ck-fbtn ghost" data-act="exitmanage">完成</button>';
            return;
        }
        ui.foot.innerHTML =
            '<button class="ck-fbtn ghost" data-act="manage">管理</button>' +
            '<button class="ck-fbtn ghost" data-act="dedupe">去重</button>' +
            '<button class="ck-fbtn ghost" data-act="export">导出字卡</button>' +
            '<button class="ck-fbtn ghost" data-act="exportsticker">导出表情包</button>' +
            '<button class="ck-fbtn ghost" data-act="import">导入</button>';
    }

    /* ---------------- 添加 ---------------- */
    function addText(k) {
        // 从 root 实时查，避免闭包里的旧引用（多次 render 后旧节点已销毁）
        const ta = root.querySelector('[data-newtext]');
        const gEl = root.querySelector('[data-newgroup]');
        if (!ta) { toast('添加框没找到，请重新进入字卡库', 'warn'); return; }
        const v = ta.value || '';
        if (!v.trim()) { toast('先写点内容', 'warn'); return; }
        const g = gEl ? (gEl.value || '') : '';
        const n = addItemOfKind(k, v, '', g);
        if (!n) { toast('这些内容已经在库里了', 'warn'); return; }
        ta.value = '';
        render();
        toast('已添加 ' + n + ' 条', 'ok');
    }

    async function importImages(k) {
        const files = await pickImages(512, 30);
        if (!files.length) return;
        const gEl = root.querySelector('[data-newgroup]');
        const g = gEl ? (gEl.value || '') : '';
        const n = Media.addMany(k, files.map((f) => ({ src: f.src, name: f.name })), g);
        render();
        toast(n ? ('已导入 ' + n + ' 张') : '没有可导入的图', n ? 'ok' : 'warn');
    }

    /* ---------------- 管理操作 ---------------- */
    function askMoveTo() {
        if (!selected.size) { toast('先勾选内容', 'warn'); return; }
        const kindsSet = new Set(Array.from(selected).map((k) => k.split('|')[0]));
        if (kindsSet.size > 1) { toast('移动到分组请只选同一类', 'warn'); return; }
        const k = Array.from(kindsSet)[0];
        const gs = groupsOfKind(k);
        const items = [{ label: '未分组', onSelect: () => doMove(k, '') }]
            .concat(gs.map((g) => ({ label: g.name, onSelect: () => doMove(k, g.name) })));
        sheet('移动到分组（' + selected.size + ' 项）', items);
    }

    function doMove(k, g) {
        const ids = Array.from(selected).filter((x) => x.split('|')[0] === k).map((x) => x.split('|')[1]);
        const n = moveToGroupOfKind(k, ids, g);
        selected.clear();
        manage = false;
        render();
        toast(n ? ('已移动 ' + n + ' 项到「' + (g || '未分组') + '」') : '没有移动', n ? 'ok' : 'warn');
    }

    function delSelected() {
        if (!selected.size) { toast('先勾选内容', 'warn'); return; }
        if (!window.confirm('删除选中的 ' + selected.size + ' 项？')) return;
        const byKind = {};
        selected.forEach((k) => {
            const p = k.split('|');
            (byKind[p[0]] = byKind[p[0]] || []).push(p[1]);
        });
        let n = 0;
        Object.keys(byKind).forEach((k) => { n += removeManyOfKind(k, byKind[k]); });
        selected.clear();
        manage = false;
        render();
        toast('已删除 ' + n + ' 项', 'ok');
    }

    function doDedupe() {
        let n = 0;
        kinds().forEach((k) => { n += dedupeOfKind(k); });
        render();
        toast(n ? ('去掉了 ' + n + ' 条重复') : '没有发现重复内容', n ? 'ok' : 'warn', 2000);
    }

    function selectAll() {
        const set = visibleItemKeys();
        if (selected.size === set.size && set.size) selected.clear();
        else set.forEach((k) => selected.add(k));
        render();
    }

    /* ---------------- 导入 / 导出 ---------------- */
    /**
     * 导出①：字卡（文本类）
     * 用户 2026-10-17：「字卡库里的导出分成两个，一个是导出字卡，一个是导出表情包。」
     * 格式用 dunian 的 reply-library 结构 —— 换回 dunian 时能直接导入，
     * 自己也认这个格式（见 importDunianLibrary）。
     * ★ 表情包不再塞在这个文件里（图片 dataURL 会把 json 撑到几十 MB）。
     */
    function exportCards() {
        const stamp = new Date().toISOString().slice(0, 10);
        const collect = (kk) => {
            const items = allOfKind(kk);
            return { items, groups: groupsOfKind(kk) };
        };

        // 主字卡 → customReplies / customReplyGroups
        const main = collect('text');
        // 其余文本类
        const mkPoke = collect('poke');
        const mkStatus = collect('status');
        const mkMotto = collect('sig');
        const mkIntro = collect('nick');
        const mkEmoji = collect('emoji');
        const mkKaomoji = collect('kaomoji');

        const flat = (r) => r.items.map((it) => it.text);
        // dunian 的分组是「items 存文本本身」，照它的格式还原
        const gdefs = (r) => r.groups.map((g) => ({
            id: g.name,
            name: g.name,
            disabled: g.enabled === false,
            items: r.items.filter((it) => (it.group || '') === g.name).map((it) => it.text)
        })).filter((g) => g.items.length);

        const payload = {
            exportDate: new Date().toISOString(),
            modules: ['replies', 'pokes', 'statuses', 'mottos', 'intros', 'emojis',
                      'announcementConfig', 'groups', 'pokeGroups', 'statusGroups'],
            customReplies: flat(main),
            customPokes: flat(mkPoke),
            customStatuses: flat(mkStatus),
            customMottos: flat(mkMotto),
            customIntros: flat(mkIntro),
            customEmojis: flat(mkEmoji),
            customKaomojis: flat(mkKaomoji),
            customReplyGroups: gdefs(main),
            customPokeGroups: gdefs(mkPoke),
            customStatusGroups: gdefs(mkStatus)
        };

        const total = payload.customReplies.length + payload.customPokes.length +
            payload.customStatuses.length + payload.customMottos.length +
            payload.customIntros.length + payload.customEmojis.length + payload.customKaomojis.length;
        if (!total) { toast('字卡库里还没有字卡', 'warn'); return; }

        const who = (Session.get(Store.sessionId()) || {}).name || '默认';
        const name = 'zika-字卡-' + who + '-' + stamp + '.json';
        if (download(name, JSON.stringify(payload, null, 2))) {
            toast('已导出 ' + total + ' 条字卡', 'ok', 2600);
        } else {
            toast('导出失败', 'warn');
        }
    }

    /**
     * 导出②：表情包（图片）
     * 形状 = { items:[{id,src,name}], groups:[{name, items:[id…]}] }，
     * 正好是 importRaw 的图片分支认的那种格式 → 导出的文件能原样导回来。
     * 隐藏组（__mine）不导出：那是聊天里我自己上传的，不属于字卡库。
     */
    function exportStickers() {
        const stamp = new Date().toISOString().slice(0, 10);
        const items = allOfKind('sticker').filter((it) => it && it.src);
        if (!items.length) { toast('表情包里还没有图片', 'warn'); return; }
        const names = groupsOfKind('sticker')
            .filter((g) => g && HIDDEN_GROUPS.indexOf(g.name) < 0)
            .map((g) => g.name);
        const payload = {
            exportDate: new Date().toISOString(),
            items: items.map((it) => ({ id: it.id, src: it.src, name: it.name || '' })),
            groups: names.map((n) => ({
                name: n,
                items: items.filter((it) => (it.group || '') === n).map((it) => it.id)
            })).filter((g) => g.items.length)
        };
        const who = (Session.get(Store.sessionId()) || {}).name || '默认';
        const name = 'zika-表情包-' + who + '-' + stamp + '.json';
        if (download(name, JSON.stringify(payload, null, 2))) {
            toast('已导出 ' + items.length + ' 张表情包', 'ok', 2600);
        } else {
            toast('导出失败', 'warn');
        }
    }

    /**
     * 把一段「文件内容 / 粘贴文本」导入。
     * 兼容四种输入：
     *   ① 纯文本：一行一条
     *   ② JSON：{ items:[], groups:[] }（图片备份）/ 纯数组
     *   ③ 本站整站备份：{ cards:[], media:{ kind: [] } }
     *   ④ dunian 的 reply-library 导出（customReplies/customPokes/... + 分组）
     *      —— 一次导入全站字卡 + 分组，用户直接给的就是这种文件
     */
    function importRaw(raw) {
        const text = String(raw || '').trim();
        if (!text) { toast('内容为空', 'warn'); return; }
        const k = kind;
        const isImg = isImageKind(k);

        // ②③④ JSON
        if (text.charAt(0) === '{' || text.charAt(0) === '[') {
            let json;
            try { json = JSON.parse(text); }
            catch { toast('JSON 解析失败', 'warn'); return; }

            // ④ dunian reply-library 导出：全站一起进，不挑当前栏目
            if (json && typeof json === 'object' && !Array.isArray(json) && importDunianLibrary(json)) {
                render();
                return;
            }

            // 本站整站备份格式
            if (json && typeof json === 'object' && !Array.isArray(json) &&
                (Array.isArray(json.cards) || (json.media && typeof json.media === 'object'))) {
                let added = 0;
                if (Array.isArray(json.cards)) {
                    added += addItemsOfKind('text', json.cards, '');
                }
                if (json.media && typeof json.media === 'object') {
                    Object.keys(json.media).forEach((mk) => {
                        if (!KINDS[mk] || mk === 'text' || !Array.isArray(json.media[mk])) return;
                        added += addItemsOfKind(mk, json.media[mk], '');
                    });
                }
                render();
                toast(added ? ('已导入 ' + added + ' 条') : '没有可导入的新内容', added ? 'ok' : 'warn', 2200);
                return;
            }

            // { items, groups } 或纯数组
            const arr = Array.isArray(json) ? json : (Array.isArray(json.items) ? json.items : null);
            if (!arr) { toast('JSON 里没有 items', 'warn'); return; }
            const groups = (!Array.isArray(json) && Array.isArray(json.groups)) ? json.groups : [];

            if (isImg) {
                // 图片：按 groups 里的 id 归属还原分组
                const gMap = {};
                groups.forEach((g) => {
                    if (!g || !g.name || !Array.isArray(g.items)) return;
                    g.items.forEach((id) => { gMap[id] = g.name; });
                });
                let added = 0;
                const byGroup = {};
                arr.forEach((it) => {
                    const one = (typeof it === 'string') ? { src: it } : it;
                    if (!one || !one.src) return;
                    const g = gMap[one.id] || one.group || '';
                    (byGroup[g] = byGroup[g] || []).push({ src: one.src, name: one.name || '', group: g });
                });
                Object.keys(byGroup).forEach((g) => {
                    added += Media.addMany(k, byGroup[g], g);
                });
                render();
                toast(added ? ('已导入 ' + added + ' 张') : '没有可导入的新图', added ? 'ok' : 'warn', 2200);
                return;
            }

            // 文本：一行一条（也可能是 [{text}]）
            const lines = arr.map((x) => (typeof x === 'string' ? x : (x && x.text) || '')).filter(Boolean);
            finishTextImport(lines);
            return;
        }

        // ① 纯文本
        finishTextImport(text.split('\n'));
    }

    /**
     * dunian（https://github.com/3485580873-gif/dunian）的字卡库导出格式：
     *   customReplies   主字卡      customReplyGroups   主字卡分组
     *   customPokes     拍一拍      customPokeGroups   拍一拍分组
     *   customStatuses  对方状态    customStatusGroups  状态分组
     *   customMottos    个性签名    customIntros 介绍    customEmojis emoji
     * 分组是 { id, name, color, disabled, items:[字卡文本] }，
     * items 存的是文本本身，直接按文本归组即可。
     * 返回 true = 已按这个格式处理完（调用方不要再往下走）。
     */
    function importDunianLibrary(json) {
        const has = (k) => Array.isArray(json[k]);
        if (!has('customReplies') && !has('customPokes') && !has('customStatuses') &&
            !has('customMottos') && !has('customIntros') && !has('customEmojis') &&
            !has('customReplyGroups') && !has('customPokeGroups') && !has('customStatusGroups')) {
            return false;
        }

        const summary = [];
        // 把 flat 列表 + 分组列表 合成 [{text, group}]
        const collect = (flatKey, groupKey) => {
            const flat = has(flatKey) ? json[flatKey] : [];
            const gdefs = has(groupKey) ? json[groupKey] : [];
            const text2group = {};
            const groupNames = [];
            gdefs.forEach((g) => {
                if (!g || !g.name) return;
                groupNames.push(g.name);
                (Array.isArray(g.items) ? g.items : []).forEach((t) => {
                    const s = String(t || '').trim();
                    if (s) text2group[s] = g.name;
                });
            });
            const out = [];
            flat.forEach((t) => {
                const s = String(t || '').trim();
                if (s) out.push({ text: s, group: text2group[s] || '' });
            });
            return { out, groupNames };
        };

        const put = (targetKind, flatKey, groupKey, label) => {
            const r = collect(flatKey, groupKey);
            if (!r.out.length) return 0;
            // 分组先建好（分完再灌内容，addMany 带 group 直接落位）
            r.groupNames.forEach((n) => addGroupOfKind(targetKind, n));
            const byGroup = {};
            r.out.forEach((x) => { (byGroup[x.group] = byGroup[x.group] || []).push(x.text); });
            let n = 0;
            Object.keys(byGroup).forEach((g) => {
                n += isTextKind(targetKind)
                    ? Cards.addMany(byGroup[g], g)
                    : Media.addMany(targetKind, byGroup[g], g);
            });
            if (n) summary.push(label + ' ' + n + ' 条');
            return n;
        };

        let total = 0;
        total += put('text',    'customReplies',  'customReplyGroups',  '主字卡');
        total += put('poke',    'customPokes',    'customPokeGroups',   '拍一拍');
        total += put('status',  'customStatuses', 'customStatusGroups', '对方状态');
        total += put('sig',     'customMottos',   null,                 '个性签名');
        total += put('nick',    'customIntros',   null,                 '网名');
        total += put('emoji',   'customEmojis',   null,                 'emoji');
        total += put('kaomoji', 'customEmojis',   null,                 '颜文字');

        if (!total) {
            toast('这个文件里没找到可导入的字卡', 'warn', 2400);
            return true;
        }
        toast('已导入 ' + total + ' 条：\n' + summary.join('\n'), 'ok', 4200);
        return true;
    }

    function finishTextImport(lines) {
        let added = 0;
        const plain = [];
        lines.forEach((l) => {
            const t = String(l || '').replace(/\r/g, '').trim();
            if (!t) return;
            if (t.indexOf('[专属]') === 0) {
                const body = t.slice(4).trim();
                if (!body) return;
                const c = Session.current();
                added += addItemOfKind(kind, body, '', '');
            } else {
                plain.push(t);
            }
        });
        if (plain.length) added += addItemOfKind(kind, plain.join('\n'), '', '');
        render();
        toast(added ? ('已导入 ' + added + ' 条') : '没有新增内容（可能已存在）', added ? 'ok' : 'warn', 2200);
    }

    /** 选文件导入 */
    async function doImportFile() {
        const f = await pickFile('.json,.txt,text/plain,application/json');
        if (!f || !f.data) return;
        try {
            // dataURL → 文本
            const text = decodeURIComponent(escape(atob(f.data.split(',').slice(1).join(','))));
            importRaw(text);
        } catch (err) {
            console.error(err);
            toast('文件读取失败', 'warn');
        }
    }

    /** 导入入口：选文件 或 粘贴文本 */
    function doImportPaste() {
        sheet('导入到「' + KINDS[kind].name + '」', [
            {
                label: '选文件（.txt / .json）', icon: icon('upload', 19),
                onSelect: doImportFile
            },
            {
                label: '粘贴内容', icon: icon('cards', 19),
                onSelect: () => {
                    const v = window.prompt('粘贴字卡内容（一行一条，或 JSON）', '');
                    if (v && v.trim()) importRaw(v);
                }
            }
        ]);
    }

    /* ---------------- 构建 ---------------- */
    function build() {
        root.innerHTML =
            '<header class="bar">' +
                '<button class="bar-btn" data-act="back" aria-label="返回">' + icon('chevronLeft', 23) + '</button>' +
                '<span class="bar-title">字卡库</span>' +
                '<button class="bar-btn plain" data-act="filter" aria-label="筛选" data-filter></button>' +
            '</header>' +
            '<div class="ck-tabs" data-tabs></div>' +
            '<div class="ck-toolwrap" data-toolwrap>' +
                '<div class="ck-who-row" data-who></div>' +
                '<div class="ck-kindbar" data-kindrow hidden></div>' +
                '<div class="ck-groupbar" data-grouprow></div>' +
            '</div>' +
            '<div class="ck-searchbar">' +
                '<input class="ck-search" data-search placeholder="搜索内容…" value="">' +
            '</div>' +
            '<div class="ck-adder" data-adder></div>' +
            '<div class="page-scroll ck-body" data-body></div>' +
            '<footer class="ck-foot" data-foot></footer>';

        ui.tabs = root.querySelector('[data-tabs]');
        ui.toolWrap = root.querySelector('[data-toolwrap]');
        ui.filterBtn = root.querySelector('[data-filter]');
        ui.who = root.querySelector('[data-who]');
        ui.kindrow = root.querySelector('[data-kindrow]');
        ui.grouprow = root.querySelector('[data-grouprow]');
        ui.search = root.querySelector('[data-search]');
        ui.adder = root.querySelector('[data-adder]');
        ui.body = root.querySelector('[data-body]');
        ui.foot = root.querySelector('[data-foot]');
    }

    /* ---------------- 事件 ---------------- */
    function bind() {
        /* ① 大栏目 */
        delegate(root, 'click', '[data-cat]', (e, t) => {
            cat = t.getAttribute('data-cat');
            kind = kinds()[0] || '';
            group = 'all';
            groupManage = false;
            editing = null;
            render();
        });

        /* 工具栏展开 / 收起 */
        delegate(root, 'click', '[data-filter]', () => {
            toolOpen = !toolOpen;
            render();
        });

        /* ② 切换看谁的字卡 */
        delegate(root, 'click', '[data-who]', (e, t) => {
            switchWho(t.getAttribute('data-who'));
            editing = null;
            selected.clear();
            render();
        });

        /* ③ 小栏目 */
        delegate(root, 'click', '[data-kind]', (e, t) => {
            kind = t.getAttribute('data-kind');
            group = 'all';
            groupManage = false;
            editing = null;
            render();
        });

        /* ④ 分组 */
        delegate(root, 'click', '[data-group]', (e, t) => {
            group = t.getAttribute('data-group');
            editing = null;
            render();
        });

        /* 折叠 / 展开分组 */
        delegate(root, 'click', '[data-fold]', (e, t) => {
            const key = t.getAttribute('data-fold');
            if (expanded.has(key)) expanded.delete(key);
            else expanded.add(key);
            const blk = t.closest('.ck-gblk');
            if (blk) {
                // 只更新这一个块，不整页重渲染（大库时整页 render 会闪一下又卡）
                const list = blockCache[key] || [];
                blk.classList.toggle('open', expanded.has(key));
                const bd = blk.querySelector('.ck-gbd');
                if (bd) bd.innerHTML = expanded.has(key) ? renderBlockBody(key, list, isImageKind(kind)) : '';
            } else {
                render();
            }
        });

        /* 「显示全部」：把该组剩余条目也渲染出来 */
        delegate(root, 'click', '[data-loadmore]', (e, t) => {
            const key = t.getAttribute('data-loadmore');
            shownAll.add(key);
            const bd = t.closest('.ck-gbd');
            const list = blockCache[key] || [];
            if (bd) bd.innerHTML = renderBlockBody(key, list, isImageKind(kind));
        });

        /* 搜索 */
        ui.search.addEventListener('input', () => {
            kw = (ui.search.value || '').trim();
            render();
        });

        /* 分组管理 / 底部动作 */
        delegate(root, 'click', '[data-act]', (e, t) => {
            const act = t.getAttribute('data-act');
            if (act === 'back') { try { Page.back(); } catch { /* noop */ } }
            else if (act === 'newgroup') {
                const v = window.prompt('新分组名', '');
                if (v && v.trim()) {
                    if (addGroupOfKind(kind, v.trim())) { render(); toast('已新建分组「' + v.trim() + '」', 'ok'); }
                    else toast('分组已存在', 'warn');
                }
            }
            else if (act === 'groupmanage') { groupManage = !groupManage; render(); }
            else if (act === 'addtext') addText(t.getAttribute('data-for'));
            // import 有两种入口：带 data-for 的是添加框里的「选择图片」，不带的是底部「导入」
            else if (act === 'import') {
                const forKind = t.getAttribute('data-for');
                if (forKind) importImages(forKind);
                else doImportPaste();
            }
            else if (act === 'manage') { manage = true; selected.clear(); render(); }
            else if (act === 'exitmanage') { manage = false; selected.clear(); render(); }
            else if (act === 'selectall') selectAll();
            else if (act === 'moveto') askMoveTo();
            else if (act === 'delselected') delSelected();
            else if (act === 'dedupe') doDedupe();
            else if (act === 'export') exportCards();
            else if (act === 'exportsticker') exportStickers();
            else if (act === 'import') doImportPaste();
            else if (act === 'canceledit') { editing = null; render(); }
        });

        delegate(root, 'click', '[data-toggleg]', (e, t) => {
            const name = t.getAttribute('data-toggleg');
            const on = toggleGroupOfKind(kind, name);
            render();
            toast('「' + name + '」' + (on ? '已启用' : '已停用'), 'ok', 1800);
        });
        delegate(root, 'click', '[data-reng]', (e, t) => {
            const old = t.getAttribute('data-reng');
            const v = window.prompt('重命名分组', old);
            if (v && v.trim() && v.trim() !== old) { renameGroupOfKind(kind, old, v.trim()); render(); toast('已重命名', 'ok'); }
        });
        delegate(root, 'click', '[data-delg]', (e, t) => {
            const name = t.getAttribute('data-delg');
            if (!window.confirm('删除分组「' + name + '」？组内内容会回到未分组。')) return;
            removeGroupOfKind(kind, name);
            if (group === name) group = 'all';
            render();
            toast('已删除分组', 'ok');
        });

        /* 编辑 / 保存 / 删除 */
        delegate(root, 'click', '[data-actsave]', (e, t) => {
            const p = t.getAttribute('data-actsave').split('|');
            const inp = ui.body.querySelector('[data-editinput]');
            if (!inp) return;
            const v = (inp.value || '').trim();
            if (!v) { toast('内容不能为空', 'warn'); return; }
            updateItemOfKind(p[0], p[1], { text: v });
            editing = null;
            render();
            toast('已保存', 'ok');
        });
        delegate(root, 'click', '[data-edit]', (e, t) => {
            const p = t.getAttribute('data-edit').split('|');
            editing = { kind: p[0], id: p[1] };
            render();
            const inp = ui.body.querySelector('[data-editinput]');
            if (inp) { try { inp.focus(); inp.select(); } catch { /* noop */ } }
        });
        delegate(root, 'click', '[data-del]', (e, t) => {
            const p = t.getAttribute('data-del').split('|');
            removeManyOfKind(p[0], [p[1]]);
            render();
            toast('已删除', 'ok');
        });

        /* 选中 / 编辑 / 预览 */
        delegate(root, 'click', '[data-pick]', (e, t) => {
            const key = t.getAttribute('data-pick');
            if (manage) {
                if (selected.has(key)) selected.delete(key); else selected.add(key);
                render();
                return;
            }
            const p = key.split('|');
            if (isImageKind(p[0])) {
                const it = allOfKind(p[0]).find((x) => x.id === p[1]);
                if (!it) return;
                const mask = document.createElement('div');
                mask.className = 'img-viewer';
                mask.innerHTML = '<img src="' + esc(it.src) + '" alt="">';
                mask.addEventListener('click', () => mask.remove());
                document.body.appendChild(mask);
                return;
            }
            editing = { kind: p[0], id: p[1] };
            render();
            const inp = ui.body.querySelector('[data-editinput]');
            if (inp) { try { inp.focus(); inp.select(); } catch { /* noop */ } }
        });
    }

    /* ---------------- 订阅 ---------------- */
    const offs = [];
    offs.push(bus.on(EV.CARDS_CHANGED, () => { render(); }));
    offs.push(bus.on(EV.MEDIA_CHANGED, () => { render(); }));
    offs.push(bus.on(EV.CONTACTS_CHANGED, () => { render(); }));

    build();
    bind();
    kind = kinds()[0] || '';
    render();

    return {
        resume() { render(); },
        destroy() { offs.forEach((o) => { try { o(); } catch { /* noop */ } }); }
    };
}
