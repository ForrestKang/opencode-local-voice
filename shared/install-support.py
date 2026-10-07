#!/usr/bin/env python3
"""Safe installer helpers for model download, validation, and v0.2 config."""
from __future__ import annotations

import argparse
import errno
import http.client
import importlib.util
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import socket
import struct
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any


def load_voice_server():
    source = Path(__file__).with_name("voice_server.py")
    if not source.is_file():
        raise RuntimeError(f"shared service source is missing: {source}")
    module_name = "opencode_local_voice_server"
    spec = importlib.util.spec_from_file_location(module_name, source)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load shared voice server configuration")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    source_path = str(source.parent)
    added_path = source_path not in sys.path
    if added_path:
        sys.path.insert(0, source_path)
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(module_name, None)
        raise
    finally:
        if added_path:
            sys.path.remove(source_path)
    return module


def validate_model(directory: Path, backend: str) -> dict[str, Any]:
    path = directory.expanduser().resolve()
    if not path.is_dir():
        raise RuntimeError(f"model directory is missing: {path}")
    config_file = path / "config.json"
    if not config_file.is_file() or config_file.stat().st_size == 0:
        raise RuntimeError("model is incomplete: non-empty config.json is required")
    try:
        config = json.loads(config_file.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"model config.json is invalid: {exc}") from exc
    if not isinstance(config, dict):
        raise RuntimeError("model config.json must contain a JSON object")

    if backend == "mlx":
        candidates = ("model.safetensors", "weights.safetensors", "weights.npz")
        present = [name for name in candidates if (path / name).is_file() and (path / name).stat().st_size > 1024]
        if not present:
            raise RuntimeError("MLX model is incomplete: expected a non-empty safetensors or npz weight file")
        weights = present[0]
    elif backend in ("auto", "faster-whisper"):
        model_bin = path / "model.bin"
        tokenizer = next((name for name in ("tokenizer.json", "vocabulary.json", "vocabulary.txt")
                          if (path / name).is_file() and (path / name).stat().st_size > 0), None)
        if not model_bin.is_file() or model_bin.stat().st_size <= 1024 * 1024:
            raise RuntimeError("faster-whisper model is incomplete: model.bin is missing or too small")
        if tokenizer is None:
            raise RuntimeError("faster-whisper model is incomplete: tokenizer/vocabulary file is missing")
        weights = "model.bin"
    else:
        raise RuntimeError("backend must be auto, faster-whisper, or mlx")

    return {"path": str(path), "backend": backend, "weights": weights,
            "weight_bytes": (path / weights).stat().st_size}


def _connection_refused(exc: OSError) -> bool:
    return exc.errno == errno.ECONNREFUSED or getattr(exc, "winerror", None) == 10061


def _tcp_listener_table_has_port(table: bytes, port: int, row_size: int,
                                 state_offset: int, port_offset: int) -> bool:
    if len(table) < 4:
        raise OSError("invalid GetExtendedTcpTable response size")
    count = struct.unpack_from("<I", table, 0)[0]
    if 4 + count * row_size > len(table):
        raise OSError("invalid GetExtendedTcpTable response size")
    for index in range(count):
        offset = 4 + index * row_size
        state = struct.unpack_from("<I", table, offset + state_offset)[0]
        local_port = struct.unpack_from("<I", table, offset + port_offset)[0]
        if state == 2 and socket.ntohs(local_port & 0xFFFF) == port:
            return True
    return False


def _windows_has_listener(port: int) -> bool | None:
    """Read the IPv4 LISTEN table to disambiguate Windows loopback timeouts."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        api = ctypes.WinDLL("iphlpapi.dll", use_last_error=True)
        get_table = api.GetExtendedTcpTable
        get_table.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong), ctypes.c_int,
                              ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        get_table.restype = ctypes.c_ulong
        for family, row_size, state_offset, port_offset in ((2, 24, 0, 8), (23, 56, 48, 20)):  # IPv4, IPv6 listener rows
            size = ctypes.c_ulong(0)
            result = get_table(None, ctypes.byref(size), 0, family, 3, 0)  # owner-PID listener table
            if result == 232:  # ERROR_NO_DATA
                continue
            if result not in (0, 122):
                raise OSError(result, "GetExtendedTcpTable size query failed")
            if size.value == 0:
                continue
            table = (ctypes.c_ubyte * size.value)()
            result = get_table(ctypes.cast(table, ctypes.c_void_p), ctypes.byref(size), 0, family, 3, 0)
            if result == 232:
                continue
            if result != 0:
                raise OSError(result, "GetExtendedTcpTable query failed")
            if _tcp_listener_table_has_port(bytes(table), port, row_size, state_offset, port_offset):
                return True
        return False
    except Exception as exc:
        raise RuntimeError(f"could not safely inspect the Windows local TCP listener table: {exc}") from exc


def _request_json(port: int, method: str, target: str, headers: dict[str, str],
                  *, timeout: float = 2.0, allow_refused: bool = False) -> tuple[int, dict[str, Any]] | None:
    """Make one bounded loopback request; never treat an ambiguous failure as absence."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        try:
            connection.connect()
        except OSError as exc:
            connection.close()
            if allow_refused:
                if _connection_refused(exc):
                    return None
                if os.name == "nt" and _windows_has_listener(port) is False:
                    return None
            raise RuntimeError(f"could not safely connect to local voice port {port}: {exc}") from exc
        connection.request(method, target, body=b"" if method == "POST" else None,
                           headers={**headers, "Connection": "close"})
        response = connection.getresponse()
        raw = response.read(8193)
        if len(raw) > 8192:
            raise RuntimeError("local voice service returned an oversized response")
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RuntimeError("local voice service returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise RuntimeError("local voice service returned a non-object response")
        return response.status, payload
    except (OSError, http.client.HTTPException) as exc:
        raise RuntimeError(f"local voice port {port} did not complete a safe {method} request: {exc}") from exc
    finally:
        connection.close()


def _port_is_released(port: int) -> bool:
    connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    connection.settimeout(0.3)
    try:
        connection.connect(("127.0.0.1", port))
        return False
    except OSError as exc:
        if _connection_refused(exc):
            return True
        if os.name == "nt":
            has_listener = _windows_has_listener(port)
            if has_listener is False:
                return True
            if has_listener is True:
                return False
        raise RuntimeError(f"cannot determine whether local voice port {port} was released: {exc}") from exc
    finally:
        connection.close()


def _preflight_store(server: Any, home: Path) -> tuple[dict[str, Any], str | None]:
    """Read existing state without creating or changing config/token files."""
    config_path = home / "config.json"
    token_path = home / "token"
    try:
        raw_config = json.loads(config_path.read_text(encoding="utf-8"))
        config = server.validate_config(raw_config)
    except FileNotFoundError:
        # Reuse ConfigStore's exact environment migration logic without
        # constructing it (construction would create persistent token/config files).
        config = server.ConfigStore._legacy_config(object.__new__(server.ConfigStore))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, server.ConfigError) as exc:
        raise RuntimeError(f"cannot safely read local voice configuration: {exc}") from exc

    try:
        token = token_path.read_text(encoding="ascii").strip()
    except FileNotFoundError:
        token = None
    except (OSError, UnicodeDecodeError) as exc:
        raise RuntimeError(f"cannot safely read local voice token: {exc}") from exc
    if token is not None and not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
        raise RuntimeError("local voice token is invalid; refusing to contact the configured port")
    return config, token


def _config_home(value: str | None) -> Path:
    if value:
        return Path(value).expanduser()
    configured_home = os.environ.get("OPENCODE_VOICE_HOME")
    return Path(configured_home).expanduser() if configured_home else Path.home() / ".config" / "opencode" / "local-voice"


def stop_verified_service(server: Any, port: int, token: str | None) -> dict[str, Any]:
    """Authenticate a loopback daemon before sending its token, stop only when idle, and wait for close."""
    if os.name == "nt" and _windows_has_listener(port) is False:
        return {"state": "not_running", "port": port}
    if token is None:
        if _port_is_released(port):
            return {"state": "not_running", "port": port}
        raise RuntimeError(
            f"local port {port} is occupied but this installation has no token; "
            "refusing to send credentials or overwrite configuration"
        )

    challenge = secrets.token_urlsafe(32)
    quoted = urllib.parse.quote(challenge, safe="")
    health = _request_json(port, "GET", f"/health?challenge={quoted}",
                           {"Accept": "application/json"}, allow_refused=True)
    if health is None:
        return {"state": "not_running", "port": port}
    status, payload = health
    if status != 200:
        raise RuntimeError(
            f"local port {port} is occupied by an unknown or incompatible service "
            f"(health returned HTTP {status}); refusing to send its token"
        )
    expected = server.hmac_proof(token, challenge)
    proof = payload.get("proof")
    if (payload.get("service") != server.SERVICE_NAME or
            payload.get("protocol") != server.PROTOCOL or
            payload.get("version") not in {server.VERSION, "0.2.1", "0.2.2", "0.3.0", "0.3.1", "0.3.2", "0.3.3", "0.3.4", "0.3.5"} or
            not isinstance(proof, str) or not hmac.compare_digest(proof, expected)):
        raise RuntimeError(
            f"local port {port} did not prove this installation's service identity; "
            "refusing to send its token"
        )

    try:
        shutdown = _request_json(port, "POST", "/v1/shutdown", {
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Content-Length": "0",
        })
    except RuntimeError as exc:
        raise RuntimeError(f"verified local service disappeared before authenticated shutdown: {exc}") from exc
    assert shutdown is not None
    shutdown_status, shutdown_payload = shutdown
    if shutdown_status == 409:
        raise RuntimeError("local voice service is busy with an active or queued job; configuration was not changed")
    if shutdown_status != 202 or shutdown_payload.get("status") != "shutting_down":
        raise RuntimeError(
            f"verified local service refused authenticated shutdown (HTTP {shutdown_status}); "
            "configuration was not changed"
        )

    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        if _port_is_released(port):
            return {"state": "stopped", "port": port, "version": payload["version"]}
        time.sleep(0.2)
    raise RuntimeError(f"authenticated shutdown was accepted but local port {port} did not close within 10 seconds")


def stop_service(args: argparse.Namespace) -> dict[str, Any]:
    """Preflight an existing daemon without creating config/token files or touching its process directly."""
    server = load_voice_server()
    home = _config_home(args.voice_home)
    config, token = _preflight_store(server, home)
    service = stop_verified_service(server, config["port"], token)
    return {"home": str(home), "service": service}


def configure(args: argparse.Namespace) -> dict[str, Any]:
    server = load_voice_server()
    home = _config_home(args.voice_home)
    model = validate_model(Path(args.model_path), args.backend)
    config, token = _preflight_store(server, home)
    service = stop_verified_service(server, config["port"], token)
    # ConfigStore can initialize token/config files, so construct it only after
    # the configured port is known to be free or the verified daemon is stopped.
    store = server.ConfigStore(home)
    updated, changed = store.update({
        "backend": args.backend,
        "device": args.device,
        "model_path": model["path"],
    })
    return {"home": str(store.home), "changed": sorted(changed), "config": updated,
            "model": model, "service": service}


def download(args: argparse.Namespace) -> dict[str, Any]:
    model_path = Path(args.model_path).expanduser().resolve()
    model_path.mkdir(parents=True, exist_ok=True)
    # huggingface_hub snapshots these feature flags during import. Initialize
    # them before importing so the mirror attempt cannot use Xet/transfer paths.
    for name, value in (
        ("HF_ENDPOINT", args.endpoint),
        ("HF_HUB_DISABLE_XET", "1"),
        ("HF_HUB_ENABLE_HF_TRANSFER", "0"),
        ("HF_HUB_DISABLE_PROGRESS_BARS", "1"),
    ):
        os.environ[name] = value
    try:
        from huggingface_hub import snapshot_download
    except Exception as exc:
        raise RuntimeError(f"huggingface_hub is unavailable in the selected environment: {exc}") from exc

    endpoints = [args.endpoint]
    if args.fallback_endpoint and args.fallback_endpoint != args.endpoint:
        endpoints.append(args.fallback_endpoint)
    errors = []
    for endpoint in endpoints:
        os.environ["HF_ENDPOINT"] = endpoint
        try:
            # Pass the endpoint directly. huggingface_hub reads its environment
            # constants at import time, so changing HF_ENDPOINT here alone can
            # leave a fallback attempt pointed at the first mirror.
            snapshot_download(repo_id=args.repo, local_dir=str(model_path), endpoint=endpoint)
            result = validate_model(model_path, args.backend)
            result["repo"] = args.repo
            result["endpoint"] = endpoint
            return result
        except Exception as exc:
            errors.append(f"{endpoint}: {exc}")
            if endpoint != endpoints[-1]:
                print(f"[install] model download from {endpoint} failed; trying {endpoints[-1]}", file=sys.stderr)
    raise RuntimeError("model download or validation failed: " + " | ".join(errors))


def deploy(args: argparse.Namespace) -> dict[str, Any]:
    source_dir = Path(__file__).resolve().parent
    destination = Path(args.destination).expanduser().resolve()
    if destination == source_dir:
        raise RuntimeError("refusing to deploy over the shared source directory")
    destination.mkdir(parents=True, exist_ok=True)
    files = [
        ("voice_server.py", "voice_server.py"),
        ("voice_server.py", "stt_server.py"),
        ("voice_cli.py", "voice_cli.py"),
        ("desktop-bridge.cjs", "desktop-bridge.cjs"),
        ("voice_text.py", "voice_text.py"),
        ("voice_secrets.py", "voice_secrets.py"),
    ]
    written = []
    for source_name, target_name in files:
        source = source_dir / source_name
        if not source.is_file():
            raise RuntimeError(f"required shared runtime source is missing: {source}")
        data = source.read_bytes()
        target = destination / target_name
        temporary = destination / f".{target_name}.tmp-{os.getpid()}-{os.urandom(4).hex()}"
        try:
            with temporary.open("xb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            shutil.copystat(source, temporary, follow_symlinks=True)
            os.replace(temporary, target)
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
        if target.read_bytes() != data:
            raise RuntimeError(f"deployed file failed verification: {target}")
        written.append({"path": str(target), "sha256": hashlib.sha256(data).hexdigest()})
    return {"destination": str(destination), "files": written}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OpenCode Local Voice v0.2 installation helpers")
    subparsers = parser.add_subparsers(dest="command", required=True)

    check = subparsers.add_parser("validate-model", help="verify a fully downloaded local model")
    check.add_argument("--backend", choices=("auto", "faster-whisper", "mlx"), required=True)
    check.add_argument("--model-path", required=True)
    check.set_defaults(handler=lambda args: validate_model(Path(args.model_path), args.backend))

    fetch = subparsers.add_parser("download-model", help="download a model explicitly with mirror fallback")
    fetch.add_argument("--backend", choices=("auto", "faster-whisper", "mlx"), required=True)
    fetch.add_argument("--repo", required=True)
    fetch.add_argument("--model-path", required=True)
    fetch.add_argument("--endpoint", default="https://hf-mirror.com")
    fetch.add_argument("--fallback-endpoint", default="https://huggingface.co")
    fetch.set_defaults(handler=download)

    setup = subparsers.add_parser("configure", help="persist backend/device/model_path in config.json")
    setup.add_argument("--backend", choices=("auto", "faster-whisper", "mlx"), required=True)
    setup.add_argument("--device", choices=("auto", "cuda", "cpu"), required=True)
    setup.add_argument("--model-path", required=True)
    setup.add_argument("--voice-home")
    setup.set_defaults(handler=configure)

    stop = subparsers.add_parser("stop-service", help="authenticate and stop an idle local voice daemon")
    stop.add_argument("--voice-home")
    stop.set_defaults(handler=stop_service)

    copy_runtime = subparsers.add_parser("deploy", help="atomically deploy the server, CLI, and bridge files")
    copy_runtime.add_argument("--destination", required=True)
    copy_runtime.set_defaults(handler=deploy)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        result = args.handler(args)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except Exception as exc:
        print(f"[install] ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
