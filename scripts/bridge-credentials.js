'use strict';

// One-off helper: fetch the BLE keys of your TTLock locks from the TTLock cloud and print an
// ESPHome secrets.yaml block for bazuchan/esphome-ttlock. See PLAN-4b.md, step 1.
//
//   npm run bridge-credentials            (or: node scripts/bridge-credentials.js [--json])
//
// Reads TTLOCK_CLIENT_ID, TTLOCK_CLIENT_SECRET, TTLOCK_USERNAME, TTLOCK_PASSWORD and optionally
// TTLOCK_REGION (eu|cn) or TTLOCK_BASE_URL from the environment; anything missing is asked for.
// Writes no files. Prompts and progress go to stderr, results to stdout.

const readline = require('readline');
const { Writable } = require('stream');
const { TTLockClient } = require('../lib/TTLockClient');
const { toSecrets, secretsYaml, prefixFromAlias } = require('../lib/bridgeKeys');

const REQUIRED = [
  { env: 'TTLOCK_CLIENT_ID', label: 'TTLock clientId' },
  { env: 'TTLOCK_CLIENT_SECRET', label: 'TTLock clientSecret', secret: true },
  { env: 'TTLOCK_USERNAME', label: 'TTLock username (e-mail or phone)' },
  { env: 'TTLOCK_PASSWORD', label: 'TTLock password', secret: true },
];

// Reads lines from stdin; the typed text is not echoed when `secret` is set.
function createPrompter(input, output) {
  let muted = false;
  let ended = false;
  const sink = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding);
      callback();
    },
  });
  const rl = readline.createInterface({ input, output: sink, terminal: Boolean(input.isTTY) });
  // Lines are queued so that several answers arriving at once (piped stdin) are not lost.
  const lines = [];
  const waiting = [];
  rl.on('line', (line) => {
    if (waiting.length) waiting.shift()(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    ended = true;
    while (waiting.length) waiting.shift()(null);
  });
  const ask = (label, secret) => new Promise((resolve, reject) => {
    output.write(`${label}: `);
    muted = Boolean(secret);
    const done = (line) => {
      muted = false;
      if (line === null) {
        reject(new Error('No more input'));
        return;
      }
      if (secret) output.write('\n');
      resolve(line.trim());
    };
    if (lines.length) done(lines.shift());
    else if (ended) reject(new Error('No more input'));
    else waiting.push(done);
  });
  return { ask, close: () => rl.close() };
}

function parseArgs(argv) {
  const flags = argv.filter(arg => arg.startsWith('-'));
  const unknown = flags.filter(flag => flag !== '--json');
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(' ')}`);
  return { json: flags.includes('--json') };
}

function configFromEnv(env) {
  if (env.TTLOCK_BASE_URL) return { region: 'custom', baseUrl: env.TTLOCK_BASE_URL };
  const region = String(env.TTLOCK_REGION || 'eu').toLowerCase();
  if (region !== 'eu' && region !== 'cn') throw new Error('TTLOCK_REGION must be eu or cn (or set TTLOCK_BASE_URL)');
  return { region };
}

async function main({
  env = process.env, argv = process.argv.slice(2), stdin = process.stdin, stdout = process.stdout,
  stderr = process.stderr, fetchFn,
} = {}) {
  const { json } = parseArgs(argv);
  const network = configFromEnv(env);

  const values = {};
  let prompter;
  for (const field of REQUIRED) {
    if (env[field.env]) {
      values[field.env] = env[field.env];
    } else {
      prompter = prompter || createPrompter(stdin, stderr);
      values[field.env] = await prompter.ask(field.label, field.secret);
      if (!values[field.env]) throw new Error(`${field.label} is required`);
    }
  }
  if (prompter) prompter.close();

  let session = null;
  const client = new TTLockClient({
    store: { get: async () => session, set: async (next) => { session = next; } },
    getConfig: () => ({ clientId: values.TTLOCK_CLIENT_ID, clientSecret: values.TTLOCK_CLIENT_SECRET, ...network }),
    ...(fetchFn ? { fetchFn } : {}),
  });

  stderr.write('Logging in to TTLock...\n');
  await client.login(values.TTLOCK_USERNAME, values.TTLOCK_PASSWORD);
  const res = await client.request('GET', '/v3/key/list', { pageNo: 1, pageSize: 100, sdkVersion: 2 });
  const items = Array.isArray(res) ? res : (res.list || []);
  if (!items.length) throw new Error('No locks found for this account');

  let failed = 0;
  const results = [];
  for (const item of items) {
    try {
      const { secrets, warnings } = toSecrets(item);
      results.push({
        item, prefix: prefixFromAlias(item), secrets, warnings,
      });
    } catch (err) {
      failed++;
      stderr.write(`Lock ${item.lockAlias || item.lockName || item.lockId}: ${err.message}\n`);
    }
  }

  if (json) {
    stdout.write(`${JSON.stringify(results.map(r => ({ prefix: r.prefix, ...r.secrets, warnings: r.warnings })), null, 2)}\n`);
  } else {
    for (const {
      item, prefix, secrets, warnings,
    } of results) {
      stdout.write(`# ===== ${item.lockAlias || item.lockName} =====\n`);
      stdout.write(`# alias: ${item.lockAlias}  name: ${item.lockName}  mac: ${item.lockMac}  id: ${item.lockId}\n`);
      stdout.write(`# lockVersion: ${JSON.stringify(item.lockVersion)}  userType: ${item.userType}\n`);
      stdout.write(`${secretsYaml(secrets, prefix)}\n`);
      for (const warning of warnings) stdout.write(`# WARNING: ${warning}\n`);
      stdout.write('\n');
    }
  }
  if (failed) throw new Error(`${failed} lock(s) could not be decoded`);
}

module.exports = { main, parseArgs, configFromEnv };

if (require.main === module) {
  main().then(() => process.exit(0), (err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
