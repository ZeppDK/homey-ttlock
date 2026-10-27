'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('stream');
const { main, parseArgs, configFromEnv } = require('../scripts/bridge-credentials');
const { TABLE } = require('../lib/bridgeKeys');

function encodeSecret(digits, k) {
  const bytes = [...digits].map(ch => ch.charCodeAt(0) ^ k);
  bytes.push(TABLE[digits.length & 0xff] ^ k);
  return Buffer.from(bytes.join(',')).toString('base64');
}

const ENV = {
  TTLOCK_CLIENT_ID: 'cid', TTLOCK_CLIENT_SECRET: 'csecret', TTLOCK_USERNAME: 'me@example.com', TTLOCK_PASSWORD: 'hunter2',
};

const ITEM = {
  lockAlias: 'Front Door',
  lockName: 'RX-ODS_d22e9e',
  lockMac: '96:FE:37:9E:2E:D2',
  lockId: 667,
  aesKeyStr: Array(16).fill('a').join(','),
  adminPwd: encodeSecret('2468013579', 0x21),
  lockKey: encodeSecret('135792468', 0x44),
  lockVersion: {
    protocolType: 5, protocolVersion: 3, scene: 2, groupId: 10, orgId: 40,
  },
  lockFlagPos: 0,
  userType: '110301',
};

function makeFetch(keyList) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const body = url.includes('/oauth2/token')
      ? {
        access_token: 'SECRET-ACCESS-TOKEN', refresh_token: 'SECRET-REFRESH', uid: 1, expires_in: 7776000,
      }
      : keyList;
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetchFn, calls };
}

function sink() {
  const chunks = [];
  return { write: (chunk) => { chunks.push(String(chunk)); return true; }, text: () => chunks.join('') };
}

test('prints a secrets block, logs in with an md5 password and calls key/list with sdkVersion=2', async () => {
  const { fetchFn, calls } = makeFetch({ list: [ITEM] });
  const stdout = sink();
  const stderr = sink();
  await main({
    env: ENV, argv: [], stdout, stderr, fetchFn,
  });

  assert.strictEqual(calls[0].url, 'https://euapi.ttlock.com/oauth2/token');
  assert.ok(!calls[0].init.body.includes('hunter2'));
  assert.match(calls[1].url, /^https:\/\/euapi\.ttlock\.com\/v3\/key\/list\?/);
  const query = new URL(calls[1].url).searchParams;
  assert.strictEqual(query.get('sdkVersion'), '2');
  assert.strictEqual(query.get('pageSize'), '100');

  const out = stdout.text();
  assert.match(out, /^front_door_aes_key: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a"$/m);
  assert.match(out, /^front_door_admin_ps: 2468013579$/m);
  assert.match(out, /^front_door_unlock_key: 135792468$/m);
  assert.match(out, /mac: 96:FE:37:9E:2E:D2/);
  assert.match(out, /protocol_type: 5/);
  for (const secret of ['SECRET-ACCESS-TOKEN', 'SECRET-REFRESH', 'hunter2', 'csecret']) {
    assert.ok(!out.includes(secret) && !stderr.text().includes(secret), `${secret} leaked`);
  }
});

test('--json prints secrets objects on stdout', async () => {
  const { fetchFn } = makeFetch({ list: [{ ...ITEM, userType: '110302' }] });
  const stdout = sink();
  await main({
    env: ENV, argv: ['--json'], stdout, stderr: sink(), fetchFn,
  });
  const parsed = JSON.parse(stdout.text());
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].prefix, 'front_door');
  assert.strictEqual(parsed[0].admin_ps, 2468013579);
  assert.strictEqual(parsed[0].warnings.length, 1);
});

test('cloud errors propagate as TTLockError messages', async () => {
  const fetchFn = async () => ({ status: 200, text: async () => JSON.stringify({ errcode: 10007, errmsg: 'invalid account or invalid password' }) });
  await assert.rejects(
    main({
      env: ENV, argv: [], stdout: sink(), stderr: sink(), fetchFn,
    }),
    /Wrong TTLock username or password/,
  );
});

test('missing values are prompted for on stdin', async () => {
  const { fetchFn } = makeFetch({ list: [ITEM] });
  const stdin = new PassThrough();
  const stdout = sink();
  const stderr = sink();
  const done = main({
    env: { TTLOCK_CLIENT_ID: 'cid', TTLOCK_CLIENT_SECRET: 'csecret' }, argv: [], stdin, stdout, stderr, fetchFn,
  });
  stdin.write('me@example.com\nhunter2\n');
  await done;
  assert.match(stderr.text(), /TTLock username/);
  assert.match(stderr.text(), /TTLock password/);
  assert.match(stdout.text(), /front_door_admin_ps/);
});

test('an empty key list is an error', async () => {
  const { fetchFn } = makeFetch({ list: [] });
  await assert.rejects(main({
    env: ENV, argv: [], stdout: sink(), stderr: sink(), fetchFn,
  }), /No locks found/);
});

test('parseArgs and configFromEnv', () => {
  assert.deepStrictEqual(parseArgs(['--json']), { json: true });
  assert.deepStrictEqual(parseArgs([]), { json: false });
  assert.throws(() => parseArgs(['--password=x']), /Unknown option/);
  assert.deepStrictEqual(configFromEnv({}), { region: 'eu' });
  assert.deepStrictEqual(configFromEnv({ TTLOCK_REGION: 'CN' }), { region: 'cn' });
  assert.deepStrictEqual(configFromEnv({ TTLOCK_BASE_URL: 'https://x.test' }), { region: 'custom', baseUrl: 'https://x.test' });
  assert.throws(() => configFromEnv({ TTLOCK_REGION: 'us' }), /eu or cn/);
});
