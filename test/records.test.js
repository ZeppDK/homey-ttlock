'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { describeRecord, parseCallback } = require('../lib/records');

test('unlock, lock and event types', () => {
  assert.deepStrictEqual(describeRecord(1), { action: 'unlock', method: 'app', description: 'Unlocked with app' });
  assert.strictEqual(describeRecord(4).method, 'passcode');
  assert.strictEqual(describeRecord(8).action, 'unlock');
  assert.strictEqual(describeRecord(11).action, 'lock');
  assert.strictEqual(describeRecord(34).method, 'passcode');
  assert.strictEqual(describeRecord(45).action, 'lock');
  assert.strictEqual(describeRecord(45).method, 'auto');
  assert.strictEqual(describeRecord(44).action, 'event');
  assert.strictEqual(describeRecord(44).method, 'tamper');
  assert.strictEqual(describeRecord(48).action, 'event');
  assert.strictEqual(describeRecord(30).method, 'door_sensor');
  assert.strictEqual(describeRecord(31).method, 'door_sensor');
});

test('accepts string record types and handles unknown ones', () => {
  assert.strictEqual(describeRecord('7').method, 'card');
  const unknown = describeRecord(9999);
  assert.strictEqual(unknown.action, 'event');
  assert.strictEqual(unknown.method, 'unknown');
});

test('parseCallback: form-encoded string body', () => {
  const records = JSON.stringify([{ recordType: 1, lockDate: 1000, electricQuantity: 80 }]);
  const body = new URLSearchParams({ notifyType: '1', lockId: '123', lockMac: 'AA:BB', records }).toString();
  const parsed = parseCallback(body);
  assert.strictEqual(parsed.lockId, '123');
  assert.strictEqual(parsed.records[0].electricQuantity, 80);
});

test('parseCallback: object body with records JSON string or array', () => {
  const rec = [{ recordType: 4 }];
  assert.strictEqual(parseCallback({ lockId: 5, records: JSON.stringify(rec) }).records.length, 1);
  assert.strictEqual(parseCallback({ lockId: 5, records: rec }).lockId, '5');
});

test('parseCallback: rejects bad input', () => {
  assert.strictEqual(parseCallback(null), null);
  assert.strictEqual(parseCallback('x=1'), null);
  assert.strictEqual(parseCallback({ lockId: 1, records: 'not json' }), null);
  assert.strictEqual(parseCallback({ lockId: 1 }), null);
});

test('doorSensorUpdate: 31 opens, 30 closes, everything else is ignored', () => {
  const { doorSensorUpdate } = require('../lib/records');
  assert.deepStrictEqual(doorSensorUpdate({ recordType: 31, electricQuantity: 80 }), { contact: true });
  assert.deepStrictEqual(doorSensorUpdate({ recordType: '30' }), { contact: false });
  assert.strictEqual(doorSensorUpdate({ recordType: 4 }), null);
  assert.strictEqual(doorSensorUpdate({ recordType: 64 }), null);
  assert.strictEqual(doorSensorUpdate(null), null);
});
