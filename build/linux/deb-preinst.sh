#!/bin/sh
# CodePad .deb pre-install check (runs as root, before the files are unpacked).
# The AI model is downloaded on first launch by the user. This only warns when the download server is unreachable;
# it never fails the installation (an offline dpkg -i must still work).
set -e

if [ "$1" != "install" ]; then
  exit 0
fi

PROBE="https://registry.ollama.ai/v2/library/qwen3/blobs/sha256:7f4030143c1c477224c5434f8272c662a8b042079a0a584f0a27a1684fe2e1fa"

if command -v curl >/dev/null 2>&1; then
  if curl -fsSI --max-time 20 "$PROBE" >/dev/null 2>&1; then
    exit 0
  fi
elif command -v wget >/dev/null 2>&1; then
  if wget -q --spider --timeout=20 "$PROBE" >/dev/null 2>&1; then
    exit 0
  fi
else
  exit 0
fi

echo "CodePad: the AI model download server could not be reached; it will be downloaded on first start once you are online." >&2
exit 0
