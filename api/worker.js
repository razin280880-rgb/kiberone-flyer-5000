/**
 * KIBERone flyer-5000 backend
 *
 * Endpoints:
 *  - POST /api/lead     — заявка с формы → AlphaCRM + Telegram + KV
 *  - POST /api/pageview — счётчик переходов на лендинг (по UTM)
 *  - GET  /api/stats    — сводка визитов и заявок (защищено STATS_TOKEN)
 *
 * Что хранится в KV (binding: STATS):
 *  pv:{YYYY-MM-DD}:{utm_source}:{utm_medium}:{utm_campaign}   → integer (counter)
 *  ld:{YYYY-MM-DD}:{utm_source}:{utm_medium}:{utm_campaign}   → integer (counter)
 *  lead:{ISO_timestamp}:{random}                              → JSON (резервный журнал лида)
 *
 * Secrets / env vars:
 *  ALPHACRM_API_URL       — endpoint AlphaCRM (e.g. https://kiberonenabchln.s20.online/v2api/lead/index)
 *  ALPHACRM_API_KEY       — API token AlphaCRM
 *  ALPHACRM_HOSTNAME      — hostname (e.g. kiberonenabchln.s20.online), для auth
 *  ALPHACRM_EMAIL         — email учётной записи интеграции (если требуется)
 *  ALPHACRM_BRANCH_ID_*   — ID локации по городам, см. ниже
 *  TG_BOT_TOKEN           — токен Telegram-бота уведомлений
 *  TG_CHAT_ID             — chat_id владельца (400383551 по умолчанию)
 *  STATS_TOKEN            — секрет для чтения /api/stats
 *  ALLOWED_ORIGIN         — Origin лендинга (https://podarok.it-kiber.ru), для CORS
 */

const CITY_TO_BRANCH_ENV = {
  chelny:      'ALPHACRM_BRANCH_ID_CHELNY',
  nizhnekamsk: 'ALPHACRM_BRANCH_ID_NIZHNEKAMSK',
  kazan:       'ALPHACRM_BRANCH_ID_KAZAN',
  elabuga:     'ALPHACRM_BRANCH_ID_ELABUGA',
  krasnodar:   'ALPHACRM_BRANCH_ID_KRASNODAR',
  surgut:      'ALPHACRM_BRANCH_ID_SURGUT',
  perm:        'ALPHACRM_BRANCH_ID_PERM',
};

const CITY_DISPLAY = {
  chelny: 'Набережные Челны',
  nizhnekamsk: 'Нижнекамск',
  kazan: 'Казань',
  elabuga: 'Елабуга',
  krasnodar: 'Краснодар',
  surgut: 'Сургут',
  perm: 'Пермь',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    try {
      if (url.pathname === '/api/lead' && request.method === 'POST') {
        return await handleLead(request, env, ctx);
      }
      if (url.pathname === '/api/pageview' && request.method === 'POST') {
        return await handlePageview(request, env, ctx);
      }
      if (url.pathname === '/api/stats' && request.method === 'GET') {
        return await handleStats(request, env);
      }
      return jsonResponse({ error: 'not_found' }, 404, env);
    } catch (err) {
      return jsonResponse({ error: 'internal', message: String(err && err.message || err) }, 500, env);
    }
  }
};

/* ─────────── /api/lead ─────────── */
async function handleLead(request, env, ctx) {
  const body = await safeJson(request);
  if (!body) return jsonResponse({ error: 'bad_json' }, 400, env);

  const parent_name = sanitize(body.parent_name, 100);
  const phone       = sanitizePhone(body.phone);
  const child_age   = sanitizeAge(body.child_age);
  const city        = sanitizeCity(body.city);
  const utm_source   = sanitize(body.utm_source,   64);
  const utm_medium   = sanitize(body.utm_medium,   64);
  const utm_campaign = sanitize(body.utm_campaign, 64);
  const ref          = sanitize(body.ref,          64);
  const page_url     = sanitize(body.page_url,     500);

  if (!parent_name || !phone || !child_age || !city) {
    return jsonResponse({ error: 'missing_fields' }, 400, env);
  }

  const lead = {
    parent_name, phone, child_age, city,
    utm_source, utm_medium, utm_campaign, ref, page_url,
    received_at: new Date().toISOString(),
    ip: request.headers.get('cf-connecting-ip') || '',
    country: request.cf && request.cf.country || '',
  };

  // Резервный журнал в KV (на случай если CRM/TG отвалятся)
  ctx.waitUntil(persistLead(env, lead));

  // Счётчик
  ctx.waitUntil(incCounter(env, 'ld', lead));

  // Параллельно: AlphaCRM + Telegram. Не валим запрос, если один из двух упал.
  const [crmResult, tgResult] = await Promise.allSettled([
    sendToAlphaCRM(env, lead),
    sendToTelegram(env, lead),
  ]);

  return jsonResponse({
    ok: true,
    crm: crmResult.status === 'fulfilled' ? 'sent' : 'failed',
    tg:  tgResult.status  === 'fulfilled' ? 'sent' : 'failed',
  }, 200, env);
}

/* ─────────── /api/pageview ─────────── */
async function handlePageview(request, env, ctx) {
  const body = await safeJson(request);
  if (!body) return jsonResponse({ error: 'bad_json' }, 400, env);

  const utm_source   = sanitize(body.utm_source,   64);
  const utm_medium   = sanitize(body.utm_medium,   64);
  const utm_campaign = sanitize(body.utm_campaign, 64);

  ctx.waitUntil(incCounter(env, 'pv', { utm_source, utm_medium, utm_campaign }));

  return jsonResponse({ ok: true }, 200, env);
}

/* ─────────── /api/stats ─────────── */
async function handleStats(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!env.STATS_TOKEN || token !== env.STATS_TOKEN) {
    return jsonResponse({ error: 'forbidden' }, 403, env);
  }
  if (!env.STATS) {
    return jsonResponse({ error: 'kv_not_bound' }, 500, env);
  }

  const days = Math.min(parseInt(url.searchParams.get('days') || '30', 10), 90);
  const today = new Date();
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const result = { days: dates, pageviews: {}, leads: {}, totals: { pv: 0, ld: 0 } };

  for (const prefix of ['pv', 'ld']) {
    const cursor = await env.STATS.list({ prefix: prefix + ':', limit: 1000 });
    for (const key of cursor.keys) {
      const parts = key.name.split(':');
      // pv:DATE:src:medium:campaign
      const dateKey = parts[1];
      const src = parts[2] || '-';
      const medium = parts[3] || '-';
      const campaign = parts[4] || '-';
      if (!dates.includes(dateKey)) continue;
      const val = parseInt(await env.STATS.get(key.name) || '0', 10);
      const bucket = `${src}/${medium}/${campaign}`;
      const into = prefix === 'pv' ? result.pageviews : result.leads;
      into[bucket] = (into[bucket] || 0) + val;
      result.totals[prefix] += val;
    }
  }

  return jsonResponse(result, 200, env);
}

/* ─────────── AlphaCRM ─────────── */
async function sendToAlphaCRM(env, lead) {
  if (!env.ALPHACRM_API_URL || !env.ALPHACRM_API_KEY) {
    throw new Error('alphacrm_not_configured');
  }
  const branchEnvKey = CITY_TO_BRANCH_ENV[lead.city];
  const branchId = branchEnvKey ? env[branchEnvKey] : null;

  // ⚠️ ВНИМАНИЕ: точная схема payload AlphaCRM зависит от вашей конфигурации.
  // Маркетолог должен сверить с https://alfacrm.pro/ru/api (v2api) и при необходимости
  // подкрутить названия полей (name → customer_name, contact → phone и т.п.).
  const payload = {
    name: lead.parent_name,
    phone: [lead.phone],
    branch_id: branchId ? parseInt(branchId, 10) : undefined,
    note: [
      `Возраст ребёнка: ${lead.child_age}`,
      `UTM: ${lead.utm_source || '-'} / ${lead.utm_medium || '-'} / ${lead.utm_campaign || '-'}`,
      lead.ref ? `Рекомендовал: ${lead.ref}` : null,
      `Источник: листовка-подарок 5000 ₽`,
      `Лендинг: ${lead.page_url || 'podarok.it-kiber.ru'}`,
    ].filter(Boolean).join('\n'),
    custom_age: lead.child_age,
    lead_source_id: env.ALPHACRM_LEAD_SOURCE_ID ? parseInt(env.ALPHACRM_LEAD_SOURCE_ID, 10) : undefined,
  };

  const res = await fetch(env.ALPHACRM_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-ALFACRM-TOKEN': env.ALPHACRM_API_KEY,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`alphacrm_${res.status}: ${text.slice(0, 200)}`);
  }
  return true;
}

/* ─────────── Telegram ─────────── */
async function sendToTelegram(env, lead) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) {
    throw new Error('telegram_not_configured');
  }
  const cityName = CITY_DISPLAY[lead.city] || lead.city;
  const channelHint = lead.utm_medium === 'mailbox'  ? 'почт. ящики'
                    : lead.utm_medium === 'referral' ? 'рекомендация'
                    : (lead.utm_medium || '-');

  const text =
    `🎁 *Новая заявка с листовки 5000 ₽*\n\n` +
    `👤 *${escapeMd(lead.parent_name)}*\n` +
    `📞 \`${lead.phone}\`\n` +
    `👶 Ребёнок: ${lead.child_age} лет\n` +
    `🏙 Город: ${escapeMd(cityName)}\n\n` +
    `📍 Канал: *${escapeMd(channelHint)}*\n` +
    `🏷 UTM: ${escapeMd(lead.utm_source || '-')} / ${escapeMd(lead.utm_medium || '-')} / ${escapeMd(lead.utm_campaign || '-')}\n` +
    (lead.ref ? `🤝 Рекомендовал: ${escapeMd(lead.ref)}\n` : '') +
    `\n⏰ ${escapeMd(lead.received_at)}`;

  const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TG_CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const tx = await res.text();
    throw new Error(`tg_${res.status}: ${tx.slice(0, 200)}`);
  }
  return true;
}

/* ─────────── Helpers ─────────── */
async function safeJson(req) { try { return await req.json(); } catch { return null; } }

function sanitize(v, max) { return (typeof v === 'string' ? v : '').replace(/[\x00-\x1f]/g, '').trim().slice(0, max); }
function sanitizePhone(v) {
  const digits = (typeof v === 'string' ? v : '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 12) return '';
  return '+' + digits;
}
function sanitizeAge(v) {
  const n = parseInt(v, 10);
  return (n >= 5 && n <= 17) ? String(n) : '';
}
function sanitizeCity(v) {
  const c = sanitize(v, 32).toLowerCase();
  return CITY_TO_BRANCH_ENV.hasOwnProperty(c) ? c : '';
}

async function persistLead(env, lead) {
  if (!env.STATS) return;
  const key = `lead:${lead.received_at}:${Math.random().toString(36).slice(2, 8)}`;
  await env.STATS.put(key, JSON.stringify(lead), { expirationTtl: 60 * 60 * 24 * 180 }); // 180 дней
}

async function incCounter(env, prefix, lead) {
  if (!env.STATS) return;
  const date = new Date().toISOString().slice(0, 10);
  const key = `${prefix}:${date}:${lead.utm_source || '-'}:${lead.utm_medium || '-'}:${lead.utm_campaign || '-'}`;
  const cur = parseInt(await env.STATS.get(key) || '0', 10);
  await env.STATS.put(key, String(cur + 1), { expirationTtl: 60 * 60 * 24 * 365 });
}

function corsHeaders(env) {
  const origin = env.ALLOWED_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(obj, status, env) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

function escapeMd(s) {
  return String(s || '').replace(/([_*`\[\]])/g, '\\$1');
}
