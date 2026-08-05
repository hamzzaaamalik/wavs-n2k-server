/**
 * MODE=sim - synthetic frame generator.
 *
 * This emits genuine binary N2K frames built with buildCanId and packed
 * buffers, pushed through the same ingest() the real bus uses. It is not
 * fabricated JSON: the decoders under test here are the ones the boat will run.
 *
 * Reserved bits are padded with 1s exactly as a real node does, so the decoders
 * are exercised against realistic byte patterns rather than convenient ones.
 *
 * Models a 24 ft vessel making way in Cape Cod Bay.
 */

import { buildCanId, fragmentFastPacket, type CanFrame } from './n2k';
import { MS_TO_KN, RAD_TO_DEG } from './decoders';

/** Source addresses, one per simulated node on the backbone. */
const SRC = {
  gnss: 2,
  compass: 5,
  engine: 20,
  depth: 35,
  wind: 40,
} as const;

const START_LAT = 41.952;
const START_LON = -70.618;
const TICK_MS = 250; // 4 Hz base rate

export interface Simulator {
  start(): void;
  stop(): void;
  /** Advance the model by one tick and emit its frames. Exposed for tests. */
  tick(): void;
}

/** Small deterministic PRNG so a sim run is reproducible. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * Frame builders. Each packs the parameter group exactly as section 6
 * of the build spec describes it.
 * ------------------------------------------------------------------ */

function frame(pgn: number, src: number, data: Buffer, priority: number): CanFrame {
  return { id: buildCanId({ pgn, src, priority }), data, ts: Date.now() };
}

/** 129026 COG & SOG, Rapid Update. */
function build129026(sid: number, cogDeg: number, sogKn: number): CanFrame {
  const b = Buffer.alloc(8, 0xff);
  b[0] = sid;
  b[1] = 0xfc; // reference 0 (true) in bits 0-1, reserved bits set
  b.writeUInt16LE(Math.round((cogDeg / RAD_TO_DEG) * 1e4), 2);
  b.writeUInt16LE(Math.round(sogKn / MS_TO_KN / 0.01), 4);
  return frame(129026, SRC.gnss, b, 2);
}

/** 129025 Position, Rapid Update. */
function build129025(lat: number, lon: number): CanFrame {
  const b = Buffer.alloc(8);
  b.writeInt32LE(Math.round(lat * 1e7), 0);
  b.writeInt32LE(Math.round(lon * 1e7), 4);
  return frame(129025, SRC.gnss, b, 2);
}

/** 127250 Vessel Heading. */
function build127250(sid: number, headingDeg: number): CanFrame {
  const b = Buffer.alloc(8, 0xff);
  b[0] = sid;
  b.writeUInt16LE(Math.round((headingDeg / RAD_TO_DEG) * 1e4), 1);
  // bytes 3-6 deviation and variation stay 0xFF (not available)
  b[7] = 0xfc; // reference 0 (true), reserved bits set
  return frame(127250, SRC.compass, b, 2);
}

/** 128267 Water Depth. */
function build128267(sid: number, depthM: number, offsetM: number): CanFrame {
  const b = Buffer.alloc(8, 0xff);
  b[0] = sid;
  b.writeUInt32LE(Math.round(depthM / 0.01), 1);
  b.writeInt16LE(Math.round(offsetM / 0.001), 5);
  return frame(128267, SRC.depth, b, 3);
}

/** 127488 Engine Parameters, Rapid Update. */
function build127488(instance: number, rpm: number): CanFrame {
  const b = Buffer.alloc(8, 0xff);
  b[0] = instance;
  b.writeUInt16LE(Math.round(rpm / 0.25), 1);
  return frame(127488, SRC.engine, b, 2);
}

/** 130306 Wind Data. Reference is 3 bits with the 5 reserved bits set. */
function build130306(sid: number, speedKn: number, angleDeg: number, reference: number): CanFrame {
  const b = Buffer.alloc(8, 0xff);
  b[0] = sid;
  b.writeUInt16LE(Math.round(speedKn / MS_TO_KN / 0.01), 1);
  b.writeUInt16LE(Math.round((angleDeg / RAD_TO_DEG) * 1e4), 3);
  b[5] = 0xf8 | (reference & 0x07);
  return frame(130306, SRC.wind, b, 2);
}

/**
 * 129029 GNSS Position Data: a 43-byte payload fragmented into 7 fast-packet
 * frames. This is the path that breaks most first attempts, so the simulator
 * exercises it on every run rather than only in the test suite.
 */
function build129029(
  sid: number,
  lat: number,
  lon: number,
  satellites: number,
  sequenceId: number,
): CanFrame[] {
  const p = Buffer.alloc(43, 0xff);
  const now = Date.now();
  p[0] = sid;
  p.writeUInt16LE(Math.floor(now / 86400000), 1); // date, days since epoch
  p.writeUInt32LE(Math.round(((now % 86400000) / 1000) * 1e4), 3); // time, 1e-4 s
  // 1e-16 degrees in two steps so the intermediate stays exact in a double.
  p.writeBigInt64LE(BigInt(Math.round(lat * 1e10)) * 1000000n, 7);
  p.writeBigInt64LE(BigInt(Math.round(lon * 1e10)) * 1000000n, 15);
  p.writeBigInt64LE(BigInt(Math.round(0.4 * 1e6)), 23); // altitude, 1e-6 m
  p[31] = (0x1 << 4) | 0x0; // method 1 (GNSS fix) high nibble, type 0 (GPS) low
  p[32] = 0xfc; // integrity 0, reserved bits set
  p[33] = satellites;
  p.writeInt16LE(90, 34); // HDOP 0.90
  p.writeInt16LE(150, 36); // PDOP 1.50
  p.writeInt32LE(-3200, 38); // geoidal separation, 0.01 m
  p[42] = 0; // reference stations
  const src = SRC.gnss;
  return fragmentFastPacket(p, sequenceId).map((data) => frame(129029, src, data, 3));
}

/* ------------------------------------------------------------------ *
 * The vessel model
 * ------------------------------------------------------------------ */

export function createSimulator(
  emit: (frame: CanFrame) => void,
  seed: number = 20260805,
): Simulator {
  const rand = mulberry32(seed);
  let timer: NodeJS.Timeout | null = null;
  let ticks = 0;
  let sid = 0;
  let fastSeq = 0;

  let lat = START_LAT;
  let lon = START_LON;
  let cog = 62; // degrees true
  let sog = 24; // knots
  let windAngle = 145;
  let windSpeed = 12;

  function stepModel(): void {
    const dtH = TICK_MS / 3600000;

    // Small random walk on course and speed, bounded to something a planing
    // hull in a bay would actually do.
    cog = (cog + (rand() - 0.5) * 3 + 360) % 360;
    sog = Math.min(28, Math.max(18, sog + (rand() - 0.5) * 0.8));

    // Integrate position from COG and SOG. 1 minute of latitude = 1 nm.
    const nm = sog * dtH;
    lat += (nm * Math.cos(cog * (Math.PI / 180))) / 60;
    lon += (nm * Math.sin(cog * (Math.PI / 180))) / (60 * Math.cos(lat * (Math.PI / 180)));

    // Turn back rather than steam out of Cape Cod Bay.
    if (lat > 42.06 || lat < 41.82 || lon < -70.66 || lon > -70.2) {
      cog = (cog + 180) % 360;
    }

    windAngle = (windAngle + (rand() - 0.5) * 4 + 360) % 360;
    windSpeed = Math.min(22, Math.max(4, windSpeed + (rand() - 0.5) * 0.6));
  }

  function depthM(): number {
    // Deepens away from the Plymouth shore, with a little sounder noise.
    const offshore = Math.max(0, lon + 70.62) * 60; // nm east of the beach
    return Math.min(64, 6 + offshore * 7 + rand() * 0.4);
  }

  function tick(): void {
    stepModel();
    sid = (sid + 1) % 253; // 0..252, clear of the 0xFE/0xFF reserved values

    // 4 Hz: navigation
    emit(build129026(sid, cog, sog));
    emit(build129025(lat, lon));
    emit(build127250(sid, (cog + 1.8) % 360)); // heading leads COG slightly

    // 2 Hz: engine
    if (ticks % 2 === 0) {
      emit(build127488(0, Math.round(600 + sog * 135)));
    }

    // 1 Hz: depth, wind, and the fast-packet GNSS fix
    if (ticks % 4 === 0) {
      emit(build128267(sid, depthM(), 0.35));
      emit(build130306(sid, windSpeed, windAngle, 2 /* apparent */));
      const sats = 9 + Math.floor(rand() * 4);
      for (const f of build129029(sid, lat, lon, sats, fastSeq)) emit(f);
      fastSeq = (fastSeq + 1) & 0x07;
    }

    ticks += 1;
  }

  return {
    tick,
    start(): void {
      if (timer) return;
      timer = setInterval(tick, TICK_MS);
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
