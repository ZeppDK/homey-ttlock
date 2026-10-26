'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const actions = require('../lib/actions');

const NOW = Date.UTC(2026, 9, 26, 10, 0, 0);
const HOUR = 3600 * 1000;
const OPTS = { now: NOW, tz: 'Europe/Copenhagen' };

// Fake client: records every call and answers from a function or a fixed object.
function fakeClient(answer = {}) {
  const calls = [];
  return {
    calls,
    async request(method, urlPath, params) {
      calls.push({ method, path: urlPath, params });
      return typeof answer === 'function' ? answer(method, urlPath, params) : answer;
    },
  };
}

test('one-time passcode: type 1, now .. now + 6 h, returns tokens', async () => {
  const client = fakeClient({ keyboardPwd: '123456', keyboardPwdId: 77 });
  const tokens = await actions.passcodeOnetime(client, 5, { name: ' Guest ' }, OPTS);
  assert.deepStrictEqual(tokens, { passcode: '123456', passcode_id: 77 });
  assert.deepStrictEqual(client.calls, [{
    method: 'POST',
    path: '/v3/keyboardPwd/get',
    params: {
      lockId: 5, keyboardPwdType: 1, keyboardPwdName: 'Guest', startDate: NOW, endDate: NOW + 6 * HOUR,
    },
  }]);
});

test('period passcode: type 3 with local date/time converted to epoch', async () => {
  const client = fakeClient({ keyboardPwd: '654321', keyboardPwdId: 8 });
  const tokens = await actions.passcodePeriod(client, 5, {
    name: 'Cleaner', start_date: '27-10-2026', start_time: '09:00', end_date: '27-10-2026', end_time: '12:00',
  }, OPTS);
  assert.deepStrictEqual(tokens, { passcode: '654321', passcode_id: 8 });
  const { params } = client.calls[0];
  assert.strictEqual(params.keyboardPwdType, 3);
  assert.strictEqual(params.startDate, Date.UTC(2026, 9, 27, 8, 0)); // Copenhagen is UTC+1 in late October
  assert.strictEqual(params.endDate, Date.UTC(2026, 9, 27, 11, 0));
});

test('period passcode: end must be after start, bad dates are rejected', async () => {
  const client = fakeClient({});
  await assert.rejects(actions.passcodePeriod(client, 5, {
    name: 'x', start_date: '27-10-2026', start_time: '12:00', end_date: '27-10-2026', end_time: '12:00',
  }, OPTS), /end must be after/);
  await assert.rejects(actions.passcodePeriod(client, 5, {
    name: 'x', start_date: 'nope', start_time: '12:00', end_date: '27-10-2026', end_time: '13:00',
  }, OPTS), /Invalid date/);
  assert.strictEqual(client.calls.length, 0);
});

test('permanent passcode without code: keyboardPwd/get type 2, endDate 0', async () => {
  const client = fakeClient({ keyboardPwd: '111222', keyboardPwdId: 3 });
  const tokens = await actions.passcodePermanent(client, 5, { name: 'Me' }, OPTS);
  assert.deepStrictEqual(tokens, { passcode: '111222', passcode_id: 3 });
  assert.deepStrictEqual(client.calls[0].path, '/v3/keyboardPwd/get');
  assert.deepStrictEqual(client.calls[0].params, {
    lockId: 5, keyboardPwdType: 2, keyboardPwdName: 'Me', startDate: NOW, endDate: 0,
  });
});

test('permanent passcode with code: keyboardPwd/add type 2 via gateway, token is the given code', async () => {
  const client = fakeClient({ keyboardPwdId: 9 });
  const tokens = await actions.passcodePermanent(client, 5, { name: 'Me', code: '2468' }, OPTS);
  assert.deepStrictEqual(tokens, { passcode: '2468', passcode_id: 9 });
  assert.strictEqual(client.calls[0].path, '/v3/keyboardPwd/add');
  assert.strictEqual(client.calls[0].params.keyboardPwd, '2468');
  assert.strictEqual(client.calls[0].params.keyboardPwdType, 2);
  assert.strictEqual(client.calls[0].params.addType, 2);
});

test('custom codes must be 4 to 9 digits', async () => {
  for (const code of ['123', '1234567890', '12ab56', '12 34']) {
    const client = fakeClient({});
    await assert.rejects(actions.passcodePermanent(client, 5, { name: 'x', code }, OPTS), /4 to 9 digits/, code);
    assert.strictEqual(client.calls.length, 0);
  }
  const client = fakeClient({ keyboardPwdId: 1 });
  await actions.passcodePermanent(client, 5, { name: 'x', code: '123456789' }, OPTS);
  assert.strictEqual(client.calls.length, 1);
});

test('custom period passcode: add type 3 with addType 2', async () => {
  const client = fakeClient({ keyboardPwdId: 4 });
  const tokens = await actions.passcodeCustomPeriod(client, 5, {
    name: 'Guest', code: '9999', start_date: '01-07-2026', start_time: '14:00', end_date: '03-07-2026', end_time: '11:00',
  }, OPTS);
  assert.deepStrictEqual(tokens, { passcode: '9999', passcode_id: 4 });
  const { path: urlPath, params } = client.calls[0];
  assert.strictEqual(urlPath, '/v3/keyboardPwd/add');
  assert.strictEqual(params.keyboardPwdType, 3);
  assert.strictEqual(params.addType, 2);
  assert.strictEqual(params.startDate, Date.UTC(2026, 6, 1, 12, 0)); // UTC+2 in July
  assert.strictEqual(params.endDate, Date.UTC(2026, 6, 3, 9, 0));
});

test('delete passcode: deleteType 2, needs a chosen passcode', async () => {
  const client = fakeClient({});
  await actions.passcodeDelete(client, 5, { passcode: { name: 'Guest', id: 42 } }, OPTS);
  assert.deepStrictEqual(client.calls, [{
    method: 'POST', path: '/v3/keyboardPwd/delete', params: { lockId: 5, keyboardPwdId: 42, deleteType: 2 },
  }]);
  await assert.rejects(actions.passcodeDelete(fakeClient({}), 5, {}, OPTS), /Choose a passcode/);
});

test('set passcode end: changeType 2, keeps the start date from the fresh list', async () => {
  const client = fakeClient((method, urlPath) => {
    if (urlPath === '/v3/lock/listKeyboardPwd') return { list: [{ keyboardPwdId: 42, startDate: NOW - HOUR, endDate: NOW + HOUR }] };
    return { errcode: 0 };
  });
  await actions.passcodeSetEnd(client, 5, { passcode: { id: 42 }, end_date: '30-10-2026', end_time: '18:00' }, OPTS);
  assert.strictEqual(client.calls[0].path, '/v3/lock/listKeyboardPwd');
  assert.deepStrictEqual(client.calls[1], {
    method: 'POST',
    path: '/v3/keyboardPwd/change',
    params: {
      lockId: 5, keyboardPwdId: 42, startDate: NOW - HOUR, endDate: Date.UTC(2026, 9, 30, 17, 0), changeType: 2,
    },
  });
});

test('set passcode end: unknown passcode and end before start are rejected', async () => {
  const empty = fakeClient({ list: [] });
  await assert.rejects(actions.passcodeSetEnd(empty, 5, { passcode: { id: 1 }, end_date: '30-10-2026', end_time: '18:00' }, OPTS), /no longer exists/);
  const past = fakeClient({ list: [{ keyboardPwdId: 1, startDate: NOW }] });
  await assert.rejects(actions.passcodeSetEnd(past, 5, { passcode: { id: 1 }, end_date: '01-01-2020', end_time: '18:00' }, OPTS), /end must be after/);
});

test('delete-all passcodes needs the confirm checkbox', async () => {
  const client = fakeClient({ keyboardPwd: '000111', keyboardPwdId: 5 });
  await assert.rejects(actions.passcodeClearAll(client, 5, { confirm: false }, OPTS), /confirm/);
  await assert.rejects(actions.passcodeClearAll(client, 5, {}, OPTS), /confirm/);
  assert.strictEqual(client.calls.length, 0);
  const tokens = await actions.passcodeClearAll(client, 5, { confirm: true }, OPTS);
  assert.deepStrictEqual(tokens, { passcode: '000111', passcode_id: 5 });
  assert.strictEqual(client.calls[0].params.keyboardPwdType, 4);
});

test('feature gating: clear errors when the lock lacks passcode/card/fingerprint support', async () => {
  const none = { passcode: false, card: false, fingerprint: false };
  const opts = { ...OPTS, features: none };
  const client = fakeClient({});
  await assert.rejects(actions.passcodeOnetime(client, 5, { name: 'x' }, opts), /does not support passcodes/);
  await assert.rejects(actions.passcodeDelete(client, 5, { passcode: { id: 1 } }, opts), /does not support passcodes/);
  await assert.rejects(actions.cardAdd(client, 5, { card_number: '1' }, opts), /does not support IC cards/);
  await assert.rejects(actions.cardDelete(client, 5, { card: { id: 1 } }, opts), /does not support IC cards/);
  await assert.rejects(actions.fingerprintDelete(client, 5, { fingerprint: { id: 1 } }, opts), /does not support fingerprints/);
  assert.strictEqual(client.calls.length, 0);
  // unknown features (null) do not block
  await actions.passcodeDelete(client, 5, { passcode: { id: 1 } }, { ...OPTS, features: null });
  assert.strictEqual(client.calls.length, 1);
});

test('gateway-bound writes fail without a gateway, cloud-only ones do not', async () => {
  const opts = { ...OPTS, remote: false };
  const client = fakeClient({ keyboardPwd: '123456', keyboardPwdId: 1, keyId: 1 });
  await assert.rejects(actions.passcodeDelete(client, 5, { passcode: { id: 1 } }, opts), /no gateway/);
  await assert.rejects(actions.passcodePermanent(client, 5, { name: 'x', code: '1234' }, opts), /no gateway/);
  await assert.rejects(actions.cardAdd(client, 5, { card_number: '1' }, opts), /no gateway/);
  assert.strictEqual(client.calls.length, 0);
  await actions.passcodeOnetime(client, 5, { name: 'x' }, opts); // keyboardPwd/get is computed in the cloud
  await actions.ekeySend(client, 5, { username: 'bob' }, opts);
  assert.strictEqual(client.calls.length, 2);
});

test('add IC card: permanent is 0/0 via gateway, with an end date it starts now', async () => {
  const client = fakeClient({});
  await actions.cardAdd(client, 5, { card_number: ' 1234567 ', name: 'Badge' }, OPTS);
  assert.deepStrictEqual(client.calls[0], {
    method: 'POST',
    path: '/v3/identityCard/add',
    params: {
      lockId: 5, cardNumber: '1234567', cardName: 'Badge', startDate: 0, endDate: 0, addType: 2,
    },
  });
  await actions.cardAdd(client, 5, { card_number: '1', name: 'B', end_date: '31-12-2026' }, OPTS);
  assert.strictEqual(client.calls[1].params.startDate, NOW);
  assert.strictEqual(client.calls[1].params.endDate, Date.UTC(2026, 11, 31, 22, 59)); // 23:59 Copenhagen
  await assert.rejects(actions.cardAdd(client, 5, { card_number: '' }, OPTS), /card number/);
  await assert.rejects(actions.cardAdd(client, 5, { card_number: '1', end_date: '01-01-2020' }, OPTS), /future/);
});

test('delete IC card and fingerprint: deleteType 2', async () => {
  const client = fakeClient({});
  await actions.cardDelete(client, 5, { card: { id: 11 } }, OPTS);
  await actions.fingerprintDelete(client, 5, { fingerprint: { id: 12 } }, OPTS);
  assert.deepStrictEqual(client.calls.map(call => [call.path, call.params]), [
    ['/v3/identityCard/delete', { lockId: 5, cardId: 11, deleteType: 2 }],
    ['/v3/fingerprint/delete', { lockId: 5, fingerprintId: 12, deleteType: 2 }],
  ]);
});

test('send eKey: remoteEnable 1/2, 0/0 when no dates, key_id token', async () => {
  const client = fakeClient({ keyId: 99 });
  const tokens = await actions.ekeySend(client, 5, { username: 'bob@example.com', remote: true }, OPTS);
  assert.deepStrictEqual(tokens, { key_id: 99 });
  assert.deepStrictEqual(client.calls[0].params, {
    lockId: 5, receiverUsername: 'bob@example.com', keyName: 'bob@example.com', startDate: 0, endDate: 0, remoteEnable: 1,
  });
  await actions.ekeySend(client, 5, {
    username: 'bob', name: 'Bob', start_date: '01-11-2026', end_date: '02-11-2026',
  }, OPTS);
  const { params } = client.calls[1];
  assert.strictEqual(params.keyName, 'Bob');
  assert.strictEqual(params.remoteEnable, 2);
  assert.strictEqual(params.startDate, Date.UTC(2026, 9, 31, 23, 0)); // 00:00 Copenhagen (UTC+1)
  assert.strictEqual(params.endDate, Date.UTC(2026, 10, 2, 22, 59));
  await assert.rejects(actions.ekeySend(client, 5, { username: '  ' }, OPTS), /username/);
});

test('freeze / unfreeze eKey', async () => {
  const client = fakeClient({});
  await actions.ekeyFreeze(client, 5, { ekey: { id: 3 } });
  await actions.ekeyUnfreeze(client, 5, { ekey: { id: 3 } });
  assert.deepStrictEqual(client.calls.map(call => [call.path, call.params]), [
    ['/v3/key/freeze', { keyId: 3 }],
    ['/v3/key/unfreeze', { keyId: 3 }],
  ]);
  await assert.rejects(actions.ekeyFreeze(client, 5, {}), /Choose a eKey/);
});

test('recent events: count clamped to 1..20, one line per record, newest first', async () => {
  const records = [
    { recordType: 1, success: 1, username: 'Sepp', lockDate: Date.UTC(2026, 9, 26, 8, 0, 0) },
    { recordType: 4, success: 0, username: '', lockDate: Date.UTC(2026, 9, 26, 9, 0, 0) },
  ];
  const client = fakeClient({ list: records });
  const { events } = await actions.recentEvents(client, 5, { count: 99 }, OPTS);
  assert.strictEqual(client.calls[0].params.pageSize, 20);
  assert.deepStrictEqual(events.split('\n'), [
    '2026-10-26 10:00:00  Unlocked with passcode (failed)',
    '2026-10-26 09:00:00  Unlocked with app - Sepp',
  ]);
  await actions.recentEvents(client, 5, { count: 0 }, OPTS);
  assert.strictEqual(client.calls[1].params.pageSize, 5); // 0/NaN falls back to the default
  await actions.recentEvents(client, 5, { count: 3 }, OPTS);
  assert.strictEqual(client.calls[2].params.pageSize, 3);
  assert.strictEqual(client.calls[2].params.pageNo, 1);
  assert.deepStrictEqual(await actions.recentEvents(fakeClient({ list: [] }), 5, { count: 3 }, OPTS), { events: '' });
});

const PASSCODES = [
  {
    keyboardPwdId: 1, keyboardPwd: '123456', keyboardPwdName: 'Guest Anna', keyboardPwdType: 3,
  },
  {
    keyboardPwdId: 2, keyboardPwd: '987654', keyboardPwdName: '', keyboardPwdType: 2,
  },
];

test('passcode autocomplete: filters case-insensitively on name and code, id in id', () => {
  assert.deepStrictEqual(actions.passcodeChoices(PASSCODES, 'anna'), [{ name: 'Guest Anna', description: 'Code 123456, period', id: 1 }]);
  assert.deepStrictEqual(actions.passcodeChoices(PASSCODES, '9876').map(c => c.id), [2]);
  assert.strictEqual(actions.passcodeChoices(PASSCODES, '9876')[0].name, '987654'); // unnamed code shows the code
  assert.strictEqual(actions.passcodeChoices(PASSCODES, '').length, 2);
  assert.strictEqual(actions.passcodeChoices(PASSCODES, 'zzz').length, 0);
});

test('card, fingerprint and eKey autocomplete', () => {
  assert.deepStrictEqual(
    actions.cardChoices([{ cardId: 1, cardNumber: '555', cardName: 'Badge' }], 'BAD'),
    [{ name: 'Badge', description: 'Card 555', id: 1 }],
  );
  assert.deepStrictEqual(
    actions.fingerprintChoices([{ fingerprintId: 2, fingerprintName: 'Left thumb', fingerprintNumber: '7' }], 'thumb'),
    [{ name: 'Left thumb', description: 'Fingerprint 7', id: 2 }],
  );
  assert.deepStrictEqual(
    actions.ekeyChoices([{ keyId: 3, keyName: 'Bob', username: 'bob@x.dk', keyStatus: 110405 }], 'bob'),
    [{ name: 'Bob', description: 'bob@x.dk, frozen', id: 3 }],
  );
});

test('user autocomplete: known names plus the typed query', () => {
  const known = ['Anna', 'Bo'];
  assert.deepStrictEqual(actions.userChoices(known, ''), [{ name: 'Anna', id: 'Anna' }, { name: 'Bo', id: 'Bo' }]);
  assert.deepStrictEqual(actions.userChoices(known, 'ann'), [{ name: 'ann', id: 'ann' }, { name: 'Anna', id: 'Anna' }]);
  assert.deepStrictEqual(actions.userChoices(known, 'Bo'), [{ name: 'Bo', id: 'Bo' }]);
  assert.deepStrictEqual(actions.userChoices(known, 'Carl'), [{ name: 'Carl', id: 'Carl' }]);
});

test('lists accept { list } or a bare array and page until a short page', async () => {
  const bare = fakeClient([{ keyboardPwdId: 1 }]);
  assert.strictEqual((await actions.listPasscodes(bare, 5)).length, 1);
  const pages = fakeClient((method, urlPath, params) => ({
    list: Array.from({ length: params.pageNo === 1 ? 200 : 3 }, (_, i) => ({ keyboardPwdId: params.pageNo * 1000 + i })),
  }));
  assert.strictEqual((await actions.listPasscodes(pages, 5)).length, 203);
  assert.deepStrictEqual(pages.calls.map(call => call.params.pageNo), [1, 2]);
  assert.strictEqual((await actions.listPasscodes(fakeClient({}), 5)).length, 0);
});

// Wiring checks without loading the Homey runtime: every card id used in the code exists and vice versa.
test('flow card ids in the code and in driver.flow.compose.json agree', () => {
  const root = path.join(__dirname, '..');
  const flow = JSON.parse(fs.readFileSync(path.join(root, 'drivers', 'lock', 'driver.flow.compose.json'), 'utf8'));
  const declared = new Set([...flow.triggers, ...flow.conditions, ...flow.actions].map(card => card.id));
  const code = ['drivers/lock/driver.js', 'drivers/lock/device.js', 'lib/records.js']
    .map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  const used = new Set(code.match(/ttlock_[a-z_]+/g));
  const capabilities = new Set(fs.readdirSync(path.join(root, '.homeycompose', 'capabilities')).map(file => path.basename(file, '.json')));
  for (const id of used) assert.ok(declared.has(id) || capabilities.has(id) || id === 'ttlock_poll_interval', `${id} is used but not declared`);
  for (const id of declared) assert.ok(used.has(id), `${id} is declared but never used`);
});

// ---- phase 3: lock settings and the passage mode / clock actions ------------------------------

test('setting actions write through the gateway with the documented params', async () => {
  const client = fakeClient({ errcode: 0 });
  await actions.setAutolock(client, 5, { seconds: 20 }, OPTS);
  await actions.setSound(client, 5, { state: 'off' }, OPTS);
  await actions.setVolume(client, 5, { volume: 4 }, OPTS);
  await actions.setPrivacy(client, 5, { state: 'on' }, OPTS);
  assert.deepStrictEqual(client.calls.map(c => [c.method, c.path, c.params]), [
    ['POST', '/v3/lock/setAutoLockTime', { lockId: 5, seconds: 20, type: 2 }],
    ['POST', '/v3/lock/updateSetting', { lockId: 5, type: 6, value: 2, changeType: 2 }],
    ['POST', '/v3/lock/updateSetting', { lockId: 5, type: 8, value: 4, changeType: 2 }],
    ['POST', '/v3/lock/updateSetting', { lockId: 5, type: 2, value: 1, changeType: 2 }],
  ]);
  assert.deepStrictEqual(await actions.setAutolock(client, 5, { seconds: 0 }, OPTS), {});
});

test('setting actions reject invalid values before any call', async () => {
  const client = fakeClient({});
  await assert.rejects(actions.setAutolock(client, 5, { seconds: 5000 }, OPTS), /Auto-lock time/);
  await assert.rejects(actions.setVolume(client, 5, { volume: 9 }, OPTS), /volume/);
  await assert.rejects(actions.setSound(client, 5, { state: 'x' }, OPTS), /on\/off/);
  assert.strictEqual(client.calls.length, 0);
});

test('setting actions need the feature (when known) and a gateway', async () => {
  const client = fakeClient({});
  const none = { ...OPTS, features: { autolock: false, passage_mode: false, sound: false, volume: false, privacy: false } };
  await assert.rejects(actions.setAutolock(client, 5, { seconds: 5 }, none), /auto-lock time/);
  await assert.rejects(actions.setPassageMode(client, 5, { mode: 'on' }, none), /passage mode/);
  await assert.rejects(actions.setSound(client, 5, { state: 'on' }, none), /sound/);
  await assert.rejects(actions.setVolume(client, 5, { volume: 1 }, none), /volume/);
  await assert.rejects(actions.setPrivacy(client, 5, { state: 'on' }, none), /privacy/);
  await assert.rejects(actions.setPassageSchedule(client, 5, { start_time: '08:00', end_time: '09:00', day_1: true }, none), /passage mode/);
  const noGateway = { ...OPTS, remote: false };
  await assert.rejects(actions.setAutolock(client, 5, { seconds: 5 }, noGateway), /no gateway/);
  await assert.rejects(actions.syncClock(client, 5, {}, noGateway), /no gateway/);
  assert.strictEqual(client.calls.length, 0);
  await actions.setAutolock(client, 5, { seconds: 5 }, { ...OPTS, features: null }); // unknown features do not block
  assert.strictEqual(client.calls.length, 1);
});

test('setLockSetting rejects unknown capabilities', async () => {
  await assert.rejects(actions.setLockSetting(fakeClient({}), 5, 'locked', true, OPTS), /Unknown setting/);
});

test('passage mode toggle keeps the current auto-unlock and schedule from getPassageModeConfiguration', async () => {
  const cyclic = [{ isAllDay: 2, startTime: 480, endTime: 960, weekDays: [1, 2, 3] }];
  const client = fakeClient((method, urlPath) => (
    urlPath === '/v3/lock/getPassageModeConfiguration'
      ? { passageMode: 2, autoUnlock: 1, cyclicConfig: cyclic }
      : { errcode: 0 }
  ));
  await actions.setPassageMode(client, 5, { mode: 'on' }, OPTS);
  assert.deepStrictEqual(client.calls[0], { method: 'GET', path: '/v3/lock/getPassageModeConfiguration', params: { lockId: 5 } });
  assert.deepStrictEqual(client.calls[1], {
    method: 'POST',
    path: '/v3/lock/configurePassageMode',
    params: {
      lockId: 5, passageMode: 1, autoUnlock: 1, type: 2, cyclicConfig: JSON.stringify(cyclic),
    },
  });
  await actions.setPassageMode(client, 5, { mode: 'off' }, OPTS);
  assert.strictEqual(client.calls[3].params.passageMode, 2);
});

test('passage mode toggle: autoUnlock falls back to the cached detail, and a failing config read stops the write', async () => {
  const client = fakeClient({ errcode: 0 });
  await actions.setPassageMode(client, 5, { mode: 'on' }, { ...OPTS, detail: { passageModeAutoUnlock: 1 } });
  assert.strictEqual(client.calls[1].params.autoUnlock, 1);
  assert.strictEqual(client.calls[1].params.cyclicConfig, '[]');

  const failing = fakeClient(() => { throw new Error('no config'); });
  await assert.rejects(actions.setPassageMode(failing, 5, { mode: 'on' }, OPTS), /no config/);
  assert.strictEqual(failing.calls.length, 1); // never wrote
});

test('passage schedule: one cyclic entry with the ticked weekdays and minutes after midnight', async () => {
  const client = fakeClient({ errcode: 0 });
  await actions.setPassageSchedule(client, 5, {
    day_1: true, day_2: false, day_3: true, day_7: true, start_time: '08:30', end_time: '17:00', auto_unlock: true,
  }, OPTS);
  const { method, path: urlPath, params } = client.calls[0];
  assert.strictEqual(method, 'POST');
  assert.strictEqual(urlPath, '/v3/lock/configurePassageMode');
  assert.deepStrictEqual({ ...params, cyclicConfig: JSON.parse(params.cyclicConfig) }, {
    lockId: 5,
    passageMode: 1,
    autoUnlock: 1,
    type: 2,
    cyclicConfig: [{
      isAllDay: 2, startTime: 510, endTime: 1020, weekDays: [1, 3, 7],
    }],
  });
  await actions.setPassageSchedule(client, 5, {
    day_5: true, start_time: '00:00', end_time: '23:59',
  }, OPTS);
  assert.strictEqual(client.calls[1].params.autoUnlock, 2);
});

test('passage schedule: needs a weekday, a valid time and an end after the start', async () => {
  const client = fakeClient({});
  const base = { day_1: true, start_time: '08:00', end_time: '09:00' };
  await assert.rejects(actions.setPassageSchedule(client, 5, { ...base, day_1: false }, OPTS), /weekday/);
  await assert.rejects(actions.setPassageSchedule(client, 5, { ...base, start_time: '8am' }, OPTS), /Invalid time/);
  await assert.rejects(actions.setPassageSchedule(client, 5, { ...base, end_time: '08:00' }, OPTS), /end must be after/);
  await assert.rejects(actions.setPassageSchedule(client, 5, { ...base, end_time: '07:00' }, OPTS), /end must be after/);
  assert.strictEqual(client.calls.length, 0);
});

test('sync clock: updateDate with the current time', async () => {
  const client = fakeClient({ errcode: 0 });
  assert.deepStrictEqual(await actions.syncClock(client, 5, {}, OPTS), {});
  assert.deepStrictEqual(client.calls, [{ method: 'POST', path: '/v3/lock/updateDate', params: { lockId: 5, date: NOW } }]);
});

test('sync clock: errors are surfaced with context and keep their code', async () => {
  const client = fakeClient(() => { throw Object.assign(new Error('The lock is offline'), { code: -3036 }); });
  await assert.rejects(actions.syncClock(client, 5, {}, OPTS), err => {
    assert.match(err.message, /Could not set the lock clock: The lock is offline/);
    assert.strictEqual(err.code, -3036);
    return true;
  });
});
