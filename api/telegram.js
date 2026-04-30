// ================================================================
// Vercel Serverless — Telegram CRM State Machine (Secured)
// POST /api/telegram
//
// SECURITY LAYERS:
//   1. CORS — only ALLOWED_ORIGIN can call from browser
//   2. API_SECRET — frontend sends x-crm-secret header
//   3. WEBHOOK_SECRET — Telegram sends X-Telegram-Bot-Api-Secret-Token
//   4. CHAT_ID guard — callbacks only from authorized chat
//   5. Resource locking — manager ID in callback_data
//   6. Payload validation — sanitize + reject empty data
//   7. HTML escaping — prevent injection in Telegram messages
//
// Env vars (set on Vercel):
//   BOT_TOKEN       — Telegram bot token
//   CHAT_ID         — Target chat/supergroup ID
//   API_SECRET      — Shared secret for frontend requests
//   WEBHOOK_SECRET  — Secret token for Telegram webhook verification
//   ALLOWED_ORIGIN  — Frontend domain (e.g. https://yourdomain.com)
// ================================================================

const BOT_TOKEN      = process.env.BOT_TOKEN;
const CHAT_ID        = process.env.CHAT_ID;
const API_SECRET     = process.env.API_SECRET;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://universal-auto-template.vercel.app';

// ── Helpers ─────────────────────────────────────────────────────

async function tg(method, payload) {
    try {
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const json = await r.json();
        if (!json.ok && json.description?.includes('message is not modified')) {
            return { ok: true, race: true };
        }
        return json;
    } catch (err) {
        console.error(`tg.${method}:`, err);
        return { ok: false, error: err.message };
    }
}

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function now() {
    return new Date().toLocaleString('ru-RU', {
        timeZone: 'Asia/Almaty',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

function rebuildHtml(text, entities) {
    if (!text) return '';
    if (!entities || entities.length === 0) return esc(text);
    const chars = [...text];
    const sorted = [...entities].sort((a, b) => a.offset - b.offset);
    let out = '', pos = 0;
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

// ── Request classifier ──────────────────────────────────────────

function isTelegramWebhook(req) {
    // Telegram webhooks include update_id, or callback_query, or message
    const b = req.body;
    return b && (b.update_id !== undefined || b.callback_query || b.message);
}

// ================================================================
//  MAIN HANDLER
// ================================================================
export default async function handler(req, res) {

    // ─── LAYER 1: Method guard ──────────────────────────────────
    if (req.method === 'OPTIONS') {
        // CORS preflight — respond with allowed origin
        res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-crm-secret');
        res.setHeader('Access-Control-Max-Age', '86400');
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // ─── LAYER 2: Route by source (Telegram vs Frontend) ────────
    const body = req.body;
    if (!body || Object.keys(body).length === 0) {
        return res.status(400).json({ error: 'Empty payload' });
    }

    const telegramRequest = isTelegramWebhook(req);

    if (telegramRequest) {
        // ─── LAYER 3a: Telegram Webhook Secret ──────────────────
        // Telegram sends the secret in X-Telegram-Bot-Api-Secret-Token
        // header when you register webhook with ?secret_token=...
        if (WEBHOOK_SECRET) {
            const tgSecret = req.headers['x-telegram-bot-api-secret-token'];
            if (tgSecret !== WEBHOOK_SECRET) {
                // Silent reject — don't reveal info to attacker
                return res.status(200).end();
            }
        }
    } else {
        // ─── LAYER 3b: Frontend CORS + API Secret ───────────────
        res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-crm-secret');

        // Origin check (browser-enforced, defense in depth)
        const origin = req.headers['origin'] || '';
        if (ALLOWED_ORIGIN !== '*' && origin && origin !== ALLOWED_ORIGIN) {
            return res.status(403).json({ error: 'Forbidden: origin' });
        }

        // API Secret check — MANDATORY
        // Blocks curl/Postman: they don't know the secret
        const clientSecret = req.headers['x-crm-secret'];
        if (!API_SECRET || clientSecret !== API_SECRET) {
            return res.status(403).json({ error: 'Forbidden' });
        }
    }

    // ─── Main logic ─────────────────────────────────────────────
    try {

        // ═════════════════════════════════════════════════════════
        // BRANCH A — Telegram Webhook: callback_query
        // ═════════════════════════════════════════════════════════
        if (body.callback_query) {
            const cb     = body.callback_query;
            const msg    = cb.message;
            const chatId = String(msg.chat.id);
            const msgId  = msg.message_id;
            const user   = cb.from;

            if (chatId !== CHAT_ID) {
                await tg('answerCallbackQuery', { callback_query_id: cb.id, text: '⛔ Нет доступа' });
                return res.status(200).end();
            }

            const [action, lockId] = cb.data.split(':');
            const mgrTag  = user.username ? `@${user.username}` : (user.first_name || 'Менеджер');
            const time    = now();
            const htmlNow = rebuildHtml(msg.text || '', msg.entities);

            // Resource lock
            if (lockId && String(user.id) !== lockId) {
                await tg('answerCallbackQuery', {
                    callback_query_id: cb.id,
                    text: '🔒 Эту заявку уже обрабатывает другой менеджер!',
                    show_alert: true,
                });
                return res.status(200).end();
            }

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

            else if (action === 'start_reject') {
                await tg('editMessageReplyMarkup', {
                    chat_id: chatId, message_id: msgId,
                    reply_markup: kbStage3(user.id),
                });
                await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Выберите причину:' });
            }

            else if (action === 'back_work') {
                await tg('editMessageReplyMarkup', {
                    chat_id: chatId, message_id: msgId,
                    reply_markup: kbStage2(user.id),
                });
                await tg('answerCallbackQuery', { callback_query_id: cb.id });
            }

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

            else {
                await tg('answerCallbackQuery', { callback_query_id: cb.id });
            }

            return res.status(200).end();
        }

        // ═════════════════════════════════════════════════════════
        // BRANCH B — Website Lead (form / quiz)
        // ═════════════════════════════════════════════════════════
        const { name, phone, car, service, quiz } = body;

        // ─── LAYER 4: Payload validation ────────────────────────
        if (!phone || typeof phone !== 'string' || phone.trim().length < 10) {
            return res.status(400).json({ error: 'Invalid phone' });
        }
        if (!quiz && (!name || !car || typeof name !== 'string' || typeof car !== 'string')) {
            return res.status(400).json({ error: 'Missing name or car' });
        }

        if (!BOT_TOKEN || !CHAT_ID) {
            return res.status(500).json({ error: 'Server misconfiguration' });
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
            return res.status(500).json({ error: 'Telegram API error' });
        }

        return res.status(200).json({ success: true });

    } catch (error) {
        console.error('Handler error:', error);
        return res.status(200).json({ error: 'Internal error' });
    }
}
