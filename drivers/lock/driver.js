'use strict';

const Homey = require('homey');
const actions = require('../../lib/actions');
const { methodMatches } = require('../../lib/records');
const { login, defaultPollInterval } = require('../../lib/session');

const LIST_CACHE_MS = 60 * 1000;

// Action card id -> handler in lib/actions.js (cards without a handler here are special-cased below).
const ACTION_HANDLERS = {
  ttlock_passcode_onetime: actions.passcodeOnetime,
  ttlock_passcode_period: actions.passcodePeriod,
  ttlock_passcode_permanent: actions.passcodePermanent,
  ttlock_passcode_custom_period: actions.passcodeCustomPeriod,
  ttlock_passcode_delete: actions.passcodeDelete,
  ttlock_passcode_set_end: actions.passcodeSetEnd,
  ttlock_clear_passcodes: actions.passcodeClearAll,
  ttlock_card_add: actions.cardAdd,
  ttlock_card_delete: actions.cardDelete,
  ttlock_fingerprint_delete: actions.fingerprintDelete,
  ttlock_ekey_send: actions.ekeySend,
  ttlock_ekey_freeze: actions.ekeyFreeze,
  ttlock_ekey_unfreeze: actions.ekeyUnfreeze,
  ttlock_recent_events: actions.recentEvents,
  ttlock_set_autolock: actions.setAutolock,
  ttlock_set_passage_mode: actions.setPassageMode,
  ttlock_set_passage_schedule: actions.setPassageSchedule,
  ttlock_set_sound: actions.setSound,
  ttlock_set_volume: actions.setVolume,
  ttlock_set_privacy: actions.setPrivacy,
  ttlock_sync_clock: actions.syncClock,
};

// Setting actions after which lock/detail is re-read, so the capabilities show what the cloud has now.
const REFRESH_DETAIL = new Set([
  'ttlock_set_autolock', 'ttlock_set_passage_mode', 'ttlock_set_passage_schedule', 'ttlock_set_sound', 'ttlock_set_volume', 'ttlock_set_privacy',
]);

class LockDriver extends Homey.Driver {

  async onInit() {
    this.registerTriggers();
    this.registerConditions();
    this.registerActions();
  }

  registerTriggers() {
    for (const id of ['ttlock_unlocked', 'ttlock_locked']) {
      this.homey.flow.getDeviceTriggerCard(id)
        .registerRunListener(async (args, state) => methodMatches(args.method, state.method));
    }
  }

  // Autocomplete over a list of the device (passcodes, cards, ...): choices(list, query) -> [{ name, description, id }]
  registerListAutocomplete(card, arg, kind, choices) {
    card.registerArgumentAutocompleteListener(arg, async (query, args) => choices(await args.device.getList(kind), query));
  }

  registerConditions() {
    const { flow } = this.homey;
    flow.getConditionCard('ttlock_is_online').registerRunListener(async args => args.device.isOnline());
    flow.getConditionCard('ttlock_last_method_is')
      .registerRunListener(async args => args.device.getCapabilityValue('ttlock_last_method') === args.method);

    const lastUser = flow.getConditionCard('ttlock_last_user_is');
    lastUser.registerRunListener(async args => {
      const wanted = String((args.user && (args.user.id || args.user.name)) || '').trim().toLowerCase();
      return wanted !== '' && String(args.device.getCapabilityValue('ttlock_last_user') || '').toLowerCase() === wanted;
    });
    lastUser.registerArgumentAutocompleteListener('user', async (query, args) => (
      actions.userChoices(args.device.getStoreValue('known_users') || [], query)
    ));

    const passcodeExists = flow.getConditionCard('ttlock_passcode_exists');
    passcodeExists.registerRunListener(async args => {
      const list = await args.device.getList('passcodes');
      return list.some(item => String(item.keyboardPwdId) === String(args.passcode && args.passcode.id));
    });
    this.registerListAutocomplete(passcodeExists, 'passcode', 'passcodes', actions.passcodeChoices);

    flow.getConditionCard('ttlock_passage_mode_is')
      .registerRunListener(async args => args.device.getCapabilityValue('ttlock_passage_mode') === true);

    flow.getConditionCard('ttlock_battery_below').registerRunListener(async args => {
      const level = args.device.getCapabilityValue('measure_battery');
      return level !== null && level !== undefined && Number(level) < Number(args.level);
    });
  }

  registerActions() {
    const { flow } = this.homey;
    for (const [id, handler] of Object.entries(ACTION_HANDLERS)) {
      flow.getActionCard(id).registerRunListener(async args => {
        const { device } = args;
        try {
          const tokens = await handler(this.homey.app.client, device.lockId, args, device.actionContext());
          if (REFRESH_DETAIL.has(id)) await device.refreshDetail().catch(err => device.handleError(err));
          return tokens;
        } catch (err) {
          device.handleError(err);
          throw err; // TTLockError messages are shown in the flow
        } finally {
          device.invalidateLists(); // passcodes/cards/eKeys may have changed
        }
      });
    }

    flow.getActionCard('ttlock_refresh').registerRunListener(async args => {
      await args.device.poll();
      return {};
    });

    this.registerListAutocomplete(flow.getActionCard('ttlock_passcode_delete'), 'passcode', 'passcodes', actions.passcodeChoices);
    this.registerListAutocomplete(flow.getActionCard('ttlock_passcode_set_end'), 'passcode', 'passcodes', actions.passcodeChoices);
    this.registerListAutocomplete(flow.getActionCard('ttlock_card_delete'), 'card', 'cards', actions.cardChoices);
    this.registerListAutocomplete(flow.getActionCard('ttlock_fingerprint_delete'), 'fingerprint', 'fingerprints', actions.fingerprintChoices);
    this.registerListAutocomplete(flow.getActionCard('ttlock_ekey_freeze'), 'ekey', 'ekeys', actions.ekeyChoices);
    this.registerListAutocomplete(flow.getActionCard('ttlock_ekey_unfreeze'), 'ekey', 'ekeys', actions.ekeyChoices);
  }

  // lock/list for all devices; one API call is shared by everything polling within a minute.
  getLocks() {
    if (!this.listCache || Date.now() - this.listCache.at > LIST_CACHE_MS) {
      const promise = this.homey.app.client.listLocks();
      const cache = { at: Date.now(), promise };
      this.listCache = cache;
      promise.catch(() => {
        if (this.listCache === cache) this.listCache = null; // do not cache failures
      });
    }
    return this.listCache.promise;
  }

  login(data) {
    return login(this.homey, data);
  }

  async onPair(session) {
    session.setHandler('login', data => this.login(data));
    session.setHandler('list_devices', async () => {
      const pollInterval = defaultPollInterval(this.homey);
      const locks = await this.homey.app.client.listLocks();
      return locks.map(lock => ({
        name: lock.lockAlias || lock.lockName,
        data: { lockId: lock.lockId },
        store: {
          lockMac: lock.lockMac,
          lockName: lock.lockName,
          featureValue: lock.featureValue,
          hasGateway: lock.hasGateway,
        },
        settings: { poll_interval: pollInterval },
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

module.exports = LockDriver;
