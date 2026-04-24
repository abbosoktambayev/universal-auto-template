# Radjabov Detailing — Premium Landing Page

Премиум лендинг для студии автодетейлинга **Radjabov Detailing** (Астана, Казахстан).

![Dark Mode](https://img.shields.io/badge/Theme-Dark_Mode-0A0A0A?style=flat-square)
![Tailwind](https://img.shields.io/badge/Tailwind_CSS-CDN-38BDF8?style=flat-square)
![Telegram](https://img.shields.io/badge/Telegram_Bot-API-26A5E4?style=flat-square)

## 🚀 Быстрый старт

1. Клонируйте репозиторий:
```bash
git clone https://github.com/abbosoktambayev/radjabov-detailing.git
cd radjabov-detailing
```

2. Создайте файл конфигурации:
```bash
cp config.example.js config.js
```

3. Впишите свои данные Telegram-бота в `config.js`:
```javascript
const BOT_TOKEN = 'ваш_токен_бота';
const CHAT_ID = 'ваш_chat_id';
```

4. Откройте `index.html` в браузере или запустите локальный сервер:
```bash
python3 -m http.server 8080
```

## 🏗️ Стек

- **HTML5** — семантическая разметка
- **Tailwind CSS** (CDN) — стилизация
- **FontAwesome 6** — иконки
- **Google Fonts** (Outfit + Inter) — типографика
- **Vanilla JS** — интерактивность
- **Telegram Bot API** — приём заявок

## 📋 Структура

```
├── index.html           # Основной файл (всё в одном)
├── config.js            # 🔒 Секреты (не в Git)
├── config.example.js    # Шаблон конфигурации
├── images/
│   ├── hero-car.png     # Hero-изображение
│   ├── ceramic-coating.png
│   └── ppf-service.png
├── .gitignore
└── README.md
```

## ✨ Фичи

- 🌑 Dark Mode с красным акцентом
- 📱 Mobile-First адаптивная вёрстка
- 🎨 Glassmorphism, parallax, shimmer-эффекты
- ⭐ Социальное доказательство (5.0 рейтинг, 284 отзыва)
- 📝 Форма захвата → Telegram Bot
- 🔔 Toast-уведомление при отправке
- 📍 3 филиала с контактами
- 🔗 Instagram, TikTok, WhatsApp

## 📄 Лицензия

MIT
