'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getTransport } = require('../lib/transport');

test('cloud transport maps to the lock endpoints', async () => {
  const calls = [];
  const client = { request: async (method, path, params) => { calls.push([method, path, params]); return { state: 1 }; } };
  const transport = getTransport(client, 'auto');
  await transport.lock(5);
  await transport.unlock(5);
  assert.strictEqual(await transport.queryState(5), 1);
  assert.deepStrictEqual(calls, [
    ['POST', '/v3/lock/lock', { lockId: 5 }],
    ['POST', '/v3/lock/unlock', { lockId: 5 }],
    ['GET', '/v3/lock/queryOpenState', { lockId: 5 }],
  ]);
});
