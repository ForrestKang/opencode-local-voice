#!/usr/bin/env python3
"""Verify candidate ZIP paths, per-file manifests, versions and outer checksums."""
import argparse
import hashlib
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN = {".git", "node_modules", "test-results", "__pycache__", "models", "backups",
             "config.json", "credentials.json", "token", "rewrite_api_key", "app.asar"}


def verify_archive(filename, version, platform):
    prefix = f"opencode-local-voice-{version}/"
    with zipfile.ZipFile(filename) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Duplicate ZIP entries")
        for name in names:
            relative = name.removeprefix(prefix)
            parts = relative.split("/")
            if (not name.startswith(prefix) or "\\" in relative or not parts or
                    any(part in FORBIDDEN or part in ("", ".", "..") for part in parts) or
                    relative.startswith("/") or re.match(r"[A-Za-z]:", relative) or
                    relative.endswith(".personal.user.js")):
                raise ValueError("Unsafe or private ZIP entry: " + name)
            mode = archive.getinfo(name).external_attr >> 16
            if mode & 0o170000 == 0o120000:
                raise ValueError("Symlinks are not allowed in release archives")
        manifest_name = prefix + "CONTENTS.sha256"
        recorded = {}
        for line in archive.read(manifest_name).decode("utf-8").splitlines():
            digest, relative = line.split("  ", 1)
            if relative in recorded or not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise ValueError("Invalid manifest entry")
            recorded[relative] = digest
        if {prefix + relative for relative in recorded} != set(names) - {manifest_name}:
            raise ValueError("Manifest must cover every payload file exactly once")
        for relative, digest in recorded.items():
            if hashlib.sha256(archive.read(prefix + relative)).hexdigest() != digest:
                raise ValueError("Manifest hash mismatch: " + relative)
        required = {"README.md", "VERSION", "shared/voice_server.py", "shared/voice_cli.py",
                    "shared/desktop-bridge.cjs", "shared/patch-package.cjs", "tools/make-web-script.py"}
        required.add("package.json" if platform == "source" else f"{platform}/install." + ("ps1" if platform == "windows" else "sh"))
        if not required.issubset(recorded):
            raise ValueError("Release archive is missing a required entry point")
        if archive.read(prefix + "VERSION").decode().strip() != version:
            raise ValueError("Archive version mismatch")
        if platform != "source" and any(name.startswith(prefix + other + "/") for other in ("windows", "macos", "linux") if other != platform for name in names):
            raise ValueError("Platform archive contains another platform's installer")
        return len(recorded)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    version = (ROOT / "VERSION").read_text().strip()
    sums = {}
    for line in (args.directory / "SHA256SUMS.txt").read_text().splitlines():
        digest, name = line.split("  ", 1)
        if name in sums or Path(name).name != name or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("Invalid outer checksum manifest")
        sums[name] = digest
    platforms = ("source", "windows", "macos", "linux")
    expected = {f"opencode-local-voice-{version}-{platform}-candidate.zip" for platform in platforms}
    if set(sums) != expected:
        raise ValueError("Checksum manifest must cover the four candidate archives")
    total = 0
    for platform in platforms:
        name = f"opencode-local-voice-{version}-{platform}-candidate.zip"
        filename = args.directory / name
        if hashlib.sha256(filename.read_bytes()).hexdigest() != sums[name]:
            raise ValueError("ZIP checksum mismatch: " + name)
        count = verify_archive(filename, version, platform)
        total += count
        print(f"PASS {platform}: {count} verified payload files")
    print(f"PASS four archives, {total} file hashes; no private runtime payloads")


if __name__ == "__main__":
    main()
