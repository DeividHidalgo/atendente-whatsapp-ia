// Conversa com o atendente pelo terminal, sem WhatsApp. Ótimo para ajustar o prompt antes de ligar na Meta.
// Uso: `npm run simular`. Precisa só do ANTHROPIC_API_KEY.
// Se as variáveis do Google estiverem preenchidas, usa a agenda real; senão, uma agenda de mentira.

import readline from 'node:readline/promises';
import { config } from '../src/config.js';
import { createClaude } from '../src/claude.js';
import { createCalendar } from '../src/calendar.js';
import { createStore } from '../src/store.js';
import { createAgent } from '../src/agent.js';
import { computeSlots, formatPtBr } from '../src/time.js';

// No simulador, mostra quanto veio do cache a cada chamada.
if (!process.env.LOG_CACHE) process.env.LOG_CACHE = '1';

if (!config.anthropic.apiKey) {
  console.error('Preencha ANTHROPIC_API_KEY no .env.');
  process.exit(1);
}

const useRealCalendar = Boolean(config.google.clientId && config.google.clientSecret && config.google.refreshToken);

const fakeCalendar = {
  booked: [],
  async availableSlots({ fromDate } = {}) {
    const busy = this.booked.map((b) => ({ start: b.start, end: new Date(new Date(b.start).getTime() + config.agenda.meetingMinutes * 60000) }));
    return computeSlots({ now: new Date(), busy, cfg: config.agenda, fromDate });
  },
  async book({ start, name }) {
    const id = `fake-${this.booked.length + 1}`;
    this.booked.push({ id, start, name });
    return { ok: true, evento_id: id, quando: formatPtBr(new Date(start), config.agenda.timezone), duracao_min: config.agenda.meetingMinutes, link_meet: 'https://meet.google.com/abc-defg-hij (simulado)' };
  },
  async upcomingFor() {
    return this.booked.map((b) => ({ evento_id: b.id, quando: formatPtBr(new Date(b.start), config.agenda.timezone) }));
  },
  async cancel(id) {
    const i = this.booked.findIndex((b) => b.id === id);
    if (i < 0) return { ok: false, erro: 'Reunião não encontrada.' };
    const [b] = this.booked.splice(i, 1);
    return { ok: true, cancelada: formatPtBr(new Date(b.start), config.agenda.timezone) };
  },
};

const store = createStore();
const agent = createAgent({
  claude: createClaude(config.anthropic),
  calendar: useRealCalendar ? createCalendar(config) : fakeCalendar,
  store,
  config,
  notifyOwner: async (t) => console.log(`\n[alerta para o dono]\n${t}\n`),
});

console.log(`Simulador do atendimento AlphaTech (agenda ${useRealCalendar ? 'REAL do Google' : 'simulada'}).`);
console.log(`Modelo: ${config.anthropic.model}`);
console.log('Escreva como se fosse um cliente. "sair" encerra.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const phone = '5511999999999';
for (;;) {
  const text = (await rl.question('Cliente: ')).trim();
  if (!text) continue;
  if (text.toLowerCase() === 'sair') break;
  if (store.isPaused(phone)) {
    console.log('(robô pausado: um atendente humano assumiria aqui)\n');
    continue;
  }
  try {
    const reply = await agent.reply({ phone, name: 'Cliente Teste', text });
    console.log(`\nAlphaTech: ${reply}\n`);
  } catch (err) {
    console.error(`\n[erro] ${err.message}\n(O simulador continua aberto. Mande o print deste erro se ele se repetir.)\n`);
  }
}
rl.close();
