/**
 * Mode selection, the single ingest seam, the WebSocket fan-out and lifecycle.
 *
 * The real bus (MODE=can), the simulator (MODE=sim) and a recorded log
 * (MODE=replay) all call the same ingest(frame). Everything below that point is
 * identical: this is a hard requirement, the decode path is never forked per
 * mode.
 *
 * Nothing operational is hard-coded here. Every rate, timeout, address and
 * identity comes from ./config, so moving to a new vessel is configuration.
 */

import { readFileSync } from 'fs';
import { WebSocket, WebSocketServer } from 'ws';

import { FAST_PACKET_PGNS, FastPacketAssembler, parseCanId, type CanFrame } from './n2k';
import { DECODERS, SUPPORTED_PGNS, decode, type Decoded } from './decoders';
import { apply, createState, type VesselState } from './state';
import { createSimulator, type Simulator } from './sim';
import { newRxStats, openRawChannel, type CanRxStats, type SocketCanChannel } from './can';
import { BusMonitor, formatBusLine, type BusSnapshot } from './diagnostics';
import { loadConfig, type Config, type LogLevel } from './config';

export {
  loadConfig,
  loadEnvFile,
  formatConfig,
  CONFIG_SPEC,
  N2K_BITRATE,
  type Config,
  type Mode,
  type LogLevel,
} from './config';

/** Retained for callers that want the shipped default rather than the config. */
export const DEFAULT_STATE_INTERVAL_MS = 200;

/* ------------------------------------------------------------------ *
 * Logging
 * ------------------------------------------------------------------ */

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, info: 1, debug: 2 };

export interface Logger {
  error(msg: string): void;
  info(msg: string): void;
  debug(msg: string): void;
}

export function createLogger(level: LogLevel): Logger {
  const rank = LEVEL_RANK[level];
  const out = (msg: string): void => {
    process.stdout.write(`${msg}\n`);
  };
  const err = (msg: string): void => {
    process.stderr.write(`${msg}\n`);
  };
  return {
    error: err,
    info: (msg) => {
      if (rank >= 1) out(msg);
    },
    debug: (msg) => {
      if (rank >= 2) out(msg);
    },
  };
}

/* ------------------------------------------------------------------ *
 * The ingest seam
 * ------------------------------------------------------------------ */

export interface Pipeline {
  /** The single entry point every frame source calls. */
  ingest(frame: CanFrame): void;
  readonly state: VesselState;
  readonly assembler: FastPacketAssembler;
  readonly monitor: BusMonitor;
  /** Everything the diagnostics need, in one call. */
  bus(): BusSnapshot;
}

export interface PipelineOptions {
  fastPacketTtlMs?: number;
  onDecoded?: (decoded: Decoded) => void;
  logger?: Logger;
}

export function createPipeline(vesselId: string, options: PipelineOptions = {}): Pipeline {
  const state = createState(vesselId);
  const assembler = new FastPacketAssembler(options.fastPacketTtlMs ?? 3000);
  const monitor = new BusMonitor();
  const { onDecoded, logger } = options;

  function ingest(frame: CanFrame): void {
    try {
      const ts = frame.ts ?? Date.now();
      const { pgn, src } = parseCanId(frame.id);
      monitor.record(pgn, src, ts, DECODERS[pgn] !== undefined);

      // Only fast-packet groups go through reassembly; everything else passes
      // its single frame straight to decode.
      const payload = FAST_PACKET_PGNS.has(pgn)
        ? assembler.add(src, pgn, frame.data, ts)
        : frame.data;
      if (payload === null) return; // sequence still in flight

      const decoded = decode(pgn, src, payload, ts);
      if (decoded === null) return; // PGN we do not decode

      apply(state, decoded);
      onDecoded?.(decoded);
    } catch (err) {
      // One malformed frame must never stop the stream.
      logger?.error(`[n2k] ingest error: ${String(err)}`);
    }
  }

  return {
    ingest,
    state,
    assembler,
    monitor,
    bus: () => monitor.snapshot({ ...assembler.stats, pending: assembler.pending }),
  };
}

/* ------------------------------------------------------------------ *
 * Frame sources
 * ------------------------------------------------------------------ */

interface FrameSource {
  stop(): void;
}

/**
 * Open the CAN interface, retrying while it is not up.
 *
 * This is the common real-world failure: systemd starts the service before the
 * network unit has brought can0 up, so the very first open fails on a rig that
 * is otherwise fine. Retrying turns a crash loop into a log line.
 */
function startCan(
  iface: string,
  retryMs: number,
  ingest: (f: CanFrame) => void,
  log: Logger,
  rxStats: CanRxStats,
): FrameSource {
  let channel: SocketCanChannel | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let attempt = 0;

  const attemptOpen = (): void => {
    if (stopped) return;
    attempt += 1;
    try {
      channel = openRawChannel(iface, ingest, rxStats);
      log.info(`[n2k] ${iface} open${attempt > 1 ? ` after ${attempt} attempts` : ''}`);
    } catch (err) {
      if (retryMs <= 0) throw err;
      log.error(
        `[n2k] cannot open ${iface} (attempt ${attempt}): ${String(err)}` +
          `\n[n2k] retrying in ${retryMs} ms. Is the interface up?` +
          `  sudo ip link set ${iface} up type can bitrate 250000`,
      );
      timer = setTimeout(attemptOpen, retryMs);
    }
  };

  attemptOpen();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      channel?.stop();
      channel = null;
    },
  };
}

function startSim(ingest: (f: CanFrame) => void): FrameSource {
  const sim: Simulator = createSimulator(ingest);
  sim.start();
  return { stop: () => sim.stop() };
}

/**
 * Replay a `candump -l` capture through ingest(), for validating the decoders
 * against real bus data before boarding the vessel.
 *
 * Line format: `(1770000000.123456) can0 09F80203#0102030405060708`
 * The leading timestamp is optional.
 */
const CANDUMP_LINE = /^(?:\((\d+)\.(\d+)\)\s+)?\S+\s+([0-9A-Fa-f]{3,8})#([0-9A-Fa-f]*)$/;

export function parseCandumpLine(line: string): CanFrame | null {
  const m = CANDUMP_LINE.exec(line.trim());
  if (!m) return null;
  const data = Buffer.from(m[4], 'hex');
  if (data.length > 8) return null;
  const ts =
    m[1] !== undefined
      ? Number(m[1]) * 1000 + Math.floor(Number(m[2].padEnd(6, '0')) / 1000)
      : Date.now();
  return { id: parseInt(m[3], 16), data, ts };
}

/** Read a capture into memory, reporting how many lines were unparseable. */
export function readCapture(file: string): { frames: CanFrame[]; skipped: number } {
  const frames: CanFrame[] = [];
  let skipped = 0;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const frame = parseCandumpLine(line);
    if (frame) frames.push(frame);
    else skipped += 1;
  }
  return { frames, skipped };
}

function startReplay(config: Config, ingest: (f: CanFrame) => void, log: Logger): FrameSource {
  const file = config.replayFile as string;
  const { frames, skipped } = readCapture(file);
  log.info(`[n2k] replay ${file}: ${frames.length} frames, ${skipped} lines skipped`);
  if (frames.length === 0) {
    log.error(`[n2k] ${file} contained no parseable candump lines`);
  }

  let i = 0;
  let timer: NodeJS.Timeout | null = null;

  const next = (): void => {
    if (i >= frames.length) {
      if (config.replayLoop && frames.length > 0) {
        i = 0;
        log.info('[n2k] replay looping');
      } else {
        log.info('[n2k] replay complete');
        return;
      }
    }
    const frame = frames[i];
    ingest(frame);
    i += 1;
    if (i >= frames.length && !config.replayLoop) {
      log.info('[n2k] replay complete');
      return;
    }
    const nextFrame = frames[i % frames.length];
    const gap = (nextFrame.ts ?? 0) - (frame.ts ?? 0);
    const delay = Math.min(config.replayMaxGapMs, Math.max(0, gap / config.replaySpeed));
    timer = setTimeout(next, delay);
  };

  if (frames.length > 0) timer = setTimeout(next, 0);

  return {
    stop: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

export interface ServerHandle {
  readonly config: Config;
  readonly state: VesselState;
  /** Actual bound port, useful when the config asked for 0. */
  readonly port: number;
  /** Live bus diagnostics. */
  bus(): BusSnapshot;
  /** Wire-level receive counts. Meaningful in MODE=can only. */
  readonly rx: CanRxStats;
  close(): Promise<void>;
}

export function startServer(config: Config, logger?: Logger): Promise<ServerHandle> {
  const log = logger ?? createLogger(config.logLevel);
  const wss = new WebSocketServer({ host: config.host, port: config.port });

  function broadcast(message: unknown): void {
    const text = JSON.stringify(message);
    for (const client of wss.clients) {
      // Backpressure: skip anything not open rather than queueing.
      if (client.readyState !== WebSocket.OPEN) continue;
      try {
        client.send(text);
      } catch (err) {
        log.debug(`[n2k] send failed: ${String(err)}`);
      }
    }
  }

  // Populated only in MODE=can; error-frame counts are the sharpest early
  // warning of a wiring fault on a real backbone.
  const rxStats = newRxStats();

  const pipeline = createPipeline(config.vesselId, {
    fastPacketTtlMs: config.fastPacketTtlMs,
    logger: log,
    onDecoded: (decoded) => {
      broadcast({
        type: 'pgn',
        pgn: decoded.pgn,
        src: decoded.src,
        ts: decoded.ts,
        fields: decoded.fields,
      });
      log.debug(`[n2k] ${decoded.pgn} src=${decoded.src} ${JSON.stringify(decoded.fields)}`);
    },
  });

  wss.on('connection', (client) => {
    // A reconnecting client immediately gets a fresh hello + state.
    client.send(
      JSON.stringify({
        type: 'hello',
        vessel_id: config.vesselId,
        pgns: SUPPORTED_PGNS,
        mode: config.mode,
        state_hz: config.stateHz,
      }),
    );
    client.send(JSON.stringify({ type: 'state', ...pipeline.state }));
    client.on('error', (err) => log.debug(`[n2k] client error: ${String(err)}`));
  });
  wss.on('error', (err) => log.error(`[n2k] server error: ${String(err)}`));

  const timers: NodeJS.Timeout[] = [];
  timers.push(
    setInterval(() => broadcast({ type: 'state', ...pipeline.state }), config.stateIntervalMs),
  );
  timers.push(
    setInterval(() => {
      const dropped = pipeline.assembler.sweep();
      if (dropped) log.debug(`[n2k] swept ${dropped} stale fast-packet sequence(s)`);
    }, config.sweepIntervalMs),
  );
  if (config.statsIntervalS > 0) {
    timers.push(
      setInterval(() => {
        const snapshot = pipeline.bus();
        const canLine =
          config.mode === 'can'
            ? ` | can err=${rxStats.error} rtr=${rxStats.remote}`
            : '';
        log.info(formatBusLine(snapshot) + canLine);
        broadcast({ type: 'stats', ts: Date.now(), ...snapshot, can: rxStats });
      }, config.statsIntervalS * 1000),
    );
  }

  let source: FrameSource | null = null;
  let closed = false;

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearInterval(timer);
    source?.stop();
    pipeline.assembler.clear();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  return new Promise<ServerHandle>((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () => {
      wss.off('error', reject);
      const address = wss.address();
      const port = typeof address === 'object' && address !== null ? address.port : config.port;

      try {
        if (config.mode === 'can') {
          source = startCan(config.canIf, config.canRetryMs, pipeline.ingest, log, rxStats);
        } else if (config.mode === 'replay') {
          if (!config.replayFile) {
            throw new Error('MODE=replay requires --replay-file=<candump log> (or REPLAY_FILE)');
          }
          source = startReplay(config, pipeline.ingest, log);
        } else {
          source = startSim(pipeline.ingest);
        }
      } catch (err) {
        void close().then(() => reject(err));
        return;
      }

      const iface = config.mode === 'can' ? config.canIf : '-';
      log.info(
        `[n2k] mode=${config.mode} iface=${iface} bind=${config.host}:${port} ` +
          `vessel=${config.vesselId} pgns=${SUPPORTED_PGNS.length} state=${config.stateHz}Hz`,
      );
      resolve({ config, state: pipeline.state, port, bus: pipeline.bus, rx: rxStats, close });
    });
  });
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

if (require.main === module) {
  void (async (): Promise<void> => {
    const { loadEnvFile, formatConfig } = await import('./config');
    const envPath = process.env.ENV_FILE ?? '.env';
    const applied = loadEnvFile(envPath);

    let config: Config;
    try {
      config = loadConfig();
    } catch (err) {
      process.stderr.write(`[n2k] ${String(err)}\n`);
      process.exit(2);
      return;
    }

    if (process.argv.includes('--print-config')) {
      process.stdout.write(`${formatConfig(config)}\n`);
      process.exit(0);
      return;
    }

    const log = createLogger(config.logLevel);
    if (applied >= 0) log.info(`[n2k] loaded ${applied} setting(s) from ${envPath}`);

    try {
      const handle = await startServer(config, log);
      let shuttingDown = false;
      const shutdown = (signal: string): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info(`[n2k] ${signal} received, shutting down`);
        handle
          .close()
          .then(() => process.exit(0))
          .catch(() => process.exit(0));
        // Never hang on a stuck socket.
        setTimeout(() => process.exit(0), config.shutdownGraceMs).unref();
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    } catch (err) {
      process.stderr.write(`[n2k] failed to start: ${String(err)}\n`);
      process.exit(1);
    }
  })();
}
