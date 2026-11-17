// Lê e valida as variáveis de ambiente. Tudo que muda de um ambiente para outro fica aqui.

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function hhmm(value, name) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`${name} deve estar no formato HH:MM (recebido: ${value})`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export const config = {
  port: Number(env('PORT', 3000)),

  whatsapp: {
    token: env('WHATSAPP_TOKEN'),
    phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
    verifyToken: env('WHATSAPP_VERIFY_TOKEN'),
    appSecret: env('WHATSAPP_APP_SECRET'),
    graphVersion: env('GRAPH_API_VERSION', 'v23.0'),
    // Meta direto: https://graph.facebook.com  |  Dualhook (coexistência): https://api.dualhook.com
    apiBase: env('WHATSAPP_API_BASE', 'https://graph.facebook.com').replace(/\/+$/, ''),
    // ID da conta do WhatsApp (WABA). Opcional: se preenchido, avisos de outras contas são ignorados.
    wabaId: env('WHATSAPP_WABA_ID', ''),
  },

  // Caminho do webhook. Com Dualhook, use um caminho difícil de adivinhar, ex.: /webhook/a8f3k29xq7
  webhookPath: (() => {
    const p = env('WEBHOOK_PATH', '/webhook');
    return p.startsWith('/') ? p : `/${p}`;
  })(),

  anthropic: {
    apiKey: env('ANTHROPIC_API_KEY'),
    model: env('ANTHROPIC_MODEL', 'claude-sonnet-5-5'),
    maxTokens: Number(env('ANTHROPIC_MAX_TOKENS', 1024)),
  },

  google: {
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
    refreshToken: env('GOOGLE_REFRESH_TOKEN'),
    calendarId: env('GOOGLE_CALENDAR_ID', 'primary'),
  },

  agenda: {
    timezone: env('TIMEZONE', 'America/Sao_Paulo'),
    // 0 = domingo ... 6 = sábado
    workDays: env('WORK_DAYS', '1,2,3,4,5').split(',').map((d) => Number(d.trim())),
    workStart: hhmm(env('WORK_START', '09:00'), 'WORK_START'),
    workEnd: hhmm(env('WORK_END', '18:00'), 'WORK_END'),
    meetingMinutes: Number(env('MEETING_DURATION_MIN', 30)),
    minNoticeHours: Number(env('MIN_NOTICE_HOURS', 2)),
    bookingWindowDays: Number(env('BOOKING_WINDOW_DAYS', 14)),
  },

  // Número pessoal do dono (só dígitos, com DDI), para alertas e comandos #pausar/#retomar.
  ownerWhatsapp: env('OWNER_WHATSAPP', '').replace(/\D/g, ''),
  // Quantas horas o robô fica em silêncio com um cliente depois de chamar um atendente.
  handoffHours: Number(env('HANDOFF_HOURS', 12)),
  // Quando o dono manda mensagem primeiro (prospecção) ou o contato responde com robô, o robô fica quieto por este tempo.
  ownerFirstPauseHours: Number(env('OWNER_FIRST_PAUSE_HOURS', 72)),
};

export function googleConfigured() {
  return Boolean(config.google.clientId && config.google.clientSecret && config.google.refreshToken);
}

export function checkConfig() {
  const missing = [];
  const req = {
    WHATSAPP_TOKEN: config.whatsapp.token,
    WHATSAPP_PHONE_NUMBER_ID: config.whatsapp.phoneNumberId,
    WHATSAPP_VERIFY_TOKEN: config.whatsapp.verifyToken,
    ANTHROPIC_API_KEY: config.anthropic.apiKey,
  };
  for (const [k, v] of Object.entries(req)) if (!v) missing.push(k);
  if (!googleConfigured()) {
    console.warn('[aviso] Google Agenda não configurada: o robô tira dúvidas, mas pedidos de reunião vão para um atendente.');
  }
  if (!config.whatsapp.appSecret) {
    if (config.webhookPath === '/webhook') {
      console.warn('[aviso] Sem WHATSAPP_APP_SECRET e com o caminho padrão /webhook: defina um WEBHOOK_PATH secreto para proteger o robô.');
    } else {
      console.log('[info] Assinatura da Meta desligada (modo Dualhook). Protegido pelo WEBHOOK_PATH secreto e pela checagem do número.');
    }
  }
  return missing;
}
