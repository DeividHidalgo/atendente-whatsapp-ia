import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/index.js';
import { createAgent } from '../src/agent.js';
import { createStore, trimHistory } from '../src/store.js';
import { createCalendar } from '../src/calendar.js';
import { createClaude, withConversationCache } from '../src/claude.js';
import { parseWebhook, validSignature, splitMessage, createWhatsApp } from '../src/whatsapp.js';

const agenda = {
  timezone: 'America/Sao_Paulo',
  workDays: [1, 2, 3, 4, 5],
  workStart: 540,
  workEnd: 1080,
  meetingMinutes: 30,
  minNoticeHours: 2,
  bookingWindowDays: 14,
};
const cfg = {
  agenda,
  handoffHours: 12,
  ownerWhatsapp: '5515900000000',
  whatsapp: { verifyToken: 'segredo', appSecret: 'app-secret' },
};

const webhook = (from, text, id = crypto.randomUUID()) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            contacts: [{ wa_id: from, profile: { name: 'Maria' } }],
            messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
          },
        },
      ],
    },
  ],
});

/** Claude de mentira que segue um roteiro de respostas. */
function scriptedClaude(script) {
  const calls = [];
  return {
    calls,
    async create(req) {
      calls.push(structuredClone(req));
      const next = script.shift();
      if (!next) throw new Error('roteiro acabou');
      return next(req);
    },
  };
}

test('fluxo completo: cliente pede horário, robô consulta agenda, agenda e confirma', async () => {
  const sent = [];
  const whatsapp = { sendText: async (to, text) => sent.push({ to, text }), markReadTyping: async () => {} };
  const store = createStore();
  const booked = [];
  const calendar = {
    availableSlots: async () => [{ inicio: '2026-11-04T10:00:00-03:00', rotulo: 'quarta-feira, 04/11 às 10:00' }],
    book: async (b) => (booked.push(b), { ok: true, evento_id: 'ev1', quando: 'quarta-feira, 04/11 às 10:00', link_meet: 'https://meet.google.com/x' }),
    upcomingFor: async () => [],
    cancel: async () => ({ ok: true }),
  };
  const claude = scriptedClaude([
    () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Oi Maria! Qual serviço te interessa?' }] }),
    () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'consultar_horarios_disponiveis', input: {} }] }),
    (req) => {
      const last = req.messages.at(-1).content[0];
      assert.equal(last.type, 'tool_result');
      assert.match(last.content, /04\/11 às 10:00/);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Tenho quarta 04/11 às 10:00. Serve?' }] };
    },
    () => ({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 't2',
          name: 'agendar_reuniao',
          input: { inicio: '2026-11-04T10:00:00-03:00', nome: 'Maria', servico_interesse: 'Agendamento automático', resumo_necessidade: 'Salão quer agenda no WhatsApp', email: 'maria@ex.com' },
        },
      ],
    }),
    () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Agendado! Link: https://meet.google.com/x' }] }),
  ]);

  let app;
  const agent = createAgent({ claude, calendar, store, config: cfg, notifyOwner: (t) => app.notifyOwner(t) });
  app = createApp({ whatsapp, agent, store, cfg });

  const client = '5511988887777';
  for (const text of ['Oi', 'Quero marcar uma reunião', 'Pode ser quarta às 10h']) {
    app.processWebhook(webhook(client, text));
    await store.enqueue(client, async () => {});
  }

  const toClient = sent.filter((s) => s.to === client).map((s) => s.text);
  assert.deepEqual(toClient, ['Oi Maria! Qual serviço te interessa?', 'Tenho quarta 04/11 às 10:00. Serve?', 'Agendado! Link: https://meet.google.com/x']);
  assert.equal(booked[0].phone, client, 'telefone vem do servidor, não do modelo');
  assert.equal(booked[0].email, 'maria@ex.com');
  assert.ok(sent.some((s) => s.to === cfg.ownerWhatsapp && /Nova reunião/.test(s.text)), 'dono foi avisado');
  // o histórico foi mantido entre mensagens
  assert.equal(claude.calls.at(-1).messages.filter((m) => m.role === 'user' && typeof m.content === 'string').length, 3);
  const sys = claude.calls[0].system;
  assert.ok(Array.isArray(sys) && sys[0].cache_control?.type === 'ephemeral', 'parte fixa vai para o cache');
  assert.doesNotMatch(sys[0].text, /Agora é/, 'data/hora fora da parte em cache');
  assert.match(sys[1].text, /Agora é/);
});

test('chamar atendente pausa o robô; dono religa com #retomar', async () => {
  const sent = [];
  const whatsapp = { sendText: async (to, text) => sent.push({ to, text }), markReadTyping: async () => {} };
  const store = createStore();
  const claude = scriptedClaude([
    () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'h', name: 'chamar_atendente', input: { motivo: 'Quer falar com uma pessoa' } }] }),
    () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Já chamei a equipe!' }] }),
    () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'De volta!' }] }),
  ]);
  let app;
  const agent = createAgent({ claude, calendar: {}, store, config: cfg, notifyOwner: (t) => app.notifyOwner(t) });
  app = createApp({ whatsapp, agent, store, cfg });

  const client = '5511977776666';
  app.processWebhook(webhook(client, 'quero falar com humano'));
  await store.enqueue(client, async () => {});
  assert.ok(store.isPaused(client));
  assert.ok(sent.some((s) => s.to === cfg.ownerWhatsapp && /#retomar 5511977776666/.test(s.text)));

  app.processWebhook(webhook(client, 'alô?'));
  await store.enqueue(client, async () => {});
  assert.equal(sent.filter((s) => s.to === client).length, 1, 'pausado: não responde');

  app.processWebhook(webhook(cfg.ownerWhatsapp, '#retomar 5511977776666'));
  await store.enqueue(cfg.ownerWhatsapp, async () => {});
  assert.ok(!store.isPaused(client));

  app.processWebhook(webhook(client, 'oi de novo'));
  await store.enqueue(client, async () => {});
  assert.equal(sent.filter((s) => s.to === client).at(-1).text, 'De volta!');
});

test('mensagem repetida da Meta é ignorada e eco do app pausa o robô', async () => {
  const sent = [];
  const whatsapp = { sendText: async (to, text) => sent.push({ to, text }), markReadTyping: async () => {} };
  const store = createStore();
  const claude = scriptedClaude([() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'oi' }] })]);
  const agent = createAgent({ claude, calendar: {}, store, config: cfg, notifyOwner: async () => {} });
  const app = createApp({ whatsapp, agent, store, cfg });
  const body = webhook('5511911112222', 'oi', 'wamid.X');
  app.processWebhook(body);
  app.processWebhook(body);
  await store.enqueue('5511911112222', async () => {});
  assert.equal(sent.length, 1);

  app.processWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'smb_message_echoes', value: { message_echoes: [{ to: '5511933334444', id: 'e' }] } }] }] });
  assert.ok(store.isPaused('5511933334444'));
});

test('servidor HTTP: verificação do webhook e assinatura', async () => {
  const store = createStore();
  const app = createApp({ whatsapp: {}, agent: {}, store, cfg });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    let r = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=segredo&hub.challenge=123`);
    assert.equal(await r.text(), '123');
    r = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=123`);
    assert.equal(r.status, 403);
    const body = JSON.stringify({ entry: [] });
    r = await fetch(`${base}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=abc' } });
    assert.equal(r.status, 401);
    const sig = 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(body).digest('hex');
    r = await fetch(`${base}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': sig } });
    assert.equal(r.status, 200);
  } finally {
    app.server.close();
  }
});

test('Google Agenda: cria evento com Meet e recusa horário ocupado', async () => {
  const requests = [];
  let busy = [];
  const fakeFetch = async (url, opts = {}) => {
    requests.push({ url, opts });
    const json = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (url.includes('oauth2')) return json(200, { access_token: 'tok', expires_in: 3600 });
    if (url.endsWith('/freeBusy')) return json(200, { calendars: { primary: { busy } } });
    if (url.includes('/events?conferenceDataVersion=1')) {
      const ev = JSON.parse(opts.body);
      return json(200, { id: 'ev9', hangoutLink: 'https://meet.google.com/aaa-bbbb-ccc', ...ev });
    }
    return json(404, {});
  };
  const cal = createCalendar(
    { google: { clientId: 'a', clientSecret: 'b', refreshToken: 'c', calendarId: 'primary' }, agenda },
    { fetchImpl: fakeFetch, now: () => new Date('2026-11-03T12:07:00Z') },
  );
  const ok = await cal.book({ start: '2026-11-04T10:00:00-03:00', name: 'Maria', phone: '5511', email: 'm@x.com', service: 'Sites', summary: 'Quer site' });
  assert.equal(ok.ok, true);
  assert.equal(ok.link_meet, 'https://meet.google.com/aaa-bbbb-ccc');
  assert.equal(ok.quando, 'quarta-feira, 04/11 às 10:00');
  const insert = requests.find((r) => r.url.includes('conferenceDataVersion'));
  assert.match(insert.url, /sendUpdates=all/);
  const ev = JSON.parse(insert.opts.body);
  assert.equal(ev.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
  assert.equal(ev.extendedProperties.private.whatsapp, '5511');

  busy = [{ start: '2026-11-04T13:00:00Z', end: '2026-11-04T13:30:00Z' }];
  const taken = await cal.book({ start: '2026-11-04T10:00:00-03:00', name: 'João', phone: '5512' });
  assert.equal(taken.ok, false);
  const offHours = await cal.book({ start: '2026-11-04T20:00:00-03:00', name: 'João', phone: '5512' });
  assert.equal(offHours.ok, false);
});

test('Claude: tenta de novo quando a API está sobrecarregada', async () => {
  let n = 0;
  const fakeFetch = async () => {
    n++;
    return n < 2
      ? { ok: false, status: 529, json: async () => ({ error: 'overloaded' }) }
      : { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [] }) };
  };
  const c = createClaude({ apiKey: 'k', model: 'm', maxTokens: 10 }, { fetchImpl: fakeFetch, sleep: async () => {} });
  await c.create({ system: 's', messages: [], tools: [] });
  assert.equal(n, 2);
});

test('utilitários', () => {
  assert.equal(validSignature(Buffer.from('x'), 'sha256=00', 's'), false);
  assert.equal(splitMessage('a'.repeat(9000)).length, 3);
  const hist = [];
  for (let i = 0; i < 50; i++) {
    hist.push({ role: 'user', content: `m${i}` }, { role: 'assistant', content: [{ type: 'tool_use' }] }, { role: 'user', content: [{ type: 'tool_result' }] }, { role: 'assistant', content: 'ok' });
  }
  const t = trimHistory(hist, 40);
  assert.equal(t[0].content, 'm10');
  const { incoming } = parseWebhook({ entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: '1', from: '55', timestamp: '1', type: 'audio' }] } }] }] });
  assert.equal(incoming[0].text, null);
});

test('raciocínio (thinking) de turnos antigos não é reenviado; dentro do mesmo turno é mantido', async () => {
  const store = createStore();
  const calendar = { availableSlots: async () => [{ inicio: '2026-11-11T09:30:00-03:00', rotulo: 'quarta' }] };
  const think = (t) => ({ type: 'thinking', thinking: t, signature: 'sig-' + t });
  const claude = scriptedClaude([
    () => ({ stop_reason: 'end_turn', content: [think('a'), { type: 'text', text: 'Oi!' }] }),
    () => ({ stop_reason: 'tool_use', content: [think('b'), { type: 'tool_use', id: 't', name: 'consultar_horarios_disponiveis', input: {} }] }),
    (req) => {
      // mesmo turno: o thinking 'b' precisa continuar junto do tool_use
      const blocks = req.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
      assert.ok(blocks.some((b) => b.type === 'thinking' && b.thinking === 'b'));
      assert.ok(!blocks.some((b) => b.type === 'thinking' && b.thinking === 'a'), 'thinking do turno anterior foi removido');
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Quarta 9:30?' }] };
    },
    (req) => {
      const blocks = req.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
      assert.ok(!blocks.some((b) => b.type === 'thinking'), 'nenhum thinking antigo no turno seguinte');
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fechado' }] };
    },
  ]);
  const agent = createAgent({ claude, calendar, store, config: cfg, notifyOwner: async () => {} });
  assert.equal(await agent.reply({ phone: '55', text: 'oi' }), 'Oi!');
  assert.equal(await agent.reply({ phone: '55', text: 'horários?' }), 'Quarta 9:30?');
  assert.equal(await agent.reply({ phone: '55', text: 'pode ser' }), 'Fechado');
});

test('cache: marca só o último bloco da conversa, sem alterar o histórico guardado', () => {
  const msgs = [
    { role: 'user', content: 'oi' },
    { role: 'assistant', content: [{ type: 'text', text: 'olá' }] },
    { role: 'user', content: 'quero marcar' },
  ];
  const out = withConversationCache(msgs);
  assert.deepEqual(out.at(-1).content, [{ type: 'text', text: 'quero marcar', cache_control: { type: 'ephemeral' } }]);
  assert.equal(msgs.at(-1).content, 'quero marcar', 'original intacto');
  const tr = withConversationCache([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '{}' }] }]);
  assert.equal(tr[0].content[0].cache_control.type, 'ephemeral');
});

test('modo Dualhook: envia para api.dualhook.com com a chave dh_live', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => (calls.push({ url, opts }), { ok: true, status: 200, json: async () => ({}) });
  const wa = createWhatsApp(
    { token: 'dh_live_abc', phoneNumberId: '123', graphVersion: 'v25.0', apiBase: 'https://api.dualhook.com' },
    { fetchImpl: fakeFetch },
  );
  await wa.sendText('5515999999999', 'oi');
  assert.equal(calls[0].url, 'https://api.dualhook.com/v25.0/123/messages');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer dh_live_abc');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.messaging_product, 'whatsapp');
  assert.equal(body.text.body, 'oi');
});

test('modo Dualhook: caminho secreto, sem assinatura, e ignora avisos de outro número', async () => {
  const sent = [];
  const whatsapp = { sendText: async (to, text) => sent.push({ to, text }), markReadTyping: async () => {} };
  const store = createStore();
  const claude = scriptedClaude([() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'olá!' }] })]);
  const dcfg = { ...cfg, webhookPath: '/webhook/segredo123', whatsapp: { verifyToken: 'segredo', appSecret: '', phoneNumberId: 'PN1', wabaId: 'W1' } };
  const agent = createAgent({ claude, calendar: {}, store, config: dcfg, notifyOwner: async () => {} });
  const app = createApp({ whatsapp, agent, store, cfg: dcfg });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const msg = (pn, waba, from, id) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: waba, changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: pn },
      messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'oi' } }],
    } }] }],
  });
  try {
    let r = await fetch(`${base}/webhook`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 404, 'caminho padrão desativado');
    r = await fetch(`${base}/webhook/segredo123?hub.mode=subscribe&hub.verify_token=segredo&hub.challenge=ok`);
    assert.equal(await r.text(), 'ok');
    r = await fetch(`${base}/webhook/segredo123`, { method: 'POST', body: JSON.stringify(msg('OUTRO', 'W1', '5511000000001', 'a')) });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/webhook/segredo123`, { method: 'POST', body: JSON.stringify(msg('PN1', 'W1', '5511000000002', 'b')) });
    assert.equal(r.status, 200);
    await store.enqueue('5511000000001', async () => {});
    await store.enqueue('5511000000002', async () => {});
    assert.deepEqual(sent.map((s) => s.to), ['5511000000002'], 'só responde ao aviso do nosso número');
  } finally {
    app.server.close();
  }
});
