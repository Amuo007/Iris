# Iris in a container, for a NAS or any always-on Linux box (see docs/docker.md).
# One container holds the browser (Electron on a virtual screen you can watch at http://<host>:6080/vnc.html),
# the resume service (resuma, with LaTeX for the PDFs) and the run tools' Python. Your own data stays in volumes.
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=America/Chicago \
    DISPLAY=:1 \
    LANG=C.UTF-8

# Electron's libraries, a virtual screen with a small window manager and a web viewer for it,
# Python for resuma and the run tools, LaTeX for resumes and cover letters, and fonts so pages render as on a desktop
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 libgtk-3-0 libxkbcommon0 libxcomposite1 \
      libxdamage1 libxrandr2 libxshmfence1 libpango-1.0-0 libcairo2 libasound2 libxss1 libxtst6 libsecret-1-0 \
      libnotify4 libcap2 xdg-utils \
      xvfb x11vnc openbox novnc websockify x11-utils \
      python3 python3-venv python3-pip \
      texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended texlive-xetex lmodern \
      fonts-liberation2 fonts-dejavu-core fonts-noto-core fonts-noto-color-emoji \
      tzdata ca-certificates curl procps lsof tini \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf vnc.html /usr/share/novnc/index.html

# The node image's own user (uid 1000) becomes iris; the entrypoint moves it to PUID/PGID when the NAS needs that
RUN usermod -l iris -d /home/iris -m node && groupmod -n iris node

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# npm ci's postinstall (scripts/setupDevEnv.js) sets Electron's fuses
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# resuma's own environment, as scripts/setupResuma.sh makes it on a Mac; its profile, resume, settings and runs
# come from /data/resuma at start
RUN python3 -m venv resuma/.venv && resuma/.venv/bin/pip install --no-cache-dir -e ./resuma

# Iris itself only reads /app; resuma may write next to its code, so its folder belongs to iris
RUN chmod +x docker/*.sh && chown -R iris:iris /app/resuma

EXPOSE 6080
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
