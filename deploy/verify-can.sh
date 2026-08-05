#!/usr/bin/env bash
# Prove MODE=can works on THIS machine, end to end, with no CAN hardware.
#
#   sudo ./deploy/verify-can.sh              # creates and uses vcan0
#   sudo ./deploy/verify-can.sh can0         # use a real interface instead
#
# Creates a virtual CAN interface, replays a known-value capture onto it with
# canplayer, runs the server in MODE=can against it, and asserts the decoded
# telemetry over WebSocket. This exercises the real native socketcan addon and
# the real kernel socket — the one path the unit tests cannot reach.
#
# Run this before going to the boat. Exit 0 means the whole stack works on this
# machine and only the physical layer remains.
#
# Requires: node >= 22, can-utils, iproute2, and `npm install && npm run build`.

set -u

IFACE="${1:-vcan0}"
CREATED=0
PORT="${VERIFY_PORT:-4788}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
cd "$ROOT"

cleanup() {
  [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null
  [ "$CREATED" = "1" ] && ip link delete "$IFACE" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo; echo "FAILED: $1"; exit 1; }

echo "=== N2K MODE=can verification ==============================="
echo "  interface : $IFACE"
echo "  node      : $(node --version 2>/dev/null || echo MISSING)"
echo "  kernel    : $(uname -r)"
echo

command -v canplayer >/dev/null || fail "canplayer not found. sudo apt install can-utils"
[ -d dist ] || fail "not built. Run: npm install && npm run build"

# 1. interface -------------------------------------------------------------
if ! ip link show "$IFACE" >/dev/null 2>&1; then
  echo "Creating virtual interface $IFACE"
  modprobe vcan 2>/dev/null
  ip link add dev "$IFACE" type vcan 2>/dev/null || fail "could not create $IFACE (need root, and a kernel with vcan)"
  ip link set up "$IFACE" || fail "could not bring up $IFACE"
  CREATED=1
fi
ip -br link show "$IFACE"
echo

# 2. the native addon ------------------------------------------------------
node -e "require('socketcan')" 2>/dev/null \
  || fail "the native socketcan addon does not load. Check node >= 22 and build-essential, then: rm -rf node_modules && npm install"
echo "socketcan addon loads OK"

# 3. known-value capture ---------------------------------------------------
node -e "
const n2k = require('$ROOT/dist/n2k.js'), fs = require('fs');
const lines = []; let t = 1770000000;
const line = (pgn, src, data) =>
  '(' + (t += 0.01).toFixed(6) + ') $IFACE ' +
  n2k.buildCanId({priority:3, pgn, src}).toString(16).toUpperCase().padStart(8,'0') +
  '#' + data.toString('hex').toUpperCase();

const a = Buffer.alloc(8, 0xff);                       // 129026: 24.1 kn, 78.4 deg
a[0]=1; a[1]=0xf8; a.writeUInt16LE(13683,2); a.writeUInt16LE(1240,4);
lines.push(line(129026, 2, a));

const b = Buffer.alloc(8);                             // 129025: 41.9520 / -70.6180
b.writeInt32LE(419520000,0); b.writeInt32LE(-706180000,4);
lines.push(line(129025, 2, b));

const h = Buffer.alloc(8, 0xff);                       // 127250: heading 76.09
h[0]=1; h.writeUInt16LE(Math.round((76.09/(180/Math.PI))*1e4),1); h[7]=0xFC;
lines.push(line(127250, 5, h));

const c = Buffer.alloc(8, 0xff);                       // 128267: 21.6 m
c[0]=1; c.writeUInt32LE(2160,1); c.writeInt16LE(0,5);
lines.push(line(128267, 35, c));

const d = Buffer.alloc(8, 0xff);                       // 127488: 3840 rpm
d[0]=0; d.writeUInt16LE(15360,1);
lines.push(line(127488, 20, d));

const e = Buffer.alloc(8, 0xff);                       // 130306: apparent wind,
e[0]=1; e.writeUInt16LE(731,1); e.writeUInt16LE(25307,3); e[5]=0xFA;  // reserved bits set
lines.push(line(130306, 40, e));

const g = Buffer.alloc(43, 0xff);                      // 129029: 43 bytes, 7 frames
g[0]=1;
g.writeBigInt64LE(BigInt(419520000000)*1000000n, 7);
g.writeBigInt64LE(BigInt(-706180000000)*1000000n, 15);
g[31] = (0x2<<4)|0x0; g[33] = 12;
for (const f of n2k.fragmentFastPacket(g)) lines.push(line(129029, 2, f));

fs.writeFileSync('$TMP/capture.log', lines.join('\n') + '\n');
console.log('Built a ' + lines.length + '-frame capture (7 of them one fast-packet sequence)');
" || fail "could not build the capture"

# 4. run + replay + assert -------------------------------------------------
MODE=can CAN_IF="$IFACE" PORT="$PORT" STATS_INTERVAL_S=0 LOG_LEVEL=info \
  node dist/server.js > "$TMP/server.log" 2>&1 &
SRV=$!

for _ in $(seq 1 60); do
  grep -q "$IFACE open" "$TMP/server.log" && break
  sleep 0.25
done
grep -q "$IFACE open" "$TMP/server.log" || { cat "$TMP/server.log"; fail "server never opened $IFACE"; }
echo
sed 's/^/  /' "$TMP/server.log"
echo

node -e "
const { WebSocket } = require('$ROOT/node_modules/ws');
const { execSync } = require('child_process');
const ws = new WebSocket('ws://127.0.0.1:$PORT');
const pgns = new Map(); let state = null, hello = null;
ws.on('error', e => { console.error('  WS error:', e.message); process.exit(1); });
ws.on('open', () => setTimeout(() => {
  try { execSync('canplayer $IFACE=$IFACE -I $TMP/capture.log'); }
  catch (e) { console.error('  canplayer failed:', e.message); process.exit(1); }
}, 200));
ws.on('message', r => {
  const m = JSON.parse(r.toString());
  if (m.type === 'hello') hello = m;
  if (m.type === 'pgn') pgns.set(m.pgn, m.fields);
  if (m.type === 'state') state = m;
});
setTimeout(() => {
  if (!state) { console.error('  no state snapshot received'); process.exit(1); }
  console.log('  Decoded off the CAN interface:');
  for (const [p, f] of [...pgns].sort((x, y) => x[0] - y[0]))
    console.log('    ' + p + '  ' + JSON.stringify(f));
  console.log();
  const results = [];
  const chk = (name, cond, got) => {
    results.push(cond);
    console.log('    ' + (cond ? 'PASS' : 'FAIL') + '  ' + name.padEnd(46) + String(got));
  };
  const w = pgns.get(130306);
  chk('mode reported as can',            hello && hello.mode === 'can',              hello && hello.mode);
  chk('sog_kn ~ 24.1',                   Math.abs(state.sog_kn - 24.1) < 0.05,       state.sog_kn);
  chk('cog_deg ~ 78.4',                  Math.abs(state.cog_deg - 78.4) < 0.05,      state.cog_deg);
  chk('heading_deg ~ 76.09',             Math.abs(state.heading_deg - 76.09) < 0.05, state.heading_deg);
  chk('lat ~ 41.9520',                   Math.abs(state.position.lat - 41.952) < 1e-6,  state.position.lat);
  chk('lon ~ -70.6180',                  Math.abs(state.position.lon + 70.618) < 1e-6,  state.position.lon);
  chk('depth_ft ~ 70.9',                 Math.abs(state.depth_ft - 70.9) < 0.1,      state.depth_ft);
  chk('engine_rpm = 3840',               state.engine_rpm === 3840,                  state.engine_rpm);
  chk('fast-packet 129029 reassembled',  state.satellites === 12,                    state.satellites);
  chk('fix_type = DGNSS (high nibble)',  state.fix_type === 'DGNSS',                 state.fix_type);
  chk('wind_reference = apparent (mask)', w && w.wind_reference === 'apparent',      w && w.wind_reference);
  chk('all 7 PGNs decoded',              pgns.size === 7,                            pgns.size + '/7');
  const passed = results.filter(Boolean).length;
  console.log();
  console.log('  ' + passed + '/' + results.length + ' assertions passed');
  process.exit(results.every(Boolean) ? 0 : 1);
}, 3000);
"
RC=$?

echo
if [ $RC -eq 0 ]; then
  echo "=== PASS ===================================================="
  echo "  MODE=can works on this machine: the native addon, the kernel"
  echo "  socket, fast-packet reassembly and every decoder."
  echo "  What remains untested is only the physical layer: the CAN"
  echo "  controller, the tap, and this vessel's own devices."
else
  echo "=== FAIL ===================================================="
  echo "  Send this output plus:  ip -details link show $IFACE"
fi
exit $RC
