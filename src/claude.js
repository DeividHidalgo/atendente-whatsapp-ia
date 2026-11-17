// Cliente mínimo da API de Mensagens da Anthropic (Claude), com novas tentativas em caso de sobrecarga
// e cache de prompt (o texto fixo e o histórico já enviado saem com desconto nas chamadas seguintes).

/**
 * Marca o último bloco da conversa como ponto de cache, para que o histórico já enviado
 * seja reaproveitado na próxima chamada (dentro do mesmo atendimento).
 * Não altera o array original.
 */
export function withConversationCache(messages) {
  if (!messages.length) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  const blocks =
    typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.map((b) => ({ ...b }));
  const i = blocks.length - 1;
  if (blocks[i].type !== 'thinking' && blocks[i].type !== 'redacted_thinking') {
    blocks[i] = { ...blocks[i], cache_control: { type: 'ephemeral' } };
  }
  out[out.length - 1] = { ...last, content: blocks };
  return out;
}

export function createClaude(
  { apiKey, model, maxTokens },
  { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onUsage = logUsage } = {},
) {
  return {
    async create({ system, messages, tools }) {
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: withConversationCache(messages), tools }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok) {
          if (data?.usage) onUsage(data.usage);
          return data;
        }
        lastErr = new Error(`Claude API ${res.status}: ${JSON.stringify(data)}`);
        if (![429, 500, 502, 503, 529].includes(res.status)) break;
        await sleep(1000 * 2 ** attempt);
      }
      throw lastErr;
    },
  };
}

/** Mostra no log quanto do texto veio do cache (só quando a variável LOG_CACHE=1). */
function logUsage(u) {
  if (process.env.LOG_CACHE !== '1') return;
  console.log(
    `[tokens] novos: ${u.input_tokens ?? 0} · gravados no cache: ${u.cache_creation_input_tokens ?? 0} · lidos do cache: ${u.cache_read_input_tokens ?? 0} · resposta: ${u.output_tokens ?? 0}`,
  );
}
