#!/usr/bin/env python3
"""Build reviewable source/install candidates from an explicit file allowlist."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE_FILES = ("README.md", "UI-TEST.md", "LICENSE", "VERSION", "CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md",
              "package.json", "package-lock.json", "tsconfig.json", ".gitignore", ".gitattributes")
COMMON_DIRS = ("shared", "extras", "tools", "docs", "tests", ".github")
SUFFIXES = {".py", ".pyw", ".js", ".cjs", ".ts", ".json", ".md", ".txt", ".sh", ".ps1", ".cmd", ".yml", ".png"}
PLATFORMS = ("source", "windows", "macos", "linux")


def release_files(platform="source"):
    if platform not in PLATFORMS:
        raise ValueError("Unknown release platform: " + str(platform))
    developer_files = {"package.json", "package-lock.json", "tsconfig.json"}
    files = {ROOT / name for name in BASE_FILES if platform == "source" or name not in developer_files}
    files.update(ROOT.glob("requirements*.txt"))
    common = COMMON_DIRS if platform == "source" else ("shared", "extras", "tools", "docs")
    directories = (*common, *(('windows', 'macos', 'linux') if platform == 'source' else (platform,)))
    for name in directories:
        for path in (ROOT / name).rglob("*"):
            if platform != "source" and name == "tools" and path.name != "make-web-script.py":
                continue
            if (path.is_file() and not path.is_symlink() and path.suffix in SUFFIXES
                    and not {"__pycache__", "models", "backups", "node_modules", "test-results"}.intersection(path.parts)
                    and path.name not in {"config.json", "token", "credentials.json"}
                    and not path.name.endswith(".personal.user.js")):
                files.add(path)
    return sorted(files, key=lambda path: path.relative_to(ROOT).as_posix())


def build(destination, platform="source"):
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("VERSION must contain a semantic version")
    files = release_files(platform)
    if any(not path.is_file() or path.is_symlink() for path in files):
        raise ValueError("Release inputs must be existing regular files, not symlinks")
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
    if package["version"] != version or lock["version"] != version or lock["packages"][""]["version"] != version:
        raise ValueError("VERSION, package.json and package-lock.json must agree")
    prefix = "opencode-local-voice-" + version + "/"
    hashes = []
    output = Path(destination)
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            relative = path.relative_to(ROOT).as_posix()
            content = path.read_bytes()
            hashes.append(hashlib.sha256(content).hexdigest() + "  " + relative)
            info = zipfile.ZipInfo(prefix + relative)
            mode = 0o755 if path.suffix == ".sh" else 0o644
            info.create_system = 3
            info.external_attr = (0o100000 | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, content)
        archive.writestr(prefix + "CONTENTS.sha256", "\n".join(hashes) + "\n")
    return {"file": str(output.resolve()), "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "files": len(files)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", default=str(ROOT / "dist"))
    args = parser.parse_args()
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    results = []
    for platform in PLATFORMS:
        result = build(Path(args.output_dir) / f"opencode-local-voice-{version}-{platform}-candidate.zip", platform)
        results.append(result)
        print(f"{result['sha256']}  {Path(result['file']).name} ({result['files']} source files)")
    (Path(args.output_dir) / "SHA256SUMS.txt").write_text("\n".join(f"{item['sha256']}  {Path(item['file']).name}" for item in results) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
