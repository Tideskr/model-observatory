from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import socket
import sys

from . import __version__
from .server import create_server


def default_data_dir() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        return base / "ModelObservatory" / "Runner"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "ModelObservatory" / "Runner"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "model-observatory-runner"


def _port_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        return probe.connect_ex(("127.0.0.1", port)) != 0


def _serve(args: argparse.Namespace) -> int:
    if not 1 <= args.port <= 65535:
        raise SystemExit("--port must be between 1 and 65535")
    if not _port_available(args.port):
        print(f"Model Observatory Runner is already listening on 127.0.0.1:{args.port}.")
        return 0

    server = create_server(port=args.port, runs_root=Path(args.data_dir))
    print(f"Model Observatory Runner {__version__}")
    print(f"Local API: http://127.0.0.1:{server.server_address[1]}")
    print(f"Data: {Path(args.data_dir).expanduser().resolve()}")
    print("Waiting for a compatible website to connect.")
    print("Keep this window open while a private check is running. Press Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping runner...", flush=True)
    finally:
        server.server_close()
    return 0


def _doctor(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir).expanduser().resolve()
    checks = {
        "version": __version__,
        "python": sys.version.split()[0],
        "python_supported": sys.version_info >= (3, 10),
        "node": shutil.which("node") or "not found (Native Codex unavailable)",
        "data_directory": str(data_dir),
        "data_directory_parent_exists": data_dir.parent.exists(),
        "port_8756_available": _port_available(8756),
    }
    width = max(len(key) for key in checks)
    for key, value in checks.items():
        print(f"{key:<{width}}  {value}")
    return 0 if checks["python_supported"] else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="model-observatory-runner")
    parser.add_argument("--version", action="version", version=__version__)
    subcommands = parser.add_subparsers(dest="command")

    serve = subcommands.add_parser("serve", help="start the loopback execution API")
    serve.add_argument("--port", type=int, default=8756)
    serve.add_argument("--data-dir", default=str(default_data_dir()))

    doctor = subcommands.add_parser("doctor", help="check local runtime prerequisites")
    doctor.add_argument("--data-dir", default=str(default_data_dir()))
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if not arguments:
        arguments.append("serve")
    elif arguments[0] != "--version" and arguments[0] not in {"serve", "doctor"}:
        arguments.insert(0, "serve")
    args = build_parser().parse_args(arguments)
    if args.command == "doctor":
        return _doctor(args)
    return _serve(args)


__all__ = ["build_parser", "default_data_dir", "main"]
