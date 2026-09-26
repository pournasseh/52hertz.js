#!/usr/bin/env python3
"""Build a clean deterministic release ZIP for this repository."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
ZIP_TIME = (1980, 1, 1, 0, 0, 0)

def package_meta() -> tuple[str, str]:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    version = str(package["version"])
    name = "52hertz.js"
    return name, version

def included(path: Path) -> bool:
    relative = path.relative_to(ROOT)
    parts = relative.parts
    if not parts:
        return False
    if parts[0] in {".git", ".github", "dist", "node_modules", "__pycache__"}:
        return False
    if path.is_symlink():
        return False
    if any(part in {"node_modules", "__pycache__"} for part in parts):
        return False
    if path.suffix.lower() in {".log", ".tmp", ".pyc"}:
        return False
    return True

def main() -> None:
    name, version = package_meta()
    DIST.mkdir(exist_ok=True)
    archive = DIST / f"{name}-{version}.zip"
    checksum = archive.with_suffix(".zip.sha256")
    files = sorted(p for p in ROOT.rglob("*") if p.is_file() and included(p))

    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as out:
        for source in files:
            rel = PurePosixPath(source.relative_to(ROOT).as_posix())
            info = zipfile.ZipInfo(str(PurePosixPath(name) / rel), ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100644 & 0xFFFF) << 16
            out.writestr(info, source.read_bytes())

    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksum.write_text(f"{digest}  {archive.name}\n", encoding="ascii")
    print(f"Built {archive} ({len(files)} files)")
    print(digest)

if __name__ == "__main__":
    main()
