/**
 * VesselState merge semantics (build spec section 7).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import stateMod from '../dist/state.js';

const { createState, apply } = stateMod;

const decoded = (pgn, fields, ts = 1770000000000) => ({ pgn, src: 2, ts, fields });

test('a fresh state starts all null', () => {
  const s = createState('WAVS-01', 1);
  assert.equal(s.vessel_id, 'WAVS-01');
  assert.deepEqual(s.position, { lat: null, lon: null });
  for (const key of [
    'sog_kn',
    'cog_deg',
    'heading_deg',
    'depth_ft',
    'engine_rpm',
    'wind_speed_kn',
    'wind_angle_deg',
    'fix_type',
    'satellites',
  ]) {
    assert.equal(s[key], null, key);
  }
  assert.deepEqual(s.sources, {});
});

test('apply copies present fields and records freshness', () => {
  const s = createState('WAVS-01', 1);
  apply(s, decoded(129026, { sog_kn: 23.93, cog_deg: 76.29, cog_reference: 'true' }, 1000));
  assert.equal(s.sog_kn, 23.93);
  assert.equal(s.cog_deg, 76.29);
  assert.equal(s.ts, 1000);
  assert.equal(s.sources[129026], 1000);
});

test('a field absent from a PGN does not clobber another PGN', () => {
  const s = createState('WAVS-01', 1);
  apply(s, decoded(129026, { sog_kn: 23.93, cog_deg: 76.29 }, 1000));
  apply(s, decoded(127250, { heading_deg: 76.09, heading_reference: 'true' }, 1100));
  assert.equal(s.sog_kn, 23.93, 'heading PGN wiped SOG');
  assert.equal(s.heading_deg, 76.09);
  assert.equal(s.sources[129026], 1000);
  assert.equal(s.sources[127250], 1100);
});

test('a field present but null overwrites, reflecting a live not-available', () => {
  const s = createState('WAVS-01', 1);
  apply(s, decoded(128267, { depth_m: 21.6, depth_ft: 70.9 }, 1000));
  assert.equal(s.depth_ft, 70.9);
  apply(s, decoded(128267, { depth_m: null, depth_ft: null }, 1200));
  assert.equal(s.depth_ft, null, 'a lost sounder must show as null, not a stale reading');
});

test('position takes whichever of 129025 / 129029 last had a fix', () => {
  const s = createState('WAVS-01', 1);
  apply(s, decoded(129025, { lat_deg: 41.952, lon_deg: -70.618 }, 1000));
  assert.deepEqual(s.position, { lat: 41.952, lon: -70.618 });

  // A null position from the other source must not blank a good fix.
  apply(s, decoded(129029, { lat_deg: null, lon_deg: null, fix_type: 'no fix' }, 1100));
  assert.deepEqual(s.position, { lat: 41.952, lon: -70.618 });
  assert.equal(s.fix_type, 'no fix');

  apply(s, decoded(129029, { lat_deg: 42.0011, lon_deg: -70.5502, fix_type: 'DGNSS' }, 1200));
  assert.deepEqual(s.position, { lat: 42.0011, lon: -70.5502 });
  assert.equal(s.fix_type, 'DGNSS');
});

test('fields this state does not carry are ignored', () => {
  const s = createState('WAVS-01', 1);
  apply(s, decoded(127488, { engine_instance: 0, engine_rpm: 3797 }, 1000));
  assert.equal(s.engine_rpm, 3797);
  assert.equal(s.engine_instance, undefined, 'engine_instance is not part of VesselState');
});

test('the snapshot serializes to the shape the console binds to', () => {
  const s = createState('WAVS-01', 1);
  apply(s, decoded(129026, { sog_kn: 23.93, cog_deg: 76.29 }, 1770000000000));
  apply(s, decoded(129025, { lat_deg: 41.95206, lon_deg: -70.6176 }, 1770000000000));
  const round = JSON.parse(JSON.stringify({ type: 'state', ...s }));
  assert.equal(round.type, 'state');
  assert.equal(round.vessel_id, 'WAVS-01');
  assert.equal(round.position.lat, 41.95206);
  assert.equal(round.sog_kn, 23.93);
  assert.equal(typeof round.ts, 'number');
});
