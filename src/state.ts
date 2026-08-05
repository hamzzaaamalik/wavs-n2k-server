/**
 * The consolidated snapshot the compliance console binds to.
 *
 * Fields fill in as PGNs arrive and start null. A field present but null in a
 * decode overwrites (it reflects a live "not available"); a field simply absent
 * from that parameter group must not clobber a value another PGN set.
 */

import type { Decoded, DecodedFields } from './decoders';

export interface VesselPosition {
  lat: number | null;
  lon: number | null;
}

export interface VesselState {
  vessel_id: string;
  /** ms epoch of the last update. */
  ts: number;
  position: VesselPosition;
  sog_kn: number | null;
  cog_deg: number | null;
  heading_deg: number | null;
  depth_ft: number | null;
  engine_rpm: number | null;
  wind_speed_kn: number | null;
  wind_angle_deg: number | null;
  fix_type: string | null;
  satellites: number | null;
  /** pgn -> last-seen ms epoch, so the console can show freshness. */
  sources: Record<number, number>;
}

export function createState(vesselId: string, ts: number = Date.now()): VesselState {
  return {
    vessel_id: vesselId,
    ts,
    position: { lat: null, lon: null },
    sog_kn: null,
    cog_deg: null,
    heading_deg: null,
    depth_ft: null,
    engine_rpm: null,
    wind_speed_kn: null,
    wind_angle_deg: null,
    fix_type: null,
    satellites: null,
    sources: {},
  };
}

/** undefined = field absent from this PGN, null = present but not available. */
function numberField(fields: DecodedFields, key: string): number | null | undefined {
  if (!(key in fields)) return undefined;
  const v = fields[key];
  if (v === null) return null;
  return typeof v === 'number' ? v : null;
}

function stringField(fields: DecodedFields, key: string): string | null | undefined {
  if (!(key in fields)) return undefined;
  const v = fields[key];
  if (v === null) return null;
  return typeof v === 'string' ? v : null;
}

/** Merge one decoded parameter group into the snapshot, in place. */
export function apply(state: VesselState, decoded: Decoded): VesselState {
  const { fields, pgn, ts } = decoded;
  state.ts = ts;
  state.sources[pgn] = ts;

  const sog = numberField(fields, 'sog_kn');
  if (sog !== undefined) state.sog_kn = sog;

  const cog = numberField(fields, 'cog_deg');
  if (cog !== undefined) state.cog_deg = cog;

  const heading = numberField(fields, 'heading_deg');
  if (heading !== undefined) state.heading_deg = heading;

  const depth = numberField(fields, 'depth_ft');
  if (depth !== undefined) state.depth_ft = depth;

  const rpm = numberField(fields, 'engine_rpm');
  if (rpm !== undefined) state.engine_rpm = rpm;

  const windSpeed = numberField(fields, 'wind_speed_kn');
  if (windSpeed !== undefined) state.wind_speed_kn = windSpeed;

  const windAngle = numberField(fields, 'wind_angle_deg');
  if (windAngle !== undefined) state.wind_angle_deg = windAngle;

  const sats = numberField(fields, 'satellites');
  if (sats !== undefined) state.satellites = sats;

  const fix = stringField(fields, 'fix_type');
  if (fix !== undefined) state.fix_type = fix;

  // Position is the one exception to the overwrite rule: 129025 and 129029 both
  // carry it, so take whichever last provided a usable fix rather than letting
  // a null from one source blank out the other.
  const lat = numberField(fields, 'lat_deg');
  if (lat !== undefined && lat !== null) state.position.lat = lat;
  const lon = numberField(fields, 'lon_deg');
  if (lon !== undefined && lon !== null) state.position.lon = lon;

  return state;
}
