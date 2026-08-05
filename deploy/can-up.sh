#!/usr/bin/env bash
# Bring a CAN interface up at the NMEA 2000 bit rate and sanity-check it.
#
#   sudo ./deploy/can-up.sh can0
#
# 250000 is not negotiable. At 500000 (the automotive rate) you receive zero
# frames and the interface reports no error, which is the single most common
# way to lose an afternoon on this.

set -euo pipefail

IFACE="${1:-can0}"
BITRATE=250000

if [[ $EUID -ne 0 ]]; then
  echo "This needs root: sudo $0 $IFACE" >&2
  exit 1
fi

if [[ ! -d "/sys/class/net/${IFACE}" ]]; then
  echo "Interface ${IFACE} does not exist. Present interfaces:" >&2
  ls /sys/class/net >&2
  echo >&2
  echo "If you are using a CAN HAT, check the dtoverlay line in /boot/config.txt" >&2
  echo "and that the module is loaded (lsmod | grep mcp251)." >&2
  exit 1
fi

echo "Bringing ${IFACE} down (ignore an error if it was already down)"
ip link set "${IFACE}" down 2>/dev/null || true

echo "Configuring ${IFACE} at ${BITRATE} bit/s"
ip link set "${IFACE}" up type can bitrate "${BITRATE}"

# restart-ms recovers the controller automatically after a bus-off event,
# which a marginal tap or a termination fault can trigger.
ip link set "${IFACE}" type can restart-ms 100 2>/dev/null || \
  echo "  (restart-ms not supported on this driver, continuing)"

ACTUAL=$(cat "/sys/class/net/${IFACE}/can_bittiming/bitrate" 2>/dev/null || echo "unknown")
echo
echo "${IFACE} is up. bitrate=${ACTUAL}"
echo

if [[ "${ACTUAL}" != "${BITRATE}" && "${ACTUAL}" != "unknown" ]]; then
  echo "WARNING: bitrate is ${ACTUAL}, expected ${BITRATE}" >&2
fi

echo "Next:"
echo "  candump ${IFACE}                       frames should scroll immediately"
echo "  npm run doctor -- --can-if=${IFACE}     full preflight and bus survey"
echo "  candump -l ${IFACE}                    record a capture to send onward"
