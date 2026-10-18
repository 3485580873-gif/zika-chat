/* ============================================================
   replier.js — 回复引擎（唯一出口）
   ------------------------------------------------------------
   规则：TA 说的一切话，都从字卡库里抽。
   抽不到就返回 null，由调用方提示用户去添加字卡 —— 绝不兜底造句子。
   后续模块（信封、朋友圈、自动动态……）也必须走这里，
   保证「内容来源」在全站只有一处定义。
   ============================================================ */

import { Cards } from './cards.js';
import { Session } from './session.js';
import { Settings } from './settings.js';

export const Replier = {
    /** 该会话有没有可用字卡 */
    ready(contactId) { return Cards.countFor(contactId) > 0; },

    /** 可用字卡数量 */
    poolSize(contactId) { return Cards.countFor(contactId); },

    /**
     * 抽一条。
     * @returns { text, cardId } | null
     */
    pick(contactId) {
        const got = Cards.pick(contactId, 1);
        return got.length ? { text: got[0].text, cardId: got[0].id } : null;
    },

    /** 抽多条（连续发言用） */
    pickMany(contactId, n) {
        return Cards.pick(contactId, n).map((k) => ({ text: k.text, cardId: k.id }));
    },

    /**
     * 群聊里「这一句是谁说的」：随机挑一个成员。
     * 单聊返回 null。
     */
    speaker(contact) {
        if (!contact || contact.kind !== 'group') return null;
        const members = Session.membersOf(contact);
        if (!members.length) return null;
        return members[Math.floor(Math.random() * members.length)];
    },

    /**
     * 模拟打字时长：按字数估算，看起来像真人。
     * 上下限跟着设置页「节奏」走（replyDelayMin / replyDelayMax，单位秒）。
     */
    typingTime(text) {
        const g = Settings.g();
        const lo = Math.max(1, g.replyDelayMin || 2) * 1000;
        // ★ 秒 → 毫秒必须在 Math.max 之前做，否则拿毫秒的 lo 和秒的上限比大小，
        //   永远是 lo 赢，再 *1000 就把上限放大 1000 倍（实测 TA 要等 33 分钟才回）。
        const hi = Math.max(lo, Math.max(1, g.replyDelayMax || 20) * 1000);
        const byLen = 420 + String(text || '').length * 42 + Math.random() * 520;
        return Math.max(400, Math.min(hi, Math.max(lo, byLen)));
    },

    /**
     * 模拟「看到消息后开始打字」的反应时间（秒 → 毫秒）。
     * 用户可在设置页把回复速度调到 1s~600s，这里统一读那个值。
     */
    reactionTime() {
        const g = Settings.g();
        const lo = Math.max(1, g.replyDelayMin || 2) * 1000;
        // ★ 同上：先统一成毫秒再取 max。修之前默认 2~20 秒会被算成 2 秒~33 分钟。
        const hi = Math.max(lo, Math.max(1, g.replyDelayMax || 20) * 1000);
        return lo + Math.random() * (hi - lo);
    }
};
