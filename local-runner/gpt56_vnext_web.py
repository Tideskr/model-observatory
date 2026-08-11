#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path
import sys
import webbrowser

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from gpt56_vnext.server import create_server  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8756)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--runs-root", default=str(ROOT / "gpt56_vnext_runs"))
    args = parser.parse_args()
    server = create_server(port=args.port, runs_root=args.runs_root)
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(url, flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
