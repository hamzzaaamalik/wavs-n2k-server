/**
 * PGN decoders. One function per parameter group, plus the DECODERS registry.
 *
 * Every field is a scaled little-endian integer, not a float. The reserved top
 * values mean "no data" and must decode to null rather than a garbage number:
 * that is the single most common N2K decoder bug.
 *
 * Every read is bounds-checked, so a truncated or malformed payload yields null
 * fields and never throws (build spec section 10).
 */

export const MS_TO_KN = 1.9438444924406;
export const RAD_TO_DEG = 180 / Math.PI;
export const M_TO_FT = 3.28084;

/** The decoded form of one parameter group. */
export interface Decoded {
  pgn: number;
  src: number;
  ts: number;
  fields: DecodedFields;
}

export type DecodedFields = Record<string, number | string | null>;

export type DecoderFn = (payload: Buffer) => DecodedFields;

/* ------------------------------------------------------------------ *
 * Bounds-checked, sentinel-aware readers.
 *
 * NMEA 2000 reserves the top TWO values of every numeric field: max means
 * "data not available" and max-1 means "out of range / sensor error". Both are
 * absence of a usable measurement, so both decode to null. (The build spec
 * lists only the all-ones case; see README "Deviations from the spec".)
 * ------------------------------------------------------------------ */

function readU8(b: Buffer, o: number): number | null {
  if (o + 1 > b.length) return null;
  const v = b[o];
  return v >= 0xfe ? null : v;
}

function readU16(b: Buffer, o: number): number | null {
  if (o + 2 > b.length) return null;
  const v = b.readUInt16LE(o);
  return v >= 0xfffe ? null : v;
}

function readU32(b: Buffer, o: number): number | null {
  if (o + 4 > b.length) return null;
  const v = b.readUInt32LE(o);
  return v >= 0xfffffffe ? null : v;
}

function readI16(b: Buffer, o: number): number | null {
  if (o + 2 > b.length) return null;
  const v = b.readInt16LE(o);
  return v >= 0x7ffe ? null : v;
}

function readI32(b: Buffer, o: number): number | null {
  if (o + 4 > b.length) return null;
  const v = b.readInt32LE(o);
  return v >= 0x7ffffffe ? null : v;
}

function readI64(b: Buffer, o: number): bigint | null {
  if (o + 8 > b.length) return null;
  const v = b.readBigInt64LE(o);
  return v >= 0x7ffffffffffffffen ? null : v;
}

/** Read a bit field out of one byte, returning null when the byte is missing. */
function readBits(b: Buffer, o: number, mask: number): number | null {
  if (o + 1 > b.length) return null;
  return b[o] & mask;
}

const round = (v: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

/** Radians (already scaled) to a 0..360 bearing. */
const radToBearing = (rad: number, dp: number): number => {
  const deg = rad * RAD_TO_DEG;
  return round(((deg % 360) + 360) % 360, dp);
};

/* ------------------------------------------------------------------ *
 * Enumerations
 * ------------------------------------------------------------------ */

/** 2-bit direction reference. Value 3 means "not available". */
function directionReference(bits: number | null): string | null {
  switch (bits) {
    case 0:
      return 'true';
    case 1:
      return 'magnetic';
    default:
      return null;
  }
}

/** PGN 129029 byte 31, high nibble: the GNSS fix method. */
const FIX_METHOD: Readonly<Record<number, string>> = {
  0: 'no fix',
  1: 'GNSS',
  2: 'DGNSS',
  3: 'precise GNSS',
  4: 'RTK fixed',
  5: 'RTK float',
};

/** PGN 130306 byte 5, low 3 bits: what the wind measurement is relative to. */
const WIND_REFERENCE: Readonly<Record<number, string>> = {
  0: 'true-north',
  1: 'magnetic',
  2: 'apparent',
  3: 'true-boat',
  4: 'true-water',
};

/* ------------------------------------------------------------------ *
 * Decoders
 * ------------------------------------------------------------------ */

/**
 * 129026 - COG & SOG, Rapid Update (single frame).
 *
 * byte 0    SID
 * byte 1    COG reference (2 bits) + reserved
 * bytes 2-3 COG,  u16, 1e-4 rad
 * bytes 4-5 SOG,  u16, 1e-2 m/s   <- the value the whole speed rule turns on
 */
export function decode129026(b: Buffer): DecodedFields {
  const cog = readU16(b, 2);
  const sog = readU16(b, 4);
  return {
    cog_reference: directionReference(readBits(b, 1, 0x03)),
    cog_deg: cog === null ? null : radToBearing(cog * 1e-4, 2),
    sog_kn: sog === null ? null : round(sog * 1e-2 * MS_TO_KN, 2),
  };
}

/**
 * 129025 - Position, Rapid Update (single frame).
 *
 * bytes 0-3 latitude,  i32, 1e-7 deg
 * bytes 4-7 longitude, i32, 1e-7 deg
 */
export function decode129025(b: Buffer): DecodedFields {
  const lat = readI32(b, 0);
  const lon = readI32(b, 4);
  return {
    lat_deg: lat === null ? null : round(lat * 1e-7, 7),
    lon_deg: lon === null ? null : round(lon * 1e-7, 7),
  };
}

/**
 * 129029 - GNSS Position Data (fast-packet, 43 bytes).
 *
 * bytes 7-14  latitude,  i64, 1e-16 deg
 * bytes 15-22 longitude, i64, 1e-16 deg
 * byte 31     GNSS type (low nibble) + fix method (HIGH nibble)
 * byte 33     satellites in use, u8
 *
 * The high nibble is the method. Reading the low nibble returns the satellite
 * constellation instead, so a GPS+GLONASS receiver would report "DGNSS".
 * See README "Deviations from the spec".
 */
export function decode129029(b: Buffer): DecodedFields {
  const lat = readI64(b, 7);
  const lon = readI64(b, 15);
  const methodBits = readBits(b, 31, 0xf0);
  const method = methodBits === null ? null : methodBits >> 4;
  return {
    lat_deg: lat === null ? null : round(Number(lat) * 1e-16, 7),
    lon_deg: lon === null ? null : round(Number(lon) * 1e-16, 7),
    fix_type: method === null ? null : (FIX_METHOD[method] ?? null),
    satellites: readU8(b, 33),
  };
}

/**
 * 127250 - Vessel Heading (single frame).
 *
 * byte 0    SID
 * bytes 1-2 heading, u16, 1e-4 rad
 * bytes 3-4 deviation, bytes 5-6 variation (not decoded)
 * byte 7    reference (2 bits) + reserved
 */
export function decode127250(b: Buffer): DecodedFields {
  const heading = readU16(b, 1);
  return {
    heading_deg: heading === null ? null : radToBearing(heading * 1e-4, 2),
    heading_reference: directionReference(readBits(b, 7, 0x03)),
  };
}

/**
 * 128267 - Water Depth (single frame).
 *
 * byte 0    SID
 * bytes 1-4 depth below transducer, u32, 0.01 m
 * bytes 5-6 transducer offset,      i16, 0.001 m (positive = surface to
 *           transducer, so it is added to reach depth below surface)
 * byte 7    range (not decoded)
 */
export function decode128267(b: Buffer): DecodedFields {
  const raw = readU32(b, 1);
  const offsetRaw = readI16(b, 5);
  const depthM = raw === null ? null : raw * 0.01;
  const offsetM = offsetRaw === null ? 0 : offsetRaw * 0.001;
  return {
    depth_m: depthM === null ? null : round(depthM, 2),
    depth_ft: depthM === null ? null : round((depthM + offsetM) * M_TO_FT, 1),
  };
}

/**
 * 127488 - Engine Parameters, Rapid Update (single frame).
 *
 * byte 0    engine instance, u8 (0 = port / single)
 * bytes 1-2 engine speed, u16, 0.25 rpm
 */
export function decode127488(b: Buffer): DecodedFields {
  const rpm = readU16(b, 1);
  return {
    engine_instance: readU8(b, 0),
    engine_rpm: rpm === null ? null : Math.round(rpm * 0.25),
  };
}

/**
 * 130306 - Wind Data (single frame).
 *
 * byte 0    SID
 * bytes 1-2 wind speed, u16, 0.01 m/s
 * bytes 3-4 wind angle, u16, 1e-4 rad
 * byte 5    reference (3 bits) + 5 reserved bits
 *
 * The reference must be masked to 3 bits. N2K pads reserved bits with 1s, so
 * the raw byte reads 0xFA for "apparent" on a real bus and matches nothing.
 * See README "Deviations from the spec".
 */
export function decode130306(b: Buffer): DecodedFields {
  const speed = readU16(b, 1);
  const angle = readU16(b, 3);
  const ref = readBits(b, 5, 0x07);
  return {
    wind_speed_kn: speed === null ? null : round(speed * 0.01 * MS_TO_KN, 1),
    wind_angle_deg: angle === null ? null : radToBearing(angle * 1e-4, 1),
    wind_reference: ref === null ? null : (WIND_REFERENCE[ref] ?? null),
  };
}

/** Every parameter group this service understands. */
export const DECODERS: Readonly<Record<number, DecoderFn>> = {
  127250: decode127250,
  127488: decode127488,
  128267: decode128267,
  129025: decode129025,
  129026: decode129026,
  129029: decode129029,
  130306: decode130306,
};

/** The PGNs advertised in the WebSocket hello message. */
export const SUPPORTED_PGNS: readonly number[] = Object.keys(DECODERS)
  .map(Number)
  .sort((a, b) => a - b);

/**
 * Decode one (reassembled) payload.
 * @returns null for an unregistered PGN, which ingest silently ignores.
 */
export function decode(pgn: number, src: number, payload: Buffer, ts: number): Decoded | null {
  const fn = DECODERS[pgn];
  if (!fn) return null;
  try {
    return { pgn, src, ts, fields: fn(payload) };
  } catch {
    // Belt and braces: the readers are bounds-checked, but one bad frame must
    // never stop the stream.
    return { pgn, src, ts, fields: {} };
  }
}
