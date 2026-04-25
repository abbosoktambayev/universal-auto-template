// ================================================================
// Vercel Serverless Function — Telegram CRM Bot
// POST /api/telegram
//
// Dual-purpose endpoint:
//   1. Website leads (form + quiz) → sendMessage with inline buttons
//   2. Telegram webhook (callback_query) → editMessageText by status
//
// Environment variables required on Vercel:
//   BOT_TOKEN  — Telegram bot token
//   CHAT_ID    — Authorized chat ID (security guard)
// ================================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID   = process.env.CHAT_ID;

// ── Telegram API helper ─────────────────────────────────────────
async function tg(method, body) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return res.json();
}

// ── Timestamp helper (Almaty timezone) ──────────────────────────
function now() {
    return new Date().toLocaleString('ru-RU', {
        timeZone: 'Asia/Almaty',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

// ── Rejection reasons map ───────────────────────────────────────
const REJECT_REASONS = {
    rej_spam:      '🚫 Спам',
    rej_expensive: '💰 Дорого',
    rej_not_fit:   '👤 Не подходит',
    rej_other:     '📝 Другое',
};

// ── Tier 1: Action buttons (new lead) ───────────────────────────
function actionButtons(whatsappUrl) {
    return {
        inline_keyboard: [
            [
                { text: '📲 Написать в WhatsApp', url: whatsappUrl },
            ],
            [
                { text: '✅ Взять в работу', callback_data: 'take_work' },
                { text: '❌ Отклонить',      callback_data: 'start_reject' },
            ],
        ],
    };
}

// ── Tier 2: Rejection reason buttons ────────────────────────────
function rejectButtons() {
    return {
        inline_keyboard: [
            [
                { text: '🚫 Спам',        callback_data: 'rej_spam' },
                { text: '💰 Дорого',      callback_data: 'rej_expensive' },
            ],
            [
                { text: '👤 Не подходит',  callback_data: 'rej_not_fit' },
                { text: '📝 Другое',      callback_data: 'rej_other' },
            ],
        ],
    };
}

// ================================================================
//  MAIN HANDLER
// ================================================================
export default async function handler(req, res) {
    // ── CORS (for website fetch) ────────────────────────────────
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')    return res.status(200).end();

    try {
        const body = req.body;
        if (!body || Object.keys(body).length === 0) {
            return res.status(200).json({ ok: true, note: 'empty body' });
        }

        // ────────────────────────────────────────────────────────
        // BRANCH A: Telegram Webhook (callback_query)
        // ────────────────────────────────────────────────────────
        if (body.callback_query) {
            const cb      = body.callback_query;
            const data    = cb.data;
            const msg     = cb.message;
            const chatId  = String(msg.chat.id);
            const msgId   = msg.message_id;
            const user    = cb.from;
            const oldText = msg.text || '';

            // Security: only allow actions from the authorized chat
            if (chatId !== CHAT_ID) {
                await tg('answerCallbackQuery', { callback_query_id: cb.id, text: '⛔ Нет доступа' });
                return res.status(200).end();
            }

            const managerName = user.username ? `@${user.username}` : user.first_name || 'Менеджер';
            const time = now();

            // ── Scenario A: Take work ───────────────────────────
            if (data === 'take_work') {
                const statusBlock = [
                    '',
                    '──────────────────────',
                    '⚡️ СТАТУС: ВЗЯТО В РАБОТУ',
                    `Менеджер: ${managerName}`,
                    `Время: ${time}`,
                ].join('\n');

                await tg('editMessageText', {
                    chat_id:    chatId,
                    message_id: msgId,
                    text:        oldText + statusBlock,
                    parse_mode: 'HTML',
                    reply_markup: undefined,
                });

                await tg('answerCallbackQuery', {
                    callback_query_id: cb.id,
                    text: '✅ Заявка взята в работу!',
                });
            }

            // ── Scenario B: Start reject (show reason menu) ─────
            else if (data === 'start_reject') {
                await tg('editMessageReplyMarkup', {
                    chat_id:      chatId,
                    message_id:   msgId,
                    reply_markup: rejectButtons(),
                });

                await tg('answerCallbackQuery', {
                    callback_query_id: cb.id,
                    text: 'Выберите причину отказа:',
                });
            }

            // ── Scenario C: Finalize rejection ──────────────────
            else if (data.startsWith('rej_')) {
                const reason = REJECT_REASONS[data] || data;
                const statusBlock = [
                    '',
                    '──────────────────────',
                    '🚫 СТАТУС: ОТКЛОНЕНО',
                    `Причина: ${reason}`,
                    `Менеджер: ${managerName}`,
                    `Время: ${time}`,
                ].join('\n');

                await tg('editMessageText', {
                    chat_id:    chatId,
                    message_id: msgId,
                    text:        oldText + statusBlock,
                    parse_mode: 'HTML',
                    reply_markup: undefined,
                });

                await tg('answerCallbackQuery', {
                    callback_query_id: cb.id,
                    text: `❌ Заявка отклонена: ${reason}`,
                });
            }

            // ── Unknown callback → just dismiss ─────────────────
            else {
                await tg('answerCallbackQuery', { callback_query_id: cb.id });
            }

            return res.status(200).end();
        }

        // ────────────────────────────────────────────────────────
        // BRANCH B: Website Lead (form or quiz)
        // ────────────────────────────────────────────────────────
        const { name, phone, car, service, quiz, bot_token, chat_id } = body;

        // Allow both: env-based and client-passed tokens (backward compat)
        const token  = BOT_TOKEN || bot_token;
        const chatTo = CHAT_ID   || chat_id;

        if (!phone || !token || !chatTo) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const cleanPhone = phone.replace(/[^\d]/g, '');
        const waLink     = `https://wa.me/${cleanPhone}`;
        let text = '';

        if (quiz) {
            // ── Quiz lead ───────────────────────────────────────
            const priceFormatted = quiz.price
                ? `~${Number(quiz.price).toLocaleString('ru-RU')} ₸`
                : 'Не рассчитан';

            text = [
                '<b>🔥 НОВЫЙ ЛИД С КВИЗА!</b>',
                '',
                `<b>🚗 Класс авто:</b>  ${quiz.carClass || '—'}`,
                `<b>🔧 Услуга:</b>  ${quiz.service || '—'}`,
                `<b>📋 Состояние:</b>  ${quiz.condition || '—'}`,
                `<b>💰 Ожидаемый чек:</b>  ${priceFormatted}`,
                `<b>📱 Телефон:</b>  ${phone}`,
                '',
                `🕐 <i>${now()}</i>`,
            ].join('\n');
        } else {
            // ── Regular form lead ───────────────────────────────
            if (!name || !car) {
                return res.status(400).json({ error: 'Missing required fields (name, car)' });
            }

            const serviceLine = service ? `\n<b>🔧 Услуга:</b>  ${service}` : '';
            text = [
                '<b>🔥 Новая заявка!</b>',
                '',
                `<b>👤 Имя:</b>  ${name}`,
                `<b>🚘 Авто:</b>  ${car}`,
                serviceLine,
                `<b>📱 Телефон:</b>  ${phone}`,
                '',
                `🕐 <i>${now()}</i>`,
            ].filter(l => l !== undefined).join('\n');
        }

        // Send message with inline CRM buttons
        const result = await fetch(
            `https://api.telegram.org/bot${token}/sendMessage`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id:  chatTo,
                    text:     text,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                    reply_markup: actionButtons(waLink),
                }),
            }
        );

        const resultData = await result.json();

        if (!result.ok) {
            console.error('Telegram API error:', resultData);
            return res.status(500).json({ error: 'Telegram API error', details: resultData });
        }

        return res.status(200).json({ success: true });

    } catch (error) {
        console.error('Server error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
