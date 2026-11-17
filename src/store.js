// Memória das conversas, pausas e mensagens já processadas.
// Fica na memória do servidor: se ele reiniciar, o histórico recente se perde (as reuniões ficam salvas na Google Agenda).

const HISTORY_TTL_MS = 24 * 3600 * 1000;
const MAX_TURNS = 40;

export function createStore({ now = () => Date.now() } = {}) {
  const histories = new Map(); // phone -> { messages, updatedAt }
  const pausedUntil = new Map(); // phone -> timestamp
  const seen = new Map(); // messageId -> timestamp
  const queues = new Map(); // phone -> Promise

  return {
    history(phone) {
      const h = histories.get(phone);
      if (!h || now() - h.updatedAt > HISTORY_TTL_MS) return [];
      return h.messages;
    },
    saveHistory(phone, messages) {
      histories.set(phone, { messages: trimHistory(messages, MAX_TURNS), updatedAt: now() });
    },
    clearHistory(phone) {
      histories.delete(phone);
    },

    pause(phone, hours) {
      pausedUntil.set(phone, now() + hours * 3600 * 1000);
    },
    resume(phone) {
      pausedUntil.delete(phone);
    },
    isPaused(phone) {
      const until = pausedUntil.get(phone);
      if (!until) return false;
      if (now() > until) {
        pausedUntil.delete(phone);
        return false;
      }
      return true;
    },

    /** true na primeira vez que vê o id; a Meta às vezes reenvia o mesmo webhook. */
    firstTime(messageId) {
      if (seen.has(messageId)) return false;
      seen.set(messageId, now());
      if (seen.size > 5000) {
        const cutoff = now() - 3600 * 1000;
        for (const [id, t] of seen) if (t < cutoff) seen.delete(id);
      }
      return true;
    },

    /** Processa as mensagens de um mesmo cliente em fila, uma de cada vez. */
    enqueue(phone, task) {
      const prev = queues.get(phone) ?? Promise.resolve();
      const next = prev.then(task, task).finally(() => {
        if (queues.get(phone) === next) queues.delete(phone);
      });
      queues.set(phone, next);
      return next;
    },
  };
}

/**
 * Mantém só os últimos turnos, cortando sempre no início de uma mensagem do cliente
 * (assim nunca separa um pedido de ferramenta da sua resposta).
 */
export function trimHistory(messages, maxTurns) {
  const starts = [];
  messages.forEach((m, i) => {
    if (m.role === 'user' && typeof m.content === 'string') starts.push(i);
  });
  if (starts.length <= maxTurns) return messages;
  return messages.slice(starts[starts.length - maxTurns]);
}
