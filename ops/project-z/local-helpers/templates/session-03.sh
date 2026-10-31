set -u
O=/home/factory-user/repos/fzv-g-out-29; N=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin/node
NAME="$1"
echo "stack lock acquired $(date -u +%FT%TZ)"
for p in 3001 3101 55441 54321 54322; do if ss -ltn | grep -q ":$p "; then echo "PORT_BUSY $p"; exit 75; fi; done
m=$(awk '/MemAvailable/{print $2}' /proc/meminfo); echo "MemAvailableKiB $m"; [ "$m" -ge 4194304 ] || { echo MEMORY_GUARD; exit 75; }
f=$(df --output=avail -B1 /home/factory-user/repos | tail -1); echo "FreeDiskBytes $f"; [ "$f" -ge 6442450944 ] || { echo DISK_GUARD; exit 75; }
timeout 1500 $N $O/z1-native/driver-03.mjs "$NAME"; echo "driver exit $? $(date -u +%FT%TZ)"
for p in 3001 3101 55441 54321 54322; do ss -ltn | grep -q ":$p " && echo "AFTER PORT_BUSY $p"; done; echo ports-checked
echo "releasing stack lock $(date -u +%FT%TZ)"
