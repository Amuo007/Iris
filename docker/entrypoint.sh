#!/bin/bash
# Runs as root: give the iris user the host's PUID/PGID, link the data volumes where Iris, resuma and the run tools
# look for them, then start everything as iris (docker/start.sh).
set -e
PUID=${PUID:-1000}
PGID=${PGID:-1000}
H=/home/iris

if [ "$(id -g iris)" != "$PGID" ]; then groupmod -o -g "$PGID" iris; fi
if [ "$(id -u iris)" != "$PUID" ]; then usermod -o -u "$PUID" iris; fi

# Iris keeps its data in ~/.config/Iris on Linux; the run tools read it at the macOS path, so that path links there
mkdir -p "$H/.config/Iris" "$H/ai/iris-run" /data/resuma/output "$H/Library/Application Support"
ln -sfn "$H/.config/Iris" "$H/Library/Application Support/Iris"
mkdir -p "$H/ai/iris-run/shots"

# resuma's own profile, resume and settings (never in git) and its runs live in /data/resuma
for f in data/profile.json data/original.tex .env; do
  src="/data/resuma/$(basename "$f")"
  if [ -e "$src" ]; then ln -sfn "$src" "/app/resuma/$f"; else echo "resuma: $src is missing (copy it in; see docs/docker.md)"; fi
done
if [ ! -L /app/resuma/output ]; then rm -rf /app/resuma/output; ln -s /data/resuma/output /app/resuma/output; fi

# the volumes may come from another machine: iris must own what it writes
for d in "$H/.config/Iris" "$H/ai/iris-run" /data/resuma; do
  [ "$(stat -c %u "$d")" = "$PUID" ] || chown -R iris:iris "$d"
done
[ "$(stat -c %u /app/resuma)" = "$PUID" ] || chown -R iris:iris /app/resuma
chown iris:iris "$H" "$H/.config" "$H/ai" "$H/Library" "$H/Library/Application Support"
chown -h iris:iris "$H/Library/Application Support/Iris"

exec setpriv --reuid=iris --regid=iris --init-groups env HOME="$H" USER=iris /app/docker/start.sh
