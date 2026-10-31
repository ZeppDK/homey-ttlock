'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  TABLE, decodeSecret, normalizeAesKey, prefixFromAlias, toSecrets, secretsYaml,
} = require('../lib/bridgeKeys');

// Same 256 bytes as _DECODE_TABLE in roquerodrigo/ttlock-ble src/ttlock_ble/crypto.py (a second,
// independent copy of the table that api2locks.py contains).
const TTLOCK_BLE_TABLE_HEX = '005ebce2613fdd83c29c7e20a3fd1f419dc3217ffca2401e5f01e3bd3e6082dc'
  + '23079fc1421cfea0e1bf5d0380de3c62bee0025cdf81633d7c22c09e1d43a1ff'
  + '4618faa427799bc584da3866e5bb5907db856739bae406581947a5fb7826c49a'
  + '653bd987045ab8e6a7f91b45c6987a24f8a6441a99c7257b3a6486d85b05e7b9'
  + '8cd2306eedb3510f4e10f2ac2f7193cd114fadf3702ecc92d38d6f31b2ec0e50'
  + 'aff1134dce90722c6d33d18f0c52b0ee326c8ed0530defb1f0ae4c1291cf2d73'
  + 'ca947628abf517490856b4ea6937d58b5709ebb536688ad495cb2977f4aa4816'
  + 'e9b7550b88d6346a2b7597c94a14f6a8742ac896154ba9f7b6e80a54d7896b35';

// The obfuscation run in reverse: XOR the digits with k, append TABLE[n] ^ k, base64 the CSV.
function encodeSecret(digits, k) {
  const bytes = [...digits].map(ch => ch.charCodeAt(0) ^ k);
  bytes.push(TABLE[digits.length & 0xff] ^ k);
  return Buffer.from(bytes.join(',')).toString('base64');
}

test('TABLE has 256 entries and matches ttlock-ble', () => {
  assert.strictEqual(TABLE.length, 256);
  assert.strictEqual(Buffer.from(TABLE).toString('hex'), TTLOCK_BLE_TABLE_HEX);
});

test('decodeSecret recovers numbers encoded in reverse, for several XOR bytes', () => {
  for (const [digits, k] of [['1234567890', 0x5a], ['4294967295', 0x00], ['87654321', 0xff], ['12345678901', 0x13]]) {
    const result = decodeSecret(encodeSecret(digits, k));
    assert.strictEqual(result.text, digits);
    assert.strictEqual(result.value, Number(digits));
  }
});

test('decodeSecret: hand-computed vector', () => {
  // "123" XOR k=0x10 -> 33,34,35 ; last byte = TABLE[3] ^ 0x10 = 0xe2 ^ 0x10 = 0xf2 = 242
  assert.strictEqual(TABLE[3], 0xe2);
  const field = Buffer.from('33,34,35,242').toString('base64');
  assert.strictEqual(decodeSecret(field).text, '123');
});

test('decodeSecret: fields of 10 characters or fewer pass through as plain digits', () => {
  assert.deepStrictEqual(decodeSecret('1234567890'), { text: '1234567890', value: 1234567890 });
  assert.deepStrictEqual(decodeSecret('42'), { text: '42', value: 42 });
});

test('decodeSecret: malformed input throws a clear error', () => {
  assert.throws(() => decodeSecret(''), /Empty key field/);
  assert.throws(() => decodeSecret(undefined), /Empty key field/);
  assert.throws(() => decodeSecret('abc'), /decimal number/);
  assert.throws(() => decodeSecret('not base64 at all!!'), /not valid base64/);
  assert.throws(() => decodeSecret(Buffer.from('hello world, no bytes').toString('base64')), /list of byte values/);
  // Wrong XOR constant: decodes to garbage, not digits.
  assert.throws(() => decodeSecret(Buffer.from('1,2,3,4,5').toString('base64')), /decimal number/);
});

test('normalizeAesKey pads to two digits and lowercases', () => {
  const key = '5,FF,a,0,10,ab,CD,1,2,3,4,5,6,7,8,9';
  assert.strictEqual(normalizeAesKey(key), '05ff0a0010abcd010203040506070809');
  assert.strictEqual(normalizeAesKey(key).length, 32);
});

test('normalizeAesKey rejects keys that are not 16 bytes or not hex', () => {
  assert.throws(() => normalizeAesKey(Array(15).fill('aa').join(',')), /has 15 bytes, expected 16/);
  assert.throws(() => normalizeAesKey(Array(17).fill('aa').join(',')), /has 17 bytes/);
  assert.throws(() => normalizeAesKey(`${Array(15).fill('aa').join(',')},zz`), /invalid byte/);
  assert.throws(() => normalizeAesKey(`${Array(15).fill('aa').join(',')},123`), /invalid byte/);
  assert.throws(() => normalizeAesKey(''), /empty/);
});

const AES = 'bc,3c,b6,1,2,3,4,5,6,7,8,9,a,b,c,d';
const keyItem = (overrides = {}) => ({
  lockAlias: 'Front Door',
  lockName: 'RX-ODS_abcdef',
  lockMac: 'AA:BB:CC:DD:EE:FF',
  lockId: 667,
  aesKeyStr: AES,
  adminPwd: encodeSecret('2468013579', 0x21),
  lockKey: encodeSecret('135792468', 0x44),
  lockVersion: {
    protocolType: 5, protocolVersion: 3, scene: 2, groupId: 10, orgId: 40,
  },
  lockFlagPos: 0,
  userType: '110301',
  ...overrides,
});

test('toSecrets builds the secrets object for an admin key', () => {
  const { secrets, warnings } = toSecrets(keyItem());
  assert.deepStrictEqual(warnings, []);
  assert.deepStrictEqual(secrets, {
    aes_key: 'bc3cb60102030405060708090a0b0c0d',
    admin_ps: 2468013579,
    unlock_key: 135792468,
    lock_mac: 'AA:BB:CC:DD:EE:FF',
    lock_name: 'RX-ODS_abcdef',
    protocol_type: 5,
    protocol_version: 3,
    scene: 2,
    group_id: 10,
    org_id: 40,
    user_type: '110301',
    lock_flag_pos: 0,
  });
});

test('toSecrets warns when the key is not an admin key', () => {
  const { warnings } = toSecrets(keyItem({ userType: '110302' }));
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /not 110301 \(admin\): admin_ps will not work/);
});

test('toSecrets warns about missing adminPwd/lockKey/lockVersion instead of failing', () => {
  const { secrets, warnings } = toSecrets(keyItem({ adminPwd: undefined, lockKey: '', lockVersion: undefined }));
  assert.strictEqual(secrets.admin_ps, null);
  assert.strictEqual(secrets.unlock_key, null);
  assert.strictEqual(warnings.length, 3);
  assert.ok(warnings.some(w => /adminPwd is missing/.test(w)));
  assert.ok(warnings.some(w => /lockKey is missing/.test(w)));
  assert.ok(warnings.some(w => /lockVersion is missing/.test(w)));
});

test('toSecrets throws on a malformed key field or aesKeyStr', () => {
  assert.throws(() => toSecrets(keyItem({ adminPwd: 'garbage garbage garbage' })), /adminPwd:/);
  assert.throws(() => toSecrets(keyItem({ aesKeyStr: 'aa,bb' })), /aesKeyStr: .*expected 16/);
});

test('secretsYaml renders quoted aes key, integer secrets and the lock block', () => {
  const { secrets } = toSecrets(keyItem());
  assert.strictEqual(secretsYaml(secrets, 'front_door'), [
    'front_door_aes_key: "bc3cb60102030405060708090a0b0c0d"',
    'front_door_admin_ps: 2468013579',
    'front_door_unlock_key: 135792468',
    '',
    '# lock: platform ttlock config for RX-ODS_abcdef (AA:BB:CC:DD:EE:FF):',
    '#   protocol_type: 5',
    '#   protocol_version: 3',
    '#   scene: 2',
    '#   group_id: 10',
    '#   org_id: 40',
  ].join('\n'));
});

test('secretsYaml comments out missing secrets', () => {
  const { secrets } = toSecrets(keyItem({ adminPwd: undefined }));
  const yaml = secretsYaml(secrets, 'door');
  assert.match(yaml, /^# door_admin_ps: <missing>$/m);
  assert.match(yaml, /^door_unlock_key: 135792468$/m);
});

test('prefixFromAlias: ascii lowercase, non-alphanumerics become underscores', () => {
  assert.strictEqual(prefixFromAlias({ lockAlias: 'Front Door #2' }), 'front_door_2');
  assert.strictEqual(prefixFromAlias({ lockAlias: 'Hovedør' }), 'hoved_r');
  assert.strictEqual(prefixFromAlias({ lockAlias: '  ', lockName: 'RX-ODS_abcdef' }), 'rx_ods_abcdef');
  assert.strictEqual(prefixFromAlias({ lockId: 7 }), 'lock_7');
});
