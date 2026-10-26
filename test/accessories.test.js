'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  asList, keypadBattery, parseDoorSensors, findDoorSensors,
} = require('../lib/accessories');
const {
  versionName, listGateways, mergeGateway, gatewayStatus, gatewayFlip,
} = require('../lib/gateway');

const bit = n => (1n << BigInt(n)).toString(16);

test('asList: bare array, { list }, single object, and junk', () => {
  assert.deepStrictEqual(asList([1, 2]), [1, 2]);
  assert.deepStrictEqual(asList({ list: [1] }), [1]);
  assert.deepStrictEqual(asList({ list: undefined, pageNo: 1 }), []);
  assert.deepStrictEqual(asList({ a: 1 }), [{ a: 1 }]);
  assert.deepStrictEqual(asList({}), []);
  assert.deepStrictEqual(asList(null), []);
  assert.deepStrictEqual(asList('x'), []);
});

test('keypadBattery: first keypad, any response envelope, null when unknown', () => {
  assert.strictEqual(keypadBattery({ list: [{ electricQuantity: 55 }, { electricQuantity: 9 }] }), 55);
  assert.strictEqual(keypadBattery([{ electricQuantity: '40' }]), 40);
  assert.strictEqual(keypadBattery({ electricQuantity: 12 }), 12);
  assert.strictEqual(keypadBattery({ list: [] }), null);
  assert.strictEqual(keypadBattery({ list: [{ name: 'k' }] }), null);
  assert.strictEqual(keypadBattery(undefined), null);
});

test('parseDoorSensors: maps the documented fields and drops items without an id', () => {
  const sensors = parseDoorSensors({
    list: [
      {
        doorSensorId: 7, name: 'Front', electricQuantity: 88, mac: 'AA:BB', number: 'N1', doorNotClosedWarningTime: 30,
      },
      { name: 'ghost' },
      { doorSensorId: 8 },
    ],
  });
  assert.deepStrictEqual(sensors, [
    {
      doorSensorId: 7, name: 'Front', battery: 88, mac: 'AA:BB', number: 'N1', warningTime: 30,
    },
    {
      doorSensorId: 8, name: '', battery: null, mac: '', number: undefined, warningTime: undefined,
    },
  ]);
  assert.strictEqual(parseDoorSensors({ doorSensorId: 1, electricQuantity: 0 })[0].battery, 0);
  assert.deepStrictEqual(parseDoorSensors({}), []);
});

test('findDoorSensors: queries only locks with a door sensor feature (13 or 50), skips failures', async () => {
  const calls = [];
  const client = {
    request: async (method, path, params) => {
      calls.push([method, path, params]);
      if (params.lockId === 3) throw new Error('boom');
      return { list: [{ doorSensorId: params.lockId * 10, name: 's' }] };
    },
  };
  const locks = [
    { lockId: 1, featureValue: bit(13) },
    { lockId: 2, featureValue: '15' },
    { lockId: 3, featureValue: bit(50) },
    { lockId: 4, featureValue: bit(50) },
  ];
  const errors = [];
  const found = await findDoorSensors(client, locks, (lock, err) => errors.push([lock.lockId, err.message]));
  assert.deepStrictEqual(found.map(f => [f.lock.lockId, f.sensor.doorSensorId]), [[1, 10], [4, 40]]);
  assert.deepStrictEqual(calls.map(c => c[2].lockId), [1, 3, 4]);
  assert.deepStrictEqual(calls[0].slice(0, 2), ['GET', '/v3/doorSensor/query']);
  assert.deepStrictEqual(errors, [[3, 'boom']]);
});

test('versionName: 1..4 are G1..G4, everything else is empty', () => {
  assert.deepStrictEqual([1, 2, 3, 4].map(versionName), ['G1', 'G2', 'G3', 'G4']);
  assert.strictEqual(versionName('2'), 'G2');
  for (const bad of [0, 5, undefined, null, 'x', 2.5]) assert.strictEqual(versionName(bad), '', String(bad));
});

test('listGateways: pageSize 200, orderBy 0, pages until a short page, accepts both shapes', async () => {
  const calls = [];
  const full = Array.from({ length: 200 }, (_, i) => ({ gatewayId: i }));
  const client = {
    request: async (method, path, params) => {
      calls.push([method, path, params]);
      return params.pageNo === 1 ? { list: full } : [{ gatewayId: 999 }];
    },
  };
  const gateways = await listGateways(client);
  assert.strictEqual(gateways.length, 201);
  assert.deepStrictEqual(calls[0], ['GET', '/v3/gateway/list', { pageNo: 1, pageSize: 200, orderBy: 0 }]);
  assert.strictEqual(calls[1][2].pageNo, 2);
  assert.strictEqual(calls.length, 2);
});

test('mergeGateway: detail fields override the list item, missing ones do not', () => {
  assert.deepStrictEqual(
    mergeGateway({ gatewayId: 1, isOnline: 1, lockNum: 2 }, { isOnline: 0, networkName: 'wifi', lockNum: null }),
    {
      gatewayId: 1, isOnline: 0, lockNum: 2, networkName: 'wifi',
    },
  );
  assert.deepStrictEqual(mergeGateway({ gatewayId: 1 }, null), { gatewayId: 1 });
});

test('gatewayStatus: offline when isOnline is 0, unknown (null) when missing', () => {
  assert.deepStrictEqual(gatewayStatus({
    isOnline: 0, lockNum: 3, gatewayVersion: 2, gatewayMac: 'AA', networkName: 'home',
  }), {
    offline: true, lockCount: 3, version: 'G2', mac: 'AA', networkName: 'home',
  });
  assert.strictEqual(gatewayStatus({ isOnline: 1 }).offline, false);
  assert.strictEqual(gatewayStatus({ isOnline: '0' }).offline, true);
  assert.strictEqual(gatewayStatus({}).offline, null);
  assert.strictEqual(gatewayStatus({ isOnline: null }).offline, null);
  assert.deepStrictEqual(gatewayStatus({}), {
    offline: null, lockCount: null, version: '', mac: '', networkName: '',
  });
});

test('gatewayFlip: only a known change fires, once per flip', () => {
  assert.strictEqual(gatewayFlip(false, true), 'offline');
  assert.strictEqual(gatewayFlip(true, false), 'online');
  assert.strictEqual(gatewayFlip(true, true), null);
  assert.strictEqual(gatewayFlip(false, false), null);
  assert.strictEqual(gatewayFlip(null, true), null);
  assert.strictEqual(gatewayFlip(undefined, false), null);
});
