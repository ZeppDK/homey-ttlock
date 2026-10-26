'use strict';

const Homey = require('homey');
const { findDoorSensors } = require('../../lib/accessories');
const { login, defaultPollInterval } = require('../../lib/session');

class DoorSensorDriver extends Homey.Driver {

  login(data) {
    return login(this.homey, data);
  }

  // One device per door sensor, found through the locks of the account that support one.
  async onPair(session) {
    session.setHandler('login', data => this.login(data));
    session.setHandler('list_devices', async () => {
      const { client } = this.homey.app;
      const locks = await client.listLocks();
      const found = await findDoorSensors(client, locks, (lock, err) => this.error(`doorSensor/query for lock ${lock.lockId} failed: ${err.message}`));
      return found.map(({ lock, sensor }) => ({
        name: this.homey.__('pair.door_sensor_name', { lock: lock.lockAlias || lock.lockName }),
        data: { doorSensorId: sensor.doorSensorId },
        store: { lockId: lock.lockId },
        settings: { poll_interval: defaultPollInterval(this.homey) },
      }));
    });
  }

  async onRepair(session, device) {
    session.setHandler('login', async data => {
      await this.login(data);
      await device.setAvailable();
      device.poll().catch(this.error);
      return true;
    });
  }

}

module.exports = DoorSensorDriver;
