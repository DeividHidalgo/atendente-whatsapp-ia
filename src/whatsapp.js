// WhatsApp Cloud API (oficial da Meta): enviar mensagens, marcar como lida, validar assinatura e ler o webhook.

import crypto from 'node:crypto';

export function createWhatsApp(
  { token, phoneNumberId, graphVersion, apiBase = 'https://graph.facebook.com' },
  { fetchImpl = fetch } = {},
) {
  // apiBase: graph.facebook.com (Meta direto) ou api.dualhook.com (coexistência). O formato é o mesmo.
  const url = `${apiBase}/${graphVersion}/${phoneNumberId}/messages`;

  async function post(body) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }

  return {
    async sendText(to, text) {
      for (const part of splitMessage(text)) {
        await post({ recipient_type: 'individual', to, type: 'text', text: { body: part, preview_url: true } });
      }
    },
    /** Marca como lida e mostra "digitando..." enquanto o Claude pensa. Falha aqui não é grave. */
    async markReadTyping(messageId) {
      try {
        await post({ status: 'read', message_id: messageId, typing_indicator: { type: 'text' } });
      } catch (err) {
        console.warn('[whatsapp] não foi possível marcar como lida:', err.message);
      }
    },
  };
}

/** O WhatsApp aceita até 4096 caracteres por mensagem; quebra em parágrafos se passar. */
export function splitMessage(text, limit = 4000) {
  const clean = String(text ?? '').trim();
  if (!clean) return [];
  if (clean.length <= limit) return [clean];
  const parts = [];
  let current = '';
  for (const para of clean.split(/\n{2,}/)) {
    if ((current + '\n\n' + para).length > limit && current) {
      parts.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${para}` : para;
    while (current.length > limit) {
      parts.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** Confere o cabeçalho X-Hub-Signature-256 enviado pela Meta. */
export function validSignature(rawBody, header, appSecret) {
  if (!appSecret) return true;
  if (!header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const got = header.slice(7);
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/**
 * Extrai do corpo do webhook o que interessa:
 * - incoming: mensagens recebidas de clientes
 * - echoes: mensagens que a equipe enviou pelo app WhatsApp Business (modo coexistência)
 */
export function parseWebhook(body) {
  const incoming = [];
  const echoes = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const meta = { wabaId: entry.id ?? null, phoneNumberId: v.metadata?.phone_number_id ?? null };
      if (change.field === 'messages') {
        const names = Object.fromEntries((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
        for (const m of v.messages ?? []) {
          incoming.push({
            id: m.id,
            from: m.from,
            name: names[m.from] ?? null,
            type: m.type,
            text: messageText(m),
            timestamp: Number(m.timestamp) * 1000,
            ...meta,
          });
        }
      } else if (change.field === 'smb_message_echoes') {
        for (const m of v.message_echoes ?? []) echoes.push({ to: m.to, id: m.id, ...meta });
      }
    }
  }
  return { incoming, echoes };
}

function messageText(m) {
  switch (m.type) {
    case 'text':
      return m.text?.body ?? '';
    case 'button':
      return m.button?.text ?? '';
    case 'interactive':
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '';
    case 'image':
    case 'video':
    case 'document':
      return m[m.type]?.caption ?? null;
    default:
      return null;
  }
}
