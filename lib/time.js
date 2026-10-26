'use strict';

// Date/time helpers for flow cards. Homey `date` args are 'dd-mm-yyyy' strings and `time` args are
// 'HH:mm' strings in the Homey timezone; TTLock wants ms since the epoch.

function validZone(tz) {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch (err) {
    return 'UTC';
  }
}

// Wall-clock parts of `ms` in the zone.
function zonedParts(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: validZone(tz),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const out = {};
  for (const part of parts) out[part.type] = part.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

// Zone offset from UTC in ms at the instant `ms`.
function zoneOffset(ms, tz) {
  const p = zonedParts(ms, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

// 'YYYY-MM-DD HH:mm:ss' in the zone (UTC when the zone is missing or unknown).
function formatDateTime(ms, tz) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  const p = zonedParts(value, tz);
  const two = n => String(n).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}:${two(p.second)}`;
}

function parseDate(text) {
  const match = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(text || '').trim());
  if (!match) throw new Error(`Invalid date "${text}", expected dd-mm-yyyy`);
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`Invalid date "${text}"`);
  }
  return { year, month, day };
}

function parseTime(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`Invalid time "${text}", expected HH:mm`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

// dd-mm-yyyy + HH:mm in the zone -> ms epoch. Re-checks the offset at the result so
// times around a DST change land on the right side.
function toEpoch(dateText, timeText, tz) {
  const { year, month, day } = parseDate(dateText);
  const { hour, minute } = parseTime(timeText);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let result = guess - zoneOffset(guess, tz);
  const second = guess - zoneOffset(result, tz);
  if (second !== result) result = second;
  return result;
}

// Optional date + time pair -> ms epoch, or 0 when no date is given (TTLock: 0 = no limit).
// A date without a time uses defaultTime.
function optionalEpoch(dateText, timeText, tz, defaultTime) {
  if (!dateText) return 0;
  return toEpoch(dateText, timeText || defaultTime, tz);
}

module.exports = {
  formatDateTime, parseDate, parseTime, toEpoch, optionalEpoch, zoneOffset,
};
