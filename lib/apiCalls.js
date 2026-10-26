'use strict';

const KEY = 'ttlock_api_calls';

// Counts TTLock API calls per calendar month: { month: '2026-10', count: n }.
function countApiCall(settings, now = new Date()) {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const current = settings.get(KEY);
  const count = current && current.month === month ? current.count : 0;
  settings.set(KEY, { month, count: count + 1 });
}

module.exports = { countApiCall };
