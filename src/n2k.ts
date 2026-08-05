/**
 * NMEA 2000 transport layer: 29-bit identifier codec and fast-packet reassembly.
 *
 * N2K is SAE J1939 on a 250 kbit/s CAN bus. Nothing in this file knows what any
 * parameter group means; it only turns frames into (pgn, src, payload) triples.
 * Spec reference: build spec sections 3, 4 and 5.
 */

/** One CAN frame, from SocketCAN or from the simulator. */
export interface CanFrame {
  /** 29-bit extended identifier. */
  id: number;
  /** 0..8 payload bytes. */
  data: Buffer;
  /** Capture time, ms epoch. Defaults to Date.now() at ingest. */
  ts?: number;
}

/** The three things the 29-bit identifier encodes, plus the destination. */
export interface CanId {
  priority: number;
  pgn: number;
  src: number;
  /** 255 means global/broadcast. */
  dst: number;
}

export interface BuildCanIdInput {
  pgn: number;
  src: number;
  /** Default 3, the usual N2K data priority. */
  priority?: number;
  /** Only meaningful for PDU1 (pf < 240) groups. Default 255. */
  dst?: number;
}

export const BROADCAST = 0xff;

/**
 * Split a 29-bit identifier into priority, PGN, source and destination.
 *
 * `dp` deliberately spans two bits: bit 24 is the J1939 data page and bit 25 is
 * the extended data page. NMEA 2000 folds both into the PGN, so a PGN can carry
 * values above 0x1FFFF (e.g. 130306 = 0x1FD02).
 */
export function parseCanId(id: number): CanId {
  const src = id & 0xff;
  const ps = (id >>> 8) & 0xff; // PDU Specific
  const pf = (id >>> 16) & 0xff; // PDU Format
  const dp = (id >>> 24) & 0x03; // extended data page + data page
  const priority = (id >>> 26) & 0x07;

  if (pf < 240) {
    // PDU1: destination-specific, the PS byte is the destination address.
    return { priority, pgn: (dp << 16) | (pf << 8), src, dst: ps };
  }
  // PDU2: broadcast, the PS byte is part of the PGN.
  return { priority, pgn: (dp << 16) | (pf << 8) | ps, src, dst: BROADCAST };
}

/** Inverse of {@link parseCanId}. Used by the simulator and the test suite. */
export function buildCanId(input: BuildCanIdInput): number {
  const priority = input.priority ?? 3;
  const pf = (input.pgn >>> 8) & 0xff;
  const dp = (input.pgn >>> 16) & 0x03;
  const ps = pf < 240 ? (input.dst ?? BROADCAST) & 0xff : input.pgn & 0xff;

  return (
    (((priority & 0x07) << 26) | (dp << 24) | (pf << 16) | (ps << 8) | (input.src & 0xff)) >>> 0
  );
}

/**
 * Parameter groups that exceed 8 bytes and therefore arrive as a fast-packet
 * sequence. Every other PGN passes its single frame straight to decode.
 */
export const FAST_PACKET_PGNS: ReadonlySet<number> = new Set([
  127489, // Engine Parameters, Dynamic
  129029, // GNSS Position Data
  129038, // AIS Class A Position Report
  129039, // AIS Class B Position Report
  129794, // AIS Class A Static and Voyage Related Data
  129809, // AIS Class B "CS" Static Data, Part A
  129810, // AIS Class B "CS" Static Data, Part B
  130842, // Manufacturer proprietary (Furuno/Simrad AIS)
]);

/** Bytes of payload carried by the first frame of a sequence. */
export const FIRST_FRAME_BYTES = 6;
/** Bytes of payload carried by each continuation frame. */
export const CONT_FRAME_BYTES = 7;

interface PartialSequence {
  sequenceId: number;
  total: number;
  buf: Buffer;
  received: number;
  /** The frameCounter we expect next; anything else abandons the sequence. */
  nextCounter: number;
  updated: number;
}

export interface FastPacketStats {
  /** First frames seen, i.e. sequences begun. */
  started: number;
  /** Sequences that reassembled fully. */
  completed: number;
  /** Sequences abandoned mid-flight (out of order, seq mismatch, orphan). */
  dropped: number;
  /** Sequences discarded by the TTL sweep, i.e. a lost final frame. */
  swept: number;
}

/**
 * Reassembles fast-packet sequences, keyed by (src, pgn).
 *
 * Robustness rules from spec section 5: drop continuations whose sequence id
 * does not match, drop out-of-order counters, drop continuations that arrive
 * with no first frame, and sweep partials older than the TTL so a lost final
 * frame cannot leak memory.
 */
export class FastPacketAssembler {
  private readonly parts = new Map<string, PartialSequence>();

  /**
   * Running counters. On a real bus a non-zero dropped/swept rate is the first
   * sign of a marginal tap, wrong termination, or a talker that interleaves.
   */
  readonly stats: FastPacketStats = { started: 0, completed: 0, dropped: 0, swept: 0 };

  constructor(private readonly ttlMs: number = 3000) {}

  /** Number of sequences currently in flight. Exposed for tests and metrics. */
  get pending(): number {
    return this.parts.size;
  }

  /**
   * Feed one frame of a fast-packet PGN.
   * @returns the assembled payload when the sequence completes, otherwise null.
   */
  add(src: number, pgn: number, data: Buffer, ts: number): Buffer | null {
    if (data.length < 2) return null;

    const control = data[0];
    const frameCounter = control & 0x1f;
    const sequenceId = (control >> 5) & 0x07;
    const key = `${src}:${pgn}`;

    if (frameCounter === 0) {
      const total = data[1];
      if (total <= 0) {
        this.parts.delete(key);
        return null;
      }
      const buf = Buffer.alloc(total);
      const n = Math.min(FIRST_FRAME_BYTES, data.length - 2, total);
      data.copy(buf, 0, 2, 2 + n);

      this.stats.started += 1;
      if (n >= total) {
        this.stats.completed += 1;
        this.parts.delete(key);
        return buf;
      }
      this.parts.set(key, {
        sequenceId,
        total,
        buf,
        received: n,
        nextCounter: 1,
        updated: ts,
      });
      return null;
    }

    const part = this.parts.get(key);
    if (!part) {
      this.stats.dropped += 1; // continuation with no first frame
      return null;
    }
    if (part.sequenceId !== sequenceId) {
      // A new talker sequence interleaved; the old one can never complete.
      this.parts.delete(key);
      this.stats.dropped += 1;
      return null;
    }
    if (frameCounter !== part.nextCounter) {
      this.parts.delete(key); // out of order, abandon
      this.stats.dropped += 1;
      return null;
    }

    const offset = FIRST_FRAME_BYTES + (frameCounter - 1) * CONT_FRAME_BYTES;
    if (offset >= part.total) {
      this.parts.delete(key); // more frames than the declared length allows
      this.stats.dropped += 1;
      return null;
    }

    const n = Math.min(CONT_FRAME_BYTES, data.length - 1, part.total - offset);
    data.copy(part.buf, offset, 1, 1 + n);
    part.received += n;
    part.nextCounter += 1;
    part.updated = ts;

    if (part.received >= part.total) {
      this.stats.completed += 1;
      this.parts.delete(key);
      return part.buf.subarray(0, part.total);
    }
    return null;
  }

  /** Discard partial sequences older than the TTL. Call on a 1 s interval. */
  sweep(now: number = Date.now()): number {
    let dropped = 0;
    for (const [key, part] of this.parts) {
      if (now - part.updated > this.ttlMs) {
        this.parts.delete(key);
        this.stats.swept += 1;
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Drop every in-flight sequence (used on shutdown and by tests). */
  clear(): void {
    this.parts.clear();
  }
}

/**
 * Split a payload into fast-packet frames, the inverse of
 * {@link FastPacketAssembler}. A 43-byte payload yields exactly 7 frames:
 * 6 bytes in the first, then 6 continuations of 7 bytes.
 *
 * Unused tail bytes are padded with 0xFF, as real N2K nodes do.
 */
export function fragmentFastPacket(payload: Buffer, sequenceId: number = 0): Buffer[] {
  const total = payload.length;
  const frames: Buffer[] = [];
  let offset = 0;
  let counter = 0;

  do {
    const frame = Buffer.alloc(8, 0xff);
    frame[0] = ((sequenceId & 0x07) << 5) | (counter & 0x1f);
    if (counter === 0) {
      frame[1] = total;
      const n = Math.min(FIRST_FRAME_BYTES, total - offset);
      payload.copy(frame, 2, offset, offset + n);
      offset += n;
    } else {
      const n = Math.min(CONT_FRAME_BYTES, total - offset);
      payload.copy(frame, 1, offset, offset + n);
      offset += n;
    }
    frames.push(frame);
    counter += 1;
  } while (offset < total);

  return frames;
}
