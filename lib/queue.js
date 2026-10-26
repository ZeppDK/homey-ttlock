'use strict';

// Runs async tasks strictly one after another. A failing task rejects its own
// promise but never blocks the tasks queued behind it.
class Queue {

  constructor() {
    this._tail = Promise.resolve();
  }

  add(task) {
    const run = this._tail.then(task);
    this._tail = run.catch(() => {});
    return run;
  }

}

module.exports = Queue;
