from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile


RUNNER_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = RUNNER_ROOT.parent
SCORING_RELEASE = REPOSITORY_ROOT / "scoring-releases" / "gpt56-v3"


def _copy_tree(source: Path, target: Path) -> None:
    shutil.copytree(
        source,
        target,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"),
    )


def _stage(target: Path, *, windows_only: bool) -> None:
    target.mkdir(parents=True)
    for name in ("README.md", "VERSION", "START-WINDOWS.cmd"):
        shutil.copy2(RUNNER_ROOT / name, target / name)
    if not windows_only:
        for name in ("start.sh", "pyproject.toml", "setup.py"):
            shutil.copy2(RUNNER_ROOT / name, target / name)
    package_root = target / "src" / "model_observatory_runner"
    _copy_tree(RUNNER_ROOT / "src" / "model_observatory_runner", package_root)
    _copy_tree(SCORING_RELEASE, package_root / "_release")


def _zip(source: Path, output: Path, root_name: str) -> None:
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(item for item in source.rglob("*") if item.is_file()):
            relative = Path(root_name) / path.relative_to(source)
            info = zipfile.ZipInfo(relative.as_posix(), date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            mode = 0o755 if path.name == "start.sh" else 0o644
            info.external_attr = mode << 16
            archive.writestr(info, path.read_bytes())


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build(output: Path) -> list[Path]:
    version = (RUNNER_ROOT / "VERSION").read_text(encoding="utf-8").strip()
    output.mkdir(parents=True, exist_ok=True)
    for old in output.glob("model-observatory-runner-*"):
        if old.is_file():
            old.unlink()
    checksum = output / "SHA256SUMS.txt"
    if checksum.exists():
        checksum.unlink()

    with tempfile.TemporaryDirectory(prefix="model-observatory-runner-") as temporary:
        root = Path(temporary)
        universal = root / "universal"
        windows = root / "windows"
        _stage(universal, windows_only=False)
        _stage(windows, windows_only=True)
        universal_zip = output / f"model-observatory-runner-{version}.zip"
        windows_zip = output / f"model-observatory-runner-{version}-windows.zip"
        _zip(universal, universal_zip, f"model-observatory-runner-{version}")
        _zip(windows, windows_zip, f"model-observatory-runner-{version}")

    subprocess.run(
        [sys.executable, "-m", "build", "--wheel", "--outdir", str(output)],
        cwd=RUNNER_ROOT,
        check=True,
    )
    artifacts = sorted(path for path in output.iterdir() if path.is_file() and path.name != checksum.name)
    checksum.write_text("".join(f"{_sha256(path)}  {path.name}\n" for path in artifacts), encoding="ascii")
    return [*artifacts, checksum]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=REPOSITORY_ROOT / "dist" / "runner")
    args = parser.parse_args()
    for artifact in build(args.output.resolve()):
        print(artifact)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
