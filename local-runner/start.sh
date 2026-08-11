#!/usr/bin/env sh
set -eu
RUNNER_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PYTHONPATH="$RUNNER_ROOT/src${PYTHONPATH:+:$PYTHONPATH}" exec python3 -m model_observatory_runner serve
