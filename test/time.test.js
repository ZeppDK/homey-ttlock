'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  formatDateTime, parseDate, parseTime, toEpoch, optionalEpoch,
} = require('../lib/time');

test('toEpoch: summer and winter time in Europe/Copenhagen', () => {
  assert.strictEqual(toEpoch('01-07-2026', '12:00', 'Europe/Copenhagen'), Date.UTC(2026, 6, 1, 10, 0)); // UTC+2
  assert.strictEqual(toEpoch('15-01-2026', '12:00', 'Europe/Copenhagen'), Date.UTC(2026, 0, 15, 11, 0)); // UTC+1
  assert.strictEqual(toEpoch('01-07-2026', '12:00', 'America/New_York'), Date.UTC(2026, 6, 1, 16, 0)); // UTC-4
});

test('toEpoch: DST change days', () => {
  // Copenhagen: clocks go forward 2026-03-29 02:00 -> 03:00, back 2026-10-25 03:00 -> 02:00
  assert.strictEqual(toEpoch('29-03-2026', '01:30', 'Europe/Copenhagen'), Date.UTC(2026, 2, 29, 0, 30));
  assert.strictEqual(toEpoch('29-03-2026', '12:00', 'Europe/Copenhagen'), Date.UTC(2026, 2, 29, 10, 0));
  assert.strictEqual(toEpoch('25-10-2026', '12:00', 'Europe/Copenhagen'), Date.UTC(2026, 9, 25, 11, 0));
});

test('toEpoch: missing or unknown timezone means UTC', () => {
  assert.strictEqual(toEpoch('01-02-2026', '08:30'), Date.UTC(2026, 1, 1, 8, 30));
  assert.strictEqual(toEpoch('01-02-2026', '08:30', 'Not/AZone'), Date.UTC(2026, 1, 1, 8, 30));
});

test('toEpoch round trips through formatDateTime', () => {
  const ms = toEpoch('26-10-2026', '14:05', 'Europe/Copenhagen');
  assert.strictEqual(formatDateTime(ms, 'Europe/Copenhagen'), '2026-10-26 14:05:00');
});

test('parseDate and parseTime reject bad input', () => {
  assert.deepStrictEqual(parseDate('5-3-2026'), { year: 2026, month: 3, day: 5 });
  assert.throws(() => parseDate('2026-03-05'), /Invalid date/);
  assert.throws(() => parseDate('31-02-2026'), /Invalid date/);
  assert.throws(() => parseDate(''), /Invalid date/);
  assert.deepStrictEqual(parseTime('9:05'), { hour: 9, minute: 5 });
  assert.throws(() => parseTime('24:00'), /Invalid time/);
  assert.throws(() => parseTime('12:60'), /Invalid time/);
  assert.throws(() => parseTime(undefined), /Invalid time/);
});

test('optionalEpoch: no date means 0, date without time uses the default time', () => {
  assert.strictEqual(optionalEpoch('', '10:00', 'UTC', '23:59'), 0);
  assert.strictEqual(optionalEpoch(undefined, undefined, 'UTC', '23:59'), 0);
  assert.strictEqual(optionalEpoch('01-02-2026', undefined, 'UTC', '23:59'), Date.UTC(2026, 1, 1, 23, 59));
  assert.strictEqual(optionalEpoch('01-02-2026', '08:00', 'UTC', '23:59'), Date.UTC(2026, 1, 1, 8, 0));
});

test('formatDateTime: empty for missing values, midnight is 00 not 24', () => {
  assert.strictEqual(formatDateTime(0, 'UTC'), '');
  assert.strictEqual(formatDateTime(undefined, 'UTC'), '');
  assert.strictEqual(formatDateTime(Date.UTC(2026, 0, 1, 0, 0, 5), 'UTC'), '2026-01-01 00:00:05');
});
