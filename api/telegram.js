// ============================================
// Vercel Serverless Function — Telegram Lead Bot
// POST /api/telegram
// ============================================

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { name, phone, car, service, bot_token, chat_id } = req.body;

        if (!name || !phone || !car || !bot_token || !chat_id) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Sanitize phone: remove everything except digits
        const formattedPhone = phone.replace(/[^\d]/g, '');

        // Build the HTML message
        const serviceLine = service ? `\n<b>🔧 Услуга:</b> ${service}` : '';
        const text = [
            '<b>🔥 Новая заявка!</b>',
            '',
            `<b>👤 Имя:</b> ${name}`,
            `<b>🚘 Авто:</b> ${car}`,
            serviceLine,
            `<b>📱 Телефон:</b> ${phone}`,
            '',
            `<a href="https://wa.me/${formattedPhone}">📲 Открыть чат в WhatsApp</a>`,
            '',
            `🕐 <i>${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}</i>`,
        ].filter(line => line !== undefined).join('\n');

        const telegramResponse = await fetch(
            `https://api.telegram.org/bot${bot_token}/sendMessage`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chat_id,
                    text: text,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                }),
            }
        );

        const data = await telegramResponse.json();

        if (!telegramResponse.ok) {
            console.error('Telegram API error:', data);
            return res.status(500).json({ error: 'Telegram API error', details: data });
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('Server error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
