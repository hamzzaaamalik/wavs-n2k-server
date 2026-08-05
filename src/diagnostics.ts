/**
 * Bus diagnostics.
 *
 * On a real backbone the first questions are always: are frames arriving at
 * all, which parameter groups is this vessel actually emitting, and is anything
 * being dropped. This module answers those without a debugger attached, which
 * matters when the machine is a headless Pi in a console locker.
 */

import type { FastPacketStats } from './n2k';
import { SUPPORTED_PGNS } from './decoders';

export interface PgnSighting {
  pgn: number;
  count: number;
  /** ms epoch of the most recent frame. */
  last: number;
  /** Source addresses that have emitted this group. */
  sources: number[];
}

export interface BusSnapshot {
  /** Seconds the monitor has been running. */
  uptimeS: number;
  /** Every frame handed to ingest(). */
  frames: number;
  /** Frames whose PGN we decode. */
  decoded: number;
  /** Frames whose PGN we do not decode (normal: most of a real bus). */
  ignored: number;
  framesPerSec: number;
  decodedPerSec: number;
  /** Groups we decode, most frequent first. */
  known: PgnSighting[];
  /** Groups present on the bus that we do not decode. */
  unknown: PgnSighting[];
  /** Of the seven compliance-critical groups, which have never been seen. */
  missing: number[];
  fastPacket: FastPacketStats & { pending: number };
}

/** Counts traffic without allocating per frame. */
export class BusMonitor {
  private frames = 0;
  private decoded = 0;
  private readonly seen = new Map<number, { count: number; last: number; sources: Set<number> }>();
  private readonly startedAt: number;

  constructor(now: number = Date.now()) {
    this.startedAt = now;
  }

  /** Record one frame. `known` is whether a decoder is registered for it. */
  record(pgn: number, src: number, ts: number, known: boolean): void {
    this.frames += 1;
    if (known) this.decoded += 1;
    let entry = this.seen.get(pgn);
    if (entry === undefined) {
      entry = { count: 0, last: ts, sources: new Set() };
      this.seen.set(pgn, entry);
    }
    entry.count += 1;
    entry.last = ts;
    if (entry.sources.size < 16) entry.sources.add(src);
  }

  snapshot(fastPacket: FastPacketStats & { pending: number }, now: number = Date.now()): BusSnapshot {
    const uptimeS = Math.max(0.001, (now - this.startedAt) / 1000);
    const supported = new Set(SUPPORTED_PGNS);
    const known: PgnSighting[] = [];
    const unknown: PgnSighting[] = [];

    for (const [pgn, entry] of this.seen) {
      const sighting: PgnSighting = {
        pgn,
        count: entry.count,
        last: entry.last,
        sources: [...entry.sources].sort((a, b) => a - b),
      };
      (supported.has(pgn) ? known : unknown).push(sighting);
    }
    const byCount = (a: PgnSighting, b: PgnSighting): number => b.count - a.count;
    known.sort(byCount);
    unknown.sort(byCount);

    return {
      uptimeS: Math.round(uptimeS),
      frames: this.frames,
      decoded: this.decoded,
      ignored: this.frames - this.decoded,
      framesPerSec: Math.round((this.frames / uptimeS) * 10) / 10,
      decodedPerSec: Math.round((this.decoded / uptimeS) * 10) / 10,
      known,
      unknown,
      missing: SUPPORTED_PGNS.filter((p) => !this.seen.has(p)),
      fastPacket,
    };
  }
}

/** One compact line for the periodic log. */
export function formatBusLine(s: BusSnapshot): string {
  const fp = s.fastPacket;
  const parts = [
    `[n2k] bus ${s.framesPerSec}/s in, ${s.decodedPerSec}/s decoded`,
    `groups ${s.known.length} known + ${s.unknown.length} other`,
    `fastpkt ok=${fp.completed} drop=${fp.dropped} swept=${fp.swept} pending=${fp.pending}`,
  ];
  if (s.missing.length) parts.push(`MISSING ${s.missing.join(',')}`);
  return parts.join(' | ');
}

/** The full report, for --doctor and for LOG_LEVEL=debug. */
export function formatBusReport(s: BusSnapshot): string {
  const lines: string[] = [];
  lines.push(`  ${s.frames} frames in ${s.uptimeS}s  (${s.framesPerSec}/s)`);
  lines.push(`  ${s.decoded} decoded, ${s.ignored} from groups we do not decode`);
  lines.push('');

  if (s.known.length) {
    lines.push('  Compliance-critical groups present:');
    for (const p of s.known) {
      lines.push(
        `    ${p.pgn}  ${String(p.count).padStart(6)} frames  ` +
          `${(p.count / Math.max(1, s.uptimeS)).toFixed(1).padStart(5)}/s  src ${p.sources.join(',')}`,
      );
    }
  } else {
    lines.push('  Compliance-critical groups present: NONE');
  }

  if (s.missing.length) {
    lines.push('');
    lines.push(`  MISSING (never seen): ${s.missing.join(', ')}`);
    lines.push('    A missing group means no device on this backbone emits it.');
    lines.push('    Its VesselState fields will stay null. That is a wiring answer,');
    lines.push('    not a software one.');
  }

  if (s.unknown.length) {
    lines.push('');
    lines.push(`  Other traffic on the bus (${s.unknown.length} groups, not decoded):`);
    for (const p of s.unknown.slice(0, 15)) {
      lines.push(`    ${p.pgn}  ${String(p.count).padStart(6)} frames  src ${p.sources.join(',')}`);
    }
    if (s.unknown.length > 15) lines.push(`    ... and ${s.unknown.length - 15} more`);
  }

  const fp = s.fastPacket;
  lines.push('');
  lines.push(
    `  Fast packet: ${fp.completed} completed, ${fp.dropped} dropped, ` +
      `${fp.swept} swept, ${fp.pending} in flight`,
  );
  if (fp.dropped > 0 || fp.swept > 0) {
    const lossRate = fp.completed > 0 ? ((fp.dropped + fp.swept) / (fp.completed + fp.dropped + fp.swept)) * 100 : 100;
    lines.push(
      `    ${lossRate.toFixed(1)}% of sequences did not complete. Sustained loss points at` +
        ' the tap, termination, or bus load, not at this decoder.',
    );
  }
  return lines.join('\n');
}
