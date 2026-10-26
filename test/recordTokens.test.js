'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  describeRecord, METHODS, normalizeMethod, recordFailed, isFailedAttempt, recordToTokens, recordTriggers, tokensForTrigger,
  methodMatches, addKnownUser, recordTime,
} = require('../lib/records');

const TZ = 'Europe/Copenhagen';
const LOCK_DATE = Date.UTC(2026, 9, 26, 12, 30, 15); // 14:30:15 in Copenhagen (UTC+1 after the DST change)

function tokens(record, tz = TZ) {
  return recordToTokens(record, describeRecord(record.recordType), tz);
}

function triggers(record) {
  return recordTriggers(record, describeRecord(record.recordType));
}

test('recordToTokens: passcode unlock', () => {
  const t = tokens({
    recordType: 4, success: 1, username: 'Sepp', keyboardPwd: '123456', lockDate: LOCK_DATE,
  });
  assert.deepStrictEqual(t, {
    method: 'passcode',
    user: 'Sepp',
    credential: '123456',
    time: '2026-10-26 13:30:15',
    description: 'Unlocked with passcode',
    record_type: 4,
    success: true,
  });
});

test('recordToTokens: missing fields become empty strings, not undefined', () => {
  const t = tokens({ recordType: '45' });
  assert.strictEqual(t.user, '');
  assert.strictEqual(t.credential, '');
  assert.strictEqual(t.time, '');
  assert.strictEqual(t.method, 'auto');
  assert.strictEqual(t.record_type, 45);
  assert.strictEqual(t.success, true);
});

test('recordToTokens: method is always one of the dropdown values', () => {
  assert.strictEqual(tokens({ recordType: 44 }).method, 'unknown'); // 'tamper' is not a user method
  assert.strictEqual(tokens({ recordType: 31 }).method, 'unknown'); // 'door_sensor'
  assert.strictEqual(tokens({ recordType: 9999 }).method, 'unknown');
  assert.strictEqual(tokens({ recordType: 84 }).method, 'palm');
  assert.strictEqual(tokens({ recordType: 9 }).method, 'wrist_strap');
  for (let type = 1; type <= 100; type++) assert.ok(METHODS.includes(tokens({ recordType: type }).method), String(type));
  assert.strictEqual(normalizeMethod('parking'), 'unknown');
});

test('recordTime: timezone uses lockDate, otherwise serverDate is preferred, each falls back to the other', () => {
  const server = Date.UTC(2026, 0, 2, 3, 4, 5);
  assert.strictEqual(recordTime({ lockDate: LOCK_DATE, serverDate: server }, TZ), '2026-10-26 13:30:15');
  assert.strictEqual(recordTime({ lockDate: LOCK_DATE, serverDate: server }), '2026-01-02 03:04:05');
  assert.strictEqual(recordTime({ serverDate: server }, TZ), '2026-01-02 04:04:05');
  assert.strictEqual(recordTime({ lockDate: LOCK_DATE }), '2026-10-26 12:30:15');
  assert.strictEqual(recordTime({}, TZ), '');
});

test('failed attempts: success 0 or the failure record types', () => {
  assert.strictEqual(recordFailed({ success: 0 }), true);
  assert.strictEqual(recordFailed({ success: '0' }), true);
  assert.strictEqual(recordFailed({ success: 1 }), false);
  assert.strictEqual(recordFailed({}), false);
  assert.strictEqual(recordFailed({ success: null }), false);
  for (const recordType of [58, 65, 68, 88, 91]) assert.strictEqual(isFailedAttempt({ recordType, success: 1 }), true, String(recordType));
  assert.strictEqual(isFailedAttempt({ recordType: 4, success: 0 }), true);
  assert.strictEqual(isFailedAttempt({ recordType: 4, success: 1 }), false);
  assert.strictEqual(recordToTokens({ recordType: 4, success: 0 }, describeRecord(4), TZ).success, false);
});

test('recordTriggers: unlock, lock, auto lock', () => {
  assert.deepStrictEqual(triggers({ recordType: 1, success: 1 }), ['ttlock_unlocked', 'ttlock_event']);
  assert.deepStrictEqual(triggers({ recordType: 11, success: 1 }), ['ttlock_locked', 'ttlock_event']);
  assert.deepStrictEqual(triggers({ recordType: 45 }), ['ttlock_locked', 'ttlock_auto_locked', 'ttlock_event']);
});

test('recordTriggers: failed unlock fires only the failed-attempt card', () => {
  assert.deepStrictEqual(triggers({ recordType: 4, success: 0 }), ['ttlock_failed_attempt', 'ttlock_event']);
  assert.deepStrictEqual(triggers({ recordType: 91 }), ['ttlock_failed_attempt', 'ttlock_event']);
  assert.deepStrictEqual(triggers({ recordType: 65, success: 1 }), ['ttlock_failed_attempt', 'ttlock_event']);
});

test('recordTriggers: alarm and door events', () => {
  assert.deepStrictEqual(triggers({ recordType: 48 }), ['ttlock_system_locked', 'ttlock_event']);
  assert.deepStrictEqual(triggers({ recordType: 44 }), ['ttlock_tamper', 'ttlock_event']);
  assert.deepStrictEqual(triggers({ recordType: 31 }), ['ttlock_door_opened', 'ttlock_event']);
  assert.deepStrictEqual(triggers({ recordType: 30 }), ['ttlock_door_closed', 'ttlock_event']);
  assert.deepStrictEqual(triggers({ recordType: 64 }), ['ttlock_door_left_open', 'ttlock_event']);
  assert.deepStrictEqual(triggers({ recordType: 29 }), ['ttlock_event']);
});

test('tokensForTrigger picks exactly the tokens of the card', () => {
  const t = tokens({
    recordType: 4, success: 1, username: 'Sepp', keyboardPwd: '123456', lockDate: LOCK_DATE,
  });
  assert.deepStrictEqual(Object.keys(tokensForTrigger('ttlock_unlocked', t)), ['method', 'user', 'credential', 'time', 'description']);
  assert.deepStrictEqual(tokensForTrigger('ttlock_auto_locked', t), { time: '2026-10-26 13:30:15' });
  assert.deepStrictEqual(tokensForTrigger('ttlock_tamper', t), {});
  assert.deepStrictEqual(tokensForTrigger('ttlock_failed_attempt', t), { method: 'passcode', description: 'Unlocked with passcode' });
  assert.strictEqual(tokensForTrigger('ttlock_event', t).record_type, 4);
  assert.strictEqual(tokensForTrigger('ttlock_event', t).success, true);
});

test('trigger tokens match drivers/lock/driver.flow.compose.json', () => {
  const flow = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'drivers', 'lock', 'driver.flow.compose.json'), 'utf8'));
  const sample = tokens({ recordType: 4, success: 1, username: 'Sepp', keyboardPwd: '1', lockDate: LOCK_DATE });
  for (const card of flow.triggers) {
    if (card.id === 'ttlock_offline' || card.id === 'ttlock_online') continue; // fired from device.js
    const declared = (card.tokens || []).map(token => token.name);
    assert.deepStrictEqual(Object.keys(tokensForTrigger(card.id, sample)), declared, card.id);
    for (const token of card.tokens || []) {
      const value = sample[token.name];
      assert.strictEqual(typeof value, token.type, `${card.id}.${token.name}`);
    }
  }
});

test('methodMatches', () => {
  assert.strictEqual(methodMatches('any', 'card'), true);
  assert.strictEqual(methodMatches('card', 'card'), true);
  assert.strictEqual(methodMatches('card', 'app'), false);
});

test('flow dropdowns list exactly the METHODS (plus any)', () => {
  const flow = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'drivers', 'lock', 'driver.flow.compose.json'), 'utf8'));
  const unlocked = flow.triggers.find(card => card.id === 'ttlock_unlocked');
  const ids = unlocked.args[0].values.map(value => value.id);
  assert.deepStrictEqual(ids, ['any', ...METHODS]);
  const capability = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.homeycompose', 'capabilities', 'ttlock_last_method.json'), 'utf8'));
  assert.deepStrictEqual(capability.values.map(value => value.id), METHODS);
});

test('addKnownUser: most recent first, distinct, capped', () => {
  assert.deepStrictEqual(addKnownUser([], 'Anna'), ['Anna']);
  assert.deepStrictEqual(addKnownUser(['Anna', 'Bo'], 'Bo'), ['Bo', 'Anna']);
  assert.deepStrictEqual(addKnownUser(['Anna'], ''), ['Anna']);
  assert.deepStrictEqual(addKnownUser(['Anna'], undefined), ['Anna']);
  const many = Array.from({ length: 50 }, (_, i) => `user${i}`);
  const next = addKnownUser(many, 'new');
  assert.strictEqual(next.length, 50);
  assert.strictEqual(next[0], 'new');
  assert.ok(!next.includes('user49'));
});
