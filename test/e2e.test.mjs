/**
 * End to end: run MODE=sim, connect a WebSocket client, and assert the client
 * receives hello, per-PGN events and 5 Hz state snapshots with every field in a
 * plausible range (build spec sections 8, 9 and 15).
 *
 * Frames here are real binary N2K built by the simulator and pushed through the
 * same ingest() the boat will use, so this exercises the whole pipeline:
 * identifier decode, fast-packet reassembly, PGN decode, state merge, fan-out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import serverMod from '../dist/server.js';

const { loadConfig, startServer } = serverMod;

const EXPECTED_PGNS = [127250, 127488, 128267, 129025, 129026, 129029, 130306];

/** Collect messages from a client until `done(messages)` is true, or time out. */
function collect(url, done, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timed out after ${timeoutMs} ms with ${messages.length} messages`));
    }, timeoutMs);

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString()));
      if (done(messages)) {
        clearTimeout(timer);
        ws.close();
        resolve(messages);
      }
    });
  });
}

test('MODE=sim: a WS client receives hello, PGN events and a full state', async (t) => {
  const config = loadConfig(['--mode=sim', '--port=0'], {});
  const handle = await startServer(config);
  t.after(() => handle.close());

  const url = `ws://127.0.0.1:${handle.port}`;
  const messages = await collect(url, (m) => {
    const seen = new Set(m.filter((x) => x.type === 'pgn').map((x) => x.pgn));
    const states = m.filter((x) => x.type === 'state');
    return EXPECTED_PGNS.every((p) => seen.has(p)) && states.length >= 3;
  });

  /* hello, first and correctly shaped */
  const hello = messages[0];
  assert.equal(hello.type, 'hello');
  assert.equal(hello.vessel_id, 'WAVS-01');
  assert.deepEqual([...hello.pgns].sort((a, b) => a - b), EXPECTED_PGNS);

  /* a state snapshot follows immediately on connect */
  assert.equal(messages[1].type, 'state');

  /* per-PGN event stream: all seven parameter groups represented */
  const pgnEvents = messages.filter((m) => m.type === 'pgn');
  assert.ok(pgnEvents.length >= 5, `expected at least 5 PGN events, got ${pgnEvents.length}`);
  const seen = new Set(pgnEvents.map((m) => m.pgn));
  for (const pgn of EXPECTED_PGNS) assert.ok(seen.has(pgn), `no event for PGN ${pgn}`);

  for (const ev of pgnEvents) {
    assert.equal(typeof ev.src, 'number');
    assert.equal(typeof ev.ts, 'number');
    assert.equal(typeof ev.fields, 'object');
  }

  /* the consolidated snapshot, with every field in a plausible range */
  const last = messages.filter((m) => m.type === 'state').pop();
  const inRange = (key, lo, hi) => {
    const v = last[key];
    assert.ok(typeof v === 'number', `${key} is ${v}, expected a number`);
    assert.ok(v >= lo && v <= hi, `${key} = ${v}, expected ${lo}..${hi}`);
  };

  assert.equal(last.vessel_id, 'WAVS-01');
  assert.ok(last.position.lat > 41.8 && last.position.lat < 42.1, `lat ${last.position.lat}`);
  assert.ok(last.position.lon > -70.7 && last.position.lon < -70.2, `lon ${last.position.lon}`);
  inRange('sog_kn', 15, 30);
  inRange('cog_deg', 0, 360);
  inRange('heading_deg', 0, 360);
  inRange('depth_ft', 1, 250);
  inRange('engine_rpm', 500, 5000);
  inRange('wind_speed_kn', 1, 30);
  inRange('wind_angle_deg', 0, 360);
  inRange('satellites', 4, 24);
  assert.equal(last.fix_type, 'GNSS', 'fast-packet 129029 did not reach the snapshot');

  /* freshness map covers every PGN */
  for (const pgn of EXPECTED_PGNS) {
    assert.equal(typeof last.sources[pgn], 'number', `no freshness entry for ${pgn}`);
  }
});

test('state snapshots arrive at 5 Hz', async (t) => {
  const handle = await startServer(loadConfig(['--mode=sim', '--port=0'], {}));
  t.after(() => handle.close());

  const target = handle.config.stateIntervalMs;
  const messages = await collect(
    `ws://127.0.0.1:${handle.port}`,
    (m) => m.filter((x) => x.type === 'state').length >= 8,
  );
  // Drop the on-connect snapshot; the rest come off the 200 ms timer.
  const stamps = messages
    .filter((m) => m.type === 'state')
    .slice(1)
    .map((m) => m.ts);
  assert.ok(stamps.length >= 6);

  const spans = [];
  for (let i = 1; i < stamps.length; i++) spans.push(stamps[i] - stamps[i - 1]);
  const mean = spans.reduce((a, b) => a + b, 0) / spans.length;
  // ts is the last decode time, so it tracks the 200 ms broadcast loosely.
  assert.ok(
    mean > target * 0.4 && mean < target * 2.5,
    `mean snapshot spacing ${mean.toFixed(0)} ms is not near ${target} ms`,
  );
});

test('a reconnecting client immediately gets a fresh hello + state', async (t) => {
  const handle = await startServer(loadConfig(['--mode=sim', '--port=0'], {}));
  t.after(() => handle.close());
  const url = `ws://127.0.0.1:${handle.port}`;

  const first = await collect(url, (m) => m.filter((x) => x.type === 'pgn').length >= 5);
  assert.equal(first[0].type, 'hello');

  // Reconnect after the first client dropped, as it would offshore.
  const second = await collect(url, (m) => m.length >= 2);
  assert.equal(second[0].type, 'hello');
  assert.equal(second[1].type, 'state');
  // The snapshot survived the disconnect rather than restarting from null.
  assert.equal(typeof second[1].sog_kn, 'number');
});

test('the pipeline survives malformed frames without stopping the stream', async (t) => {
  const { createPipeline } = serverMod;
  const decodedPgns = [];
  const pipeline = createPipeline('WAVS-01', { onDecoded: (d) => decodedPgns.push(d.pgn) });

  // Garbage that must not throw.
  pipeline.ingest({ id: 0, data: Buffer.alloc(0), ts: 1 });
  pipeline.ingest({ id: 0xffffffff, data: Buffer.alloc(8, 0xff), ts: 1 });
  pipeline.ingest({ id: -1, data: Buffer.alloc(3), ts: 1 });
  pipeline.ingest({ id: 0x09f80203, data: Buffer.alloc(2), ts: 1 }); // truncated 129026

  // A good frame after the garbage still decodes.
  const good = Buffer.alloc(8, 0xff);
  good[0] = 1;
  good[1] = 0xf8;
  good.writeUInt16LE(13683, 2);
  good.writeUInt16LE(1240, 4);
  pipeline.ingest({ id: 0x09f80203, data: good, ts: 2 });

  assert.ok(decodedPgns.includes(129026), 'the stream stopped after a bad frame');
  assert.ok(pipeline.state.sog_kn > 24 && pipeline.state.sog_kn < 24.2);
  t.diagnostic(`decoded ${decodedPgns.length} groups through the garbage`);
});

test('close() stops the timers and releases the port', async () => {
  const handle = await startServer(loadConfig(['--mode=sim', '--port=0'], {}));
  const port = handle.port;
  await handle.close();

  // Rebinding the same port proves the listener really went away.
  const again = await startServer(loadConfig(['--mode=sim', `--port=${port}`], {}));
  assert.equal(again.port, port);
  await again.close();
});
