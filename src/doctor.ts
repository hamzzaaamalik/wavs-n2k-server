/**
 * Preflight check. Run this first on the boat, before the server.
 *
 * It answers, in order: can this machine talk to CAN at all, is the interface
 * configured correctly, are frames arriving, and does this vessel actually emit
 * the seven parameter groups the compliance record needs.
 *
 *   npm run doctor -- --can-if=can0 --seconds=15
 *
 * Exit code 0 = ready, 1 = something needs fixing. Safe to run in a script.
 */

import { inspectInterface, listInterfaces, newRxStats, openRawChannel, requireSocketcan } from './can';
import { BusMonitor, formatBusReport } from './diagnostics';
import { FAST_PACKET_PGNS, FastPacketAssembler, parseCanId } from './n2k';
import { DECODERS, SUPPORTED_PGNS, decode } from './decoders';
import { N2K_BITRATE, loadConfig, loadEnvFile } from './config';

type Status = 'ok' | 'warn' | 'fail' | 'skip';

interface Check {
  status: Status;
  title: string;
  detail?: string;
  fix?: string;
}

const MARK: Record<Status, string> = {
  ok: '  OK  ',
  warn: ' WARN ',
  fail: ' FAIL ',
  skip: ' SKIP ',
};

function render(check: Check): string {
  const lines = [`[${MARK[check.status]}] ${check.title}`];
  if (check.detail) lines.push(`         ${check.detail}`);
  if (check.fix) lines.push(`         fix: ${check.fix}`);
  return lines.join('\n');
}

function checkPlatform(): Check {
  if (process.platform === 'linux') {
    return { status: 'ok', title: `platform is ${process.platform}` };
  }
  return {
    status: 'fail',
    title: `platform is ${process.platform}, not linux`,
    detail: 'SocketCAN is a Linux kernel facility. MODE=can cannot run here.',
    fix: 'Run this on the Pi, a Linux VM, or use MODE=replay against a candump capture.',
  };
}

/** socketcan 4.2.x declares engines.node >= 22. */
const MIN_NODE_MAJOR = 22;

function checkNode(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= MIN_NODE_MAJOR) {
    return { status: 'ok', title: `node ${process.versions.node}` };
  }
  return {
    status: 'fail',
    title: `node ${process.versions.node} is too old for the socketcan addon`,
    detail:
      `socketcan 4.2.x requires node >= ${MIN_NODE_MAJOR}. npm skips an optional ` +
      'dependency whose engine does not match SILENTLY, so MODE=can would fail ' +
      'later with a misleading "addon is missing" message.',
    fix:
      'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && ' +
      'sudo apt install -y nodejs && rm -rf node_modules && npm install',
  };
}

function checkAddon(): Check {
  try {
    requireSocketcan();
    return { status: 'ok', title: 'native socketcan addon loads' };
  } catch (err) {
    return {
      status: 'fail',
      title: 'native socketcan addon is missing',
      detail: String(err).split('\n')[0],
      fix: 'sudo apt install build-essential && npm install socketcan',
    };
  }
}

function checkInterface(iface: string): Check[] {
  const info = inspectInterface(iface);
  const checks: Check[] = [];

  if (!info.exists) {
    const available = listInterfaces();
    return [
      {
        status: 'fail',
        title: `interface ${iface} does not exist`,
        detail: available.length ? `present: ${available.join(', ')}` : undefined,
        fix: `sudo ip link set ${iface} up type can bitrate ${N2K_BITRATE}`,
      },
    ];
  }
  checks.push({ status: 'ok', title: `interface ${iface} exists${info.kind ? ` (${info.kind})` : ''}` });

  if (info.operstate === 'up' || info.operstate === 'unknown') {
    checks.push({
      status: 'ok',
      title: `${iface} operstate is ${info.operstate}`,
      detail: info.operstate === 'unknown' ? 'normal for a virtual CAN interface' : undefined,
    });
  } else {
    checks.push({
      status: 'fail',
      title: `${iface} operstate is ${info.operstate ?? 'unreadable'}`,
      fix: `sudo ip link set ${iface} up type can bitrate ${N2K_BITRATE}`,
    });
  }

  if (info.bitrate === null) {
    checks.push({
      status: 'skip',
      title: 'bitrate not reported',
      detail: 'virtual interfaces have no bit timing; nothing to verify',
    });
  } else if (info.bitrate === N2K_BITRATE) {
    checks.push({ status: 'ok', title: `bitrate is ${info.bitrate} (NMEA 2000)` });
  } else {
    checks.push({
      status: 'fail',
      title: `bitrate is ${info.bitrate}, expected ${N2K_BITRATE}`,
      detail:
        info.bitrate === 500000
          ? 'This is the automotive CAN rate. At the wrong rate you receive zero frames and no error.'
          : undefined,
      fix: `sudo ip link set ${iface} down && sudo ip link set ${iface} up type can bitrate ${N2K_BITRATE}`,
    });
  }
  return checks;
}

/** Listen for `seconds` and report what is actually on the backbone. */
async function survey(
  iface: string,
  seconds: number,
): Promise<{ report: string; missing: number[]; frames: number; errorFrames: number }> {
  const monitor = new BusMonitor();
  const assembler = new FastPacketAssembler();
  const rx = newRxStats();

  const channel = openRawChannel(iface, (frame) => {
    const ts = frame.ts ?? Date.now();
    const { pgn, src } = parseCanId(frame.id);
    monitor.record(pgn, src, ts, DECODERS[pgn] !== undefined);
    // Run the real reassembly and decode so the survey exercises the same path
    // the server will, not just the identifier.
    const payload = FAST_PACKET_PGNS.has(pgn) ? assembler.add(src, pgn, frame.data, ts) : frame.data;
    if (payload !== null) decode(pgn, src, payload, ts);
  }, rx);

  const sweeper = setInterval(() => assembler.sweep(), 1000);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  clearInterval(sweeper);
  channel.stop();

  const snapshot = monitor.snapshot({ ...assembler.stats, pending: assembler.pending });
  return {
    report: formatBusReport(snapshot),
    missing: snapshot.missing,
    frames: snapshot.frames,
    errorFrames: rx.error,
  };
}

export async function runDoctor(iface: string, seconds: number): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };

  out('');
  out('N2K PREFLIGHT');
  out(`  interface ${iface}, listening ${seconds}s`);
  out('');

  const checks: Check[] = [checkPlatform()];
  if (checks[0].status === 'ok') {
    checks.push(checkNode());
    if (checks[checks.length - 1].status === 'ok') checks.push(checkAddon());
    if (checks[checks.length - 1].status === 'ok') checks.push(...checkInterface(iface));
  }
  for (const check of checks) out(render(check));

  if (checks.some((c) => c.status === 'fail')) {
    out('');
    out('NOT READY. Fix the failures above, then run this again.');
    out('');
    return 1;
  }

  out('');
  out(`Listening on ${iface} for ${seconds}s ...`);
  out('');

  let result: Awaited<ReturnType<typeof survey>>;
  try {
    result = await survey(iface, seconds);
  } catch (err) {
    out(render({ status: 'fail', title: 'could not open the interface', detail: String(err) }));
    return 1;
  }

  out(result.report);
  out('');

  if (result.errorFrames > 0) {
    out(`  CAN ERROR FRAMES: ${result.errorFrames} received and discarded.`);
    out('    The controller is reporting bus faults. Check termination (120 ohm at');
    out('    BOTH ends of the trunk), the drop cable, and that nothing else is');
    out('    driving the bus at a different rate.');
    out('');
  }

  if (result.frames === 0) {
    out('NOT READY. Zero frames received.');
    out('  Check, in this order:');
    out(`    1. candump ${iface}          does anything scroll at all?`);
    out('    2. bitrate                   250000, not 500000');
    out('    3. the tap                   drop cable seated, backbone powered');
    out('    4. termination               120 ohm at BOTH ends of the trunk');
    out('');
    return 1;
  }

  if (result.missing.length > 0) {
    out(`READY, with gaps. ${result.missing.length} of 7 groups are absent: ${result.missing.join(', ')}`);
    out('  The server will run and those fields will stay null. Whether that');
    out('  matters depends on the rule: sog_kn (129026) is the one the speed');
    out('  rule turns on. The rest are context.');
    out('');
    return 0;
  }

  out('READY. All seven compliance-critical groups are present on this bus.');
  out(`  MODE=can CAN_IF=${iface} node dist/server.js`);
  out('');
  return 0;
}

if (require.main === module) {
  loadEnvFile(process.env.ENV_FILE ?? '.env');
  const config = loadConfig();
  const secondsArg = process.argv.find((a) => a.startsWith('--seconds='));
  const seconds = secondsArg ? Number(secondsArg.split('=')[1]) : 10;

  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) {
    process.stderr.write('[n2k] --seconds must be between 1 and 3600\n');
    process.exit(2);
  }

  void runDoctor(config.canIf, seconds).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`[n2k] doctor failed: ${String(err)}\n`);
      process.exit(1);
    },
  );
}

export { SUPPORTED_PGNS };
