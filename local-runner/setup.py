from __future__ import annotations

from pathlib import Path
import shutil

from setuptools import setup
from setuptools.command.build_py import build_py as _build_py


class build_py(_build_py):
    def run(self) -> None:
        super().run()
        repository_source = Path(__file__).resolve().parent.parent / "scoring-releases" / "gpt56-v4"
        embedded_source = Path(__file__).resolve().parent / "src" / "model_observatory_runner" / "_release"
        source = repository_source if repository_source.is_dir() else embedded_source
        target = Path(self.build_lib) / "model_observatory_runner" / "_release"
        if not source.is_dir():
            raise RuntimeError(f"scoring release is missing: {source}")
        target.mkdir(parents=True, exist_ok=True)
        for item in source.glob("*.json"):
            shutil.copy2(item, target / item.name)


setup(cmdclass={"build_py": build_py})
