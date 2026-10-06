#!/bin/sh
# Runs as root before kesher-node starts (ExecStartPre=+ in the unit).
# Everything here is best effort and harmless on non-Pi systems.
# Opt out with KESHER_TUNE=0 in /etc/default/kesher-node.

[ -f /etc/default/kesher-node ] && . /etc/default/kesher-node
[ "${KESHER_TUNE:-1}" = "0" ] && exit 0

# Full CPU clock: "ondemand" ramps up too late for 5 ms audio periods.
for gov in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
  [ -w "$gov" ] && echo performance > "$gov" 2>/dev/null
done

# Wi-Fi power save delays received packets by up to 100 ms.
if command -v iw >/dev/null 2>&1; then
  for dev in /sys/class/net/*/wireless; do
    [ -e "$dev" ] || continue
    iface="$(basename "$(dirname "$dev")")"
    iw dev "$iface" set power_save off 2>/dev/null
  done
fi

exit 0
