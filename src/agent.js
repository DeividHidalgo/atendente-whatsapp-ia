// O "cérebro" do atendimento: conversa com o Claude e executa as ferramentas (agenda e atendente humano).

import { buildSystemPrompt, TOOLS } from './prompt.js';
import { nowDescription } from './time.js';

const MAX_STEPS = 8;

/**
 * Remove os blocos de raciocínio ("thinking") das respostas antigas antes de guardar o histórico.
 * Eles ficam presos às instruções do momento em que foram gerados (que incluem a data/hora atual),
 * e a API recusa reenviá-los numa conversa com instruções diferentes.
 */
export function stripThinking(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const content = m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
      out.push({ ...m, content: content.length ? content : [{ type: 'text', text: '...' }] });
    } else {
      out.push(m);
    }
  }
  return out;
}

export function createAgent({ claude, calendar, store, notifyOwner, config }) {
  async function runTool(name, input, ctx) {
    switch (name) {
      case 'consultar_horarios_disponiveis': {
        const slots = await calendar.availableSlots({ fromDate: input.a_partir_de });
        if (!Array.isArray(slots)) return slots;
        return slots.length
          ? { horarios: slots }
          : { horarios: [], aviso: 'Sem horários livres nesse período. Sugira outra data ou chame um atendente.' };
      }
      case 'agendar_reuniao': {
        const result = await calendar.book({
          start: input.inicio,
          name: input.nome,
          phone: ctx.phone,
          email: input.email,
          service: input.servico_interesse,
          summary: input.resumo_necessidade,
        });
        if (result.ok) {
          await notifyOwner(
            `📅 *Nova reunião de orçamento*\n${input.nome} (+${ctx.phone})\n${result.quando}\nInteresse: ${input.servico_interesse}\n${input.resumo_necessidade}`,
          );
        }
        return result;
      }
      case 'consultar_minhas_reunioes':
        return { reunioes: await calendar.upcomingFor(ctx.phone) };
      case 'cancelar_reuniao': {
        const result = await calendar.cancel(input.evento_id, ctx.phone);
        if (result.ok) await notifyOwner(`❌ Reunião cancelada pelo cliente +${ctx.phone}: ${result.cancelada}`);
        return result;
      }
      case 'chamar_atendente': {
        store.pause(ctx.phone, config.handoffHours);
        await notifyOwner(
          `🙋 *Cliente pediu atendimento humano*\n${ctx.name ?? 'Cliente'} (+${ctx.phone})\nMotivo: ${input.motivo}\nhttps://wa.me/${ctx.phone}\n\nO robô ficou pausado com este cliente por ${config.handoffHours}h. Para religar: #retomar ${ctx.phone}`,
        );
        return { ok: true, robo_pausado_por_horas: config.handoffHours };
      }
      default:
        return { erro: `Ferramenta desconhecida: ${name}` };
    }
  }

  return {
    /** Recebe a mensagem do cliente e devolve o texto da resposta. */
    async reply({ phone, name, text, now = new Date() }) {
      const ctx = { phone, name };
      const messages = [...store.history(phone), { role: 'user', content: text }];
      const system = buildSystemPrompt({
        nowText: nowDescription(now, config.agenda.timezone),
        meetingMinutes: config.agenda.meetingMinutes,
        customerName: name,
        phone,
      });

      for (let step = 0; step < MAX_STEPS; step++) {
        const res = await claude.create({ system, messages, tools: TOOLS });
        messages.push({ role: 'assistant', content: res.content });

        const toolUses = res.content.filter((b) => b.type === 'tool_use');
        if (res.stop_reason !== 'tool_use' || toolUses.length === 0) {
          store.saveHistory(phone, stripThinking(messages));
          return res.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
            .trim();
        }

        const results = [];
        for (const tu of toolUses) {
          let output;
          try {
            output = await runTool(tu.name, tu.input ?? {}, ctx);
          } catch (err) {
            console.error(`[ferramenta ${tu.name}]`, err);
            output = { erro: 'Falha técnica ao acessar a agenda. Peça desculpas e ofereça chamar um atendente.' };
          }
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(output) });
        }
        messages.push({ role: 'user', content: results });
      }

      // Passou do limite de passos: não salva o meio do caminho, chama a equipe.
      const fallback = 'Desculpe, tive um problema para concluir isso agora. Vou chamar alguém da equipe para continuar com você.';
      store.saveHistory(phone, [...store.history(phone), { role: 'user', content: text }, { role: 'assistant', content: fallback }]);
      await runTool('chamar_atendente', { motivo: 'O robô não conseguiu concluir o atendimento sozinho.' }, ctx);
      return fallback;
    },
  };
}
