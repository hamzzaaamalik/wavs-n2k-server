/**
 * The SocketCAN adapter: the only part of this service that touches hardware.
 *
 * The native `socketcan` addon is an optional dependency and is required
 * lazily, so sim and replay modes never need it and `npm install` succeeds on
 * macOS and Windows where it cannot build.
 */

import { readFileSync } from 'fs';

import type { CanFrame } from './n2k';

/**
 * Minimal surface of the optional native addon that we depend on.
 *
 * Verified against socketcan 4.2.4's own `src/can.d.ts` and `samples/dump.js`.
 * Note that `ts_sec` / `ts_usec` are delivered at runtime when the channel is
 * opened with timestamps, but are absent from the package's declarations, so
 * they stay optional here with a Date.now() fallback.
 */
export interface SocketCanMessage {
  id: number;
  data: Uint8Array;
  /** Extended (29-bit) identifier. Always true for NMEA 2000. */
  ext?: boolean;
  /** Remote transmission request: no payload to decode. */
  rtr?: boolean;
  /** CAN error frame: `id` is an error bitmask, not a PGN. */
  err?: boolean;
  ts_sec?: number;
  ts_usec?: number;
}
export interface SocketCanChannel {
  addListener(event: 'onMessage', cb: (msg: SocketCanMessage) => void): void;
  start(): void;
  stop(): void;
}
export interface SocketCanModule {
  createRawChannel(iface: string, timestamps?: boolean, protocol?: number): SocketCanChannel;
}

/** Counts of what arrived on the wire, including what we deliberately drop. */
export interface CanRxStats {
  /** Frames passed on to ingest(). */
  accepted: number;
  /**
   * CAN error frames: bus-off, ACK errors, controller overruns. Not telemetry.
   * A rising count is the clearest signal of a marginal tap, missing
   * termination, or the wrong bit rate.
   */
  error: number;
  /** Remote-transmission-request frames. No payload, nothing to decode. */
  remote: number;
}

export function newRxStats(): CanRxStats {
  return { accepted: 0, error: 0, remote: 0 };
}

export class SocketCanUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      'The optional native "socketcan" addon is not available. It is Linux-only ' +
        'and needs a C/C++ toolchain: sudo apt install build-essential && npm install socketcan' +
        `\n  cause: ${String(cause)}`,
    );
    this.name = 'SocketCanUnavailableError';
  }
}

/** Load the native addon, or explain precisely why it is missing. */
export function requireSocketcan(): SocketCanModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('socketcan') as SocketCanModule;
  } catch (err) {
    throw new SocketCanUnavailableError(err);
  }
}

/** Convert the addon's message shape into our CanFrame. */
export function toCanFrame(msg: SocketCanMessage): CanFrame {
  const ts =
    msg.ts_sec !== undefined
      ? msg.ts_sec * 1000 + Math.floor((msg.ts_usec ?? 0) / 1000)
      : Date.now();
  return { id: msg.id, data: Buffer.from(msg.data), ts };
}

/**
 * Open `iface` and route every usable frame to `onFrame`. Throws if it cannot.
 *
 * Error and remote frames are counted and dropped rather than decoded: an error
 * frame's identifier is a bitmask, not a PGN, so passing it through would
 * pollute the bus survey with phantom parameter groups and hide the very fault
 * it is reporting.
 */
export function openRawChannel(
  iface: string,
  onFrame: (frame: CanFrame) => void,
  stats: CanRxStats = newRxStats(),
): SocketCanChannel {
  const channel = requireSocketcan().createRawChannel(iface, true);
  channel.addListener('onMessage', (msg) => {
    if (msg.err === true) {
      stats.error += 1;
      return;
    }
    if (msg.rtr === true) {
      stats.remote += 1;
      return;
    }
    stats.accepted += 1;
    onFrame(toCanFrame(msg));
  });
  channel.start();
  return channel;
}

/* ------------------------------------------------------------------ *
 * Interface inspection, for the preflight check.
 *
 * Read straight from sysfs rather than shelling out to `ip`, so it works in a
 * minimal container and cannot be confused by locale or output formatting.
 * ------------------------------------------------------------------ */

export interface InterfaceInfo {
  name: string;
  exists: boolean;
  /** 'up', 'down', 'unknown' (vcan reports unknown even when usable). */
  operstate: string | null;
  /** Configured bitrate, or null for virtual interfaces that have none. */
  bitrate: number | null;
  /** Kernel driver type where discoverable, e.g. 'can' or 'vcan'. */
  kind: string | null;
}

function readSys(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

export function inspectInterface(name: string): InterfaceInfo {
  const base = `/sys/class/net/${name}`;
  const operstate = readSys(`${base}/operstate`);
  const bitrateRaw = readSys(`${base}/can_bittiming/bitrate`);
  const uevent = readSys(`${base}/uevent`);
  const kind = uevent ? (/DEVTYPE=(\w+)/.exec(uevent)?.[1] ?? null) : null;

  return {
    name,
    exists: operstate !== null || readSys(`${base}/type`) !== null,
    operstate,
    bitrate: bitrateRaw !== null ? Number(bitrateRaw) : null,
    kind,
  };
}

/** Every network interface the kernel knows about, for a helpful error. */
export function listInterfaces(): string[] {
  try {
    // readdirSync is only needed here, so require it inline.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readdirSync } = require('fs') as typeof import('fs');
    return readdirSync('/sys/class/net').sort();
  } catch {
    return [];
  }
}
