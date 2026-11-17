import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSlots, isoWithOffset, zonedToUtc, isValidSlotStart, formatPtBr } from '../src/time.js';

const cfg = {
  timezone: 'America/Sao_Paulo',
  workDays: [1, 2, 3, 4, 5],
  workStart: 9 * 60,
  workEnd: 18 * 60,
  meetingMinutes: 30,
  minNoticeHours: 2,
  bookingWindowDays: 14,
};

test('converte horário de São Paulo para UTC', () => {
  const d = zonedToUtc(2026, 11, 10, 14 * 60, 'America/Sao_Paulo');
  assert.equal(d.toISOString(), '2026-11-10T17:00:00.000Z');
  assert.equal(isoWithOffset(d, 'America/Sao_Paulo'), '2026-11-10T14:00:00-03:00');
  assert.match(formatPtBr(d, 'America/Sao_Paulo'), /^terça-feira, 10\/11 às 14:00$/);
});

test('respeita antecedência mínima, dias úteis e compromissos', () => {
  // Terça 03/11/2026 às 09:07 em SP (12:07Z)
  const now = new Date('2026-11-03T12:07:00Z');
  const busy = [{ start: '2026-11-03T14:30:00-03:00', end: '2026-11-03T15:30:00-03:00' }];
  const slots = computeSlots({ now, busy, cfg });
  // Primeiro horário: 11:30 (09:07 + 2h = 11:07, próximo da grade)
  assert.equal(slots[0].inicio, '2026-11-03T11:30:00-03:00');
  assert.ok(!slots.some((s) => s.inicio === '2026-11-03T14:30:00-03:00'));
  assert.ok(!slots.some((s) => s.inicio === '2026-11-03T15:00:00-03:00'));
  // no máximo 4 por dia e 4 dias
  const days = new Set(slots.map((s) => s.inicio.slice(0, 10)));
  assert.ok(days.size <= 4);
  for (const d of days) assert.ok(slots.filter((s) => s.inicio.startsWith(d)).length <= 4);
  // nada no fim de semana (07 e 08/11)
  assert.ok(!slots.some((s) => s.inicio.startsWith('2026-11-07') || s.inicio.startsWith('2026-11-08')));
});

test('a partir de uma data específica', () => {
  const now = new Date('2026-11-03T12:07:00Z');
  const slots = computeSlots({ now, busy: [], cfg, fromDate: '2026-11-09' });
  assert.equal(slots[0].inicio, '2026-11-09T09:00:00-03:00');
});

test('valida início fora do expediente ou da grade', () => {
  assert.equal(isValidSlotStart(new Date('2026-11-10T14:00:00-03:00'), cfg), true);
  assert.equal(isValidSlotStart(new Date('2026-11-10T14:10:00-03:00'), cfg), false);
  assert.equal(isValidSlotStart(new Date('2026-11-10T17:45:00-03:00'), cfg), false);
  assert.equal(isValidSlotStart(new Date('2026-11-08T10:00:00-03:00'), cfg), false); // domingo
});
