#!/bin/sh
# Container entrypoint for the OpenChatCut web editor.
#
# Why the socat bridge: editor-only endpoints (uploads, project store, agent
# bridge) accept requests only from a loopback socket with a localhost Host/Origin
# (server/editor-auth.ts). Requests that arrive through Docker's published port
# come from the bridge gateway (e.g. 172.17.0.1), so Vite listens on 127.0.0.1
# inside the container and socat relays the published port to it. Publish the
# port on the host's loopback only (127.0.0.1:5199:5199, as docker-compose.yml
# does) so the editor stays reachable from this machine alone.
set -eu

PUBLIC_PORT="${OPENCHATCUT_PORT:-5199}"
INTERNAL_PORT="${OPENCHATCUT_INTERNAL_PORT:-5198}"

if [ "$PUBLIC_PORT" = "$INTERNAL_PORT" ]; then
  echo "OPENCHATCUT_PORT and OPENCHATCUT_INTERNAL_PORT must differ" >&2
  exit 1
fi

mkdir -p "${OPENCHATCUT_DATA_DIR:-$HOME/.openchatcut}"

# Pass explicit arguments through instead, e.g. `docker compose run --rm openchatcut sh`.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

socat "TCP-LISTEN:${PUBLIC_PORT},fork,reuseaddr,bind=0.0.0.0" "TCP:127.0.0.1:${INTERNAL_PORT}" &

echo "[OpenChatCut] data: ${OPENCHATCUT_DATA_DIR:-$HOME/.openchatcut} · open http://localhost:${PUBLIC_PORT}"
exec node node_modules/vite/bin/vite.js --config config/vite.config.ts \
  --host 127.0.0.1 --port "$INTERNAL_PORT" --strictPort
