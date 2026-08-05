/**
 * Deployment surface: every knob is reachable from configuration, the .env
 * loader behaves, and the diagnostics report what an operator needs.
 *
 * These are the tests that back the claim "going to the boat is configuration,
 * not a code change".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import configMod from '../dist/config.js';
import serverMod from '../dist/server.js';
import diagMod from '../dist/diagnostics.js';
import n2k from '../dist/n2k.js';

const { loadConfig, loadEnvFile, formatConfig, CONFIG_SPEC, N2K_BITRATE } = configMod;
const { startServer, createPipeline } = serverMod;
const { BusMonitor, formatBusReport, formatBusLine } = diagMod;
const { buildCanId, FastPacketAssembler, fragmentFastPacket } = n2k;

/* ---------------------------------------------------------------- *
 * Every knob is configurable
 * ---------------------------------------------------------------- */

test('every knob in CONFIG_SPEC resolves from both an env var and a flag', () => {
  for (const spec of CONFIG_SPEC) {
    const probe = spec.env === 'MODE' ? 'can' : spec.env === 'LOG_LEVEL' ? 'debug' : null;
    if (probe === null) continue;
    assert.equal(loadConfig([], { [spec.env]: probe })[spec.prop], probe, `${spec.env} via env`);
    assert.equal(
      loadConfig([`--${spec.flag}=${probe}`], {})[spec.prop],
      probe,
      `--${spec.flag} via flag`,
    );
  }
});

test('the previously hard-coded values are now configuration', () => {
  const c = loadConfig(
    [
      '--host=127.0.0.1',
      '--state-hz=10',
      '--fast-packet-ttl-ms=5000',
      '--sweep-interval-ms=2000',
      '--stats-interval-s=15',
      '--can-retry-ms=1000',
      '--shutdown-grace-ms=500',
      '--replay-max-gap-ms=50',
      '--replay-loop=true',
    ],
    {},
  );
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.stateHz, 10);
  assert.equal(c.stateIntervalMs, 100, 'stateIntervalMs is derived from stateHz');
  assert.equal(c.fastPacketTtlMs, 5000);
  assert.equal(c.sweepIntervalMs, 2000);
  assert.equal(c.statsIntervalS, 15);
  assert.equal(c.canRetryMs, 1000);
  assert.equal(c.shutdownGraceMs, 500);
  assert.equal(c.replayMaxGapMs, 50);
  assert.equal(c.replayLoop, true);
});

test('defaults are unchanged, so an unconfigured deployment behaves as shipped', () => {
  const c = loadConfig([], {});
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.port, 4001);
  assert.equal(c.stateHz, 5);
  assert.equal(c.stateIntervalMs, 200);
  assert.equal(c.fastPacketTtlMs, 3000);
  assert.equal(c.sweepIntervalMs, 1000);
  assert.equal(N2K_BITRATE, 250000);
});

test('out-of-range values are rejected with the knob named', () => {
  assert.throws(() => loadConfig(['--state-hz=0'], {}), /Invalid STATE_HZ/);
  assert.throws(() => loadConfig(['--state-hz=999'], {}), /Invalid STATE_HZ/);
  assert.throws(() => loadConfig(['--fast-packet-ttl-ms=10'], {}), /Invalid FAST_PACKET_TTL_MS/);
  assert.throws(() => loadConfig(['--log-level=chatty'], {}), /Unknown LOG_LEVEL/);
  assert.throws(() => loadConfig(['--shutdown-grace-ms=-1'], {}), /Invalid SHUTDOWN_GRACE_MS/);
});

test('--print-config reports every knob and where its value came from', () => {
  const text = formatConfig(loadConfig(['--state-hz=2'], { VESSEL_ID: 'WAVS-09' }));
  for (const spec of CONFIG_SPEC) assert.match(text, new RegExp(spec.env), `${spec.env} missing`);
  assert.match(text, /STATE_HZ\s+2\s+flag/);
  assert.match(text, /VESSEL_ID\s+WAVS-09\s+env/);
  assert.match(text, /PORT\s+4001\s+default/);
});

/* ---------------------------------------------------------------- *
 * .env file
 * ---------------------------------------------------------------- */

test('loadEnvFile parses a .env and never overrides the real environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'n2k-env-'));
  const file = join(dir, '.env');
  writeFileSync(
    file,
    ['# a comment', '', 'VESSEL_ID=WAVS-42', 'MODE = can', 'HOST="10.0.0.5"', 'PORT=5000'].join('\n'),
  );

  const env = { PORT: '9999' }; // already set: must win over the file
  const applied = loadEnvFile(file, env);
  rmSync(dir, { recursive: true, force: true });

  // 4 keys in the file, but PORT was already set, so only 3 were applied.
  assert.equal(applied, 3);
  assert.equal(env.VESSEL_ID, 'WAVS-42');
  assert.equal(env.MODE, 'can');
  assert.equal(env.HOST, '10.0.0.5', 'quotes stripped');
  assert.equal(env.PORT, '9999', 'the real environment was overridden by the file');

  const c = loadConfig([], env);
  assert.equal(c.vesselId, 'WAVS-42');
  assert.equal(c.mode, 'can');
});

test('a missing .env is not an error', () => {
  assert.equal(loadEnvFile(join(tmpdir(), 'definitely-not-here-3f9a', '.env'), {}), -1);
});

/* ---------------------------------------------------------------- *
 * Configuration actually takes effect at runtime
 * ---------------------------------------------------------------- */

test('HOST binds where told, and a configured rate is the rate used', async (t) => {
  const handle = await startServer(
    loadConfig(['--mode=sim', '--port=0', '--host=127.0.0.1', '--state-hz=20'], {}),
  );
  t.after(() => handle.close());
  assert.equal(handle.config.stateIntervalMs, 50);

  const seen = [];
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}`);
    const timer = setTimeout(() => reject(new Error('no snapshots')), 8000);
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'hello') seen.push(m);
      if (m.type === 'state') seen.push(m);
      if (seen.length >= 14) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
  });

  const hello = seen[0];
  assert.equal(hello.state_hz, 20, 'hello advertises the configured rate');
  assert.equal(hello.mode, 'sim');
  // 14 messages inside 8 s is only reachable well above the 5 Hz default.
  assert.ok(seen.length >= 14);
});

test('a vessel id set purely by configuration reaches the wire', async (t) => {
  const handle = await startServer(
    loadConfig(['--mode=sim', '--port=0'], { VESSEL_ID: 'WAVS-77' }),
  );
  t.after(() => handle.close());

  const hello = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}`);
    const timer = setTimeout(() => reject(new Error('no hello')), 5000);
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'hello') {
        clearTimeout(timer);
        ws.close();
        resolve(m);
      }
    });
  });
  assert.equal(hello.vessel_id, 'WAVS-77');
  assert.equal(handle.state.vessel_id, 'WAVS-77');
});

test('the configured fast-packet TTL is the TTL enforced', () => {
  const asm = new FastPacketAssembler(500);
  const frames = fragmentFastPacket(Buffer.alloc(43, 0x01));
  asm.add(2, 129029, frames[0], 1000);
  assert.equal(asm.sweep(1400), 0, 'swept before the configured TTL elapsed');
  assert.equal(asm.sweep(1600), 1, 'not swept after the configured TTL elapsed');
});

/* ---------------------------------------------------------------- *
 * Diagnostics
 * ---------------------------------------------------------------- */

test('the assembler counts completions, drops and sweeps', () => {
  const asm = new FastPacketAssembler(3000);
  const frames = fragmentFastPacket(Buffer.alloc(43, 0x01));

  for (const f of frames) asm.add(2, 129029, f, 1000); // one clean sequence
  assert.equal(asm.stats.started, 1);
  assert.equal(asm.stats.completed, 1);

  asm.add(2, 129029, frames[3], 2000); // orphan continuation
  assert.equal(asm.stats.dropped, 1);

  asm.add(2, 129029, frames[0], 3000);
  asm.add(2, 129029, frames[4], 3001); // out of order
  assert.equal(asm.stats.dropped, 2);

  asm.add(2, 129029, frames[0], 4000);
  asm.sweep(9000);
  assert.equal(asm.stats.swept, 1);
});

test('the bus monitor separates known groups from the rest of the traffic', () => {
  const monitor = new BusMonitor(0);
  monitor.record(129026, 2, 100, true);
  monitor.record(129026, 2, 200, true);
  monitor.record(129026, 7, 300, true);
  monitor.record(60928, 12, 400, false); // ISO address claim, not decoded
  monitor.record(126992, 12, 500, false); // system time, not decoded

  const s = monitor.snapshot({ started: 1, completed: 1, dropped: 0, swept: 0, pending: 0 }, 1000);
  assert.equal(s.frames, 5);
  assert.equal(s.decoded, 3);
  assert.equal(s.ignored, 2);
  assert.equal(s.known.length, 1);
  assert.equal(s.known[0].pgn, 129026);
  assert.deepEqual(s.known[0].sources, [2, 7], 'source addresses are tracked');
  assert.equal(s.unknown.length, 2);
  assert.deepEqual(s.missing, [127250, 127488, 128267, 129025, 129029, 130306]);
});

test('the bus report names the missing groups, which is a wiring answer', () => {
  const monitor = new BusMonitor(0);
  monitor.record(129026, 2, 100, true);
  const s = monitor.snapshot({ started: 0, completed: 0, dropped: 0, swept: 0, pending: 0 }, 1000);

  const report = formatBusReport(s);
  assert.match(report, /MISSING \(never seen\)/);
  assert.match(report, /127488/);
  assert.match(report, /wiring answer/);

  const line = formatBusLine(s);
  assert.match(line, /MISSING/);
  assert.match(line, /fastpkt/);
});

test('a live pipeline reports its own bus health', () => {
  const pipeline = createPipeline('WAVS-01');
  const id = buildCanId({ priority: 2, pgn: 129026, src: 3 });
  const data = Buffer.alloc(8, 0xff);
  data[0] = 1;
  data[1] = 0xf8;
  data.writeUInt16LE(13683, 2);
  data.writeUInt16LE(1240, 4);
  for (let i = 0; i < 10; i++) pipeline.ingest({ id, data, ts: 1000 + i });

  // Traffic we do not decode must still be counted, not silently dropped.
  pipeline.ingest({ id: buildCanId({ priority: 6, pgn: 60928, src: 12 }), data, ts: 1100 });

  const bus = pipeline.bus();
  assert.equal(bus.frames, 11);
  assert.equal(bus.decoded, 10);
  assert.equal(bus.ignored, 1);
  assert.equal(bus.unknown[0].pgn, 60928);
  assert.ok(bus.missing.includes(129029), 'never-seen groups are reported');
});

/* ---------------------------------------------------------------- *
 * SocketCAN frame filtering
 *
 * Verified against socketcan 4.2.4's own src/can.d.ts, which declares
 * Message as { id, ext, rtr, data, err? }. An error frame's identifier is a
 * bitmask, not a PGN: decoding it would invent parameter groups that are not
 * on the bus and mask the fault it is reporting.
 * ---------------------------------------------------------------- */

import canMod from '../dist/can.js';
const { toCanFrame, newRxStats } = canMod;

test('toCanFrame converts the addon message shape, timestamps included', () => {
  const frame = toCanFrame({
    id: 0x09f80203,
    data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    ext: true,
    rtr: false,
    ts_sec: 1770000000,
    ts_usec: 123456,
  });
  assert.equal(frame.id, 0x09f80203);
  assert.equal(frame.data.length, 8);
  assert.ok(Buffer.isBuffer(frame.data));
  assert.equal(frame.ts, 1770000000123);
});

test('toCanFrame falls back to wall clock when the addon omits timestamps', () => {
  const before = Date.now();
  const frame = toCanFrame({ id: 0x09f80203, data: Buffer.alloc(8) });
  assert.ok(frame.ts >= before && frame.ts <= Date.now());
});

test('a fresh rx stats block starts at zero', () => {
  assert.deepEqual(newRxStats(), { accepted: 0, error: 0, remote: 0 });
});

test('error and remote frames are counted and never reach the decoders', () => {
  // Reproduces what openRawChannel's listener does, without the native addon.
  const stats = newRxStats();
  const pipeline = createPipeline('WAVS-01');
  const feed = (msg) => {
    if (msg.err === true) { stats.error += 1; return; }
    if (msg.rtr === true) { stats.remote += 1; return; }
    stats.accepted += 1;
    pipeline.ingest(toCanFrame(msg));
  };

  const good = Buffer.alloc(8, 0xff);
  good[0] = 1; good[1] = 0xf8;
  good.writeUInt16LE(13683, 2);
  good.writeUInt16LE(1240, 4);

  feed({ id: buildCanId({ priority: 2, pgn: 129026, src: 3 }), data: good });
  feed({ id: 0x20000004, data: Buffer.alloc(8), err: true });  // controller/bus fault
  feed({ id: 0x20000001, data: Buffer.alloc(8), err: true });
  feed({ id: buildCanId({ priority: 3, pgn: 129025, src: 2 }), data: Buffer.alloc(8), rtr: true });

  assert.deepEqual(stats, { accepted: 1, error: 2, remote: 1 });

  const bus = pipeline.bus();
  assert.equal(bus.frames, 1, 'only the real frame reached ingest');
  assert.equal(bus.unknown.length, 0, 'no phantom PGN invented from an error bitmask');
  assert.ok(pipeline.state.sog_kn > 24 && pipeline.state.sog_kn < 24.2);
});
