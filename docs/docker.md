# Iris in Docker (a NAS or any always-on Linux box)

One container holds everything Iris needs:
- Iris itself, running on a virtual screen
- resuma, with LaTeX for the PDFs
- the Python the run tools use

You watch and use it from any browser at `http://<host>:6080`. It starts again by itself after a crash or a reboot. The AI model stays where it is (the Halo server), so the box only needs to reach it on your network.

Your own data never goes into git or the image. It lives in `data/` next to `docker-compose.yml`:

| Folder | Inside the container | What it holds |
| --- | --- | --- |
| `data/userdata` | `~/.config/Iris` | Iris's settings, application history, sessions, postings |
| `data/iris-run` | `~/ai/iris-run` | the run tools: `task.txt`, job lists, scripts, `jobs.db` |
| `data/resuma` | resuma's data | `profile.json`, `original.tex`, `.env`, and its runs in `output/` |

## Set it up

**1. Get the code** on the Docker machine. On a UGREEN NAS a good place is the shared `docker` folder (`/volume1/docker`).

```bash
cd /volume1/docker && git clone https://github.com/Amuo007/Iris.git iris
```

If the machine has no git, this does the same:

```bash
cd /volume1/docker && sudo docker run --rm -v "$PWD":/git alpine/git clone https://github.com/Amuo007/Iris.git iris
```

**2. Set a password for the screen viewer** in `iris/.env`, which git leaves out. Without one, anyone on your network can open Iris's screen.

```bash
cd /volume1/docker/iris && echo "VNC_PASSWORD=$(openssl rand -hex 6)" > .env && chmod 600 .env
```

You can also set these in `.env`:
- `PUID` and `PGID`: your user's ids (`id -u`, `id -g`) when they aren't 1000.
- `TZ`: the time zone, `America/Chicago` by default.
- `IRIS_AUTOSTART=0`: don't start the run when the container starts.

**3. Copy your data from the Mac.** Quit Iris on the Mac first, then run this from the Mac's checkout:

```bash
scripts/copyToDocker.sh you@nas-ip /volume1/docker/iris
```

It copies:
- Iris's settings and history
- `~/ai/iris-run`, without backups, logs and screenshots
- resuma's `profile.json`, `original.tex` and `.env`

**4. Build and start it.** The first build takes a while because it downloads Electron and LaTeX.

```bash
cd /volume1/docker/iris && sudo docker compose up -d --build
```

**5. Sign in once.** Open `http://<host>:6080`, enter the screen password, and sign in to your job sites in Iris's own tabs. Then open Settings and enter your saved job email password and any other secrets again.

This step is needed because logins, saved passwords and WhatsApp's link were locked by the Mac's keychain, so they couldn't be copied.

## Run it

- **Start a run.** The container starts the run in `task.txt` once each time it starts. To start one yourself:

  ```bash
  sudo docker exec -u iris iris ~/ai/iris-run/start_run.sh task.txt continuous
  ```

- **Use the run tools** inside the container, the same as on the Mac:

  ```bash
  sudo docker exec -u iris iris python3 ~/ai/iris-run/ib.py agent_status
  ```

- **Pause across restarts:** create `data/iris-run/PAUSED`. Delete it to let the container start runs again.
- **Logs:** `sudo docker logs -f iris` shows Iris's output. `data/iris-run/iris-debug.log` holds the agent's debug log.
- **Update:**

  ```bash
  cd /volume1/docker/iris && git pull && sudo docker compose up -d --build
  ```

  Your data in `data/` stays.

Don't run Iris on the Mac and in Docker at the same time. Each keeps its own history, so the two would apply to the same jobs.
