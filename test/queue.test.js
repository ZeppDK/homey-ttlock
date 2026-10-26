'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Queue = require('../lib/queue');

test('runs tasks one at a time in order, even when one fails', async () => {
  const queue = new Queue();
  const log = [];
  let running = 0;
  const task = (name, ms, fail) => async () => {
    running++;
    assert.strictEqual(running, 1);
    log.push(`start ${name}`);
    await new Promise(resolve => setTimeout(resolve, ms));
    log.push(`end ${name}`);
    running--;
    if (fail) throw new Error(name);
    return name;
  };
  const results = await Promise.allSettled([queue.add(task('a', 20)), queue.add(task('b', 1, true)), queue.add(task('c', 1))]);
  assert.deepStrictEqual(results.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.deepStrictEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});
