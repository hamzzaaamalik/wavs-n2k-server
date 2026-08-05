/**
 * Transport layer: 29-bit identifier codec and fast-packet reassembly.
 * Vectors from section 9 of the build spec.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import n2k from '../dist/n2k.js';
import decoders from '../dist/decoders.js';

const { parseCanId, buildCanId, FastPacketAssembler, fragmentFastPacket, FAST_PACKET_PGNS } = n2k;

test('ID round-trip (PDU2): pgn 129026, src 3, priority 2, dst 255', () => {
  const id = buildCanId({ priority: 2, pgn: 129026, src: 3 });
  const parsed = parseCanId(id);
  assert.equal(parsed.pgn, 129026);
  assert.equal(parsed.src, 3);
  assert.equal(parsed.priority, 2);
  assert.equal(parsed.dst, 255);
});

test('ID round-trip: every supported PGN survives build -> parse', () => {
  for (const pgn of [127250, 127488, 128267, 129025, 129026, 129029, 130306]) {
    const parsed = parseCanId(buildCanId({ priority: 3, pgn, src: 17 }));
    assert.equal(parsed.pgn, pgn, `pgn ${pgn}`);
    assert.equal(parsed.src, 17);
  }
});

test('ID PDU1: destination is preserved', () => {
  // 126208 has pf = 0xED (237) < 240, so it is destination-specific.
  const id = buildCanId({ priority: 3, pgn: 126208, src: 9, dst: 0x30 });
  const parsed = parseCanId(id);
  assert.equal(parsed.pgn, 126208);
  assert.equal(parsed.src, 9);
  assert.equal(parsed.dst, 0x30);
});

test('the 29-bit identifier stays inside 29 bits', () => {
  const id = buildCanId({ priority: 7, pgn: 130842, src: 255 });
  assert.ok(id <= 0x1fffffff, `id ${id.toString(16)} exceeds 29 bits`);
  assert.ok(id >= 0);
});

/* ---------------------------------------------------------------- *
 * Fast packet
 * ---------------------------------------------------------------- */

/** A 43-byte 129029 payload with known latitude, longitude and satellites. */
function gnssPayload(lat, lon, satellites) {
  const p = Buffer.alloc(43, 0xff);
  p[0] = 7; // SID
  p.writeUInt16LE(20000, 1); // date
  p.writeUInt32LE(123456, 3); // time
  p.writeBigInt64LE(BigInt(Math.round(lat * 1e10)) * 1000000n, 7);
  p.writeBigInt64LE(BigInt(Math.round(lon * 1e10)) * 1000000n, 15);
  p.writeBigInt64LE(0n, 23); // altitude
  p[31] = (0x1 << 4) | 0x0; // method 1 (GNSS fix), type 0 (GPS)
  p[32] = 0xfc;
  p[33] = satellites;
  p.writeInt16LE(90, 34);
  p.writeInt16LE(150, 36);
  p.writeInt32LE(-3200, 38);
  p[42] = 0;
  return p;
}

test('frame count: a 43-byte payload fragments into exactly 7 frames', () => {
  const frames = fragmentFastPacket(gnssPayload(41.952, -70.618, 11));
  assert.equal(frames.length, 7);
  // 6 bytes in the first frame + 6 continuations of 7 = 48 capacity >= 43.
  assert.equal(frames[0][1], 43, 'first frame declares the total length');
  for (const f of frames) assert.equal(f.length, 8, 'frames are padded to 8 bytes');
});

test('fast-packet: 43-byte 129029 reassembles with lat/lon/satellites intact', () => {
  const lat = 41.952;
  const lon = -70.618;
  const payload = gnssPayload(lat, lon, 11);
  const frames = fragmentFastPacket(payload);

  const asm = new FastPacketAssembler();
  let out = null;
  frames.forEach((f, i) => {
    const r = asm.add(2, 129029, f, 1000 + i);
    if (i < frames.length - 1) assert.equal(r, null, `frame ${i} completed early`);
    else out = r;
  });

  assert.ok(out, 'sequence did not complete');
  assert.equal(out.length, 43);
  assert.deepEqual(out, payload);
  assert.equal(asm.pending, 0, 'completed sequence was not released');

  const fields = decoders.decode129029(out);
  assert.ok(Math.abs(fields.lat_deg - lat) < 1e-6, `lat ${fields.lat_deg}`);
  assert.ok(Math.abs(fields.lon_deg - lon) < 1e-6, `lon ${fields.lon_deg}`);
  assert.equal(fields.satellites, 11);
  assert.equal(fields.fix_type, 'GNSS');
});

test('fast-packet: 129029 is registered as a fast-packet PGN', () => {
  assert.ok(FAST_PACKET_PGNS.has(129029));
  assert.ok(FAST_PACKET_PGNS.has(127489));
  assert.ok(!FAST_PACKET_PGNS.has(129026), '129026 is a single frame');
});

test('fast-packet: a continuation with no first frame is dropped', () => {
  const asm = new FastPacketAssembler();
  const frames = fragmentFastPacket(gnssPayload(41.9, -70.6, 8));
  assert.equal(asm.add(2, 129029, frames[3], 1000), null);
  assert.equal(asm.pending, 0);
});

test('fast-packet: an out-of-order frame abandons the sequence', () => {
  const asm = new FastPacketAssembler();
  const frames = fragmentFastPacket(gnssPayload(41.9, -70.6, 8));
  asm.add(2, 129029, frames[0], 1000);
  assert.equal(asm.pending, 1);
  asm.add(2, 129029, frames[4], 1001); // expected counter 1, got 4
  assert.equal(asm.pending, 0, 'sequence should have been abandoned');
});

test('fast-packet: a mismatched sequence id abandons the sequence', () => {
  const asm = new FastPacketAssembler();
  const a = fragmentFastPacket(gnssPayload(41.9, -70.6, 8), 0);
  const b = fragmentFastPacket(gnssPayload(41.9, -70.6, 8), 3);
  asm.add(2, 129029, a[0], 1000);
  asm.add(2, 129029, b[1], 1001);
  assert.equal(asm.pending, 0);
});

test('fast-packet: sequences from different sources do not collide', () => {
  const asm = new FastPacketAssembler();
  const pa = gnssPayload(41.95, -70.61, 11);
  const pb = gnssPayload(42.01, -70.55, 7);
  const fa = fragmentFastPacket(pa);
  const fb = fragmentFastPacket(pb);

  let outA = null;
  let outB = null;
  for (let i = 0; i < 7; i++) {
    outA = asm.add(2, 129029, fa[i], 1000 + i) ?? outA;
    outB = asm.add(9, 129029, fb[i], 1000 + i) ?? outB;
  }
  assert.deepEqual(outA, pa);
  assert.deepEqual(outB, pb);
});

test('fast-packet: TTL sweep discards a sequence whose final frame was lost', () => {
  const asm = new FastPacketAssembler(3000);
  const frames = fragmentFastPacket(gnssPayload(41.9, -70.6, 8));
  asm.add(2, 129029, frames[0], 1000);
  asm.add(2, 129029, frames[1], 1100);
  assert.equal(asm.pending, 1);

  assert.equal(asm.sweep(2000), 0, 'swept while still fresh');
  assert.equal(asm.pending, 1);
  assert.equal(asm.sweep(9000), 1, 'stale sequence was not swept');
  assert.equal(asm.pending, 0);
});

test('fast-packet: short and empty frames do not throw', () => {
  const asm = new FastPacketAssembler();
  assert.equal(asm.add(2, 129029, Buffer.alloc(0), 1), null);
  assert.equal(asm.add(2, 129029, Buffer.from([0x00]), 1), null);
  assert.equal(asm.add(2, 129029, Buffer.from([0x00, 0x00]), 1), null);
  assert.equal(asm.pending, 0);
});
