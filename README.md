# kiberone-flyer-5000

Связка **печатная листовка + мини-лендинг + бэкенд** под канал «листовки с сертификатом 5 000 ₽».
Один макет — два канала (почтовые ящики / рекомендации друзей). Заявка летит **напрямую в AlphaCRM**, дублируется в Telegram, посещения и заявки считаются в KV для аналитики по UTM.

```
flyer.html ──QR──>  index.html (Cloudflare Pages)
                          │
                          ├── POST /api/pageview ──> Worker → KV
                          │
                          └── POST /api/lead ─────> Worker ──┬──> AlphaCRM API
                                                              ├──> Telegram владельцу (400383551)
                                                              └──> KV (резервный журнал + счётчик)
```

## Файлы

- **`index.html`** — лендинг (Cloudflare Pages). Форма-заявка, без WhatsApp. Реагирует на UTM.
- **`flyer.html`** — печатный шаблон A6, реагирует на `?city=` и `?medium=`. QR ведёт на лендинг с UTM.
- **`api/worker.js`** — Cloudflare Worker: `/api/lead`, `/api/pageview`, `/api/stats`.
- **`wrangler.toml`** — конфиг Worker.
- **`api/.env.example`** — список переменных, которые маркетолог регистрирует через `wrangler secret put`.

## Что считается

| Метрика | Где смотреть |
|---|---|
| Все визиты лендинга (с поведением, картой кликов, вебвизором) | **Яндекс.Метрика** (счётчик 109689627 — заглушка, маркетолог заведёт свой под `podarok.it-kiber.ru`) |
| Визиты в разрезе UTM (источник × канал × город × день) | **GET `/api/stats?token=...`** — отдаёт JSON с разбивкой `pageviews` и `leads` |
| Поданные заявки | AlphaCRM (тег «Канал: листовка», источник «Листовка 5000 ₽») + Telegram владельцу + резервный лог в KV |
| Конверсия визит → заявка | Стат-endpoint `/api/stats` (отношение `ld` / `pv` по тем же UTM) |

## Лендинг

### Что показывает

1. **Hero** — карточка-сертификат 5 000 ₽ + заголовок «За 1 час пробного ребёнок создаст свою игру с ИИ — бесплатно»
2. **Как использовать сертификат** — 3 шага
3. **Что такое KIBERone** — 4 цифры
4. **Форма-заявка** — 4 поля (имя / телефон / возраст / город), inline, без модалки. Сабмит → fetch POST `/api/lead`, success-state.

### UTM-параметры

```
https://podarok.it-kiber.ru/?utm_source=flyer&utm_medium=mailbox&utm_campaign=chelny&city=chelny
```

| Параметр | Значение | Что делает |
|---|---|---|
| `utm_source` | `flyer` | Источник трафика |
| `utm_medium` | `mailbox` или `referral` | Канал распространения |
| `utm_campaign` | `chelny` / `nizhnekamsk` / `kazan` / `elabuga` / `krasnodar` / `surgut` / `perm` | Город |
| `city` | то же значение | Предвыбирает город в форме + маршрутит заявку в нужный филиал |
| `ref` | имя (опционально) | Если в QR зашили имя того, кто посоветовал |

### Что подкрутить перед запуском

1. **`API_BASE` в `index.html`** — подставить URL Cloudflare Worker после деплоя.
2. **Я.Метрика 109689627** — это сейчас счётчик `kanikuly.it-kiber.ru` как заглушка. Маркетолог заводит новый счётчик под `podarok.it-kiber.ru` и заменяет `ym(109689627, ...)` на свой ID в трёх местах.
3. Цели в Я.Метрике: `flyer_lead_submitted` (успешная отправка), `flyer_lead_error` (ошибка). Создаются автоматически по reachGoal.

## Листовка (печатная)

### Формат

- **A6 (105×148 мм)**, двусторонняя, плотность 170–200 г/м²
- **Лицо:** «Сертификат 5 000 ₽» + QR + headline
- **Оборот:** заголовок-крючок, 5 буллетов, название филиала (без адреса/телефона — заявка только через сайт), поле «Меня посоветовал: __»

### Печать 14 версий (7 городов × 2 канала)

1. Открыть `flyer.html` в Chrome.
2. В тулбаре выбрать город + канал (`mailbox` / `referral`).
3. Ctrl+P → A6 без полей.
4. Для каждой комбинации — отдельный прогон, итого 14 PDF.

> Тулбар при печати скрыт (`@media print`).

### URL-параметры

```
flyer.html?city=chelny&medium=mailbox
flyer.html?city=chelny&medium=referral
...
flyer.html?city=perm&medium=referral
```

QR пересобирается при смене селекта — UTM в QR всегда соответствует выбранному городу и каналу.

## Backend (Cloudflare Worker)

### Endpoints

| Method | Path | Что делает |
|---|---|---|
| `POST` | `/api/lead` | Принимает заявку, валидирует, отправляет в AlphaCRM + Telegram + KV. Ничего не блокирует — если CRM упал, Telegram всё равно уйдёт. |
| `POST` | `/api/pageview` | Инкрементит счётчик визитов по `(date, utm_source, utm_medium, utm_campaign)`. |
| `GET` | `/api/stats?token=...&days=30` | Сводка визитов и заявок по UTM за N дней. Защищено `STATS_TOKEN`. |

### Хранилище (KV namespace `STATS`)

| Ключ | Значение | TTL |
|---|---|---|
| `pv:YYYY-MM-DD:utm_source:utm_medium:utm_campaign` | счётчик визитов | 365 дней |
| `ld:YYYY-MM-DD:utm_source:utm_medium:utm_campaign` | счётчик заявок | 365 дней |
| `lead:ISO_timestamp:RAND` | резервная копия лида (JSON) | 180 дней |

### Деплой Worker

```bash
# 1. Установить wrangler (один раз)
npm i -g wrangler
wrangler login

# Все команды ниже выполняются из подпапки api/
cd api/

# 2. Создать KV namespace и подставить id в wrangler.toml
wrangler kv:namespace create STATS
wrangler kv:namespace create STATS --preview

# 3. Зарегистрировать секреты (см. api/.env.example)
wrangler secret put ALPHACRM_API_URL
wrangler secret put ALPHACRM_API_KEY
wrangler secret put ALPHACRM_LEAD_SOURCE_ID
wrangler secret put ALPHACRM_BRANCH_ID_CHELNY
wrangler secret put ALPHACRM_BRANCH_ID_NIZHNEKAMSK
wrangler secret put ALPHACRM_BRANCH_ID_KAZAN
wrangler secret put ALPHACRM_BRANCH_ID_ELABUGA
wrangler secret put ALPHACRM_BRANCH_ID_KRASNODAR
wrangler secret put ALPHACRM_BRANCH_ID_SURGUT
wrangler secret put ALPHACRM_BRANCH_ID_PERM
wrangler secret put TG_BOT_TOKEN
wrangler secret put TG_CHAT_ID            # 400383551
wrangler secret put STATS_TOKEN           # любая случайная строка для GET /api/stats

# 4. Деплой
wrangler deploy
# → kiberone-flyer-5000-api.<account>.workers.dev
# Подставить URL в API_BASE в index.html.
```

### Что нужно от AlphaCRM (маркетолог запрашивает у админа CRM)

1. **API token** — в настройках интеграций AlphaCRM.
2. **API endpoint** — типа `https://kiberonenabchln.s20.online/v2api/lead/index` (точное имя метода создания лида сверить в [официальной доке AlphaCRM v2 API](https://alfacrm.pro/ru/api)).
3. **Создать новый источник лида** «Листовка 5000 ₽» — получить numeric ID, положить в `ALPHACRM_LEAD_SOURCE_ID`.
4. **Численные ID каждого филиала** (Локации в настройках AlphaCRM) — для маршрутизации заявки в нужную школу.

> ⚠️ Точная схема payload AlphaCRM в `api/worker.js` (функция `sendToAlphaCRM`) — это шаблон. После получения доступа к API маркетолог должен сверить названия полей с актуальной докой и подкорректировать. Это **единственное** место, где может потребоваться правка.

## Деплой лендинга

Cloudflare Pages (как `kiber-summer-landing`):
1. Создать репо `kiberone-flyer-5000`
2. Cloudflare Pages → Connect to Git → root `/`
3. Получить `kiberone-flyer-5000.pages.dev` → CNAME на `podarok.it-kiber.ru`
4. Push в `main` — автодеплой

## Воронка лида → AlphaCRM

1. Человек сканирует QR → `podarok.it-kiber.ru?utm_source=flyer&utm_medium=mailbox|referral&utm_campaign=город`
2. Worker инкрементит счётчик визита (`pv:date:src:medium:campaign`)
3. Человек заполняет 4 поля → жмёт «Отправить заявку»
4. Browser → `POST /api/lead` → Worker:
   - Создаёт сделку в AlphaCRM (тег «Канал: листовка», источник «Листовка 5000 ₽», локация = город)
   - Шлёт уведомление в Telegram владельцу (400383551)
   - Пишет в KV резервную копию лида + инкрементит счётчик заявок
5. Пользователь видит success-state «Заявка отправлена!»
6. Менеджер филиала видит сделку в AlphaCRM в течение секунд → перезванивает по штатному регламенту [154](../kiberone-management/154-obrabotka-marketingovyh-lidov-otdelom-prodazh-mop.md)

## Связанные документы

- `kiberone-management/193-listovka-5000-podarok-yashchiki-rekomendacii.md` — методичка раздачи
- `kiberone-management/190-privedi-druga-3.0.md` — рекомендательная программа (5 000 ₽ другу по **именному** сертификату — отдельный канал, более тёплый)
- `kiberone-management/192-tochki-oflain-kontakta-s-klientom.md` — реестр офлайн-точек контакта
- `kiberone-reactivation-landing/` — соседний мини-лендинг (тот же дизайн-язык)
