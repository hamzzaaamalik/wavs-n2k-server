# Linux + CAN Setup — WAVS N2K Telemetry Server

Start-to-finish bring-up on a Linux machine with a real NMEA 2000 connection.
Written to be followed top to bottom. Every command is copy-pasteable.

**Target:** Raspberry Pi (any model) or any Linux SBC/laptop.
**Time:** ~30 minutes, plus a reboot if you are installing a CAN HAT.

> **Bit rate is 250000, not 500000.** NMEA 2000 runs at a quarter of the
> automotive CAN rate. At the wrong rate you receive **zero frames and no error
> message**. This is the single most common way to lose an afternoon here.

Contents: [0. No hardware yet](#0-no-hardware-yet-test-the-whole-path-anyway) ·
[1. OS prep](#1-os-prep) · [2. CAN HAT](#2-can-hat-raspberry-pi-only) ·
[3. Interface up](#3-bring-the-interface-up) · [4. Sanity check](#4-sanity-check-the-bus) ·
[5. Install](#5-install-the-server) · [6. Preflight](#6-preflight) ·
[7. Run](#7-run-it) · [8. Service](#8-install-as-a-service) ·
[9. Verify](#9-verify-from-another-machine) · [Troubleshooting](#troubleshooting)

---

## 0. No hardware yet? Test the whole path anyway

Worth doing **before** the parts arrive. A virtual CAN interface exercises the
exact same SocketCAN code the boat will use — the only thing it does not prove
is the physical layer.

```bash
sudo apt update && sudo apt install -y can-utils
sudo modprobe vcan
sudo ip link add dev vcan0 type vcan
sudo ip link set up vcan0
```

Then jump to [step 1](#1-os-prep), and use `vcan0` wherever this guide says
`can0`. To push real traffic through it, replay a capture from the boat:

```bash
canplayer vcan0=can0 -I candump-2026-08-05.log
```

### Or just run the one-command proof

After [step 1](#1-os-prep) and [step 5](#5-install-the-server), this creates the
virtual interface, replays a known-value capture, runs `MODE=can` against it and
asserts every decoded field:

```bash
sudo ./deploy/verify-can.sh
```

```
    PASS  mode reported as can                          can
    PASS  sog_kn ~ 24.1                                 24.1
    PASS  fast-packet 129029 reassembled                12
    PASS  fix_type = DGNSS (high nibble)                DGNSS
    PASS  all 7 PGNs decoded                            7/7

  12/12 assertions passed
```

**This has already been run and passes.** If it passes on your machine too, then
the native addon, the kernel socket and every decoder are working there, and the
only thing left untested is the physical layer — the controller, the tap, and
the vessel's own devices. That is the cheapest possible way to separate "is the
software right" from "is the wiring right" *before* you are standing on a boat.

---

## 1. OS prep

### Node 22 or newer — required

The `socketcan` native addon declares `engines.node >= 22`. **npm skips an
engine-mismatched optional dependency silently**, so on Raspberry Pi OS's stock
Node 18 everything installs "successfully" and then `MODE=can` fails at run time
with a misleading *"addon is missing"* — sending you hunting for a compiler that
is already there.

```bash
node --version        # if this is below v22, run the next two lines

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version        # expect v22.x or newer
```

### Build tools and CAN utilities

```bash
sudo apt install -y build-essential can-utils git
```

- `build-essential` — the `socketcan` addon compiles from source.
- `can-utils` — provides `candump`, `cansend`, `canplayer`. You will use
  `candump` constantly for diagnosis.

---

## 2. CAN HAT (Raspberry Pi only)

Skip if you are using a USB-CAN adapter (those enumerate automatically) or
`vcan0`.

An MCP2515-based HAT — PiCAN-M, PiCAN2, Waveshare RS485-CAN — needs a device
tree overlay. Edit the boot config:

```bash
sudo nano /boot/firmware/config.txt      # Bookworm and newer
# older Raspberry Pi OS: /boot/config.txt
```

Add at the end:

```ini
dtparam=spi=on
dtoverlay=mcp2515-can0,oscillator=16000000,interrupt=25
dtoverlay=spi-bcm2835-overlay
```

> **Check your board's oscillator frequency** — this is the second most common
> failure. PiCAN-M / PiCAN2 are usually **16000000**; the Waveshare RS485-CAN HAT
> is **12000000**; some clones are **8000000**. The value is printed on the
> crystal or given in the board's documentation. A wrong oscillator produces
> exactly the same symptom as a wrong bit rate: silence, or a storm of error
> frames.

Reboot, then confirm the kernel created the device:

```bash
sudo reboot
# after it comes back:
dmesg | grep -i mcp251
ip link show can0
```

`ip link show can0` must list the interface. If it does not, the overlay did not
load — recheck the oscillator value and that SPI is enabled.

---

## 3. Bring the interface up

### Once, by hand

```bash
sudo ip link set can0 up type can bitrate 250000
sudo ip link set can0 type can restart-ms 100     # auto-recover after bus-off
ip -details link show can0                        # confirm: bitrate 250000
```

Or use the helper, which does both and verifies the result:

```bash
cd n2k-server
sudo ./deploy/can-up.sh can0
```

### At every boot

Raspberry Pi OS Bookworm uses NetworkManager, which does not configure CAN
interfaces. Use the supplied unit — it works regardless of network stack:

```bash
sudo cp deploy/can0.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now can0
systemctl status can0
```

---

## 4. Sanity check the bus

**Do this before touching the server.** If frames do not scroll here, no amount
of software configuration will help.

```bash
candump can0
```

Expect a fast scroll of lines like:

```
  can0  09F80203   [8]  01 00 73 35 D8 04 FF FF
  can0  09F80102   [8]  C0 B9 01 19 E0 A5 CC FA
```

Press Ctrl-C. If nothing appears, go to [Troubleshooting](#troubleshooting) —
do not continue.

### Record a capture while you are here

Ten minutes of real traffic is the most valuable artifact on this whole page. It
lets the decoders be validated at a desk, by anyone, with no hardware.

```bash
candump -l can0        # writes candump-<date>.log; run ~10 min underway
```

---

## 5. Install the server

```bash
cd n2k-server
npm install            # compiles the socketcan addon here; needs build-essential
npm run build
npm test               # 75 tests, all must pass
```

If `npm install` prints warnings about `socketcan` but continues, that is the
**optional** dependency failing — check `node --version` is ≥ 22 and that
`build-essential` is installed, then `rm -rf node_modules && npm install`.

---

## 6. Preflight

```bash
npm run doctor -- --can-if=can0 --seconds=15
```

This is the step that saves the afternoon. It checks, in order: platform, Node
version, that the native addon loads, that the interface exists and is up, and
**that the bit rate is 250000 and not 500000**. Then it listens on the live bus
and reports what this vessel actually emits:

```
[  OK  ] platform is linux
[  OK  ] node v22.11.0
[  OK  ] native socketcan addon loads
[  OK  ] interface can0 exists (can)
[  OK  ] can0 operstate is up
[  OK  ] bitrate is 250000 (NMEA 2000)

Listening on can0 for 15s ...

  14203 frames in 15s  (946.9/s)
  1284 decoded, 12919 from groups we do not decode

  Compliance-critical groups present:
    129026    148 frames    9.9/s  src 2
    129025    148 frames    9.9/s  src 2
    127250    147 frames    9.8/s  src 5
    128267     15 frames    1.0/s  src 35

  MISSING (never seen): 127488, 130306
    A missing group means no device on this backbone emits it.
    Its VesselState fields will stay null. That is a wiring answer,
    not a software one.

READY, with gaps. 2 of 7 groups are absent: 127488, 130306
```

Exit code **0 = ready**, **1 = fix something first**, so it drops into a
provisioning script.

**A missing group is information, not a failure.** If 127488 is absent, this
boat's engine does not report on NMEA 2000 — it may be J1939 behind a gateway
that is not fitted. `engine_rpm` will stay `null`. Only 129026 (`sog_kn`) is
load-bearing for the speed rule.

---

## 7. Run it

```bash
MODE=can CAN_IF=can0 node dist/server.js
```

```
[n2k] mode=can iface=can0 bind=0.0.0.0:4001 vessel=WAVS-01 pgns=7 state=5Hz
[n2k] can0 open
[n2k] bus 946.9/s in, 21.4/s decoded | groups 4 known + 23 other | fastpkt ok=148 drop=0 swept=0 pending=0 | can err=0 rtr=0
```

Watch the stats line. `can err=` climbing means the controller is reporting bus
faults — that is a wiring problem, not a decoder problem. See
[Troubleshooting](#troubleshooting).

### Sanity-check the numbers against the chartplotter

**Please do this.** Thirty seconds, and it closes a gap no automated test can.
The decoders are verified against the written spec, not against this vessel's
actual firmware — and three errors were already found in that spec.

Compare the server's `sog_kn` and `depth_ft` with what the boat's own display
shows. They should agree closely. If they do not, capture 60 seconds with
`candump -l can0` and send it back — that is a decoder bug worth knowing about.

---

## 8. Install as a service

```bash
sudo useradd -r -s /usr/sbin/nologin wavs 2>/dev/null || true
sudo mkdir -p /opt/wavs && sudo cp -r . /opt/wavs/n2k-server
sudo chown -R wavs:wavs /opt/wavs/n2k-server

sudo mkdir -p /etc/wavs
sudo cp .env.example /etc/wavs/n2k.env
sudo nano /etc/wavs/n2k.env
```

Set at minimum:

```ini
MODE=can
CAN_IF=can0
VESSEL_ID=WAVS-01
```

Then:

```bash
sudo cp deploy/n2k-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now n2k-server
journalctl -u n2k-server -f
```

Confirm what it actually resolved:

```bash
cd /opt/wavs/n2k-server && ENV_FILE=/etc/wavs/n2k.env npm run config
```

**Boot ordering is handled.** systemd routinely starts services before `can0` is
configured. Rather than crash-looping, the server retries every `CAN_RETRY_MS`
and logs the exact command to fix it:

```
[n2k] cannot open can0 (attempt 1): ...
[n2k] retrying in 5000 ms. Is the interface up?  sudo ip link set can0 up type can bitrate 250000
[n2k] can0 open after 3 attempts
```

---

## 9. Verify from another machine

Find the Pi's address, then connect from a laptop on the same network:

```bash
hostname -I
```

```bash
# on the laptop
npx wscat -c ws://<pi-ip>:4001
```

You should immediately receive a `hello`, then a `state` snapshot, then a
continuous stream. If it hangs, check the firewall on the Pi:

```bash
sudo ufw status
sudo ufw allow 4001/tcp        # only if ufw is active
```

To restrict the feed to the Pi itself, set `HOST=127.0.0.1` in
`/etc/wavs/n2k.env` and restart.

---

## Troubleshooting

| Symptom | Most likely cause | Fix |
|---|---|---|
| `candump` shows nothing | **Wrong bit rate** | `ip -details link show can0` — must read `bitrate 250000`, not 500000 |
| `candump` shows nothing | Drop cable not seated, or backbone unpowered | Reseat the tee; confirm the N2K network has 12 V |
| `candump` shows nothing | Missing termination | 120 Ω at **both** ends of the trunk. Not one, not three |
| `ip link show can0` → device not found | Overlay did not load | Recheck `dtoverlay` line and the **oscillator frequency** for your HAT; `dmesg \| grep mcp251` |
| Storm of error frames / `can err=` climbing | Wrong oscillator, wrong bit rate, or bad termination | Check the oscillator value first — it mimics every other fault |
| `addon is missing` | **Node < 22** (npm skipped the optional dep silently) | `node --version`; install Node 22 via NodeSource, then `rm -rf node_modules && npm install` |
| `addon is missing`, Node is fine | No compiler | `sudo apt install build-essential && npm install` |
| Server starts, all fields `null` | Frames arriving but no group decoded | `npm run doctor` — it lists which groups are present and which are missing |
| One field stays `null`, others fine | No device emits that group | Expected. See the doctor's MISSING list — that is a wiring answer |
| `cannot open can0`, retrying | Interface not up yet | `sudo systemctl enable --now can0`; the server recovers on its own once it is |
| Console cannot connect | Firewall, or bound to localhost | `sudo ufw allow 4001/tcp`; check `HOST` in the env file |
| Numbers disagree with the chartplotter | Possible decoder bug | Capture 60 s with `candump -l can0` and send it back |

### Diagnostic one-liners

```bash
ip -details link show can0        # bitrate, state, error counters
candump can0 | head -20           # is anything arriving at all
candump -l can0                   # record for offline analysis
npm run doctor -- --can-if=can0   # full preflight + bus survey
npm run config                    # what configuration actually resolved
journalctl -u n2k-server -n 50    # recent service log
```

---

## What to send back

If anything does not work, these three things make it diagnosable remotely:

1. `npm run doctor -- --can-if=can0 --seconds=15` — full output
2. `ip -details link show can0` — full output
3. A 60-second `candump -l can0` capture

With those, the problem can be reproduced at a desk using `MODE=replay` without
anyone returning to the boat.
