'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { TTLockClient, TTLockError, resolveBaseUrl } = require('../lib/TTLockClient');

// Scripted fake fetch: each response is a JSON object (or a function returning one).
function setup(responses, config = {}) {
  const calls = [];
  const sleeps = [];
  let session = null;
  let counted = 0;
  const t = {
    calls, sleeps, counted: () => counted, getSession: () => session, setSession: s => { session = s; },
  };
  t.client = new TTLockClient({
    store: { get: () => session, set: s => { session = s; } },
    getConfig: () => ({
      clientId: 'cid', clientSecret: 'secret', region: 'eu', ...config,
    }),
    onCall: () => { counted++; },
    fetchFn: async (url, init) => {
      const u = new URL(url);
      const params = init.method === 'GET' ? Object.fromEntries(u.searchParams) : Object.fromEntries(new URLSearchParams(init.body));
      const call = {
        method: init.method, path: u.pathname, origin: u.origin, params, search: u.search, headers: init.headers,
      };
      calls.push(call);
      const next = responses.shift();
      const data = typeof next === 'function' ? next(call) : next;
      return { status: 200, text: async () => JSON.stringify(data) };
    },
    sleep: async ms => { sleeps.push(ms); },
  });
  return t;
}

// Wraps a client's fetch so we can observe how many calls run at the same time.
function trackConcurrency(client) {
  const state = { running: 0, max: 0 };
  const inner = client.fetch;
  client.fetch = async (...args) => {
    state.running++;
    state.max = Math.max(state.max, state.running);
    await new Promise(resolve => setTimeout(resolve, 10));
    const res = await inner(...args);
    state.running--;
    return res;
  };
  return state;
}

const TOKENS = {
  access_token: 'AT', refresh_token: 'RT', uid: 7, expires_in: 7776000,
};

test('login: form body with md5(password), stores session', async () => {
  const t = setup([TOKENS]);
  await t.client.login('me@example.com', 'Pa$$word');
  const call = t.calls[0];
  assert.strictEqual(call.method, 'POST');
  assert.strictEqual(call.origin, 'https://euapi.ttlock.com');
  assert.strictEqual(call.path, '/oauth2/token');
  assert.strictEqual(call.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.strictEqual(call.params.clientId, 'cid');
  assert.strictEqual(call.params.clientSecret, 'secret');
  assert.strictEqual(call.params.username, 'me@example.com');
  assert.strictEqual(call.params.password, crypto.createHash('md5').update('Pa$$word').digest('hex'));
  assert.match(call.params.password, /^[0-9a-f]{32}$/);
  assert.strictEqual(t.getSession().accessToken, 'AT');
  assert.strictEqual(t.getSession().refreshToken, 'RT');
  assert.strictEqual(t.counted(), 1);
});

test('login: wrong password maps to a TTLockError with code', async () => {
  const t = setup([{ errcode: 10007, errmsg: 'invalid account or invalid password' }]);
  await assert.rejects(t.client.login('a', 'b'), err => err instanceof TTLockError && err.code === 10007 && /username or password/.test(err.message));
  assert.strictEqual(t.getSession(), null);
});

test('missing clientId/clientSecret gives a clear error and no network call', async () => {
  const t = setup([], { clientId: '' });
  await assert.rejects(t.client.login('a', 'b'), /clientId and clientSecret in the app settings/);
  assert.strictEqual(t.calls.length, 0);
});

test('GET request: params in query, token and date injected', async () => {
  const t = setup([{ list: [] }]);
  t.setSession({ accessToken: 'AT', refreshToken: 'RT' });
  const before = Date.now();
  await t.client.request('GET', '/v3/lock/list', { pageNo: 1, pageSize: 100 });
  const c = t.calls[0];
  assert.strictEqual(c.method, 'GET');
  assert.strictEqual(c.path, '/v3/lock/list');
  assert.strictEqual(c.params.clientId, 'cid');
  assert.strictEqual(c.params.accessToken, 'AT');
  assert.strictEqual(c.params.pageSize, '100');
  assert.ok(Number(c.params.date) >= before);
  assert.strictEqual(c.headers, undefined);
});

test('POST request: params in form body', async () => {
  const t = setup([{ errcode: 0, errmsg: 'none error message' }]);
  t.setSession({ accessToken: 'AT' });
  await t.client.request('POST', '/v3/lock/unlock', { lockId: 42 });
  const c = t.calls[0];
  assert.strictEqual(c.method, 'POST');
  assert.strictEqual(c.search, '');
  assert.strictEqual(c.params.lockId, '42');
  assert.strictEqual(c.params.accessToken, 'AT');
});

test('errcode != 0 becomes TTLockError; -4043 has the Remote Unlock message', async () => {
  const t = setup([{ errcode: -4043, errmsg: 'not supported' }]);
  t.setSession({ accessToken: 'AT' });
  await assert.rejects(t.client.request('POST', '/v3/lock/unlock', { lockId: 1 }), err => err.code === -4043 && /Enable Remote Unlock in the TTLock app/.test(err.message));
});

test('unknown errcode falls back to the server message', async () => {
  const t = setup([{ errcode: 12345, errmsg: 'something odd' }]);
  t.setSession({ accessToken: 'AT' });
  await assert.rejects(t.client.request('GET', '/v3/lock/list'), err => err.code === 12345 && err.message === 'something odd');
});

test('10004: refreshes once, retries with the new token', async () => {
  const t = setup([
    { errcode: 10004, errmsg: 'invalid token' },
    {
      access_token: 'AT2', refresh_token: 'RT2', uid: 7, expires_in: 100,
    },
    { list: [1] },
  ]);
  t.setSession({ accessToken: 'AT', refreshToken: 'RT' });
  const res = await t.client.request('GET', '/v3/lock/list');
  assert.deepStrictEqual(res, { list: [1] });
  assert.strictEqual(t.calls[1].path, '/oauth2/token');
  assert.strictEqual(t.calls[1].params.grant_type, 'refresh_token');
  assert.strictEqual(t.calls[1].params.refresh_token, 'RT');
  assert.strictEqual(t.calls[2].params.accessToken, 'AT2');
  assert.strictEqual(t.getSession().refreshToken, 'RT2');
});

test('10004 twice: gives up after one refresh', async () => {
  const t = setup([{ errcode: 10004 }, TOKENS, { errcode: 10004 }]);
  t.setSession({ accessToken: 'old', refreshToken: 'RT' });
  await assert.rejects(t.client.request('GET', '/v3/lock/list'), err => err.code === 10004);
  assert.strictEqual(t.calls.length, 3);
});

test('refresh failing surfaces the refresh error', async () => {
  const t = setup([{ errcode: 10004 }, { errcode: 10011 }]);
  t.setSession({ accessToken: 'old', refreshToken: 'bad' });
  await assert.rejects(t.client.request('GET', '/v3/lock/list'), err => err.code === 10011);
});

test('request without a session fails with not_logged_in', async () => {
  const t = setup([]);
  await assert.rejects(t.client.request('GET', '/v3/lock/list'), err => err.code === 'not_logged_in');
});

test('-3003 / -3037: retries with 3s, 6s, 12s backoff then succeeds', async () => {
  const t = setup([{ errcode: -3003 }, { errcode: -3037 }, { errcode: -3003 }, { errcode: 0 }]);
  t.setSession({ accessToken: 'AT' });
  await t.client.request('POST', '/v3/lock/lock', { lockId: 1 });
  assert.deepStrictEqual(t.sleeps, [3000, 6000, 12000]);
  assert.strictEqual(t.calls.length, 4);
});

test('-3003 keeps failing: gives up after 3 retries', async () => {
  const t = setup([{ errcode: -3003 }, { errcode: -3003 }, { errcode: -3003 }, { errcode: -3003 }]);
  t.setSession({ accessToken: 'AT' });
  await assert.rejects(t.client.request('POST', '/v3/lock/lock', { lockId: 1 }), err => err.code === -3003);
  assert.strictEqual(t.calls.length, 4);
});

test('gateway-bound calls are serialized', async () => {
  const t = setup([{ errcode: 0 }, { state: 0 }, { errcode: 0 }]);
  t.setSession({ accessToken: 'AT' });
  const state = trackConcurrency(t.client);
  await Promise.all([
    t.client.request('POST', '/v3/lock/unlock', { lockId: 1 }),
    t.client.request('GET', '/v3/lock/queryOpenState', { lockId: 1 }),
    t.client.request('POST', '/v3/lock/lock', { lockId: 1 }),
  ]);
  assert.strictEqual(state.max, 1);
});

test('other calls are not queued', async () => {
  const t = setup([{ list: [] }, { list: [] }]);
  t.setSession({ accessToken: 'AT' });
  const state = trackConcurrency(t.client);
  await Promise.all([
    t.client.request('GET', '/v3/lock/list'),
    t.client.request('GET', '/v3/gateway/listByLock', { lockId: 1 }),
  ]);
  assert.strictEqual(state.max, 2);
});

test('every HTTP call is counted, including retries and refresh', async () => {
  const t = setup([{ errcode: 10004 }, TOKENS, { errcode: -3003 }, { errcode: 0 }]);
  t.setSession({ accessToken: 'old', refreshToken: 'RT' });
  await t.client.request('POST', '/v3/lock/lock', { lockId: 1 });
  assert.strictEqual(t.counted(), 4);
});

test('network failure and non-JSON are TTLockErrors', async () => {
  const t = setup([]);
  t.setSession({ accessToken: 'AT' });
  t.client.fetch = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(t.client.request('GET', '/v3/lock/list'), err => err instanceof TTLockError && err.code === 'network');
  t.client.fetch = async () => ({ status: 502, text: async () => '<html>' });
  await assert.rejects(t.client.request('GET', '/v3/lock/list'), err => err.code === 'bad_response');
});

test('listLocks pages until a short page, accepts { list } and bare arrays', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ lockId: i }));
  const t = setup([{ list: page1 }, [{ lockId: 100 }]]);
  t.setSession({ accessToken: 'AT' });
  const locks = await t.client.listLocks();
  assert.strictEqual(locks.length, 101);
  assert.strictEqual(t.calls[0].params.pageNo, '1');
  assert.strictEqual(t.calls[0].params.pageSize, '100');
  assert.strictEqual(t.calls[1].params.pageNo, '2');
});

test('resolveBaseUrl', () => {
  assert.strictEqual(resolveBaseUrl('eu'), 'https://euapi.ttlock.com');
  assert.strictEqual(resolveBaseUrl('cn'), 'https://cnapi.ttlock.com');
  assert.strictEqual(resolveBaseUrl('custom', 'https://api.example.com/'), 'https://api.example.com');
  assert.strictEqual(resolveBaseUrl(undefined), 'https://euapi.ttlock.com');
  assert.throws(() => resolveBaseUrl('custom', ''), err => err.code === 'config');
});

test('custom region uses the configured base URL', async () => {
  const t = setup([{ list: [] }], { region: 'custom', baseUrl: 'https://api.sciener.com/' });
  t.setSession({ accessToken: 'AT' });
  await t.client.request('GET', '/v3/lock/list');
  assert.strictEqual(t.calls[0].origin, 'https://api.sciener.com');
});

test('gateway-bound passcode, card and fingerprint writes are queued; keyboardPwd/get is not', async () => {
  const t = setup(Array.from({ length: 6 }, () => ({ errcode: 0 })));
  t.setSession({ accessToken: 'AT' });
  const state = trackConcurrency(t.client);
  await Promise.all([
    t.client.request('POST', '/v3/keyboardPwd/add', { lockId: 1 }),
    t.client.request('POST', '/v3/keyboardPwd/change', { lockId: 1 }),
    t.client.request('POST', '/v3/keyboardPwd/delete', { lockId: 1 }),
    t.client.request('POST', '/v3/identityCard/add', { lockId: 1 }),
    t.client.request('POST', '/v3/identityCard/delete', { lockId: 1 }),
    t.client.request('POST', '/v3/fingerprint/delete', { lockId: 1 }),
  ]);
  assert.strictEqual(state.max, 1);
  const t2 = setup([{ errcode: 0 }, { errcode: 0 }]);
  t2.setSession({ accessToken: 'AT' });
  const state2 = trackConcurrency(t2.client);
  await Promise.all([
    t2.client.request('POST', '/v3/keyboardPwd/get', { lockId: 1 }),
    t2.client.request('POST', '/v3/key/send', { lockId: 1 }),
  ]);
  assert.strictEqual(state2.max, 2);
});

test('setting writes (auto-lock, updateSetting, passage mode, clock) are queued; detail reads are not', async () => {
  const t = setup(Array.from({ length: 4 }, () => ({ errcode: 0 })));
  t.setSession({ accessToken: 'AT' });
  const state = trackConcurrency(t.client);
  await Promise.all([
    t.client.request('POST', '/v3/lock/setAutoLockTime', { lockId: 1 }),
    t.client.request('POST', '/v3/lock/updateSetting', { lockId: 1 }),
    t.client.request('POST', '/v3/lock/configurePassageMode', { lockId: 1 }),
    t.client.request('POST', '/v3/lock/updateDate', { lockId: 1 }),
  ]);
  assert.strictEqual(state.max, 1);
  const t2 = setup([{}, {}]);
  t2.setSession({ accessToken: 'AT' });
  const state2 = trackConcurrency(t2.client);
  await Promise.all([
    t2.client.request('GET', '/v3/lock/detail', { lockId: 1 }),
    t2.client.request('GET', '/v3/lock/getPassageModeConfiguration', { lockId: 1 }),
  ]);
  assert.strictEqual(state2.max, 2);
});
