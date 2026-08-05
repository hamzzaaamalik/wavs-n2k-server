/**
 * Configuration, the CLI entry point, and MODE=replay.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import serverMod from '../dist/server.js';
import n2k from '../dist/n2k.js';

const { loadConfig, startServer, parseCandumpLine } = serverMod;
const { buildCanId, fragmentFastPacket } = n2k;

const SERVER = fileURLToPath(new URL('../dist/server.js', import.meta.url));

/* ---------------------------------------------------------------- *
 * Config
 * ---------------------------------------------------------------- */

test('config defaults match the spec', () => {
  const c = loadConfig([], {});
  assert.equal(c.mode, 'sim');
  assert.equal(c.port, 4001);
  assert.equal(c.canIf, 'can0');
  assert.equal(c.vesselId, 'WAVS-01');
  assert.equal(c.logLevel, 'info');
});

test('config reads the environment', () => {
  const c = loadConfig([], {
    MODE: 'can',
    PORT: '9001',
    CAN_IF: 'can1',
    VESSEL_ID: 'WAVS-07',
    LOG_LEVEL: 'debug',
  });
  assert.equal(c.mode, 'can');
  assert.equal(c.port, 9001);
  assert.equal(c.canIf, 'can1');
  assert.equal(c.vesselId, 'WAVS-07');
  assert.equal(c.logLevel, 'debug');
});

test('flags win over the environment, so the npm scripts work on Windows', () => {
  const c = loadConfig(['--mode=sim', '--port=4002'], { MODE: 'can', PORT: '4001' });
  assert.equal(c.mode, 'sim');
  assert.equal(c.port, 4002);
});

test('an unknown mode or port is rejected loudly', () => {
  assert.throws(() => loadConfig(['--mode=magic'], {}), /Unknown MODE/);
  assert.throws(() => loadConfig(['--port=70000'], {}), /Invalid PORT/);
  assert.throws(() => loadConfig([], { PORT: 'abc' }), /Invalid PORT/);
});

/* ---------------------------------------------------------------- *
 * candump parsing
 * ---------------------------------------------------------------- */

test('parseCandumpLine reads the candump -l format', () => {
  const f = parseCandumpLine('(1770000000.123456) can0 09F80203#0100733508D8FFFF');
  assert.equal(f.id, 0x09f80203);
  assert.equal(f.data.length, 8);
  assert.equal(f.data[0], 0x01);
  assert.equal(f.ts, 1770000000123);
});

test('parseCandumpLine tolerates a missing timestamp and rejects junk', () => {
  const f = parseCandumpLine('can0 09F80203#0102');
  assert.equal(f.id, 0x09f80203);
  assert.equal(f.data.length, 2);
  assert.equal(parseCandumpLine(''), null);
  assert.equal(parseCandumpLine('# a comment'), null);
  assert.equal(parseCandumpLine('can0 09F80203#0102030405060708AA'), null, 'over 8 bytes');
});

/* ---------------------------------------------------------------- *
 * MODE=replay
 * ---------------------------------------------------------------- */

test('MODE=replay decodes a recorded capture through the same pipeline', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'n2k-replay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'capture.log');

  const line = (pgn, src, data, seconds) =>
    `(177000${String(seconds).padStart(4, '0')}.000000) can0 ` +
    `${buildCanId({ priority: 3, pgn, src }).toString(16).toUpperCase().padStart(8, '0')}#` +
    `${data.toString('hex').toUpperCase()}`;

  const lines = [];

  // 129026 carrying 24.1 kn / 78.4 deg.
  const cogSog = Buffer.alloc(8, 0xff);
  cogSog[0] = 1;
  cogSog[1] = 0xf8;
  cogSog.writeUInt16LE(13683, 2);
  cogSog.writeUInt16LE(1240, 4);
  lines.push(line(129026, 2, cogSog, 0));

  // A full 7-frame 129029 fast-packet sequence.
  const gnss = Buffer.alloc(43, 0xff);
  gnss[0] = 1;
  gnss.writeBigInt64LE(BigInt(Math.round(41.952 * 1e10)) * 1000000n, 7);
  gnss.writeBigInt64LE(BigInt(Math.round(-70.618 * 1e10)) * 1000000n, 15);
  gnss[31] = (0x2 << 4) | 0x0; // DGNSS fix
  gnss[33] = 12;
  for (const frame of fragmentFastPacket(gnss)) lines.push(line(129029, 2, frame, 1));

  writeFileSync(file, lines.join('\n') + '\n', 'utf8');

  const handle = await startServer(
    loadConfig(['--mode=replay', '--port=0', `--replay-file=${file}`, '--replay-speed=1000'], {}),
  );
  t.after(() => handle.close());

  const ws = new WebSocket(`ws://127.0.0.1:${handle.port}`);
  const state = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('replay produced no complete state')), 8000);
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'state' && msg.fix_type !== null && msg.sog_kn !== null) {
        clearTimeout(timer);
        ws.close();
        resolve(msg);
      }
    });
  });

  assert.ok(Math.abs(state.sog_kn - 24.1) < 0.05, `sog_kn ${state.sog_kn}`);
  assert.equal(state.fix_type, 'DGNSS');
  assert.equal(state.satellites, 12);
  assert.ok(Math.abs(state.position.lat - 41.952) < 1e-6);
});

test('MODE=replay without a file fails fast', async () => {
  await assert.rejects(
    () => startServer(loadConfig(['--mode=replay', '--port=0'], {})),
    /requires --replay-file/,
  );
});

/* ---------------------------------------------------------------- *
 * CLI entry point
 * ---------------------------------------------------------------- */

test('the CLI starts in sim mode and shuts down on a signal', async () => {
  const child = spawn(process.execPath, [SERVER, '--mode=sim', '--port=0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const startup = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no startup line, got: ${out}`)), 10000);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      if (out.includes('[n2k] mode=')) {
        clearTimeout(timer);
        resolve(out);
      }
    });
    child.on('error', reject);
  });

  assert.match(startup, /mode=sim/);
  assert.match(startup, /vessel=WAVS-01/);
  assert.match(startup, /state=5Hz/);

  const code = await new Promise((resolve) => {
    child.on('exit', (c) => resolve(c));
    child.kill();
  });
  assert.ok(code === 0 || code === null, `unexpected exit code ${code}`);
});
