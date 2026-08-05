/**
 * PGN decoders against hand-built frames with known values.
 * Vectors from section 9 of the build spec.
 *
 * Frames here are packed with raw integers computed in the test itself, not
 * with the simulator's encoders, so a matching bug on both sides cannot hide.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import decoders from '../dist/decoders.js';

const { decode, DECODERS, SUPPORTED_PGNS, MS_TO_KN, RAD_TO_DEG } = decoders;

const near = (actual, expected, tol, label) =>
  assert.ok(
    actual !== null && Math.abs(actual - expected) <= tol,
    `${label}: got ${actual}, expected ${expected} +/- ${tol}`,
  );

const at = (pgn, buf) => decode(pgn, 2, buf, 1770000000000).fields;

/* ---------------------------------------------------------------- *
 * 129026 - COG & SOG
 * ---------------------------------------------------------------- */

function frame129026(cogDeg, sogKn, refBits = 0) {
  const b = Buffer.alloc(8, 0xff);
  b[0] = 1; // SID
  b[1] = 0xf8 | refBits; // reserved bits set, as a real node sends them
  b.writeUInt16LE(Math.round((cogDeg / RAD_TO_DEG) * 1e4), 2);
  b.writeUInt16LE(Math.round(sogKn / MS_TO_KN / 0.01), 4);
  return b;
}

test('SOG decode: 129026 raw for 24.1 kn', () => {
  const f = at(129026, frame129026(78.4, 24.1));
  near(f.sog_kn, 24.1, 0.05, 'sog_kn');
});

test('COG decode: 129026 raw for 78.4 deg', () => {
  const f = at(129026, frame129026(78.4, 24.1));
  near(f.cog_deg, 78.4, 0.05, 'cog_deg');
});

test('129026: COG reference is masked to 2 bits', () => {
  assert.equal(at(129026, frame129026(78.4, 24.1, 0)).cog_reference, 'true');
  assert.equal(at(129026, frame129026(78.4, 24.1, 1)).cog_reference, 'magnetic');
  // 3 = not available
  assert.equal(at(129026, frame129026(78.4, 24.1, 3)).cog_reference, null);
});

test('129026: rounded to 2 dp for display', () => {
  const f = at(129026, frame129026(78.4, 24.1));
  assert.equal(f.sog_kn, Number(f.sog_kn.toFixed(2)));
  assert.equal(f.cog_deg, Number(f.cog_deg.toFixed(2)));
});

/* ---------------------------------------------------------------- *
 * 129025 - Position, Rapid Update
 * ---------------------------------------------------------------- */

test('Position: 129025 lat 41.9520, lon -70.6180 round-trips to +/-1e-6', () => {
  const b = Buffer.alloc(8);
  b.writeInt32LE(Math.round(41.952 * 1e7), 0);
  b.writeInt32LE(Math.round(-70.618 * 1e7), 4);
  const f = at(129025, b);
  near(f.lat_deg, 41.952, 1e-6, 'lat_deg');
  near(f.lon_deg, -70.618, 1e-6, 'lon_deg');
});

test('Position: southern and eastern hemispheres keep their sign', () => {
  const b = Buffer.alloc(8);
  b.writeInt32LE(Math.round(-33.8688 * 1e7), 0);
  b.writeInt32LE(Math.round(151.2093 * 1e7), 4);
  const f = at(129025, b);
  near(f.lat_deg, -33.8688, 1e-6, 'lat_deg');
  near(f.lon_deg, 151.2093, 1e-6, 'lon_deg');
});

/* ---------------------------------------------------------------- *
 * 127250 - Vessel Heading
 * ---------------------------------------------------------------- */

test('Heading: 127250 raw for 76.09 deg, reference true', () => {
  const b = Buffer.alloc(8, 0xff);
  b[0] = 1;
  b.writeUInt16LE(Math.round((76.09 / RAD_TO_DEG) * 1e4), 1);
  b[7] = 0xfc; // reference 0 with reserved bits set
  const f = at(127250, b);
  near(f.heading_deg, 76.09, 0.05, 'heading_deg');
  assert.equal(f.heading_reference, 'true');
});

/* ---------------------------------------------------------------- *
 * 128267 - Water Depth
 * ---------------------------------------------------------------- */

function frame128267(depthM, offsetM) {
  const b = Buffer.alloc(8, 0xff);
  b[0] = 1;
  b.writeUInt32LE(Math.round(depthM / 0.01), 1);
  // For a signed field the N2K "not available" sentinel is max positive.
  if (offsetM === null) b.writeInt16LE(0x7fff, 5);
  else b.writeInt16LE(Math.round(offsetM / 0.001), 5);
  return b;
}

test('Depth: 128267 depth 21.6 m, offset 0 -> 70.9 ft', () => {
  const f = at(128267, frame128267(21.6, 0));
  assert.equal(f.depth_m, 21.6);
  near(f.depth_ft, 70.9, 0.05, 'depth_ft');
});

test('Depth: the transducer offset is added before conversion', () => {
  const f = at(128267, frame128267(21.6, 0.4));
  assert.equal(f.depth_m, 21.6, 'depth_m is below the transducer');
  near(f.depth_ft, 22.0 * 3.28084, 0.05, 'depth_ft includes the offset');
});

test('Depth: a not-available offset is treated as 0', () => {
  const f = at(128267, frame128267(21.6, null));
  near(f.depth_ft, 70.9, 0.05, 'depth_ft');
});

/* ---------------------------------------------------------------- *
 * 127488 - Engine Parameters, Rapid Update
 * ---------------------------------------------------------------- */

test('Engine: 127488 raw for 3840 rpm', () => {
  const b = Buffer.alloc(8, 0xff);
  b[0] = 0; // instance
  b.writeUInt16LE(3840 / 0.25, 1);
  const f = at(127488, b);
  assert.equal(f.engine_rpm, 3840);
  assert.equal(f.engine_instance, 0);
  assert.equal(Number.isInteger(f.engine_rpm), true, 'engine_rpm is rounded to an integer');
});

/* ---------------------------------------------------------------- *
 * 130306 - Wind Data
 * ---------------------------------------------------------------- */

function frame130306(speedKn, angleDeg, reference) {
  const b = Buffer.alloc(8, 0xff);
  b[0] = 1;
  b.writeUInt16LE(Math.round(speedKn / MS_TO_KN / 0.01), 1);
  b.writeUInt16LE(Math.round((angleDeg / RAD_TO_DEG) * 1e4), 3);
  b[5] = 0xf8 | (reference & 0x07); // 5 reserved bits set, as on a real bus
  return b;
}

test('Wind: 130306 speed and angle', () => {
  const f = at(130306, frame130306(14.2, 145, 2));
  near(f.wind_speed_kn, 14.2, 0.1, 'wind_speed_kn');
  near(f.wind_angle_deg, 145, 0.1, 'wind_angle_deg');
});

test('Wind: the reference is masked to 3 bits, not read as a whole byte', () => {
  // Regression test. N2K pads reserved bits with 1s, so byte 5 reads 0xFA for
  // "apparent". Reading the whole byte matches nothing on a real bus.
  assert.equal(at(130306, frame130306(14.2, 145, 2)).wind_reference, 'apparent');
  assert.equal(at(130306, frame130306(14.2, 145, 0)).wind_reference, 'true-north');
  assert.equal(at(130306, frame130306(14.2, 145, 4)).wind_reference, 'true-water');
});

/* ---------------------------------------------------------------- *
 * 129029 - GNSS Position Data
 * ---------------------------------------------------------------- */

function frame129029(method, gnssType, satellites) {
  const p = Buffer.alloc(43, 0xff);
  p[0] = 1;
  p.writeBigInt64LE(BigInt(Math.round(41.952 * 1e10)) * 1000000n, 7);
  p.writeBigInt64LE(BigInt(Math.round(-70.618 * 1e10)) * 1000000n, 15);
  p[31] = ((method & 0x0f) << 4) | (gnssType & 0x0f);
  p[33] = satellites;
  return p;
}

test('129029: fix_type comes from the high nibble of byte 31', () => {
  // Regression test. The low nibble is the satellite constellation, not the
  // fix method: reading it makes a GPS+GLONASS receiver report "DGNSS".
  assert.equal(at(129029, frame129029(1, 2, 11)).fix_type, 'GNSS');
  assert.equal(at(129029, frame129029(2, 0, 11)).fix_type, 'DGNSS');
  assert.equal(at(129029, frame129029(4, 3, 11)).fix_type, 'RTK fixed');
  assert.equal(at(129029, frame129029(0, 1, 11)).fix_type, 'no fix');
});

test('129029: satellites and position decode', () => {
  const f = at(129029, frame129029(1, 0, 11));
  assert.equal(f.satellites, 11);
  near(f.lat_deg, 41.952, 1e-6, 'lat_deg');
  near(f.lon_deg, -70.618, 1e-6, 'lon_deg');
});

/* ---------------------------------------------------------------- *
 * Sentinels and resilience
 * ---------------------------------------------------------------- */

/** The correct not-available payload for each PGN: all-ones for unsigned
 *  fields, max-positive for signed ones. */
const SENTINEL_PAYLOAD = {
  127250: () => Buffer.alloc(8, 0xff),
  127488: () => Buffer.alloc(8, 0xff),
  128267: () => {
    const b = Buffer.alloc(8, 0xff);
    b.writeInt16LE(0x7fff, 5); // signed transducer offset
    return b;
  },
  129025: () => {
    const b = Buffer.alloc(8);
    b.writeInt32LE(0x7fffffff, 0);
    b.writeInt32LE(0x7fffffff, 4);
    return b;
  },
  129026: () => Buffer.alloc(8, 0xff),
  129029: () => {
    const b = Buffer.alloc(43, 0xff);
    b.writeBigInt64LE(0x7fffffffffffffffn, 7);
    b.writeBigInt64LE(0x7fffffffffffffffn, 15);
    return b;
  },
  130306: () => Buffer.alloc(8, 0xff),
};

test('Sentinel: a not-available payload decodes every field to null', () => {
  for (const pgn of SUPPORTED_PGNS) {
    const fields = at(pgn, SENTINEL_PAYLOAD[pgn]());
    for (const [key, value] of Object.entries(fields)) {
      assert.equal(value, null, `${pgn}.${key} should be null, got ${value}`);
    }
  }
});

test('Sentinel: an all-0xFF payload nulls every unsigned field', () => {
  // The section 9 vector. Every field these groups expose is unsigned, so
  // all-ones is the not-available encoding for all of them.
  for (const pgn of [127250, 127488, 129026, 130306]) {
    const fields = at(pgn, Buffer.alloc(8, 0xff));
    for (const [key, value] of Object.entries(fields)) {
      assert.equal(value, null, `${pgn}.${key} should be null, got ${value}`);
    }
  }
  const depth = at(128267, Buffer.alloc(8, 0xff));
  assert.equal(depth.depth_m, null);
  assert.equal(depth.depth_ft, null);

  const gnss = at(129029, Buffer.alloc(43, 0xff));
  assert.equal(gnss.fix_type, null);
  assert.equal(gnss.satellites, null);
});

test('Sentinel: signed fields use max-positive, not all-ones', () => {
  // A real node signals "no position" in 129025 with 0x7FFFFFFF. An all-0xFF
  // payload is -1 raw, which is a legitimate (if absurd) position just south of
  // Null Island, and must not be special-cased into null.
  const allOnes = at(129025, Buffer.alloc(8, 0xff));
  assert.equal(allOnes.lat_deg, -1e-7);
  assert.equal(allOnes.lon_deg, -1e-7);

  const proper = at(129025, SENTINEL_PAYLOAD[129025]());
  assert.equal(proper.lat_deg, null);
  assert.equal(proper.lon_deg, null);
});

test('Sentinel: SOG and depth specifically decode to null, not a garbage number', () => {
  assert.equal(at(129026, Buffer.alloc(8, 0xff)).sog_kn, null);
  assert.equal(at(128267, Buffer.alloc(8, 0xff)).depth_ft, null);
  assert.equal(at(128267, Buffer.alloc(8, 0xff)).depth_m, null);
  assert.equal(at(127488, Buffer.alloc(8, 0xff)).engine_rpm, null);
});

test('Resilience: truncated and empty payloads yield nulls and never throw', () => {
  for (const pgn of SUPPORTED_PGNS) {
    for (const len of [0, 1, 2, 3, 5, 7]) {
      const decoded = decode(pgn, 2, Buffer.alloc(len), 1770000000000);
      assert.ok(decoded, `${pgn} returned no result for length ${len}`);
      for (const [key, value] of Object.entries(decoded.fields)) {
        assert.ok(
          value === null || typeof value === 'number' || typeof value === 'string',
          `${pgn}.${key} at length ${len}`,
        );
      }
    }
  }
});

test('decode() returns null for an unregistered PGN', () => {
  assert.equal(decode(59904, 2, Buffer.alloc(8), 1), null);
  assert.equal(decode(0, 2, Buffer.alloc(8), 1), null);
});

test('decode() carries pgn, src and ts through', () => {
  const d = decode(129026, 42, frame129026(78.4, 24.1), 1770000000000);
  assert.equal(d.pgn, 129026);
  assert.equal(d.src, 42);
  assert.equal(d.ts, 1770000000000);
});

test('all seven compliance-critical PGNs are registered', () => {
  assert.deepEqual(SUPPORTED_PGNS, [127250, 127488, 128267, 129025, 129026, 129029, 130306]);
  for (const pgn of SUPPORTED_PGNS) assert.equal(typeof DECODERS[pgn], 'function');
});
