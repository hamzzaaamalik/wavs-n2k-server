# WAVS NMEA 2000 Telemetry Server

![tests](https://img.shields.io/badge/tests-75%2F75-brightgreen)
![typecheck](https://img.shields.io/badge/tsc%20--strict-clean-brightgreen)
![MODE=can](https://img.shields.io/badge/MODE%3Dcan-verified%2012%2F12-brightgreen)
![node](https://img.shields.io/badge/node-%E2%89%A522-informational)

Reads a vessel's NMEA 2000 bus **directly** (raw CAN via Linux SocketCAN, no
gateway and no SignalK), decodes the parameter groups the compliance pipeline
needs, and streams normalized JSON telemetry over WebSocket at 5 Hz.

Implements an internal build brief for the AHOI WAVS pilot. It deviates from
that brief in five places, all deliberate and three of them bug fixes — see
[Deviations from the build spec](#deviations-from-the-build-spec).

**Bringing up a Linux machine on the bus? → [LINUX_SETUP.md](LINUX_SETUP.md)** —
start-to-finish, copy-pasteable, with a troubleshooting matrix.

```
[N2K backbone] ──socketcan──► ingest(frame) ──► parseCanId
                                   ▲                │
                            simulator / replay      ├─► FastPacketAssembler
                                                    ├─► decode(pgn, …)
                                                    └─► apply() ─► VesselState
                                                                      │
                                                        ws://host:4001 @ 5 Hz
```

`ingest(frame)` is the seam. The real bus, the simulator and a recorded capture
all call it, and **nothing below it is forked per mode**.

---

## Quick start (any OS, no hardware)

```bash
npm install
npm run build
npm run sim                 # ws://localhost:4001
```

You should see:

```
[n2k] mode=sim iface=- bind=0.0.0.0:4001 vessel=WAVS-01 pgns=7 state=5Hz
```

The simulator emits **genuine binary N2K frames** — built with `buildCanId` and
packed buffers, reserved bits padded with 1s the way a real node sends them —
through the same `ingest()` the boat will use. It is not fabricated JSON, so the
decoders being exercised are the ones that will run offshore.

A client connected for 2.5 s sees all seven parameter groups:

```
127250 src= 5  {"heading_deg":61.93,"heading_reference":"true"}
127488 src=20  {"engine_instance":0,"engine_rpm":3922}
128267 src=35  {"depth_m":7.13,"depth_ft":24.5}
129025 src= 2  {"lat_deg":41.9520951,"lon_deg":-70.6177723}
129026 src= 2  {"cog_reference":"true","cog_deg":60.13,"sog_kn":24.61}
129029 src= 2  {"lat_deg":41.9521219,"lon_deg":-70.6177049,"fix_type":"GNSS","satellites":9}
130306 src=40  {"wind_speed_kn":12.6,"wind_angle_deg":144.6,"wind_reference":"apparent"}
```

---

## Real bus (Linux + CAN interface)

Hardware: a Raspberry Pi (or any Linux SBC) plus a CAN HAT (PiCAN-M or an
MCP2515 board), tapped into the N2K backbone with a drop cable and proper
termination at both ends of the trunk.

**Node 22 or newer is required — install it before `npm install`, not after.**
This works fine on a Raspberry Pi (Node 22 is published for `arm64` and `armhf`);
Pi OS just ships with Node 18. The `socketcan` addon is an *optional* dependency
declaring `engines.node >= 22`, and npm skips an engine mismatch **silently** —
so the install reports success and `MODE=can` later fails with a misleading
"addon is missing". `npm run doctor` checks the Node version first for exactly
this reason. Full detail: [LINUX_SETUP.md](LINUX_SETUP.md#1-os-prep).

```bash
node --version                        # must be >= 22

# NOTE: 250k, not the 500k of automotive CAN. At the wrong rate you receive
# zero frames, with no error to tell you why.
sudo ip link set can0 up type can bitrate 250000

candump can0                          # sanity check: frames should scroll

npm install                           # builds the native socketcan addon here
npm run build
MODE=can CAN_IF=can0 node dist/server.js
```

`socketcan` is an **optional** dependency and a native addon: it needs a C/C++
toolchain (`build-essential`) and only installs on Linux. It is `require`d
lazily inside the `MODE=can` branch, so sim mode never touches it — that is what
lets `npm install` succeed on macOS and Windows even when the addon fails to
build.

---

## Replay a capture

Validate the decoders against real bus data before you board the vessel.

```bash
candump -l can0                       # on the boat, writes candump-*.log
npm run replay -- --replay-file=candump-2026-08-05.log
```

Accepts the `candump -l` line format, with or without the leading timestamp:

```
(1770000000.123456) can0 09F80203#0100733508D8FFFF
```

Frames are paced by their recorded gaps (capped at 250 ms so a quiet capture
does not stall). `--replay-speed=10` runs it ten times faster.

---

## Configuration

**Nothing operational is hard-coded.** Every rate, timeout, address, interface
and identity resolves from configuration, so moving to a new vessel is a
settings change and never a code change.

Precedence: `--flag` > real environment > `.env` file > built-in default.

| Env | Flag | Default | Meaning |
|---|---|---|---|
| `MODE` | `--mode` | `sim` | `sim`, `can` or `replay` |
| `HOST` | `--host` | `0.0.0.0` | Bind address; `127.0.0.1` refuses anything off-box |
| `PORT` | `--port` | `4001` | WebSocket port; `0` binds a free one |
| `CAN_IF` | `--can-if` | `can0` | CAN interface, `MODE=can` only |
| `CAN_RETRY_MS` | `--can-retry-ms` | `5000` | Retry cadence while the interface is down; `0` disables |
| `VESSEL_ID` | `--vessel-id` | `WAVS-01` | Identity in `hello` and every snapshot |
| `LOG_LEVEL` | `--log-level` | `info` | `error`, `info` or `debug` |
| `STATE_HZ` | `--state-hz` | `5` | Snapshot rate; lower it on a constrained uplink |
| `FAST_PACKET_TTL_MS` | `--fast-packet-ttl-ms` | `3000` | Partial fast-packet sequence TTL |
| `SWEEP_INTERVAL_MS` | `--sweep-interval-ms` | `1000` | TTL sweep cadence |
| `STATS_INTERVAL_S` | `--stats-interval-s` | `60` | Bus stats line + `stats` message; `0` disables |
| `SHUTDOWN_GRACE_MS` | `--shutdown-grace-ms` | `2000` | Shutdown deadline before forced exit |
| `REPLAY_FILE` | `--replay-file` | — | Required for `MODE=replay` |
| `REPLAY_SPEED` | `--replay-speed` | `1` | Replay rate multiplier |
| `REPLAY_MAX_GAP_MS` | `--replay-max-gap-ms` | `250` | Cap on replayed inter-frame gaps |
| `REPLAY_LOOP` | `--replay-loop` | `false` | Restart the capture at EOF |

Copy [`.env.example`](.env.example) to `.env` and edit; every knob is documented
inline. Point elsewhere with `ENV_FILE=/etc/wavs/n2k.env`. The loader never
overrides a variable already set in the real environment.

Check what actually resolved, and where each value came from:

```bash
npm run config          # or: node dist/server.js --print-config

  MODE                sim                    default  sim | can | replay
  HOST                0.0.0.0                default  WebSocket bind address
  STATE_HZ            10                     flag     snapshot rate, Hz
  VESSEL_ID           WAVS-09                env      vessel identity
  ...
  derived: snapshot interval 100 ms
```

Invalid values are rejected at startup with the knob named and exit code 2 —
a typo in `/etc/wavs/n2k.env` fails loudly instead of silently reverting.

No credentials anywhere in this service. If an auth token is added to the
WebSocket later, read it from the environment and never commit it.

`SIGINT` / `SIGTERM` stop the frame source, close the WebSocket server and exit 0.

---

## Deploying to the vessel

### 1. Preflight, before anything else

```bash
sudo ./deploy/can-up.sh can0        # brings can0 up at 250k, checks the rate
npm run doctor -- --can-if=can0 --seconds=15
```

The doctor checks platform, the native addon, that the interface exists and is
up, and that the **bitrate is 250000 and not 500000** — then listens on the bus
and reports what this vessel actually emits:

```
[  OK  ] interface can0 exists (can)
[  OK  ] bitrate is 250000 (NMEA 2000)

  14203 frames in 15s  (946.9/s)

  Compliance-critical groups present:
    129026    148 frames    9.9/s  src 2
    129025    148 frames    9.9/s  src 2
    ...
  MISSING (never seen): 127488, 130306
    A missing group means no device on this backbone emits it.
    Its VesselState fields will stay null. That is a wiring answer,
    not a software one.
```

Exit 0 = ready, 1 = something needs fixing, so it drops into a provisioning
script. It also lists the traffic it *doesn't* decode, which is how you find
out what else is on that backbone.

### 2. Install as a service

```bash
sudo cp deploy/n2k-server.service /etc/systemd/system/
sudo mkdir -p /etc/wavs && sudo cp .env.example /etc/wavs/n2k.env
sudo nano /etc/wavs/n2k.env         # MODE=can, VESSEL_ID=..., done
sudo systemctl daemon-reload && sudo systemctl enable --now n2k-server
journalctl -u n2k-server -f
```

The unit reads `/etc/wavs/n2k.env`, restarts on failure, and shuts down cleanly
on `SIGTERM`. It runs unprivileged with `ProtectSystem=strict` — reading a CAN
socket needs no filesystem write access.

**Boot ordering is handled.** systemd routinely starts services before `can0`
is configured. Rather than crash-looping, the server retries every
`CAN_RETRY_MS` and logs what to do:

```
[n2k] cannot open can0 (attempt 1): ...
[n2k] retrying in 5000 ms. Is the interface up?  sudo ip link set can0 up type can bitrate 250000
[n2k] can0 open after 3 attempts
```

### 3. Confirm it stays alive

With `STATS_INTERVAL_S` set, one line per interval tells you the bus is healthy
without attaching anything:

```
[n2k] bus 946.9/s in, 21.4/s decoded | groups 7 known + 23 other | fastpkt ok=148 drop=0 swept=0 pending=0
```

In `MODE=can` the line also carries `can err=N rtr=N`. **CAN error frames are the
sharpest signal of a wiring fault** — bus-off, ACK errors and controller
overruns are counted and discarded rather than decoded, because an error frame's
identifier is a bitmask and not a PGN; decoding it would invent parameter groups
that are not on the bus and mask the very fault it reports.

A rising `drop` / `swept` / `err` count points at the tap, the termination, or
the bit rate — not at this decoder. The same payload is broadcast as a `stats`
WebSocket message.

---

## WebSocket protocol

Listens on `ws://0.0.0.0:${PORT}`. JSON text frames. Broadcasts go only to
clients in `OPEN`; a client that drops is skipped rather than queued, and a
reconnecting client immediately gets a fresh `hello` + `state`.

**On connect**, in order:

```json
{ "type": "hello", "vessel_id": "WAVS-01", "mode": "can", "state_hz": 5,
  "pgns": [127250,127488,128267,129025,129026,129029,130306] }
```

`mode` and `state_hz` let the console show whether it is looking at real bus
data or the simulator, and adapt to a configured snapshot rate.
```json
{ "type": "state", "...": "full VesselState" }
```

**Per decoded PGN** (event stream):

```json
{ "type": "pgn", "pgn": 129026, "src": 2, "ts": 1770000000000,
  "fields": { "cog_reference": "true", "cog_deg": 78.4, "sog_kn": 24.1 } }
```

**Consolidated snapshot** at a steady 5 Hz:

```json
{ "type": "state", "vessel_id": "WAVS-01", "ts": 1785929698861,
  "position": { "lat": 41.9521877, "lon": -70.617535 },
  "sog_kn": 24.53, "cog_deg": 62.96, "heading_deg": 64.76,
  "depth_ft": 25.5, "engine_rpm": 3915,
  "wind_speed_kn": 12.9, "wind_angle_deg": 146.3,
  "fix_type": "GNSS", "satellites": 12,
  "sources": { "127250": 1785929698861, "129026": 1785929698860 } }
```

`sources` maps PGN to last-seen ms epoch, so the console can grey out a stale
instrument instead of showing a frozen number as if it were live.

**Bus health** every `STATS_INTERVAL_S`, alongside the log line:

```json
{ "type": "stats", "ts": 1785929698861, "uptimeS": 60,
  "frames": 56814, "decoded": 1284, "ignored": 55530,
  "framesPerSec": 946.9, "decodedPerSec": 21.4,
  "known": [ { "pgn": 129026, "count": 240, "last": 1785929698860, "sources": [2] } ],
  "unknown": [ { "pgn": 60928, "count": 12, "last": 1785929698000, "sources": [12] } ],
  "missing": [130306],
  "fastPacket": { "started": 60, "completed": 60, "dropped": 0, "swept": 0, "pending": 0 } }
```

Clients that only care about telemetry can ignore any message type they do not
recognise; `hello`, `pgn` and `state` are unchanged.

Merge rules: a field present but `null` **overwrites** (it reflects a live "not
available"); a field simply absent from that parameter group never clobbers a
value another PGN set. Position is the one exception — 129025 and 129029 both
carry it, so the snapshot takes whichever last supplied a usable fix.

---

## PGNs decoded

| PGN | Parameter group | Fields | Transport |
|---|---|---|---|
| 129026 | COG & SOG, Rapid Update | `cog_deg` `sog_kn` `cog_reference` | single |
| 129025 | Position, Rapid Update | `lat_deg` `lon_deg` | single |
| 129029 | GNSS Position Data | `lat_deg` `lon_deg` `fix_type` `satellites` | **fast-packet** |
| 127250 | Vessel Heading | `heading_deg` `heading_reference` | single |
| 128267 | Water Depth | `depth_m` `depth_ft` | single |
| 127488 | Engine Parameters, Rapid | `engine_instance` `engine_rpm` | single |
| 130306 | Wind Data | `wind_speed_kn` `wind_angle_deg` `wind_reference` | single |

`sog_kn` is the value the entire speed rule turns on.

Field definitions for anything beyond these seven come from the open **canboat**
PGN database. This service deliberately keeps its own small, audited decoder set
so the compliance-critical fields have no external runtime dependency.

---

## Wiring the console

The AHOI compliance console currently generates its own vessel state internally
and reads it straight off a local object, so there is no single place to swap.
The smallest honest change is to introduce a telemetry object using these field
names, have its simulator write into that, then point it at this server:

```js
const TELEM = { position:{lat:null,lon:null}, sog_kn:null, cog_deg:null,
                heading_deg:null, depth_ft:null, engine_rpm:null, fix_type:null };

const ws = new WebSocket('ws://localhost:4001');
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'state') Object.assign(TELEM, m);
};
```

Detection, rules, attestation and the ledger are untouched — they read position
and speed, and do not care where those came from.

---

## Testing

```bash
npm test            # builds, then runs the suite: 75 tests, must all pass
npm run typecheck   # tsc --noEmit under strict
sudo ./deploy/verify-can.sh   # Linux only: proves MODE=can end to end, no hardware
```

`verify-can.sh` is the one the unit tests cannot replace. It creates a virtual
CAN interface, replays a known-value capture with `canplayer`, runs the server
in `MODE=can` against it and asserts every decoded field over WebSocket — using
the real native addon and a real kernel socket. **Verified passing 12/12.** Run
it on the Pi before going to the boat: if it passes there, only the physical
layer is left untested.

Every spec section 9 vector is covered, against frames hand-built in the tests
with raw integers computed there — not with the simulator's encoders, so a
matching bug on both sides cannot hide:

| Test | Expected |
|---|---|
| ID round-trip (PDU2) | pgn 129026, src 3, priority 2, dst 255 |
| ID PDU1 destination | dst preserved as 0x30 |
| SOG decode | `sog_kn` ≈ 24.1 (±0.05) |
| COG decode | `cog_deg` ≈ 78.4 (±0.05) |
| Position | 41.9520 / −70.6180 round-trips to ±1e-6 |
| Depth | 21.6 m → `depth_ft` ≈ 70.9 |
| Engine | raw 15360 → `engine_rpm` = 3840 |
| Sentinel | not-available payloads decode to `null` |
| Fast-packet | 43-byte 129029 split into 7 frames reassembles intact |
| Frame count | a 43-byte payload is exactly 7 frames |
| End-to-end | `MODE=sim` + a WS client sees all 7 PGNs and a full snapshot |

Plus: fast-packet robustness (out-of-order, missing first frame, sequence-id
mismatch, cross-source interleaving, TTL sweep), truncated and empty payloads
across every decoder, `VesselState` merge semantics, candump parsing, a full
`MODE=replay` round trip, and the CLI entry point.

And the deployment surface, which is what backs the claim that going to the boat
is configuration rather than a code change: every knob reachable from both an
env var and a flag, defaults unchanged from shipped, out-of-range values
rejected by name, `.env` precedence, and proof that `HOST` / `STATE_HZ` /
`VESSEL_ID` / `FAST_PACKET_TTL_MS` actually change runtime behaviour rather than
just parsing.

Non-zero exit on any failure, so CI fails loudly.

---

## Deviations from the build spec

Five, all deliberate. Three are bug fixes to constants the spec calls ground
truth; each would pass a test suite built against the spec's own simulator and
then fail on a real bus, which is the worst way to find out.

**1. `130306` wind reference is masked to 3 bits.** The spec reads byte 5 as a
whole `u8` with the map `0=true-north, 2=apparent`. In canboat the field is 3
bits followed by 5 reserved bits, and N2K pads reserved bits with **1s** — so on
a real bus that byte reads `0xFA` for apparent and matches neither case.
Implemented as `data[5] & 0x07`. Regression test:
`test/decoders.test.mjs` → "the reference is masked to 3 bits".

**2. `129029` fix method comes from the high nibble.** The spec reads
`data[31] & 0x0F` and applies the map `0=no fix, 1=GNSS, 2=DGNSS, …`. That enum
is canboat's **Method**, but the low nibble is **GNSS type** (the satellite
constellation). As specified, a GPS+GLONASS receiver reports `fix_type:
"DGNSS"`. Implemented as `(data[31] >> 4) & 0x0F`. Regression test:
"fix_type comes from the high nibble of byte 31".

**3. Both reserved values decode to `null`.** The spec lists only all-ones.
N2K reserves the top **two** values of every numeric field: max is "not
available", max−1 is "out of range / sensor error". Both are the absence of a
usable measurement. Note this is per-field-signedness: for signed fields the
sentinels are `0x7FFF` / `0x7FFE`, so an all-`0xFF` 129025 payload is `-1` raw —
a legitimate position — and is deliberately **not** special-cased. Pinned by
"signed fields use max-positive, not all-ones".

**4. The simulator emits all seven PGNs.** Spec section 11 lists five
(129026, 129025, 127250, 127488, 128267), but section 15 requires a sim-mode
client to see "all seven PGNs represented" and section 9 wants a snapshot with
"all fields in plausible range". Those cannot both hold. 129029 (as a real
7-frame fast-packet sequence) and 130306 were added, so the acceptance criteria
pass and the fast-packet path is exercised on every run rather than only in
tests.

**5. npm scripts use `--flags`, not inline env assignment.** Spec section 12
specifies `"sim": "MODE=sim ts-node src/server.ts"`, which is not valid syntax
in PowerShell or cmd — while section 15 requires sim mode to run on a non-Linux
machine. Environment variables still work everywhere and remain the documented
interface; the flags exist so `npm run sim` works on Windows without adding a
`cross-env` dependency.

Also worth knowing, not a deviation: `parseCanId` reads `dp = (id >> 24) & 0x3`,
deliberately spanning the J1939 data page **and** extended data page bits.
NMEA 2000 folds both into the PGN, which is why 130306 (`0x1FD02`) decodes.

---

## Project layout

| File | Responsibility |
|---|---|
| [`src/n2k.ts`](src/n2k.ts) | `CanFrame`, `parseCanId`, `buildCanId`, `FastPacketAssembler`, `fragmentFastPacket`, `FAST_PACKET_PGNS` |
| [`src/decoders.ts`](src/decoders.ts) | One function per PGN, the `DECODERS` registry, `decode()`, `Decoded` |
| [`src/state.ts`](src/state.ts) | `VesselState` and the `apply()` merge |
| [`src/sim.ts`](src/sim.ts) | Synthetic frame generator (`MODE=sim`) |
| [`src/config.ts`](src/config.ts) | Every knob, the `.env` loader, validation, `--print-config` |
| [`src/can.ts`](src/can.ts) | The SocketCAN adapter and interface inspection. **The only code that touches hardware.** |
| [`src/diagnostics.ts`](src/diagnostics.ts) | Bus monitor: frame rates, groups seen, groups missing, fast-packet health |
| [`src/doctor.ts`](src/doctor.ts) | Preflight check and bus survey (`npm run doctor`) |
| [`src/server.ts`](src/server.ts) | `ingest()`, frame sources, WebSocket fan-out, lifecycle |
| [`deploy/`](deploy/) | systemd unit and the `can-up.sh` bring-up helper |
| [`test/*.test.mjs`](test/) | Verification suite, run against the built output in `dist/` |

Strict TypeScript throughout, no `any` in the decode path, `tsc --noEmit` clean.
Every read is bounds-checked, so a truncated or malformed frame yields `null`
fields and never throws — one bad frame cannot stop the stream. Fast-packet
partials are swept on a 1 s interval with a 3 s TTL, so a lost final frame
cannot leak memory.

---

## Extending

To add a PGN:

1. Write a decoder in [`src/decoders.ts`](src/decoders.ts) following the shape
   of the existing seven, using the bounds-checked readers.
2. Register it in `DECODERS` (`SUPPORTED_PGNS` and the `hello` message follow
   automatically).
3. If the group exceeds 8 bytes, add its number to `FAST_PACKET_PGNS` in
   [`src/n2k.ts`](src/n2k.ts).
4. Add a known-value case to the test suite.
5. Surface any new field in `VesselState` and `apply()` if the console needs it.

---

## Boundaries

This server produces **vessel telemetry only**. Two other streams feed the
compliance record and are **not** on the NMEA 2000 bus — do not try to source
them here:

- **Whale detections** come from the SeaAI / FLIR cameras via their own APIs,
  surfaced through the Viam Data Client API.
- **External whale reports** come from public HTTP feeds (the Sentinel agent).

The signed compliance event is assembled at the edge from this server's decoded
values plus those two streams. Keep this service single-purpose: bus in,
normalized telemetry out.
