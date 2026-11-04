# OpenChatCut web editor in a container. See "Run with Docker" in README.md.
#
#   docker compose up -d --build
#   open http://localhost:5199
#
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# socat: loopback bridge (see docker/entrypoint.sh)
# tini:  PID 1 that forwards signals and reaps child processes
# lib*:  runtime libraries for Remotion's headless Chromium (video export)
# fonts: CJK, emoji, and Latin coverage for captions and rendered titles
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates socat tini \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 \
    libgbm1 libgomp1 libnss3 libpango-1.0-0 libxcomposite1 libxdamage1 libxfixes3 \
    libxkbcommon0 libxrandr2 \
    fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# All state (projects, media, settings, MCP token, custom skills) lives under the
# app's default root, ~/.openchatcut, which docker-compose.yml mounts as one volume.
RUN chown node:node /app \
  && mkdir -p /home/node/.openchatcut && chown node:node /home/node/.openchatcut
USER node

# Dependencies first so source edits reuse this layer.
# ONNXRUNTIME_NODE_INSTALL=skip avoids the multi-hundred-MB CUDA provider download;
# the container runs ONNX models on the CPU.
# NPM_REGISTRY picks the registry for every lockfile entry (some entries pin a mirror);
# e.g. --build-arg NPM_REGISTRY=https://registry.npmmirror.com/ in mainland China.
ARG NPM_REGISTRY=https://registry.npmjs.org/
COPY --chown=node:node package.json package-lock.json ./
RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund \
    --registry="$NPM_REGISTRY" --replace-registry-host=always \
  && npm cache clean --force

COPY --chown=node:node . .

# Provision the pinned runtime assets that `npm run dev` would fetch on first start
# (MediaPipe models, whisper.cpp CLI), check the generated tool catalog, and pre-fetch
# Remotion's headless Chromium so the first export does not wait for a download
# (if that download fails here, Remotion retries it on the first export).
RUN npm run sync:mediapipe \
  && npm run sync:whisper-cli \
  && npm run verify:server-tool-catalog \
  && (node --input-type=module -e "const { ensureBrowser } = await import('@remotion/renderer'); await ensureBrowser({ chromeMode: 'headless-shell', logLevel: 'info' });" \
    || echo "warning: Remotion headless Chromium was not pre-fetched; it downloads on first export")

ENV BROWSER=none \
    OPENCHATCUT_DATA_DIR=/home/node/.openchatcut \
    OPENCHATCUT_SETTINGS_FILE=/home/node/.openchatcut/settings.env \
    OPENCHATCUT_PORT=5199 \
    OPENCHATCUT_INTERNAL_PORT=5198

VOLUME ["/home/node/.openchatcut"]
EXPOSE 5199

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.OPENCHATCUT_INTERNAL_PORT + '/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/bin/sh", "/app/docker/entrypoint.sh"]
