/**
 * Every knob this service has, in one place.
 *
 * Nothing operational is hard-coded: rates, timeouts, bind address, interface
 * and identity all resolve from (in precedence order) a --flag, the process
 * environment, an optional .env file, then a documented default.
 *
 * Deploying to a new vessel is a configuration exercise, not a code change.
 */

import { readFileSync } from 'fs';

export type Mode = 'sim' | 'can' | 'replay';
export type LogLevel = 'error' | 'info' | 'debug';

export interface Config {
  /** Frame source. */
  mode: Mode;
  /** WebSocket bind address. 127.0.0.1 to refuse anything off-box. */
  host: string;
  /** WebSocket port. 0 binds a free one. */
  port: number;
  /** CAN interface, MODE=can only. */
  canIf: string;
  /** Identity stamped into hello and every snapshot. */
  vesselId: string;
  logLevel: LogLevel;

  /** Consolidated snapshot rate, Hz. */
  stateHz: number;
  /** Derived from stateHz; the interval the broadcast timer actually uses. */
  stateIntervalMs: number;
  /** Discard a partial fast-packet sequence older than this. */
  fastPacketTtlMs: number;
  /** How often to run the fast-packet TTL sweep. */
  sweepIntervalMs: number;
  /** Bus statistics line + stats message cadence, seconds. 0 disables. */
  statsIntervalS: number;
  /** Retry cadence when can0 is not up yet (boot ordering). 0 disables. */
  canRetryMs: number;
  /** How long shutdown waits for sockets before forcing exit. */
  shutdownGraceMs: number;

  replayFile: string | null;
  replaySpeed: number;
  /** Cap on replayed inter-frame gaps, so a quiet capture does not stall. */
  replayMaxGapMs: number;
  replayLoop: boolean;

  /** Where each value came from, for --print-config. */
  sources: Record<string, 'default' | 'env' | 'flag'>;
}

export const MODES: readonly Mode[] = ['sim', 'can', 'replay'];
const LOG_LEVELS: readonly LogLevel[] = ['error', 'info', 'debug'];

/** The N2K bus rate. Set on the interface by the OS, not by this process. */
export const N2K_BITRATE = 250000;

export interface ConfigSpecEntry {
  env: string;
  flag: string;
  /** The Config property this knob resolves into. */
  prop: keyof Config;
  fallback: string;
  describe: string;
}

/** The single source of truth for every knob, used by config and by docs. */
export const CONFIG_SPEC: readonly ConfigSpecEntry[] = [
  { env: 'MODE', flag: 'mode', prop: 'mode', fallback: 'sim', describe: 'sim | can | replay' },
  { env: 'HOST', flag: 'host', prop: 'host', fallback: '0.0.0.0', describe: 'WebSocket bind address' },
  { env: 'PORT', flag: 'port', prop: 'port', fallback: '4001', describe: 'WebSocket port (0 = any free)' },
  { env: 'CAN_IF', flag: 'can-if', prop: 'canIf', fallback: 'can0', describe: 'CAN interface (MODE=can)' },
  { env: 'VESSEL_ID', flag: 'vessel-id', prop: 'vesselId', fallback: 'WAVS-01', describe: 'vessel identity' },
  { env: 'LOG_LEVEL', flag: 'log-level', prop: 'logLevel', fallback: 'info', describe: 'error | info | debug' },
  { env: 'STATE_HZ', flag: 'state-hz', prop: 'stateHz', fallback: '5', describe: 'snapshot rate, Hz' },
  { env: 'FAST_PACKET_TTL_MS', flag: 'fast-packet-ttl-ms', prop: 'fastPacketTtlMs', fallback: '3000', describe: 'partial sequence TTL' },
  { env: 'SWEEP_INTERVAL_MS', flag: 'sweep-interval-ms', prop: 'sweepIntervalMs', fallback: '1000', describe: 'TTL sweep cadence' },
  { env: 'STATS_INTERVAL_S', flag: 'stats-interval-s', prop: 'statsIntervalS', fallback: '60', describe: 'bus stats cadence, 0 = off' },
  { env: 'CAN_RETRY_MS', flag: 'can-retry-ms', prop: 'canRetryMs', fallback: '5000', describe: 'retry while can0 is down, 0 = off' },
  { env: 'SHUTDOWN_GRACE_MS', flag: 'shutdown-grace-ms', prop: 'shutdownGraceMs', fallback: '2000', describe: 'shutdown deadline' },
  { env: 'REPLAY_FILE', flag: 'replay-file', prop: 'replayFile', fallback: '', describe: 'candump log (MODE=replay)' },
  { env: 'REPLAY_SPEED', flag: 'replay-speed', prop: 'replaySpeed', fallback: '1', describe: 'replay rate multiplier' },
  { env: 'REPLAY_MAX_GAP_MS', flag: 'replay-max-gap-ms', prop: 'replayMaxGapMs', fallback: '250', describe: 'cap on replayed gaps' },
  { env: 'REPLAY_LOOP', flag: 'replay-loop', prop: 'replayLoop', fallback: 'false', describe: 'restart the capture at EOF' },
];

/**
 * Load KEY=VALUE pairs from a .env file into `target`, without overwriting
 * anything already set. Deliberately tiny and dependency-free: no interpolation,
 * no export keyword, no multi-line values.
 *
 * @returns the number of keys applied, or -1 if the file was absent.
 */
export function loadEnvFile(path = '.env', target: NodeJS.ProcessEnv = process.env): number {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return -1;
  }
  let applied = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (target[key] === undefined) {
      target[key] = value;
      applied += 1;
    }
  }
  return applied;
}

function bounded(name: string, raw: string, lo: number, hi: number, integer = true): number {
  const v = Number(raw);
  if (!Number.isFinite(v) || (integer && !Number.isInteger(v)) || v < lo || v > hi) {
    throw new Error(
      `Invalid ${name} "${raw}". Expected ${integer ? 'an integer' : 'a number'} in ${lo}..${hi}`,
    );
  }
  return v;
}

/**
 * Resolve configuration. Flags beat environment beats default.
 *
 * Environment variables are the documented deployment interface; the flags
 * exist so the npm scripts run unchanged on Windows, where `MODE=sim node ...`
 * is not valid shell syntax.
 */
export function loadConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(arg);
    if (m) flags.set(m[1], m[2] ?? 'true');
  }

  const sources: Record<string, 'default' | 'env' | 'flag'> = {};
  const raw: Record<string, string> = {};
  for (const spec of CONFIG_SPEC) {
    const fromFlag = flags.get(spec.flag);
    const fromEnv = env[spec.env];
    if (fromFlag !== undefined) {
      raw[spec.env] = fromFlag;
      sources[spec.env] = 'flag';
    } else if (fromEnv !== undefined && fromEnv !== '') {
      raw[spec.env] = fromEnv;
      sources[spec.env] = 'env';
    } else {
      raw[spec.env] = spec.fallback;
      sources[spec.env] = 'default';
    }
  }

  const mode = raw.MODE as Mode;
  if (!MODES.includes(mode)) {
    throw new Error(`Unknown MODE "${raw.MODE}". Expected one of: ${MODES.join(', ')}`);
  }
  const logLevel = raw.LOG_LEVEL as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`Unknown LOG_LEVEL "${raw.LOG_LEVEL}". Expected one of: ${LOG_LEVELS.join(', ')}`);
  }

  const port = bounded('PORT', raw.PORT, 0, 65535);
  const stateHz = bounded('STATE_HZ', raw.STATE_HZ, 0.1, 50, false);

  return {
    mode,
    host: raw.HOST,
    port,
    canIf: raw.CAN_IF,
    vesselId: raw.VESSEL_ID,
    logLevel,
    stateHz,
    stateIntervalMs: Math.round(1000 / stateHz),
    fastPacketTtlMs: bounded('FAST_PACKET_TTL_MS', raw.FAST_PACKET_TTL_MS, 100, 600000),
    sweepIntervalMs: bounded('SWEEP_INTERVAL_MS', raw.SWEEP_INTERVAL_MS, 100, 600000),
    statsIntervalS: bounded('STATS_INTERVAL_S', raw.STATS_INTERVAL_S, 0, 86400),
    canRetryMs: bounded('CAN_RETRY_MS', raw.CAN_RETRY_MS, 0, 600000),
    shutdownGraceMs: bounded('SHUTDOWN_GRACE_MS', raw.SHUTDOWN_GRACE_MS, 0, 60000),
    replayFile: raw.REPLAY_FILE === '' ? null : raw.REPLAY_FILE,
    replaySpeed: bounded('REPLAY_SPEED', raw.REPLAY_SPEED, 0.01, 10000, false),
    replayMaxGapMs: bounded('REPLAY_MAX_GAP_MS', raw.REPLAY_MAX_GAP_MS, 0, 60000),
    replayLoop: raw.REPLAY_LOOP === 'true' || raw.REPLAY_LOOP === '1',
    sources,
  };
}

/** Human-readable effective configuration, with the origin of each value. */
export function formatConfig(config: Config): string {
  const lines = ['effective configuration (flag > env > default)', ''];
  const width = Math.max(...CONFIG_SPEC.map((s) => s.env.length));
  for (const spec of CONFIG_SPEC) {
    const value = config[spec.prop];
    const shown =
      value === null || value === '' ? '(unset)' : String(value as string | number | boolean);
    const origin = config.sources[spec.env];
    lines.push(
      `  ${spec.env.padEnd(width)}  ${shown.padEnd(22)} ${origin.padEnd(8)} ${spec.describe}`,
    );
  }
  lines.push('', `  derived: snapshot interval ${config.stateIntervalMs} ms`);
  return lines.join('\n');
}
