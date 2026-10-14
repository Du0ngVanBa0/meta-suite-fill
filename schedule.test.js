const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePattern, buildSchedule } = require('./public/schedule');

test('evening slots roll into next morning with explicit or inferred day break', () => {
  const explicit = parsePattern('19,21,23 | 7,9');
  assert.equal(explicit.pattern, '19:00, 21:00, 23:00 | 07:00, 09:00');
  assert.equal(parsePattern('19,21,23,7,9').pattern, explicit.pattern);
  assert.deepEqual(buildSchedule('2026-10-12', explicit, 6), [
    { date: '2026-10-12', time: '19:00' },
    { date: '2026-10-12', time: '21:00' },
    { date: '2026-10-12', time: '23:00' },
    { date: '2026-10-13', time: '07:00' },
    { date: '2026-10-13', time: '09:00' },
    { date: '2026-10-14', time: '19:00' },
  ]);
});

test('calendar rollover and invalid patterns', () => {
  assert.deepEqual(buildSchedule('2026-12-31', '23 | 7h30', 2), [
    { date: '2026-12-31', time: '23:00' },
    { date: '2027-01-01', time: '07:30' },
  ]);
  assert.throws(() => parsePattern('19 | | 7'));
  assert.throws(() => parsePattern('25'));
  assert.throws(() => buildSchedule('2026-02-30', '19', 1));
});
