// Google Agenda: consultar horários livres, criar reunião com Google Meet, listar e cancelar.
// Usa a API REST diretamente (sem googleapis), autenticando com o refresh token do dono da agenda.

import { computeSlots, isValidSlotStart, formatPtBr, isoWithOffset } from './time.js';

const API = 'https://www.googleapis.com/calendar/v3';

export function createCalendar({ google, agenda }, { fetchImpl = fetch, now = () => new Date() } = {}) {
  let cached = { token: null, exp: 0 };

  async function accessToken() {
    if (cached.token && Date.now() < cached.exp - 60000) return cached.token;
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: google.clientId,
        client_secret: google.clientSecret,
        refresh_token: google.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Google OAuth falhou: ${res.status} ${JSON.stringify(data)}`);
    cached = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
    return cached.token;
  }

  async function api(method, path, body) {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Google Agenda ${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
    return data;
  }

  async function busyBetween(start, end) {
    const data = await api('POST', '/freeBusy', {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      timeZone: agenda.timezone,
      items: [{ id: google.calendarId }],
    });
    const cal = data.calendars?.[google.calendarId] ?? Object.values(data.calendars ?? {})[0];
    if (cal?.errors?.length) throw new Error(`freeBusy: ${JSON.stringify(cal.errors)}`);
    return cal?.busy ?? [];
  }

  const calId = encodeURIComponent(google.calendarId);

  return {
    /** Horários livres a partir de hoje (ou de uma data YYYY-MM-DD). */
    async availableSlots({ fromDate, days } = {}) {
      const n = now();
      const end = new Date(n.getTime() + (agenda.bookingWindowDays + 1) * 86400000);
      const busy = await busyBetween(n, end);
      return computeSlots({ now: n, busy, cfg: agenda, fromDate, days });
    },

    /** Cria a reunião com link do Meet. Confere de novo se o horário está livre. */
    async book({ start, name, phone, email, service, summary }) {
      const startDate = new Date(start);
      if (Number.isNaN(startDate.getTime())) return { ok: false, erro: 'Horário inválido.' };
      const n = now();
      if (startDate.getTime() < n.getTime() + agenda.minNoticeHours * 3600000) {
        return { ok: false, erro: 'Esse horário já passou ou está muito em cima. Ofereça outro.' };
      }
      if (startDate.getTime() > n.getTime() + agenda.bookingWindowDays * 86400000) {
        return { ok: false, erro: 'Esse horário está além da janela de agendamento. Ofereça outro.' };
      }
      if (!isValidSlotStart(startDate, agenda)) {
        return { ok: false, erro: 'Esse horário está fora do expediente. Consulte os horários disponíveis.' };
      }
      const endDate = new Date(startDate.getTime() + agenda.meetingMinutes * 60000);
      const busy = await busyBetween(startDate, endDate);
      if (busy.length) return { ok: false, erro: 'Esse horário acabou de ser ocupado. Consulte os horários de novo.' };

      const sendUpdates = email ? 'all' : 'none';
      const event = await api('POST', `/calendars/${calId}/events?conferenceDataVersion=1&sendUpdates=${sendUpdates}`, {
        summary: `Orçamento AlphaTech · ${name}${service ? ` · ${service}` : ''}`,
        description: [
          `Cliente: ${name}`,
          `WhatsApp: +${phone}`,
          email ? `E-mail: ${email}` : null,
          service ? `Interesse: ${service}` : null,
          summary ? `\nResumo da necessidade:\n${summary}` : null,
          '\nAgendado automaticamente pelo atendimento do WhatsApp.',
        ]
          .filter(Boolean)
          .join('\n'),
        start: { dateTime: isoWithOffset(startDate, agenda.timezone), timeZone: agenda.timezone },
        end: { dateTime: isoWithOffset(endDate, agenda.timezone), timeZone: agenda.timezone },
        attendees: email ? [{ email, displayName: name }] : undefined,
        conferenceData: {
          createRequest: { requestId: `wa-${phone}-${startDate.getTime()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } },
        },
        extendedProperties: { private: { whatsapp: phone, origem: 'bot-whatsapp' } },
        reminders: { useDefault: true },
      });
      const meet =
        event.hangoutLink ?? event.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ?? null;
      return {
        ok: true,
        evento_id: event.id,
        quando: formatPtBr(startDate, agenda.timezone),
        duracao_min: agenda.meetingMinutes,
        link_meet: meet,
        convite_por_email: Boolean(email),
      };
    },

    /** Próximas reuniões marcadas por este número de WhatsApp. */
    async upcomingFor(phone) {
      const q = new URLSearchParams({
        privateExtendedProperty: `whatsapp=${phone}`,
        timeMin: now().toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '5',
      });
      const data = await api('GET', `/calendars/${calId}/events?${q}`);
      return (data.items ?? [])
        .filter((e) => e.status !== 'cancelled')
        .map((e) => ({
          evento_id: e.id,
          quando: formatPtBr(new Date(e.start.dateTime ?? e.start.date), agenda.timezone),
          link_meet: e.hangoutLink ?? null,
        }));
    },

    /** Cancela, mas só se a reunião pertencer a este número. */
    async cancel(eventId, phone) {
      const ev = await api('GET', `/calendars/${calId}/events/${encodeURIComponent(eventId)}`).catch(() => null);
      if (!ev || ev.extendedProperties?.private?.whatsapp !== phone) {
        return { ok: false, erro: 'Reunião não encontrada para este número.' };
      }
      await api('DELETE', `/calendars/${calId}/events/${encodeURIComponent(eventId)}?sendUpdates=all`);
      return { ok: true, cancelada: formatPtBr(new Date(ev.start.dateTime), agenda.timezone) };
    },
  };
}
