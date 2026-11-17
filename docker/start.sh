#!/bin/bash
# Runs as iris: a virtual screen and a web viewer for it (http://<host>:6080), then Iris, started again whenever it
# exits. Once per container start it also starts the run in ~/ai/iris-run/task.txt, unless ~/ai/iris-run/PAUSED
# exists or IRIS_AUTOSTART=0.
cd "$HOME"
RUN="$HOME/ai/iris-run"
export IRIS_AGENT_DEBUG="$RUN/iris-debug.log"

rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
Xvfb :1 -screen 0 "${SCREEN:-1600x1000x24}" -nolisten tcp &
for i in $(seq 1 50); do xdpyinfo -display :1 >/dev/null 2>&1 && break; sleep 0.2; done
openbox >/dev/null 2>&1 &

if [ -n "$VNC_PASSWORD" ]; then
  mkdir -p "$HOME/.vnc"
  x11vnc -storepasswd "$VNC_PASSWORD" "$HOME/.vnc/passwd" >/dev/null 2>&1
  AUTH=(-rfbauth "$HOME/.vnc/passwd")
else
  echo "VNC_PASSWORD is empty: anyone on your network can open Iris's screen at port 6080"
  AUTH=(-nopw)
fi
x11vnc -display :1 -forever -shared -localhost -rfbport 5900 "${AUTH[@]}" -quiet >/dev/null 2>&1 &
websockify --web=/usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &

if [ "${IRIS_AUTOSTART:-1}" = 1 ] && [ -f "$RUN/task.txt" ] && [ -x "$RUN/start_run.sh" ] && [ ! -e "$RUN/PAUSED" ]; then
  (
    for i in $(seq 1 90); do python3 "$RUN/ib.py" agent_status >/dev/null 2>&1 && break; sleep 2; done
    sleep 10
    echo "autostart $(date '+%F %T')"
    "$RUN/start_run.sh" task.txt continuous
  ) >> "$RUN/autostart.log" 2>&1 &
fi

while true; do
  /app/node_modules/.bin/electron /app --no-sandbox --password-store=basic
  echo "Iris exited ($?) at $(date '+%F %T'); starting it again in 5 s"
  sleep 5
done
