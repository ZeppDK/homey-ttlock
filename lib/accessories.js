'use strict';

// Wireless keypad and door sensor data from the cloud. Pure functions, no Homey dependencies.
// UNVERIFIED: the docs list the item fields only, not the response envelope. Everything accepts a bare array,
// { list: [...] } or a single object.

const { decodeFeatures, hasDoorSensor } = require('./features');

function asList(res) {
  if (Array.isArray(res)) return res;
  if (!res || typeof res !== 'object') return [];
  if ('list' in res) return Array.isArray(res.list) ? res.list : [];
  return Object.keys(res).length ? [res] : [];
}

// Battery of the first wireless keypad (GET /v3/wirelessKeypad/listByLock), or null.
// UNVERIFIED: field casing electricQuantity.
function keypadBattery(res) {
  const first = asList(res)[0];
  const level = first ? Number(first.electricQuantity) : NaN;
  return Number.isFinite(level) ? level : null;
}

// GET /v3/doorSensor/query -> [{ doorSensorId, name, battery, mac, number, warningTime }].
// UNVERIFIED: fields doorSensorId, name, electricQuantity, mac, number, doorNotClosedWarningTime.
// Items without a doorSensorId are dropped (a lock without a bound sensor answers without one).
function parseDoorSensors(res) {
  return asList(res)
    .filter(item => item && item.doorSensorId !== undefined && item.doorSensorId !== null && item.doorSensorId !== '')
    .map(item => {
      const battery = Number(item.electricQuantity);
      return {
        doorSensorId: item.doorSensorId,
        name: item.name || '',
        battery: item.electricQuantity !== undefined && item.electricQuantity !== null && Number.isFinite(battery) ? battery : null,
        mac: item.mac || '',
        number: item.number,
        warningTime: item.doorNotClosedWarningTime,
      };
    });
}

// Door sensors of every lock that supports one: [{ lock, sensor }]. A failing query skips that lock.
async function findDoorSensors(client, locks, onError = () => {}) {
  const found = [];
  for (const lock of locks) {
    if (!hasDoorSensor(decodeFeatures(lock.featureValue))) continue;
    try {
      const res = await client.request('GET', '/v3/doorSensor/query', { lockId: lock.lockId });
      for (const sensor of parseDoorSensors(res)) found.push({ lock, sensor });
    } catch (err) {
      onError(lock, err);
    }
  }
  return found;
}

module.exports = {
  asList, keypadBattery, parseDoorSensors, findDoorSensors,
};
