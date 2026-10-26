'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { countApiCall } = require('../lib/apiCalls');

function fakeSettings() {
  const data = {};
  return { get: k => data[k], set: (k, v) => { data[k] = v; } };
}

test('counts per calendar month and resets on a new month', () => {
  const settings = fakeSettings();
  countApiCall(settings, new Date(2026, 9, 5));
  countApiCall(settings, new Date(2026, 9, 20));
  assert.deepStrictEqual(settings.get('ttlock_api_calls'), { month: '2026-10', count: 2 });
  countApiCall(settings, new Date(2026, 10, 1));
  assert.deepStrictEqual(settings.get('ttlock_api_calls'), { month: '2026-11', count: 1 });
});
