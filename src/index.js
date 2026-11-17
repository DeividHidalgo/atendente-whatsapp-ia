// Servidor do webhook: recebe as mensagens da Meta, passa para o agente e responde no WhatsApp.

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { config, checkConfig, googleConfigured } from './config.js';
import { createWhatsApp, parseWebhook, validSignature } from './whatsapp.js';
import { createClaude } from './claude.js';
import { createCalendar } from './calendar.js';
import { createStore } from './store.js';
import { createAgent } from './agent.js';
import { isAutomatedMessage, NO_REPLY } from './automated.js';

// Trava contra conversa robô x robô: mais que isso de respostas para o mesmo contato em 3 minutos, o robô para.
const LOOP_MAX_REPLIES = 5;
const LOOP_WINDOW_MS = 3 * 60 * 1000;

const UNSUPPORTED_REPLY =
  'Por enquanto eu consigo ler só mensagens de texto 🙂 Pode me escrever sua dúvida? Se preferir falar com uma pessoa, é só pedir.';
const ERROR_REPLY =
  'Desculpe, tive uma instabilidade agora. Pode repetir sua mensagem em instantes? Se preferir, peça para falar com um atendente.';

export function createApp(deps) {
  const { whatsapp, agent, store, cfg, log = () => {} } = deps;
  const pauseHours = cfg.ownerFirstPauseHours ?? 72;
  const recentReplies = new Map(); // phone -> timestamps das últimas respostas do robô

  function tooManyReplies(phone) {
    const now = Date.now();
    const list = (recentReplies.get(phone) ?? []).filter((t) => now - t < LOOP_WINDOW_MS);
    recentReplies.set(phone, list);
    return list.length >= LOOP_MAX_REPLIES;
  }

  async function silenceForBot(msg, reason) {
    store.pause(msg.from, pauseHours);
    log(`[robô de terceiros] +${msg.from}: ${reason}. Robô pausado por ${pauseHours}h com este contato.`);
    await notifyOwner(
      `🤖 *Resposta automática de outra empresa*\n${msg.name ?? 'Contato'} (+${msg.from}) respondeu com um robô.\nO nosso robô ficou em silêncio com esse contato por ${pauseHours}h, para não conversar robô com robô.\nhttps://wa.me/${msg.from}\nPara religar: #retomar ${msg.from}`,
    );
  }

  async function notifyOwner(text) {
    if (!cfg.ownerWhatsapp) return;
    try {
      await whatsapp.sendText(cfg.ownerWhatsapp, text);
    } catch (err) {
      // Fora da janela de 24h a Meta só aceita modelo (template) aprovado. Veja o README.
      console.warn('[alerta ao dono] não enviado:', err.message);
    }
  }

  async function handleOwnerCommand(text) {
    const m = /^#(pausar|retomar)\s+\+?(\d{10,15})/i.exec(text.trim());
    if (!m) return false;
    const [, cmd, phone] = m;
    if (cmd.toLowerCase() === 'pausar') store.pause(phone, 24 * 30);
    else store.resume(phone);
    await whatsapp.sendText(cfg.ownerWhatsapp, `Ok: robô ${cmd.toLowerCase() === 'pausar' ? 'pausado' : 'religado'} para +${phone}.`);
    return true;
  }

  async function handleMessage(msg) {
    if (cfg.ownerWhatsapp && msg.from === cfg.ownerWhatsapp && msg.text?.startsWith('#')) {
      if (await handleOwnerCommand(msg.text)) return;
    }
    if (store.isPaused(msg.from)) {
      log(`[pausado] mensagem de +${msg.from} ignorada (atendente humano)`);
      return;
    }
    log(`[recebida] +${msg.from}: ${msg.text ?? `(${msg.type})`}`);

    // Robô de outra empresa (menu, boas-vindas automáticas): não responde.
    if (msg.text && isAutomatedMessage(msg.text)) {
      await silenceForBot(msg, 'mensagem automática detectada');
      return;
    }
    // Trava de segurança contra loop entre robôs.
    if (tooManyReplies(msg.from)) {
      await silenceForBot(msg, `mais de ${LOOP_MAX_REPLIES} respostas em 3 minutos`);
      return;
    }

    await whatsapp.markReadTyping(msg.id);
    if (!msg.text) {
      await whatsapp.sendText(msg.from, UNSUPPORTED_REPLY);
      return;
    }
    try {
      const reply = await agent.reply({ phone: msg.from, name: msg.name, text: msg.text });
      if (reply && reply.includes(NO_REPLY)) {
        await silenceForBot(msg, 'o Claude identificou mensagem automática');
        return;
      }
      if (reply) {
        (recentReplies.get(msg.from) ?? recentReplies.set(msg.from, []).get(msg.from)).push(Date.now());
        await whatsapp.sendText(msg.from, reply);
        log(`[enviada] +${msg.from}: ${reply.slice(0, 80).replace(/\n/g, ' ')}${reply.length > 80 ? '…' : ''}`);
      }
    } catch (err) {
      console.error('[erro no atendimento]', err.message);
      await whatsapp.sendText(msg.from, ERROR_REPLY).catch(() => {});
    }
  }

  /** Aceita só avisos do nosso número/conta (proteção extra, principalmente no modo Dualhook). */
  function isOurs(item) {
    if (cfg.whatsapp.phoneNumberId && item.phoneNumberId && item.phoneNumberId !== cfg.whatsapp.phoneNumberId) return false;
    if (cfg.whatsapp.wabaId && item.wabaId && item.wabaId !== cfg.whatsapp.wabaId) return false;
    return true;
  }

  function processWebhook(body) {
    if (body?.object !== 'whatsapp_business_account') {
      log('[webhook] ignorado: formato inesperado');
      return;
    }
    const parsed = parseWebhook(body);
    const incoming = parsed.incoming.filter(isOurs);
    const echoes = parsed.echoes.filter(isOurs);
    const dropped = parsed.incoming.length - incoming.length + parsed.echoes.length - echoes.length;
    if (dropped) log(`[webhook] ${dropped} aviso(s) de outro número/conta ignorado(s)`);
    // Coexistência: se a equipe respondeu pelo app, o robô sai de cena com aquele cliente.
    // Vale também para a prospecção: quem a AlphaTech chamou primeiro é atendido pelo dono, não pelo robô.
    for (const e of echoes) {
      store.pause(e.to, Math.max(cfg.handoffHours ?? 12, pauseHours));
      log(`[eco] mensagem enviada pelo app para +${e.to}: robô pausado com este contato`);
    }
    for (const msg of incoming) {
      if (!store.firstTime(msg.id)) continue;
      if (Date.now() - msg.timestamp > 10 * 60 * 1000) {
        log(`[ignorada] mensagem antiga de +${msg.from}`);
        continue;
      }
      store.enqueue(msg.from, () => handleMessage(msg));
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }

    if (url.pathname !== (cfg.webhookPath ?? '/webhook')) {
      res.writeHead(404).end();
      return;
    }

    // Verificação do webhook pela Meta
    if (req.method === 'GET') {
      const ok =
        url.searchParams.get('hub.mode') === 'subscribe' &&
        url.searchParams.get('hub.verify_token') === cfg.whatsapp.verifyToken;
      if (ok) res.writeHead(200, { 'content-type': 'text/plain' }).end(url.searchParams.get('hub.challenge'));
      else res.writeHead(403).end();
      log(ok ? '[webhook] verificado pela Meta' : '[webhook] verificação recusada: token diferente do WHATSAPP_VERIFY_TOKEN');
      return;
    }

    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks);
      if (!validSignature(raw, req.headers['x-hub-signature-256'], cfg.whatsapp.appSecret)) {
        log('[webhook] RECUSADO: assinatura inválida. Confira o WHATSAPP_APP_SECRET no .env (Configurações do app > Básico).');
        res.writeHead(401).end();
        return;
      }
      // Responde 200 na hora (a Meta reenvia se demorar) e processa em seguida.
      res.writeHead(200).end();
      log('[webhook] aviso recebido da Meta');
      try {
        processWebhook(JSON.parse(raw.toString('utf8')));
      } catch (err) {
        console.error('[webhook] corpo inválido', err);
      }
      return;
    }

    res.writeHead(405).end();
  });

  return { server, processWebhook, notifyOwner };
}

// Inicialização real (não roda quando importado pelos testes)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const missing = checkConfig();
  if (missing.length) {
    console.error(`Faltam variáveis de ambiente: ${missing.join(', ')}. Veja o .env.example e o README.`);
    process.exit(1);
  }
  const store = createStore();
  const whatsapp = createWhatsApp(config.whatsapp);
  const claude = createClaude(config.anthropic);
  // Sem Google configurado, o robô continua atendendo e repassa os pedidos de reunião para a equipe.
  const semAgenda = async () => ({
    erro: 'O agendamento automático ainda não está ativo. Pegue nome, serviço de interesse e melhor dia/horário do cliente, diga que a equipe vai confirmar a reunião e use chamar_atendente com esses dados no motivo.',
  });
  const calendar = googleConfigured()
    ? createCalendar(config)
    : { availableSlots: semAgenda, book: semAgenda, upcomingFor: async () => [], cancel: semAgenda };
  let app;
  const agent = createAgent({
    claude,
    calendar,
    store,
    config,
    notifyOwner: (t) => app.notifyOwner(t),
  });
  const log = (t) => console.log(`${new Date().toLocaleTimeString('pt-BR', { timeZone: config.agenda.timezone })} ${t}`);
  app = createApp({ whatsapp, agent, store, cfg: config, log });
  app.server.listen(config.port, () => {
    console.log(`Atendimento AlphaTech no ar na porta ${config.port}. Webhook: /webhook`);
  });
}
