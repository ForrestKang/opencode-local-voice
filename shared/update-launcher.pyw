"""Windowless Windows entry point for the local voice recovery core.

The launcher reads only the active configuration and delegates all recovery
decisions to Node.  It never opens a console and does not print arguments or
configuration values into a user visible error.
"""
from __future__ import annotations

import json
import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path


CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
MANIFEST_HASH = re.compile(r"^[0-9a-fA-F]{64}$")
REQUIRED_PACKAGE_FILES = {
    "VERSION",
    "shared/patch-package.cjs",
    "shared/feature-update.cjs",
    "shared/install-support.cjs",
    "shared/install-support.py",
    "shared/voice_server.py",
    "shared/voice_cli.py",
    "shared/voice_text.py",
    "shared/voice_secrets.py",
    "shared/desktop-bridge.cjs",
    "shared/oc-mic.js",
    "shared/native-voice-settings.js",
    "shared/update-recovery.cjs",
    "shared/update-bridge.cjs",
    "shared/update-launcher.pyw",
    "shared/update-notify.pyw",
    "shared/maintenance-package.cjs",
    "shared/maintenance-inspect.cjs",
    "windows/maintenance-processes.ps1",
    "windows/maintenance-shortcuts.ps1",
    "windows/install-maintenance.ps1",
    "windows/restore-maintenance.ps1",
    "windows/install-feature-preview.ps1",
    "windows/Repair-Voice.cmd",
    "windows/Repair-Voice.ps1",
    "windows/Restore-Voice.cmd",
    "windows/Restore-Voice.ps1",
    "windows/maintenance-README.txt",
    "windows/restore-voice-managed.ps1",
}


def _message_box(message: str) -> None:
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, message, "OpenCode 本地语音", 0x10)
    except Exception:
        # pythonw has no console.  Keep the failure silent on non-Windows test
        # hosts; the Node core has already written the diagnostic log.
        pass


def _read_config(filename: Path) -> dict:
    try:
        value = json.loads(filename.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        raise RuntimeError("active.json 无法读取") from exc
    if not isinstance(value, dict) or value.get("schema") != 1:
        raise RuntimeError("active.json 格式无效")
    for key in ("node", "packageRoot"):
        value_path = value.get(key)
        if not isinstance(value_path, str) or not os.path.isabs(value_path):
            raise RuntimeError("active.json 路径无效")
    node = Path(value["node"])
    package_path = Path(value["packageRoot"])
    if package_path.is_symlink() or not package_path.is_dir():
        raise RuntimeError("语音恢复运行时不完整")
    package_root = package_path.resolve()
    core = package_root / "shared" / "update-recovery.cjs"
    configured_core = value.get("core")
    if configured_core is not None and (not isinstance(configured_core, str) or not os.path.isabs(configured_core) or os.path.normcase(str(Path(configured_core).resolve())) != os.path.normcase(str(core))):
        raise RuntimeError("active.json 核心路径无效")
    _verify_package(value, package_root)
    if not node.is_file() or node.is_symlink() or not core.is_file() or core.is_symlink():
        raise RuntimeError("语音恢复运行时不完整")
    value["core"] = str(core)
    return value


def _verify_package(config: dict, package_root: Path) -> None:
    expected_manifest = config.get("packageManifestSha256")
    if not isinstance(expected_manifest, str) or not MANIFEST_HASH.fullmatch(expected_manifest):
        raise RuntimeError("active.json 清单哈希无效")
    manifest_path = package_root / "CONTENTS.sha256"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise RuntimeError("语音恢复清单缺失")
    manifest = manifest_path.read_bytes()
    if hashlib.sha256(manifest).hexdigest().lower() != expected_manifest.lower():
        raise RuntimeError("语音恢复清单哈希不匹配")
    entries: dict[str, str] = {}
    try:
        lines = manifest.decode("utf-8").splitlines()
    except UnicodeDecodeError as exc:
        raise RuntimeError("语音恢复清单无效") from exc
    for line in lines:
        if not line:
            continue
        match = re.fullmatch(r"([0-9a-fA-F]{64})  (.+)", line)
        if not match:
            raise RuntimeError("语音恢复清单无效")
        digest, relative = match.groups()
        parts = relative.split("/")
        if relative == "CONTENTS.sha256" or not relative or "\\" in relative or relative.startswith("/") or any(part in ("", ".", "..") for part in parts) or re.match(r"^[A-Za-z]:", relative):
            raise RuntimeError("语音恢复清单路径无效")
        if relative in entries:
            raise RuntimeError("语音恢复清单包含重复文件")
        entries[relative] = digest.lower()
    if not REQUIRED_PACKAGE_FILES.issubset(entries):
        raise RuntimeError("语音恢复包不完整")
    for relative, expected in entries.items():
        candidate = package_root.joinpath(*relative.split("/"))
        try:
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(package_root)
        except (OSError, ValueError) as exc:
            raise RuntimeError("语音恢复包路径无效") from exc
        if candidate.is_symlink() or not candidate.is_file():
            raise RuntimeError("语音恢复包文件无效")
        if hashlib.sha256(candidate.read_bytes()).hexdigest().lower() != expected:
            raise RuntimeError("语音恢复包文件哈希不匹配")


def _parse(argv: list[str]) -> tuple[Path, list[str]]:
    config: Path | None = None
    forwarded: list[str] = []
    passthrough = False
    index = 0
    while index < len(argv):
        item = argv[index]
        if passthrough:
            forwarded.append(item)
        elif item == "--":
            passthrough = True
        elif item == "--config" and index + 1 < len(argv):
            index += 1
            config = Path(argv[index]).resolve()
        else:
            raise RuntimeError("启动参数无效")
        index += 1
    if config is None:
        raise RuntimeError("缺少 active.json")
    return config, forwarded


def main(argv: list[str] | None = None) -> int:
    try:
        config_path, forwarded = _parse(list(sys.argv[1:] if argv is None else argv))
        config = _read_config(config_path)
        command = [config["node"], config["core"], "--config", str(config_path), "--mode", "launch", "--", *forwarded]
        # Recovery is a one-shot transaction.  Wait for the Node process so a
        # validation/repair failure can be surfaced without leaving a hidden
        # helper behind.  The Node core has already shown a native message for
        # failures that happened after it acquired the recovery lock (exit 2).
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=CREATE_NO_WINDOW,
            close_fds=True,
            check=False,
        )
        if completed.returncode == 0:
            return 0
        if completed.returncode == 2:
            return 2
        _message_box("本地语音暂不可用，请查看恢复日志或重启 OpenCode。")
        return completed.returncode or 1
    except Exception:
        _message_box("本地语音暂不可用，请查看恢复日志或重启 OpenCode。")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
