# TTLock local control research (gateway + BLE), as of 2026-10-26

## Verdict
- **No local LAN API on the gateway.** Confirmed by research and by a full TCP portscan (1-65535) of the user's gateway: zero open ports. The gateway is a cloud-relay device only.
- **Direct BLE control without the cloud is real and actively maintained (2026).** Credentials come from the cloud once (`/v3/key/list` → lockData/aesKey), then every operation is local BLE.
- Options for Homey: (a) cloud+gateway (zero hardware, proven), (b) direct BLE from Homey Pro (unproven on Homey, range-limited), (c) local bridge (ESP32 BT proxy / Pi / Unraid container) exposing MQTT/REST.

## 1. Gateway (G2/G3/G4/G2 Lite)
- Only public analysis: Aleph Research "Kontrol Lux lock part 1" https://alephsecurity.com/2024/02/20/kontrol-lux-lock-1/ (G2 only): ESP-12S WiFi + Telink TLSR8251 BLE. Custom binary frames to server (header `5a 00`, direction, 6-byte MAC, length, payload, CRC-16, footer `0b 0c`); login ping/pong 0x45 + "SCIENER"; cmd 0x19 switches from hard-coded AES key to a session key; nearby locks via 0x0b; lock commands (0x41, 0x60) relayed over BLE. Ports/domains/TLS not stated.
- CVE-2023-7007: G2 can be impersonated by MAC (cloud-side flaw). Not a local control path.
- HA forum anecdotes: G2 ESP8266 serial pinout sniffable; custom firmware bricked the other MCU. No MQTT/UDP interface. "MQTT" in vendor marketing = cloud MQTT.

## 2. Open-source BLE implementations (all V3 protocol)
| Project | Lang/License | Status | Notes |
|---|---|---|---|
| kind3r/ttlock-sdk-js | Node/TS, GPL-3 | 67★, v0.3.14, last commit 2021-08 (unmaintained) | Reference port. Init/pair, reset, lock/unlock, status, autolock, passage mode, passcodes, fingerprints, IC cards, op log, event detect. Uses @abandonware/noble. Known bugs: CRC8 table (index 33→7), unlockKey decode off-by-one. |
| kind3r/hass-addons (ttlock-hass-integration) | Node | 100★, 2022-07; author: "BLE very unstable" | HA lock via sdk-js. |
| roquerodrigo/ttlock-ble | Python (bleak), MIT | 2026-05 → 2026-10-20, beta, PyPI, Python 3.14+ | Best-documented current API. Lock/unlock, state+battery, passcodes, fingerprint list, autolock, sound, clock sync, op log, real-time push, passive advert decoding. Cloud login once → cached VirtualKey(aesKey, lockMac...). |
| roquerodrigo/ha-ttlock-ble | HA integration | 36★, 2026-10-21 | Via ESPHome BT proxies. Add lock by MAC, AES key, unlock key, admin passcode. |
| bazuchan/esphome-ttlock | Python + ESPHome C++ | 2026-10 | ttlock-sdk-py + ESPHome component (lock/unlock, passage, battery); `grab-locks-from-api/api2locks.py` extracts aesKeyStr/adminPwd/lockKey from key/list (CRC-XOR de-obfuscation). |
| diabl0w/ttlock + logichousepcb/ttlock-ble | Python / Node (BlueZ D-Bus, no noble) | 2026-08 | REPL/CLI + MQTT bridge HA add-on. Closest to "Node + MQTT bridge". |
| n8henrie/ttlock-rs | Rust + Python | 2026-09 | CLI, MQTT daemon, HA component. Credentials from phone sqlite DB. |
| rabeckas/ttlock-local-ble | Python HA | 2026-04 | Documents sdk-js unlockKey decode bug; handles company-manager eKeys (-4043 via cloud) over BLE. |
| luke265/esp32-ble-gateway | ESP32 | dead 2021 | WiFi→BLE proxy for sdk-js. |
| jbergler/hass-ttlock | Python HA, MIT | 157★, active | Cloud API, not BLE. |

Official SDKs (closed, phone only): ttlock/Android_SDK_Demo, ttlock/iOS_SDK_Demo; take `lockData` as input.

**State caveat (n8henrie measurements, unverified):** manual thumbturn/key operations are not reported via adverts, status query or log; they appear only after 4-10 min. Treat lock state as "last known". Auto-lock visible only in advertisement manufacturer data.

## 3. Hybrid "cloud for credentials, BLE for commands" — works
- Confirmed by roquerodrigo/ttlock-ble, bazuchan, rabeckas, n8henrie.
- Credentials for an already-paired lock: `POST /v3/key/list` with `sdkVersion=2` → lockData, lockMac, lockVersion{protocolType, protocolVersion, scene, groupId, orgId}, userType, remoteEnable. bazuchan's script reads `aesKeyStr`, `adminPwd`, `lockKey` from that response (obfuscated via CRC-table XOR; de-obfuscated in script). Whether official `lockData` decodes to the same fields: UNVERIFIED. Alternative: phone app sqlite DB.
- ttlock-sdk-js input (`src/store/TTLockData.ts`): per lock `address`, `battery`, `rssi`, `autoLockTime`, `lockedStatus`, `privateData{aesKey, admin, adminPasscode, pwdInfo}`. Other ports take MAC + AES key + unlock key + admin passcode + frame header (protocol 5, version 3, scene 2, group 1, org 1).
- Access levels: lock/unlock/status need user eKey (`CHECK_USER_TIME` 0x55); settings/passcode/fingerprint management need admin eKey (`CHECK_ADMIN` 0x41 + admin passcode).
- Limits: resetting the eKey in the official app invalidates cached keys; one BLE connection at a time (phone app conflicts); lock drops idle sessions after ~5 s; ToS on key extraction UNVERIFIED.

## 4. Node/Homey BLE portability
- sdk-js deps: @abandonware/noble, crypto-js, moment, ws, reconnecting-websocket, chalk. Scanner behind `ScannerInterface` (noble / noble-websocket) in `src/scanner/BluetoothLeService.ts`.
- GATT: service `00001910-0000-1000-8000-00805f9b34fb` (`1910`); write char `0000fff2-...`; notify char `0000fff4-...` (CCCD 2902). Device Info `180a`: model 2a24, firmware 2a26, hardware 2a27. Frames chunked to 20 bytes, end CRLF. V3 frame: `7f 5a`, protocol version, sub version, scene, org ids, command, encrypt byte, length, AES-128-CBC payload, CRC-8 (Dallas/Maxim, modified table), `0d 0a`. Docs: https://github.com/kind3r/ttlock-sdk-js/blob/main/docs/SDK-Analysis.md
- Homey ManagerBLE has all primitives (discover, find, connect, getService/getCharacteristic, read/write, subscribeToNotifications, disconnect). Effort: vendor the protocol layer, replace noble scanner/device layer with a Homey adapter, fix the two known bugs, replace crypto-js with Node crypto, re-test on real lock. Risks: `fff2` may need write-without-response (UNVERIFIED), 5 s idle timeout requires fast connect→handshake→command, range (-80 dBm degrades), GPL-3 license if vendoring sdk-js (roquerodrigo is MIT but Python).

## 5. Options
| Option | Pros | Cons | Effort |
|---|---|---|---|
| (a) Cloud + gateway | No protocol work; proven (briis, hass-ttlock) | Gateway + internet + dev-account approval; "Remote unlock" must be on; one command at a time per account; cloud latency; callback needs public HTTPS (Homey cloud webhook) | Low |
| (b) Direct BLE from Homey Pro | No extra hardware, no cloud at runtime, instant | Port protocol; Homey must be in BLE range of the door; single connection; Pro only; manual-op state unreliable; GPL; heavy testing | Medium-high |
| (c) Local bridge (ESP32 BT proxy + container on Unraid, MQTT/REST) | BLE adapter next to the door; Homey side simple; reuse roquerodrigo/diabl0w engines; user already runs Unraid | One more component; credential extraction; ESPHome proxy slots limited | Medium |

Recommendation: pluggable transport. Ship (a) first; add (b) as experimental once a Homey Pro can hold a stable `1910` session; (c) as alternative if BLE range from Homey is insufficient.

## 6. Cloud remote-unlock limits
- Lock-level "Remote unlock" switch must be on (set in app, in BLE range); -4043 otherwise.
- Gateways process one command at a time per account regardless of count (Seam article); parallel unlocks → "gateway busy". Space 30-60 s or serialize.
- Range ~10-15 m open space, ~3 m recommended; latency: seconds (cloud round trip + gateway BLE connect). Cloud can occasionally drop the lock↔gateway association (jbergler).
- Dev app approval takes days.
