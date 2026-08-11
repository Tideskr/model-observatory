#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
exec python3 gpt56_vnext_web.py --port 8756 --no-browser
