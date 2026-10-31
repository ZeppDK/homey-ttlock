# Homey-app til TTLock — plan

Dato: 2026-10-26. Research-grundlag ligger i `docs/research/` (TTLock cloud-API, Homey SDK3, lokal/BLE).

## 1. Konklusioner fra research

**Gateway'en kan ikke styres lokalt.** Portscan af gateway'en (TCP 1–65535) gav nul åbne porte, og ingen har nogensinde fundet en lokal API på G2/G3/G4. Den taler kun en proprietær, AES-krypteret binær protokol til TTLock's cloud. En "gateway-IP"-indstilling i appen giver derfor ingen mening og droppes.

**"Lokalt" betyder derfor BLE direkte til låsen.** Det er reelt og aktivt vedligeholdt i 2026 (roquerodrigo/ttlock-ble, bazuchan/esphome-ttlock, n8henrie/ttlock-rs). Opskriften er hybrid: nøgler (AES-key, lockData) hentes én gang fra cloud'en via `/v3/key/list`, derefter går alle kommandoer over Bluetooth uden cloud. Homey Pro har BLE-API'et der skal til, men ingen har endnu kørt TTLock-protokollen på Homey, og Homey'en skal stå i BLE-rækkevidde af låsen (ca. under -80 dBm).

**Der findes allerede en cloud-only Homey-app**: briis/ttlock-homey (MIT, juli 2026, v1.1.1, cloud-API + webhook, ingen egne flow-kort, ingen BLE). Dens OAuth2-klient, gateway-kø og event-map er direkte genbrugelige. App Store afviser dubletter, så enten bygger vi oven på den (fork/PR) eller begrunder en separat app med lokal BLE + mange flere features.

**Cloud-begrænsninger vi skal designe omkring:**
- 30.000 API-kald/måned gratis → langsom polling + webhook, ikke 1-minuts polling.
- Gateway'en udfører én kommando ad gangen pr. konto → kø + retry på -3003/-3037.
- Fjernlåsning kræver "Remote unlock" slået til i TTLock-appen (ellers -4043); kan ikke sættes via API.
- Fingeraftryk kan kun tilføjes via telefon-BLE; alt andet (koder, kort, indstillinger) virker via gateway.
- Webhook kræver offentlig HTTPS-URL → Homey's cloud-webhook (`webhooks.athom.com`) løser det.
- Manuel låsning med tommelgreb/nøgle rapporteres dårligt (også over BLE) → låsestatus er "sidst kendte".

## 2. Arkitektur

```
Homey app (SDK3, .homeycompose)
├── lib/cloud/TTLockClient.js      cloud-API (OAuth password-grant, md5, errcode→fejl, gateway-kø)
├── lib/ble/TTLockBle.js           BLE-transport (V3-protokol på homey.ble) — fase 4
├── lib/transport.js               vælger pr. kommando: BLE hvis aktiv+i rækkevidde, ellers cloud
├── lib/records.js                 recordType → tilstand/tokens (unlock/lock/alarm/dør)
├── drivers/lock/                  hovedenhed
├── drivers/gateway/               online-status, antal låse, RSSI pr. lås
├── drivers/door_sensor/           alarm_contact + batteri (kun hvis låsen har sensor)
├── drivers/keypad/                trådløst tastatur: batteri (kun hvis bundet)
├── settings/index.html            clientId/secret, region, poll-interval, webhook-URL til copy
└── api.js                         GET /webhook-url til settings-siden
```

**Transportvalg pr. lås** (device setting `transport`): `auto` (BLE først, cloud som fallback), `cloud`, `ble`. Status-hentning: webhook (realtid) → cloud-poll (fallback, 15 min default) → BLE-advertisement (fase 4).

**Pairing**: login_credentials (TTLock-app brugernavn/kodeord, md5 straks) → list_devices (lock/list, viser gateway-status) → add_devices. Repair genbruger login. clientId/secret/region hentes fra app-settings; findes de ikke, viser pairing en side med link til settings.

**Opbevaring**: tokens i oauth2-session-store, lockData/aesKey i device store (skjult), aldrig i settings eller repo.

## 3. Feature-liste

### Lås-enhed (capabilities)
| Capability | Kilde | Notat |
|---|---|---|
| `locked` (set) | queryOpenState / records / BLE | lock/unlock via gateway eller BLE |
| `measure_battery`, `alarm_battery` | lock/list (cached) + webhook-records (live) | alarm under 20 % |
| `alarm_tamper` | recordType 44 | auto-nulstil efter 60 s |
| `alarm_contact` | recordType 30/31, queryOpenState | kun hvis featureValue bit 13/50 |
| `alarm_generic` "systemlåst" | recordType 48 (for mange forkerte forsøg) | |
| `measure_signal_strength` | gateway/listByLock rssi | |
| `ttlock_passage_mode` (set, toggle) | detail / configurePassageMode | bit 22 |
| `ttlock_autolock_time` (set, number s) | detail / setAutoLockTime | bit 4 |
| `ttlock_lock_sound` (set, toggle) | detail / updateSetting 6 | bit 15 |
| `ttlock_sound_volume` (set, 1–5) | updateSetting 8 | bit 43 |
| `ttlock_privacy_lock` (set, toggle) | updateSetting 2 | bit 30 |
| `ttlock_last_user` (string) | sidste record username | |
| `ttlock_last_method` (enum: app/passcode/card/fingerprint/key/remote/auto/…) | sidste record | |
| `ttlock_last_event_time` (string) | lockDate | |
| `ttlock_online` (boolean) | hasGateway + gateway isOnline + BLE-rækkevidde | + setUnavailable når offline |
| `ttlock_transport` (enum cloud/ble) | hvilken transport sidste kommando brugte | |

Capabilities tilføjes dynamisk ud fra featureValue, så låse uden f.eks. dørsensor ikke viser den.

### Gateway-enhed
`ttlock_online` (alarm_generic-lignende), `ttlock_lock_count`, `measure_signal_strength` pr. tilknyttet lås (sub-capabilities), settings: navn, version (G2/G3/G4), MAC, WiFi-netværk.

### Dørsensor-enhed (hvis bundet)
`alarm_contact`, `measure_battery`, setting: "dør ikke lukket"-advarselstid.

### Device settings (lås)
Transport (auto/cloud/ble), poll-interval (5–60 min), auto-lock-tid, lyd, volume, passage mode, privacy lock, tamper-alarm, reset-knap, åbneretning, "dør ikke lukket"-alarm (sek), reset tamper-alarm automatisk (ja/nej), vis info: lockId, MAC, model, firmware, featureValue-dekodet liste.

### App settings
clientId, clientSecret, region (EU / CN / global), standard poll-interval, webhook-URL (readonly, kopiér til TTLock Management Center), test-knap "Tjek forbindelse", API-kald-tæller denne måned (mod 30k-grænsen).

## 4. Flow-kort

### Triggers (lås-enhed)
| Kort | Args | Tokens |
|---|---|---|
| Låsen blev låst op | metode (dropdown, valgfri) | metode, bruger, kode/kort-nr, tidspunkt, via (cloud/ble) |
| Låsen blev låst | metode (dropdown, valgfri) | metode, bruger, tidspunkt |
| Auto-lock aktiveret | | tidspunkt |
| Forkert kode indtastet | | antal (hvis kendt) |
| Systemet låst (for mange forsøg) | | |
| Tamper-alarm | | |
| Dør åbnet / Dør lukket (dørsensor) | | |
| Dør stået åben for længe | | sekunder |
| Batteri lavt | tærskel (number) | niveau |
| Låsen gik offline / online | | årsag (gateway offline / ingen BLE) |
| Passage mode slået til / fra | | |
| Ny kode tilføjet / kode slettet (fra TTLock-app) | | navn, kode-type |
| Hændelse (rå) | | recordType, beskrivelse, bruger, success |
| Gateway gik offline / online (gateway-enhed) | | navn |

Alle `locked`-, `alarm_*`- og `measure_battery`-kort kommer gratis fra Homey oveni.

### Conditions
- Låsen er/er ikke låst (gratis).
- Låsen er/er ikke online.
- Transport er BLE / cloud.
- Passage mode er/er ikke aktiv.
- Sidste oplåsning var af [bruger] (autocomplete over kendte brugernavne).
- Sidste oplåsning var med [metode].
- Kode [navn] findes/findes ikke (autocomplete).
- Gateway er/er ikke online.
- Batteri under [n] %.

### Actions
| Kort | Args |
|---|---|
| Lås / Lås op (gratis) | |
| Lås op via BLE / via cloud (tvungen transport) | |
| Opret engangskode | navn, start (time) → token: kode |
| Opret tidsbegrænset kode | navn, start (date+time), slut (date+time) → token: kode |
| Opret permanent kode | navn, kode (text, valgfri → tilfældig) → token: kode |
| Opret cyklisk kode | navn, ugedage (multiselect), fra (time), til (time) → token: kode |
| Slet kode | kode (autocomplete på navn) |
| Slet alle koder undtagen admin | (bekræft-checkbox) |
| Ændr kode-gyldighed | kode (autocomplete), slut (date+time) |
| Tilføj IC-kort | kortnummer, navn, slut (valgfri) |
| Slet IC-kort / fingeraftryk | autocomplete |
| Send eKey til bruger | TTLock-brugernavn, navn, start, slut, remote-unlock (checkbox) |
| Frys / optø eKey | autocomplete |
| Sæt auto-lock-tid | sekunder (0 = fra) |
| Passage mode til/fra | dropdown |
| Passage mode med tidsplan | ugedage, fra, til, auto-unlock (checkbox) |
| Lyd til/fra, volume | |
| Privacy lock til/fra | |
| Synkronisér låsens ur | |
| Opdatér status nu (tvungen poll) | |
| Hent seneste hændelser | antal → token: tekst-liste (til notifikationer) |
| Nulstil tamper-alarm | |

Action-kort returnerer tokens (f.eks. den genererede kode) så de kan bruges i Advanced Flow, f.eks. "gæst ankommer → opret engangskode → send SMS".

## 5. Faser og agent-fordeling

Fase 0 kan brugeren starte **nu**, da godkendelsen tager dage.

| Fase | Indhold | Agent | Verifikation |
|---|---|---|---|
| 0 | Opret developer-konto på euopen.ttlock.com, opret Application, vent på godkendelse, slå "Remote unlock" til i TTLock-appen | **Brugeren** | clientId/secret modtaget |
| 1 | Scaffold (.homeycompose), cloud-klient med oauth/md5/errcode/gateway-kø, lock-driver med pairing, locked/batteri/online, poll + Homey-webhook, app-settings-side | Sonnet | `homey app validate --level publish` grøn; lås/lås op virker mod rigtig lås; webhook modtager unlock-event |
| 2 | Records → capabilities + alle triggers/conditions; passcode-, kort-, eKey-actions med autocomplete og tokens; featureValue-gating | Sonnet | Hvert flow-kort testet i et flow; unit-tests på records.js og featureValue-dekoder |
| 3 | Indstillings-capabilities (auto-lock, lyd, passage, privacy), gateway-driver, dørsensor-driver, keypad, API-kald-tæller, dansk oversættelse | Sonnet | Settings-ændringer slår igennem i TTLock-appen |
| 4 | BLE-transport: vendor V3-protokol (MIT-port foretrækkes frem for GPL sdk-js), Homey-BLE-adapter, nøgler fra key/list, auto-fallback | Fable/Opus (svær) | Lås op over BLE med gateway slukket; fallback til cloud når ude af rækkevidde |
| 5 | Billeder, ikoner, README.txt, changelog, `homey app review`, publicering (test-kanal) | Haiku | Godkendt i test-kanal |

Fase 1–3 er lavrisiko cloud-arbejde og kan køre som Sonnet-sessioner; fase 4 er eksperimentel og bør vente til 1–3 er stabile. Hver fase er en egen session med dette dokument + `docs/research/` som brief.

## 6. Beslutninger (2026-10-26)

1. **Ny app** med .homeycompose-struktur. Genbrug briis' OAuth2Client-mønster og event-map (MIT). App-id: `dk.sepp.ttlock` (kan ændres).
2. **Homey Pro 2023/mini, men for langt fra låsen til BLE.** Fase 4 "BLE direkte fra Homey" udgår. Lokal styring bliver i stedet **fase 4b: lokal bro** — ESP32 med ESPHome `bluetooth_proxy` ved døren + container på Unraid (roquerodrigo/ttlock-ble eller diabl0w/ttlock som motor) der eksponerer MQTT/REST. Homey-appen får en tredje transport `bridge` med settings: bro-URL/MQTT-host, port, token. Nøgler hentes fra `/v3/key/list` via cloud-klienten og pushes til broen.
3. **Kun eget brug.** Fase 5 udgår; appen installeres med `homey app install`. Ingen dubletbegrundelse nødvendig.
4. **Developer-konto oprettes nu af brugeren.** Fase 1 bygges og valideres uden nøgler; test mod rigtig lås når clientId/secret er godkendt.
5. **Stadig ukendt**: låsemodel + firmware (TTLock-app → lås → info). Afgør featureValue-bits og om broen (V3-protokol) kan tale med den. Hentes automatisk i fase 1 via lock/detail når nøglerne kommer.

### Revideret faseplan
| Fase | Indhold | Agent |
|---|---|---|
| 0 | Developer-konto + Application på euopen.ttlock.com; slå "Remote unlock" til i TTLock-appen | Brugeren |
| 1 | Scaffold, cloud-klient, lock-driver, poll + webhook, app-settings | Sonnet |
| 2 | Records, alle triggers/conditions, passcode/kort/eKey-actions | Sonnet |
| 3 | Indstillings-capabilities, gateway-, dørsensor-, keypad-driver, dansk | Sonnet |
| 4b | Bro-container på Unraid + ESPHome-proxy + `bridge`-transport i appen | Fable/Opus (BLE-protokol er svær) |
