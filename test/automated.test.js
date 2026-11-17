import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { isAutomatedMessage } from '../src/automated.js';
import { createApp } from '../src/index.js';
import { createStore } from '../src/store.js';

// Exemplos de respostas automáticas de outras empresas (nomes fictícios)
const ROBOS = [
  'Olá! Seja bem-vindo à Odonto Exemplo.           Meu nome é Karen, como posso te ajudar?',
  'Olá! Será um prazer te atender!  Antes de iniciar seu atendimento, uma perguntinha rápida: Você já é nosso paciente?\n\nSim, já sou paciente!\nAinda não sou paciente!',
  'Bem-vindo à Clínica Exemplo Saúde - Centro \n\nPara agilizar seu atendimento, digite uma das opções abaixo:\n1 - Fisioterapia Especializada (Ortopédica, Pélvica e Respiratória)\n2 - Especialidades',
  'Agradecemos o contato. Um representante falará com você em breve.',
  'Olá! 😊 Seja bem-vindo à Clínica Sorriso Exemplo.\nÉ um prazer poder atender você. 🦷✨\nComo posso ajudar você hoje?',
  'Você já é nosso cliente?👇\n1 - Sim\n2 - Não',
];

const PESSOAS = [
  'oi',
  'Olá, vi o anúncio de vocês no Instagram. Quanto custa um site?',
  'Tenho uma clínica de fisioterapia e queria entender como funciona o agendamento automático',
  'Pode ser amanhã às 10h?',
  'Quero falar com uma pessoa',
  'Opções: prefiro terça ou quarta, qual tem horário?',
  'Obrigado pelo contato, vou ver com meu sócio e te retorno',
];

test('reconhece respostas automáticas de robôs de outras empresas', () => {
  for (const t of ROBOS) assert.equal(isAutomatedMessage(t), true, t);
});

test('não confunde mensagens de pessoas com robôs', () => {
  for (const t of PESSOAS) assert.equal(isAutomatedMessage(t), false, t);
});

const cfg = { handoffHours: 12, ownerFirstPauseHours: 72, ownerWhatsapp: '5515900000000', whatsapp: {} };
const msg = (from, text) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: crypto.randomUUID(), from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }],
});
const echo = (to) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'smb_message_echoes', value: { message_echoes: [{ id: crypto.randomUUID(), to }] } }] }],
});
const settle = () => new Promise((r) => setTimeout(r, 30));

function setup() {
  const sent = [];
  const store = createStore();
  const whatsapp = { sendText: async (to, text) => sent.push({ to, text }), markReadTyping: async () => {} };
  let agentCalls = 0;
  const agent = { reply: async () => (agentCalls++, 'Resposta do robô') };
  const app = createApp({ whatsapp, agent, store, cfg });
  return { app, sent, store, calls: () => agentCalls };
}

test('robô da clínica responde: o nosso fica em silêncio e avisa só o dono', async () => {
  const { app, sent, store, calls } = setup();
  app.processWebhook(msg('5515900001111', ROBOS[2]));
  await settle();
  assert.equal(calls(), 0);
  assert.ok(sent.every((s) => s.to === cfg.ownerWhatsapp));
  assert.equal(store.isPaused('5515900001111'), true);
  // Depois disso, nem uma pergunta normal desse contato é respondida pelo robô (o dono assume).
  app.processWebhook(msg('5515900001111', 'oi, pode explicar melhor?'));
  await settle();
  assert.equal(calls(), 0);
});

test('mensagem enviada pelo app (prospecção) pausa o robô com o contato por 72h', async () => {
  const { app, store, calls } = setup();
  app.processWebhook(echo('5515900002222'));
  app.processWebhook(msg('5515900002222', 'Oi, quero saber mais'));
  await settle();
  assert.equal(calls(), 0);
  assert.equal(store.isPaused('5515900002222'), true);
});

test('Claude devolve [SEM_RESPOSTA]: nada é enviado ao contato', async () => {
  const sent = [];
  const store = createStore();
  const whatsapp = { sendText: async (to, text) => sent.push({ to, text }), markReadTyping: async () => {} };
  const app = createApp({ whatsapp, agent: { reply: async () => '[SEM_RESPOSTA]' }, store, cfg });
  app.processWebhook(msg('5515999990000', 'Atendimento: aguarde, em instantes daremos sequência'));
  await settle();
  assert.ok(sent.every((s) => s.to === cfg.ownerWhatsapp));
  assert.equal(store.isPaused('5515999990000'), true);
});

test('trava de loop: depois de 5 respostas em 3 minutos o robô para', async () => {
  const { app, store, calls } = setup();
  for (let i = 0; i < 7; i++) {
    app.processWebhook(msg('5515988887777', `pergunta ${i}`));
    await settle();
  }
  assert.equal(calls(), 5);
  assert.equal(store.isPaused('5515988887777'), true);
});

test('cliente normal continua sendo atendido', async () => {
  const { app, sent, calls } = setup();
  app.processWebhook(msg('5515911112222', 'Olá, quanto custa um site?'));
  await settle();
  assert.equal(calls(), 1);
  assert.deepEqual(sent, [{ to: '5515911112222', text: 'Resposta do robô' }]);
});
