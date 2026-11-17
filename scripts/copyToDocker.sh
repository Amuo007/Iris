#!/bin/bash
# scripts/copyToDocker.sh user@host [folder] — copy this Mac's own Iris data (none of it is in git) into the data
# folder next to docker-compose.yml on the Docker machine (default folder: /volume1/docker/iris).
#   Iris: settings, application history, sessions, postings, accounts list, resume template
#   run tools: ~/ai/iris-run (task, job lists, scripts, jobs.db), without backups, logs and screenshots
#   resuma: data/profile.json, data/original.tex, .env (from the folder Iris uses, ~/Desktop/Projects/resuma by default)
# Site logins, saved passwords and WhatsApp stay behind: this Mac's keychain locks them, so sign in again there.
# Stop Iris on this Mac first, so its history is final and the two never apply at the same time.
set -e
DEST=$1
DIR=${2:-/volume1/docker/iris}
[ -n "$DEST" ] || { echo "usage: scripts/copyToDocker.sh user@host [folder on that machine]"; exit 1; }
U="$HOME/Library/Application Support/Iris"
RUN="$HOME/ai/iris-run"
RES=${RESUMA_HOME:-$HOME/Desktop/Projects/resuma}
[ -d "$RES/data" ] || RES="$(cd "$(dirname "$0")/.." && pwd)/resuma"

if lsof -nP -iTCP:47821 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Iris is still open on this Mac: quit it first, so the history you copy is final"; exit 1
fi

export COPYFILE_DISABLE=1
ssh "$DEST" "mkdir -p '$DIR/data/userdata' '$DIR/data/iris-run' '$DIR/data/resuma'"

cd "$U"
FILES=$(ls -d settings.json iris-*.json iris-*.jsonl iris-sessions iris-resume-template 2>/dev/null | grep -vE 'backup|\.bak\.json$')
echo "Iris data: $(echo $FILES | wc -w | tr -d ' ') items"
tar --no-mac-metadata -cf - $FILES | ssh "$DEST" "tar -C '$DIR/data/userdata' -xf -"

cd "$RUN"
echo "run tools: $RUN"
tar --no-mac-metadata --exclude='backups' --exclude='*.backup*' --exclude='shots' --exclude='__pycache__' \
  --exclude='*.log' --exclude='main.build.backup*' -cf - . | ssh "$DEST" "tar -C '$DIR/data/iris-run' -xf -"

cd "$RES"
echo "resuma: $RES"
tar --no-mac-metadata -cf - -C "$RES/data" profile.json original.tex -C "$RES" .env | ssh "$DEST" "tar -C '$DIR/data/resuma' -xf -"

echo "copied to $DEST:$DIR/data"
