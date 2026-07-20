# Custom e2b sandbox template for OpenChatCut skill scripts.
# Base = e2b code-interpreter (node + python preinstalled) + ffmpeg baked in, so
# asset-import's media probing/transcoding runs instantly (no per-sandbox apt install).
# Build: e2b template create openchatcut-media -p e2b   → then set E2B_TEMPLATE=openchatcut-media
FROM e2bdev/code-interpreter:latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
