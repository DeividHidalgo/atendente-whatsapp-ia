// Utilidades de data/hora com fuso horário, sem bibliotecas externas.

const partsCache = new Map();

function formatter(tz) {
  if (!partsCache.has(tz)) {
    partsCache.set(
      tz,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
      }),
    );
  }
  return partsCache.get(tz);
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Partes da data vistas no fuso `tz`. */
export function zonedParts(date, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(date).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    mi: Number(p.minute),
    s: Number(p.second),
    weekday: WEEKDAYS[p.weekday],
  };
}

/** Diferença (ms) entre o horário local do fuso e o UTC naquele instante. */
export function tzOffsetMs(date, tz) {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - date.getTime()) / 60000) * 60000;
}

/** Converte "dia D às X minutos do dia, no fuso tz" para um Date (UTC). */
export function zonedToUtc(y, mo, d, minutesOfDay, tz) {
  const guess = Date.UTC(y, mo - 1, d, 0, minutesOfDay);
  const off1 = tzOffsetMs(new Date(guess), tz);
  let t = guess - off1;
  const off2 = tzOffsetMs(new Date(t), tz);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

const pad = (n) => String(n).padStart(2, '0');

/** ISO 8601 com o deslocamento do fuso, ex.: 2026-11-10T14:00:00-03:00 */
export function isoWithOffset(date, tz) {
  const p = zonedParts(date, tz);
  const off = tzOffsetMs(date, tz) / 60000;
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Texto amigável em português, ex.: "terça-feira, 10/11 às 14:00" */
export function formatPtBr(date, tz) {
  const weekday = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'long' }).format(date);
  const p = zonedParts(date, tz);
  return `${weekday}, ${pad(p.d)}/${pad(p.mo)} às ${pad(p.h)}:${pad(p.mi)}`;
}

/** Data e hora atual por extenso, para o Claude saber "quando é hoje". */
export function nowDescription(date, tz) {
  const txt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz,
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
  const p = zonedParts(date, tz);
  return `${txt} (${p.y}-${pad(p.mo)}-${pad(p.d)}, fuso ${tz})`;
}

/**
 * Calcula os horários livres para reunião.
 * Função pura: recebe "agora", os períodos ocupados e a configuração da agenda.
 */
export function computeSlots({ now, busy, cfg, fromDate, days, maxPerDay = 4, maxDays = 4 }) {
  const tz = cfg.timezone;
  const durMs = cfg.meetingMinutes * 60000;
  const earliest = now.getTime() + cfg.minNoticeHours * 3600000;
  const busyMs = busy.map((b) => [new Date(b.start).getTime(), new Date(b.end).getTime()]);

  let base = zonedParts(now, tz);
  if (fromDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fromDate);
    if (m) base = { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
  }
  const window = Math.min(days ?? cfg.bookingWindowDays, cfg.bookingWindowDays);
  const lastAllowed = now.getTime() + cfg.bookingWindowDays * 86400000;

  const result = [];
  let daysWithSlots = 0;
  for (let i = 0; i < window && daysWithSlots < maxDays; i++) {
    const cal = new Date(Date.UTC(base.y, base.mo - 1, base.d + i));
    if (!cfg.workDays.includes(cal.getUTCDay())) continue;
    let perDay = 0;
    for (let m = cfg.workStart; m + cfg.meetingMinutes <= cfg.workEnd && perDay < maxPerDay; m += cfg.meetingMinutes) {
      const start = zonedToUtc(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate(), m, tz);
      const s = start.getTime();
      const e = s + durMs;
      if (s < earliest || s > lastAllowed) continue;
      if (busyMs.some(([bs, be]) => s < be && e > bs)) continue;
      result.push({ inicio: isoWithOffset(start, tz), rotulo: formatPtBr(start, tz) });
      perDay++;
    }
    if (perDay > 0) daysWithSlots++;
  }
  return result;
}

/** Verifica se um início pedido cai num horário válido da agenda (dia útil, expediente, grade). */
export function isValidSlotStart(date, cfg) {
  const p = zonedParts(date, cfg.timezone);
  if (!cfg.workDays.includes(p.weekday)) return false;
  const m = p.h * 60 + p.mi;
  if (m < cfg.workStart || m + cfg.meetingMinutes > cfg.workEnd) return false;
  return (m - cfg.workStart) % cfg.meetingMinutes === 0;
}
