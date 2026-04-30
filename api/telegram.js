// ================================================================
// Vercel Serverless — Telegram CRM State Machine
// POST /api/telegram
//
// Two entry points on one URL:
//   1. JSON from website (form / quiz) → sendMessage + Stage 1 buttons
//   2. Webhook from Telegram (callback_query) → editMessage by stage
//
// State flow:
//   Stage 1  →  take_work   →  Stage 2  →  success       →  FINAL
//           →  spam         →  FINAL       →  start_reject →  Stage 3
//                                           ←  back (Stage3→2)
//   Stage 3  →  rej_*       →  FINAL
//
// Env vars: BOT_TOKEN, CHAT_ID
// ================================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID   = process.env.CHAT_ID;

// ── Helpers ─────────────────────────────────────────────────────

/** Safe Telegram API call with race-condition guard */
async function tg(method, payload) {
    try {
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const json = await r.json();
        // Graceful handling: two managers clicked at the same instant
        if (!json.ok && json.description?.includes('message is not modified')) {
            return { ok: true, race: true };
        }
        return json;
    } catch (err) {
        console.error(`tg.${method} error:`, err);
        return { ok: false, error: err.message };
    }
}

/** Escape HTML special chars in user-submitted data */
function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Astana time (UTC+5) */
function now() {
    return new Date().toLocaleString('ru-RU', {
        timeZone: 'Asia/Almaty',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

/**
 * Reconstruct HTML from plain text + Telegram entities array.
 * Preserves bold, italic, links when editing a message.
 */
function rebuildHtml(text, entities) {
    if (!text) return '';
    if (!entities || entities.length === 0) return esc(text);

    const chars = [...text]; // proper Unicode offset handling
    const sorted = [...entities].sort((a, b) => a.offset - b.offset);
    let out = '';
    let pos = 0;

    for (const e of sorted) {
        if (e.offset > pos) out += esc(chars.slice(pos, e.offset).join(''));
        const inner = esc(chars.slice(e.offset, e.offset + e.length).join(''));
        switch (e.type) {
            case 'bold':      out += `<b>${inner}</b>`; break;
            case 'italic':    out += `<i>${inner}</i>`; break;
            case 'text_link': out += `<a href="${e.url}">${inner}</a>`; break;
            default:          out += inner;
        }
        pos = e.offset + e.length;
    }
    if (pos < chars.length) out += esc(chars.slice(pos).join(''));
    return out;
}

// ── Keyboard Factories ──────────────────────────────────────────

const REJECT_MAP = {
    rej_expensive: '💰 Дорого',
    rej_time:      '⏳ Не подошло время',
    rej_asked:     '📝 Просто спросил',
};

function kbStage1(waUrl) {
    return { inline_keyboard: [
        [{ text: '📲 Написать в WhatsApp', url: waUrl }],
        [
            { text: '✅ Взять в работу',  callback_data: 'take_work' },
            { text: '🗑 Спам / Ошибка',   callback_data: 'spam' },
        ],
    ]};
}

function kbStage2(mid) {
    return { inline_keyboard: [
        [
            { text: '🏆 Успешно (Записан)', callback_data: `success:${mid}` },
            { text: '❌ Отказ',             callback_data: `start_reject:${mid}` },
        ],
    ]};
}

function kbStage3(mid) {
    return { inline_keyboard: [
        [
            { text: '💰 Дорого',           callback_data: `rej_expensive:${mid}` },
            { text: '⏳ Не подошло время',  callback_data: `rej_time:${mid}` },
        ],
        [
            { text: '📝 Просто спросил',   callback_data: `rej_asked:${mid}` },
            { text: '⬅️ Назад',            callback_data: `back_work:${mid}` },
        ],
    ]};
}

// ================================================================
//  MAIN HANDLER
// ================================================================
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')    return res.status(200).end();

    try {
        const body = req.body;
        if (!body || Object.keys(body).length === 0) return res.status(200).end();

        // ═════════════════════════════════════════════════════════
        // BRANCH A — Telegram Webhook: callback_query
        // ═════════════════════════════════════════════════════════
        if (body.callback_query) {
            const cb     = body.callback_query;
            const msg    = cb.message;
            const chatId = String(msg.chat.id);
            const msgId  = msg.message_id;
            const user   = cb.from;

            // ── Chat ID guard ───────────────────────────────────
            if (chatId !== CHAT_ID) {
                await tg('answerCallbackQuery', { callback_query_id: cb.id, text: '⛔ Нет доступа' });
                return res.status(200).end();
            }

            // Parse "action" or "action:lockedManagerId"
            const [action, lockId] = cb.data.split(':');
            const mgrTag  = user.username ? `@${user.username}` : (user.first_name || 'Менеджер');
            const time    = now();
            const htmlNow = rebuildHtml(msg.text || '', msg.entities);

            // ── Resource lock check (Stages 2-3-4) ──────────────
            if (lockId && String(user.id) !== lockId) {
                await tg('answerCallbackQuery', {
                    callback_query_id: cb.id,
                    text: '🔒 Эту заявку уже обрабатывает другой менеджер!',
                    show_alert: true,
                });
                return res.status(200).end();
            }

            // ── Stage 1 → Stage 2 : Взять в работу ─────────────
            if (action === 'take_work') {
                const updated = htmlNow
                    + `\n\n──────────────────────`
                    + `\n⚡️ <b>Взято в работу:</b> ${esc(mgrTag)} (${time})`;

                await tg('editMessageText', {
                    chat_id: chatId, message_id: msgId,
                    text: updated, parse_mode: 'HTML',
                    reply_markup: kbStage2(user.id),
                });
                await tg('answerCallbackQuery', { callback_query_id: cb.id, text: '✅ Заявка за вами!' });
            }

            // ── Stage 1 → FINAL : Спам ──────────────────────────
            else if (action === 'spam') {
                const updated = htmlNow
                    + `\n\n──────────────────────`
                    + `\n🗑 <b>СПАМ / ОШИБКА</b>`
                    + `\nМенеджер: ${esc(mgrTag)} (${time})`;

                await tg('editMessageText', {
                    chat_id: chatId, message_id: msgId,
                    text: updated, parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [] },
                });
                await tg('answerCallbackQuery', { callback_query_id: cb.id, text: '🗑 Спам' });
            }

            // ── Stage 2 → FINAL : Записан ───────────────────────
            else if (action === 'success') {
                const updated = htmlNow
                    + `\n\n✅ <b>ЗАПИСАН</b>`
                    + `\nМенеджер: ${esc(mgrTag)} (${time})`;

                await tg('editMessageText', {
                    chat_id: chatId, message_id: msgId,
                    text: updated, parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [] },
                });
                await tg('answerCallbackQuery', { callback_query_id: cb.id, text: '🏆 Клиент записан!' });
            }

            // ── Stage 2 → Stage 3 : Показать причины ────────────
            else if (action === 'start_reject') {
                await tg('editMessageReplyMarkup', {
                    chat_id: chatId, message_id: msgId,
                    reply_markup: kbStage3(user.id),
                });
                await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Выберите причину:' });
            }

            // ── Stage 3 → Stage 2 : Назад ───────────────────────
            else if (action === 'back_work') {
                await tg('editMessageReplyMarkup', {
                    chat_id: chatId, message_id: msgId,
                    reply_markup: kbStage2(user.id),
                });
                await tg('answerCallbackQuery', { callback_query_id: cb.id });
            }

            // ── Stage 3 → FINAL : Причина отказа ────────────────
            else if (action.startsWith('rej_')) {
                const reason = REJECT_MAP[action] || action;
                const updated = htmlNow
                    + `\n\n──────────────────────`
                    + `\n🚫 <b>ОТКЛОНЕНО:</b> ${reason}`
                    + `\nМенеджер: ${esc(mgrTag)} (${time})`;

                await tg('editMessageText', {
                    chat_id: chatId, message_id: msgId,
                    text: updated, parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [] },
                });
                await tg('answerCallbackQuery', { callback_query_id: cb.id, text: `❌ ${reason}` });
            }

            // ── Unknown → dismiss ───────────────────────────────
            else {
                await tg('answerCallbackQuery', { callback_query_id: cb.id });
            }

            return res.status(200).end();
        }

        // ═════════════════════════════════════════════════════════
        // BRANCH B — Website Lead (form / quiz)
        // ═════════════════════════════════════════════════════════
        const { name, phone, car, service, quiz } = body;

        if (!phone || !BOT_TOKEN || !CHAT_ID) {
            return res.status(400).json({ error: 'Missing required fields or server config' });
        }

        const cleanPhone = phone.replace(/[^\d]/g, '');
        const waUrl = `https://wa.me/${cleanPhone}`;
        let text = '';

        if (quiz) {
            const price = quiz.price
                ? `~${Number(quiz.price).toLocaleString('ru-RU')} ₸`
                : 'Не рассчитан';
            text = [
                '<b>🔥 НОВЫЙ ЛИД С КВИЗА</b>', '',
                `<b>🚗 Класс авто:</b>  ${esc(quiz.carClass || '—')}`,
                `<b>🔧 Услуга:</b>  ${esc(quiz.service || '—')}`,
                `<b>📋 Состояние:</b>  ${esc(quiz.condition || '—')}`,
                `<b>💰 Ожидаемый чек:</b>  ${price}`,
                `<b>📱 Телефон:</b>  ${esc(phone)}`, '',
                `🕐 <i>${now()}</i>`,
            ].join('\n');
        } else {
            if (!name || !car) {
                return res.status(400).json({ error: 'Missing name or car' });
            }
            const svc = service ? `\n<b>🔧 Услуга:</b>  ${esc(service)}` : '';
            text = [
                '<b>🔥 НОВАЯ ЗАЯВКА</b>', '',
                `<b>👤 Имя:</b>  ${esc(name)}`,
                `<b>🚘 Авто:</b>  ${esc(car)}`,
                svc,
                `<b>📱 Телефон:</b>  ${esc(phone)}`, '',
                `🕐 <i>${now()}</i>`,
            ].filter(Boolean).join('\n');
        }

        const result = await tg('sendMessage', {
            chat_id: CHAT_ID,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: kbStage1(waUrl),
        });

        if (!result.ok) {
            console.error('sendMessage error:', result);
            return res.status(500).json({ error: 'Telegram API error', details: result });
        }

        return res.status(200).json({ success: true });

    } catch (error) {
        console.error('Handler error:', error);
        // Return 200 for webhook errors to prevent Telegram retry spam
        return res.status(200).json({ error: 'Internal error' });
    }
}
