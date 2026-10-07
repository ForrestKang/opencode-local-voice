#!/usr/bin/env python3
"""Local, authenticated OpenCode Voice v0.3 service.

The HTTP process never loads a speech model. Audio stays in memory and is sent
to one persistent, terminable worker process which lazily loads a local model.
"""
from __future__ import annotations

import argparse
import copy
import contextlib
import ctypes
import hashlib
import hmac
import io
import json
import importlib
import multiprocessing
import os
import platform
import queue
import re
import secrets
import stat
import sys
import sysconfig
import threading
import time
import urllib.parse
import uuid
import wave
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Optional

try:
    from . import voice_text
    from . import voice_secrets
except ImportError:
    try:
        import voice_text  # type: ignore[no-redef]
        import voice_secrets  # type: ignore[no-redef]
    except ImportError:
        # Test fixtures and embedded loaders can import this file by path while
        # only the repository root is on sys.path.
        from shared import voice_text  # type: ignore[no-redef]
        from shared import voice_secrets  # type: ignore[no-redef]

VERSION = "0.2.0"
PROTOCOL = 1
SERVICE_NAME = "opencode-local-voice"
DEFAULT_PORT = 47832
MAX_HTTP_THREADS = 8
MAX_PENDING_JOBS = 4
MAX_RETAINED_JOBS = 64
MAX_TOMBSTONES = 256
MAX_JSON_BYTES = 64 * 1024
RESULT_TTL_SECONDS = 300
CANCEL_TOMBSTONE_SECONDS = 30
MAX_ERROR_CHARS = 500

DEFAULT_ALLOWED_ORIGINS = ("http://localhost:47832", "http://127.0.0.1:47832")
DEFAULT_MODEL_PATH = "~/.config/opencode/whisper-models/large-v3-turbo"
CONFIG_FIELDS = {
    "backend", "device", "model_path", "language", "beam_size",
    "cpu_threads", "max_seconds", "idle_seconds", "warmup_on_record",
    "initial_prompt", "allowed_origins", "port", *voice_text.TEXT_CONFIG_FIELDS,
}
CONFIG_PATCH_FIELDS = CONFIG_FIELDS | voice_text.CONFIG_PATCH_CREDENTIAL_FIELDS
MODEL_FIELDS = {"backend", "device", "model_path", "cpu_threads"}
_CUDA_RUNTIME_HANDLES: list[Any] = []
_CUDA_RUNTIME_PRELOADED: set[str] = set()
_CUDA_RUNTIME_REGISTERED_DIRS: set[str] = set()


class ConfigError(ValueError):
    pass


class QueueLimitError(OverflowError):
    pass


class ServiceStoppingError(RuntimeError):
    pass


def _default_config(port: int = DEFAULT_PORT) -> dict[str, Any]:
    config = {
        "backend": "auto",
        "device": "auto",
        "model_path": os.path.expanduser(DEFAULT_MODEL_PATH),
        "language": "auto",
        "beam_size": 1,
        "cpu_threads": max(1, min(8, os.cpu_count() or 4)),
        "max_seconds": 120,
        "idle_seconds": 1800,
        "warmup_on_record": True,
        "initial_prompt": "",
        "allowed_origins": [f"http://localhost:{port}", f"http://127.0.0.1:{port}"],
        "port": port,
    }
    config.update(copy.deepcopy(voice_text.DEFAULT_TEXT_CONFIG))
    return config


def _validate_origin(origin: Any) -> str:
    if not isinstance(origin, str) or not origin or len(origin) > 512:
        raise ConfigError("allowed_origins must contain origin strings")
    parsed = urllib.parse.urlsplit(origin)
    if parsed.scheme not in ("http", "https", "oc") or not parsed.netloc:
        raise ConfigError("allowed_origins entries must be complete HTTP(S) or oc origins")
    if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise ConfigError("allowed_origins entries must contain only an origin")
    if parsed.scheme == "oc" and parsed.port is not None:
        raise ConfigError("oc origins cannot contain a port")
    try:
        _ = parsed.port
    except ValueError as exc:
        raise ConfigError("allowed_origins contains an invalid port") from exc
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


def validate_config(config: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(config, dict):
        raise ConfigError("configuration must be a JSON object")
    unknown = set(config) - CONFIG_FIELDS
    if unknown:
        raise ConfigError("unknown configuration field(s): " + ", ".join(sorted(unknown)))
    result = _default_config()
    result.update(copy.deepcopy(config))
    if result["backend"] not in ("auto", "faster-whisper", "mlx"):
        raise ConfigError("backend must be auto, faster-whisper, or mlx")
    if result["device"] not in ("auto", "cuda", "cpu"):
        raise ConfigError("device must be auto, cuda, or cpu")
    if not isinstance(result["model_path"], str) or not result["model_path"].strip():
        raise ConfigError("model_path must be a non-empty local directory path")
    result["model_path"] = os.path.expanduser(result["model_path"].strip())
    language = result["language"]
    if not isinstance(language, str) or not language or len(language) > 32:
        raise ConfigError("language must be auto or a short language code")
    result["language"] = language.strip().lower()
    for key, minimum, maximum in (("beam_size", 1, 5), ("cpu_threads", 1, 128),
                                  ("max_seconds", 5, 300), ("idle_seconds", 30, 86400),
                                  ("port", 1024, 65535)):
        value = result[key]
        if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
            raise ConfigError(f"{key} must be an integer from {minimum} to {maximum}")
    if not isinstance(result["warmup_on_record"], bool):
        raise ConfigError("warmup_on_record must be boolean")
    if not isinstance(result["initial_prompt"], str) or len(result["initial_prompt"]) > 2048:
        raise ConfigError("initial_prompt must be text up to 2048 characters")
    origins = result["allowed_origins"]
    if not isinstance(origins, list) or len(origins) > 64:
        raise ConfigError("allowed_origins must be a list of at most 64 origins")
    result["allowed_origins"] = sorted({_validate_origin(origin) for origin in origins})
    try:
        result.update(voice_text.validate_text_config({
            key: result[key] for key in voice_text.TEXT_CONFIG_FIELDS
        }))
    except voice_text.TextConfigError as exc:
        raise ConfigError(str(exc)) from exc
    return result


def _chmod_private(path: Path, mode: int) -> None:
    if os.name != "nt":
        os.chmod(path, mode)


@contextlib.contextmanager
def _initialization_lock(home: Path):
    """Serialize first-run config/token creation across CLI and service processes."""
    lock_path = home / ".initialize.lock"
    fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        _chmod_private(lock_path, 0o600)
        if os.name == "nt":
            import msvcrt
            if os.fstat(fd).st_size == 0:
                os.write(fd, b"\0")
                os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            if os.name == "nt":
                import msvcrt
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


class ConfigStore:
    """Atomic config and one-time environment migration plus a private token."""

    def __init__(self, home: Optional[os.PathLike[str] | str] = None):
        if home is None:
            home = os.environ.get("OPENCODE_VOICE_HOME")
        self.home = Path(home).expanduser() if home else Path.home() / ".config" / "opencode" / "local-voice"
        self.config_path = self.home / "config.json"
        self.token_path = self.home / "token"
        self.secret_store = voice_secrets.SecretStore(self.home)
        self.rewrite_key_path = self.secret_store.path
        self._lock = threading.RLock()
        self.home.mkdir(parents=True, exist_ok=True)
        _chmod_private(self.home, 0o700)
        with _initialization_lock(self.home):
            self.token = self._read_or_create_token()
            self._config = self._read_or_initialize_config()

    def _read_or_create_token(self) -> str:
        try:
            token = self.token_path.read_text(encoding="ascii").strip()
        except FileNotFoundError:
            token = None
        if token is not None:
            if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
                raise ConfigError("token file is invalid; refusing to replace an existing credential")
            _chmod_private(self.token_path, 0o600)
            return token
        token = secrets.token_urlsafe(32)
        tmp = self.home / (".token-" + secrets.token_hex(8) + ".tmp")
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="ascii") as f:
                f.write(token + "\n")
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.token_path)
            _chmod_private(self.token_path, 0o600)
        finally:
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass
        return token

    def _legacy_config(self) -> dict[str, Any]:
        port = DEFAULT_PORT
        old_port = os.environ.get("OPENCODE_STT_LOCAL_PORT")
        if old_port:
            try:
                port = int(old_port)
            except ValueError:
                pass
        cfg = _default_config(port)
        env_map = {
            "OPENCODE_WHISPER_MODEL_DIR": "model_path",
            "OPENCODE_STT_DEVICE": "device",
            "OPENCODE_STT_THREADS": "cpu_threads",
            "OPENCODE_STT_BEAM": "beam_size",
            "OPENCODE_WHISPER_IDLE_SEC": "idle_seconds",
        }
        for env_name, key in env_map.items():
            value = os.environ.get(env_name)
            if value:
                try:
                    if key in ("cpu_threads", "beam_size", "idle_seconds"):
                        cfg[key] = int(value)
                    else:
                        cfg[key] = value
                except ValueError:
                    continue
        return validate_config(cfg)

    def _read_or_initialize_config(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.config_path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raise ConfigError("configuration must be a JSON object")
            # Discard bindings from the unreleased WIP. Enter/Escape behavior
            # remains fixed in the UI and ordinary spaces stay ordinary text.
            raw.pop("shortcuts", None)
            legacy_key = raw.pop("rewrite_api_key", None)
            if legacy_key is not None:
                try:
                    legacy_key = voice_text.validate_rewrite_api_key(legacy_key)
                    self.secret_store.migrate_legacy_text(legacy_key)
                except (voice_text.TextConfigError, voice_secrets.SecretStorageError) as exc:
                    raise ConfigError("legacy rewrite credential could not be migrated") from exc
            cfg = validate_config(raw)
            # Add newly introduced defaults to older installations atomically.
            if cfg != raw:
                self._write_atomic(cfg)
        except FileNotFoundError:
            cfg = self._legacy_config()
            self._write_atomic(cfg)
        except (json.JSONDecodeError, ConfigError) as exc:
            raise ConfigError(f"invalid {self.config_path.name}: {exc}") from exc
        _chmod_private(self.config_path, 0o600)
        return cfg

    def _write_atomic(self, config: dict[str, Any]) -> None:
        data = (json.dumps(config, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        tmp = self.home / (".config-" + secrets.token_hex(8) + ".tmp")
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            _chmod_private(tmp, 0o600)
            os.replace(tmp, self.config_path)
            if os.name != "nt":
                try:
                    dirfd = os.open(str(self.home), os.O_RDONLY)
                    try:
                        os.fsync(dirfd)
                    finally:
                        os.close(dirfd)
                except OSError:
                    # The atomic replacement already committed. A directory
                    # fsync failure must not leave the caller's memory stale.
                    pass
        finally:
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass

    def get(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._config)

    def _read_rewrite_api_key(self) -> str:
        try:
            key = self.secret_store.read()
            return voice_text.validate_rewrite_api_key(key)
        except (voice_text.TextConfigError, voice_secrets.SecretStorageError) as exc:
            raise ConfigError("rewrite credential file is invalid") from exc

    def get_rewrite_api_key(self) -> str:
        """Internal credential accessor. Never include this value in public JSON."""
        with self._lock:
            return self._read_rewrite_api_key()

    def public(self) -> dict[str, Any]:
        with self._lock:
            config = copy.deepcopy(self._config)
            config["rewrite_key_configured"] = bool(self._read_rewrite_api_key())
            return config

    def _write_rewrite_api_key_atomic(self, key: str) -> None:
        try:
            self.secret_store.write(key)
        except voice_secrets.SecretStorageError as exc:
            raise OSError("could not persist rewrite credential") from exc

    def update(self, patch: dict[str, Any]) -> tuple[dict[str, Any], set[str]]:
        if not isinstance(patch, dict):
            raise ConfigError("configuration patch must be a JSON object")
        with self._lock:
            unknown = set(patch) - CONFIG_PATCH_FIELDS
            if unknown:
                raise ConfigError("unknown configuration field(s): " + ", ".join(sorted(unknown)))
            public_patch = {key: value for key, value in patch.items()
                            if key not in voice_text.CONFIG_PATCH_CREDENTIAL_FIELDS}
            has_new_key = "rewrite_api_key" in patch
            new_key = ""
            old_key = self._read_rewrite_api_key()
            if has_new_key:
                try:
                    new_key = voice_text.validate_rewrite_api_key(patch["rewrite_api_key"])
                except voice_text.TextConfigError as exc:
                    raise ConfigError(str(exc)) from exc
            new_config = validate_config({**self._config, **public_patch})
            changed = {key for key in CONFIG_FIELDS if new_config[key] != self._config[key]}
            credential_changed = has_new_key and new_key != old_key
            if credential_changed:
                changed.add("rewrite_api_key")
                self._write_rewrite_api_key_atomic(new_key)
            try:
                if changed - {"rewrite_api_key"}:
                    self._write_atomic(new_config)
            except Exception:
                if credential_changed:
                    try:
                        self._write_rewrite_api_key_atomic(old_key)
                    except Exception as rollback_exc:
                        raise OSError("could not safely roll back rewrite credential update") from rollback_exc
                raise
            self._config = new_config
            return copy.deepcopy(self._config), changed


def hmac_proof(token: str, challenge: str) -> str:
    return hmac.new(token.encode("ascii"), challenge.encode("utf-8"), hashlib.sha256).hexdigest()


def _read_wav16k_pcm(data: bytes, max_seconds: int, *, collect_pcm: bool = True) -> tuple[bytes, int]:
    """Validate a bounded PCM WAV using only the Python standard library."""
    if not data or len(data) > max_seconds * 16000 * 2 + 65536:
        raise ValueError("WAV body is empty or exceeds the configured audio limit")
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            if wav.getframerate() != 16000 or wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getcomptype() != "NONE":
                raise ValueError("expected uncompressed 16kHz mono s16 WAV")
            frames = wav.getnframes()
            if frames <= 0 or frames > max_seconds * 16000:
                raise ValueError(f"audio duration must be between 0 and {max_seconds} seconds")
            if collect_pcm:
                raw = wav.readframes(frames)
                if len(raw) != frames * 2:
                    raise ValueError("WAV frame data is truncated")
            else:
                # The HTTP process only needs to prove that declared frames exist.
                # Read bounded chunks to avoid a second full-audio allocation.
                remaining = frames
                while remaining:
                    batch_frames = min(remaining, 32768)
                    chunk = wav.readframes(batch_frames)
                    if len(chunk) != batch_frames * 2:
                        raise ValueError("WAV frame data is truncated")
                    remaining -= batch_frames
                raw = b""
    except (wave.Error, EOFError) as exc:
        raise ValueError("invalid WAV audio") from exc
    return raw, frames


def validate_wav16k(data: bytes, max_seconds: int) -> float:
    """Validate an uploaded WAV without loading NumPy into the HTTP process."""
    _raw, frames = _read_wav16k_pcm(data, max_seconds, collect_pcm=False)
    return frames / 16000.0


def decode_wav16k(data: bytes, max_seconds: int) -> tuple[Any, float]:
    """Validate a bounded PCM WAV and decode it to a float waveform in the worker."""
    raw, frames = _read_wav16k_pcm(data, max_seconds)
    import numpy as np
    audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    return audio, frames / 16000.0


def make_silence_wav(seconds: float = 0.25) -> bytes:
    frames = max(1, round(seconds * 16000))
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\0\0" * frames)
    return out.getvalue()


def _is_apple_silicon() -> bool:
    return os.sys.platform == "darwin" and platform.machine().lower() in ("arm64", "aarch64")


def _python_venv_site_packages() -> Optional[Path]:
    """Return this interpreter's site-packages only when it is inside sys.prefix."""
    try:
        prefix = Path(sys.prefix).resolve()
        site_packages = Path(sysconfig.get_path("purelib")).resolve()
        site_packages.relative_to(prefix)
        return site_packages
    except (OSError, TypeError, ValueError):
        return None


def _prepare_cuda_runtime() -> list[Path]:
    """Make pip CUDA runtime libraries discoverable without searching global paths.

    Windows DLL search directories are held for the life of the process. On Linux,
    NVIDIA's pip wheels are preloaded by absolute path before CTranslate2 imports;
    system-installed CUDA libraries continue to use the system dynamic-loader path.
    """
    site_packages = _python_venv_site_packages()
    if site_packages is None:
        return []
    packages = site_packages / "nvidia"
    directories: list[Path] = []
    if sys.platform == "win32":
        for package in ("cublas", "cudnn"):
            directory = packages / package / "bin"
            if directory.is_dir() and any(directory.glob("*.dll")):
                directories.append(directory)
        if not directories:
            return []

        add_dll_directory = getattr(os, "add_dll_directory", None)
        if add_dll_directory is not None:
            for directory in directories:
                key = str(directory).casefold()
                if key not in _CUDA_RUNTIME_REGISTERED_DIRS:
                    handle = add_dll_directory(str(directory))
                    # Keep the handle alive: closing it removes this DLL search path.
                    _CUDA_RUNTIME_HANDLES.append(handle)
                    _CUDA_RUNTIME_REGISTERED_DIRS.add(key)
        path_parts = os.environ.get("PATH", "").split(os.pathsep)
        existing = {part.casefold() for part in path_parts if part}
        new_parts = [str(path) for path in directories if str(path).casefold() not in existing]
        if new_parts:
            os.environ["PATH"] = os.pathsep.join([*new_parts, *path_parts])
        return directories

    if sys.platform.startswith("linux"):
        cublas_dir = packages / "cublas" / "lib"
        cudnn_dir = packages / "cudnn" / "lib"
        libraries: list[Path] = []
        cublas = cublas_dir / "libcublas.so.12"
        if cublas.is_file():
            libraries.append(cublas)
        if cudnn_dir.is_dir():
            libraries.extend(sorted(cudnn_dir.glob("libcudnn*.so.9")))
        for library in libraries:
            key = str(library.resolve())
            if key not in _CUDA_RUNTIME_PRELOADED:
                # RTLD_GLOBAL makes symbols available to the later CTranslate2 dlopen.
                handle = ctypes.CDLL(key, mode=getattr(ctypes, "RTLD_GLOBAL", 0))
                _CUDA_RUNTIME_HANDLES.append(handle)
                _CUDA_RUNTIME_PRELOADED.add(key)
        return [path for path in (cublas_dir, cudnn_dir) if path.is_dir()]
    return []


class FasterWhisperEngine:
    def __init__(self, config: dict[str, Any]):
        model_path = Path(config["model_path"]).expanduser()
        if not model_path.is_dir():
            raise RuntimeError("local faster-whisper model directory is missing")
        if config["device"] != "cpu":
            # The CTranslate2 extension may resolve CUDA DLLs during import.
            _prepare_cuda_runtime()
        from faster_whisper import WhisperModel
        self.config = config
        self.WhisperModel = WhisperModel
        self.model_path = str(model_path)
        self.using_cuda = False
        self.backend = "faster-whisper"
        self.device = "cpu"
        self._load()

    def _create(self, device: str):
        compute_type = "float16" if device == "cuda" else "int8"
        kwargs = {"device": device, "compute_type": compute_type, "local_files_only": True}
        if device == "cpu":
            kwargs["cpu_threads"] = self.config["cpu_threads"]
        else:
            _prepare_cuda_runtime()
        return self.WhisperModel(self.model_path, **kwargs)

    def _load(self) -> None:
        choice = self.config["device"]
        if choice == "cpu":
            self.model = self._create("cpu")
            self.device = "cpu"
            return
        try:
            self.model = self._create("cuda")
            self.using_cuda = True
            self.device = "cuda"
        except Exception as exc:
            if choice == "cuda":
                raise RuntimeError(f"CUDA model load failed: {exc}") from exc
            self.model = self._create("cpu")
            self.device = "cpu"

    def _transcribe_once(self, audio: Any) -> tuple[str, Optional[str]]:
        initial_prompt, hotwords = voice_text.build_asr_hints(self.config)
        kwargs = {
            "language": None if self.config["language"] == "auto" else self.config["language"],
            "beam_size": self.config["beam_size"],
            "vad_filter": True,
            "condition_on_previous_text": False,
            "without_timestamps": True,
            "initial_prompt": initial_prompt or None,
        }
        if hotwords:
            kwargs["hotwords"] = hotwords
        segments, info = self.model.transcribe(audio, **kwargs)
        return "".join(segment.text for segment in segments).strip(), getattr(info, "language", None)

    def transcribe(self, audio: Any) -> tuple[str, Optional[str]]:
        try:
            return self._transcribe_once(audio)
        except Exception as exc:
            if self.config["device"] != "auto" or not self.using_cuda:
                raise
            self.model = self._create("cpu")
            self.using_cuda = False
            self.device = "cpu"
            try:
                return self._transcribe_once(audio)
            except Exception as retry_exc:
                raise RuntimeError(f"CUDA inference failed ({exc}); CPU retry failed ({retry_exc})") from retry_exc


class MlxWhisperEngine:
    def __init__(self, config: dict[str, Any]):
        if config["device"] == "cuda":
            raise RuntimeError("MLX does not use CUDA; set backend=faster-whisper for CUDA")
        if config["device"] == "cpu":
            raise RuntimeError("MLX CPU selection is not supported by this service; set backend=faster-whisper")
        model_path = Path(config["model_path"]).expanduser()
        if not model_path.is_dir():
            raise RuntimeError("local MLX Whisper model directory is missing")
        import mlx.core as mx
        import mlx_whisper
        self.module = mlx_whisper
        self.model_path = str(model_path)
        self.config = config
        self.backend = "mlx"
        self.device = "metal"
        load_model = importlib.import_module("mlx_whisper.load_models").load_model
        transcribe_module = importlib.import_module("mlx_whisper.transcribe")
        # Load weights now so the worker reports loading time separately and
        # the subsequent transcribe call reuses the package's model cache.
        model = load_model(self.model_path, dtype=mx.float16)
        transcribe_module.ModelHolder.model = model
        transcribe_module.ModelHolder.model_path = self.model_path

    def transcribe(self, audio: Any) -> tuple[str, Optional[str]]:
        if self.config["beam_size"] > 1:
            raise RuntimeError("mlx-whisper 0.4.3 supports greedy decoding only; set beam_size=1 or use faster-whisper")
        kwargs = {
            "path_or_hf_repo": self.model_path,
            "verbose": None,
            "language": None if self.config["language"] == "auto" else self.config["language"],
            "condition_on_previous_text": False,
        }
        initial_prompt, _hotwords = voice_text.build_asr_hints(self.config)
        if initial_prompt:
            kwargs["initial_prompt"] = initial_prompt
        result = self.module.transcribe(audio, **kwargs)
        return str(result.get("text", "")).strip(), result.get("language")


def create_engine(config: dict[str, Any]):
    backend = config["backend"]
    if backend == "mlx" or (backend == "auto" and config["device"] == "auto" and _is_apple_silicon()):
        if not _is_apple_silicon():
            raise RuntimeError("MLX backend requires Apple Silicon macOS")
        return MlxWhisperEngine(config)
    return FasterWhisperEngine(config)


def recognition_worker_main(config: dict[str, Any], in_queue: Any, out_queue: Any,
                            backend_factory: Optional[Callable] = None) -> None:
    """Multiprocessing target. It contains all model imports and audio work."""
    parent = multiprocessing.parent_process()
    guardian_stop = threading.Event()
    if parent is not None:
        def parent_guardian():
            while not guardian_stop.wait(0.5):
                try:
                    if not parent.is_alive():
                        os._exit(0)
                except Exception:
                    os._exit(0)
        threading.Thread(target=parent_guardian, name="voice-parent-guardian", daemon=True).start()
    engine = None
    try:
        while True:
            task = in_queue.get()
            if task is None:
                return
            job_id = task["id"]
            warmup = bool(task.get("warmup"))
            wav_bytes = task.get("audio") or make_silence_wav()
            task_config = task.get("config", config)
            started = time.monotonic()
            try:
                if engine is None:
                    out_queue.put({"type": "state", "id": job_id, "state": "loading"})
                    load_started = time.monotonic()
                    engine = (backend_factory or create_engine)(task_config)
                    load_seconds = time.monotonic() - load_started
                else:
                    load_seconds = 0.0
                    engine.config = task_config
                out_queue.put({"type": "state", "id": job_id, "state": "loading",
                               "backend": engine.backend, "device": engine.device})
                out_queue.put({"type": "state", "id": job_id, "state": "transcribing"})
                audio, audio_seconds = decode_wav16k(wav_bytes, task_config["max_seconds"])
                infer_started = time.monotonic()
                raw_text, language = engine.transcribe(audio)
                inference_seconds = time.monotonic() - infer_started
                local_seconds = 0.0
                rewrite_seconds = 0.0
                processing_warning = None
                local_text = ""
                text = ""
                if not warmup:
                    local_started = time.monotonic()
                    try:
                        local_text = voice_text.local_transform(raw_text, task_config, language)
                    except Exception:
                        local_text = raw_text
                        processing_warning = "文本整理未完成，已保留本地识别结果。"
                    local_seconds = time.monotonic() - local_started
                    text = local_text
                    if task_config.get("text_mode") == "ai" and processing_warning is None:
                        progress_timings = {
                            "queue_seconds": max(0.0, float(task.get("queue_seconds", 0.0))),
                            "load_seconds": load_seconds,
                            "inference_seconds": inference_seconds,
                            "local_seconds": local_seconds,
                            "rewrite_seconds": 0.0,
                            "total_seconds": time.monotonic() - started,
                            "audio_seconds": audio_seconds,
                        }
                        out_queue.put({"type": "state", "id": job_id, "state": "rewriting",
                                       "raw_text": raw_text, "local_text": local_text,
                                       "timings": progress_timings})
                        rewrite_started = time.monotonic()
                        text, processing_warning = voice_text.rewrite_text(
                            local_text, task_config,
                            api_key=str(task.get("rewrite_api_key", "")),
                            recognized_language=language,
                        )
                        rewrite_seconds = time.monotonic() - rewrite_started
                timings = {
                    "queue_seconds": max(0.0, float(task.get("queue_seconds", 0.0))),
                    "load_seconds": load_seconds,
                    "inference_seconds": inference_seconds,
                    "local_seconds": local_seconds,
                    "rewrite_seconds": rewrite_seconds,
                    "total_seconds": time.monotonic() - started,
                    "audio_seconds": audio_seconds,
                }
                out_queue.put({
                    "type": "result", "id": job_id, "state": "done",
                    "text": text,
                    "raw_text": "" if warmup else raw_text,
                    "local_text": "" if warmup else local_text,
                    "timings": timings,
                    "backend": engine.backend,
                    "device": engine.device,
                    "language": language,
                    "processing_warning": None if warmup else processing_warning,
                })
            except BaseException as exc:
                out_queue.put({"type": "result", "id": job_id, "state": "error",
                               "code": "recognition_failed",
                               "error": f"{type(exc).__name__}: {exc}"[:MAX_ERROR_CHARS]})
    finally:
        guardian_stop.set()


class ProcessWorker:
    """Small injectable wrapper around one persistent multiprocessing worker."""
    def __init__(self, config: dict[str, Any], target: Callable = recognition_worker_main,
                 context: Optional[Any] = None, target_args: tuple[Any, ...] = ()):
        self.context = context or multiprocessing.get_context()
        self.in_queue = self.context.Queue(maxsize=1)
        self.out_queue = self.context.Queue()
        self.process = self.context.Process(target=target,
                                            args=(copy.deepcopy(config), self.in_queue, self.out_queue, *target_args),
                                            name="opencode-local-voice-worker", daemon=True)
        self.process.start()
        self.closed = False

    def submit(self, task: dict[str, Any]) -> None:
        self.in_queue.put(task, timeout=2)

    def poll(self, timeout: float = 0.1) -> Optional[dict[str, Any]]:
        try:
            return self.out_queue.get(timeout=timeout)
        except (queue.Empty, EOFError, OSError, ValueError):
            if self.closed:
                return None
            if not self.process.is_alive():
                return {"type": "worker_exit", "exitcode": self.process.exitcode}
            return None

    def close_queue(self, q: Any) -> None:
        try:
            q.cancel_join_thread()
            q.close()
        except (AttributeError, OSError, ValueError):
            pass

    def stop(self, terminate: bool = False) -> None:
        if self.closed:
            return
        self.closed = True
        if self.process.is_alive() and not terminate:
            try:
                self.in_queue.put_nowait(None)
            except Exception:
                terminate = True
            if not terminate:
                self.process.join(timeout=0.5)
        if self.process.is_alive():
            self.process.terminate()
            self.process.join(timeout=2)
        self.close_queue(self.in_queue)
        self.close_queue(self.out_queue)


class Job:
    def __init__(self, job_id: str, audio: Optional[bytes], warmup: bool = False):
        now = time.monotonic()
        self.id = job_id
        self.state = "queued"
        self.audio = audio
        self.warmup = warmup
        self.text: Optional[str] = None
        self.raw_text: Optional[str] = None
        self.local_text: Optional[str] = None
        self.processing_warning: Optional[str] = None
        self.error: Optional[str] = None
        self.error_code: Optional[str] = None
        self.timings: Optional[dict[str, float]] = None
        self.created = now
        self.updated = now
        self.started: Optional[float] = None

    def public(self) -> dict[str, Any]:
        result: dict[str, Any] = {"id": self.id, "state": self.state}
        if self.state == "done" and not self.warmup:
            result["text"] = self.text or ""
            result["raw_text"] = self.raw_text if self.raw_text is not None else result["text"]
            result["local_text"] = self.local_text if self.local_text is not None else result["text"]
            if self.processing_warning:
                result["processing_warning"] = self.processing_warning
        elif self.state == "rewriting" and not self.warmup:
            if self.raw_text is not None:
                result["raw_text"] = self.raw_text
            if self.local_text is not None:
                result["local_text"] = self.local_text
        if self.error:
            result["error"] = self.error
            result["code"] = self.error_code or "recognition_failed"
        if self.timings is not None:
            result["timings"] = self.timings
        return result


class Coordinator:
    """Bounded in-memory jobs and one persistent, replaceable worker process."""
    def __init__(self, config: dict[str, Any], worker_factory: Callable = ProcessWorker,
                 result_ttl: int = RESULT_TTL_SECONDS, tombstone_ttl: int = CANCEL_TOMBSTONE_SECONDS,
                 max_retained_jobs: int = MAX_RETAINED_JOBS, rewrite_api_key: str = ""):
        self._lock = threading.RLock()
        self._condition = threading.Condition(self._lock)
        self.config = copy.deepcopy(config)
        self.rewrite_api_key = rewrite_api_key
        self.worker_factory = worker_factory
        self.result_ttl = result_ttl
        self.tombstone_ttl = tombstone_ttl
        self.max_retained_jobs = max(1, int(max_retained_jobs))
        self.jobs: dict[str, Job] = {}
        self.pending: deque[str] = deque()
        self.tombstones: dict[str, float] = {}
        self.worker: Optional[Any] = None
        self.worker_generation = 0
        self.worker_stopping = False
        self.active_id: Optional[str] = None
        self.model_state = "unloaded"
        self.backend: Optional[str] = None
        self.device: Optional[str] = None
        self.last_error: Optional[str] = None
        self.last_error_code: Optional[str] = None
        self.last_warmup_id: Optional[str] = None
        self._stopping = False
        self._thread = threading.Thread(target=self._run, name="voice-job-coordinator", daemon=True)
        self._thread.start()

    def _is_live(self, job: Job) -> bool:
        return job.state in ("queued", "loading", "transcribing", "rewriting")

    def _prune_locked(self) -> None:
        now = time.monotonic()
        for job_id, deadline in list(self.tombstones.items()):
            if deadline <= now:
                self.tombstones.pop(job_id, None)
        for job_id, job in list(self.jobs.items()):
            if not self._is_live(job) and now - job.updated > self.result_ttl:
                self.jobs.pop(job_id, None)

    def _make_room_locked(self) -> bool:
        while len(self.jobs) >= self.max_retained_jobs:
            terminal = [job for job in self.jobs.values() if not self._is_live(job)]
            if not terminal:
                return False
            oldest = min(terminal, key=lambda job: job.updated)
            self.jobs.pop(oldest.id, None)
        return True

    def _add_tombstone_locked(self, job_id: str) -> None:
        now = time.monotonic()
        self.tombstones[job_id] = now + self.tombstone_ttl
        while len(self.tombstones) > MAX_TOMBSTONES:
            oldest = min(self.tombstones, key=self.tombstones.get)
            self.tombstones.pop(oldest, None)

    def enqueue(self, job_id: str, audio: bytes, warmup: bool = False) -> tuple[Job, bool]:
        with self._condition:
            if self._stopping:
                raise ServiceStoppingError("service is shutting down")
            self._prune_locked()
            if job_id in self.jobs:
                existing = self.jobs[job_id]
                return existing, False
            if self.tombstones.get(job_id, 0) > time.monotonic():
                if not self._make_room_locked():
                    raise QueueLimitError("voice job retention limit is full")
                job = Job(job_id, None, warmup)
                job.state = "cancelled"
                job.audio = None
                job.updated = time.monotonic()
                self.jobs[job_id] = job
                return job, False
            if len(self.pending) >= MAX_PENDING_JOBS:
                raise QueueLimitError("voice queue is full")
            if not self._make_room_locked():
                raise QueueLimitError("voice job retention limit is full")
            job = Job(job_id, audio, warmup)
            self.jobs[job_id] = job
            self.pending.append(job_id)
            if warmup:
                self.last_warmup_id = job_id
            self._condition.notify_all()
            return job, True

    def enqueue_warmup(self) -> Job:
        with self._condition:
            if self._stopping:
                raise ServiceStoppingError("service is shutting down")
            self._prune_locked()
            for job in self.jobs.values():
                if job.warmup and self._is_live(job):
                    return job
            if self.model_state == "ready":
                if self.last_warmup_id and self.last_warmup_id in self.jobs:
                    return self.jobs[self.last_warmup_id]
                if not self._make_room_locked():
                    raise QueueLimitError("voice job retention limit is full")
                job = Job("warmup-" + str(uuid.uuid4()), None, True)
                job.state = "done"
                job.timings = {"queue_seconds": 0.0, "load_seconds": 0.0, "inference_seconds": 0.0,
                               "total_seconds": 0.0, "audio_seconds": 0.0}
                job.updated = time.monotonic()
                self.jobs[job.id] = job
                self.last_warmup_id = job.id
                return job
        job, _ = self.enqueue("warmup-" + str(uuid.uuid4()), make_silence_wav(), warmup=True)
        return job

    def get(self, job_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            self._prune_locked()
            job = self.jobs.get(job_id)
            return job.public() if job else None

    def queue_depth(self) -> int:
        with self._lock:
            return len(self.pending)

    def has_live_jobs(self) -> bool:
        with self._lock:
            return bool(self.active_id or self.pending)

    def request_shutdown_if_idle(self) -> bool:
        """Atomically stop accepting jobs only when the queue and worker are idle."""
        with self._condition:
            if self.active_id or self.pending:
                return False
            self._stopping = True
            self._condition.notify_all()
            return True

    def update_config(self, config: dict[str, Any], changed: set[str],
                      rewrite_api_key: Optional[str] = None) -> None:
        with self._condition:
            if self.has_live_jobs():
                raise RuntimeError("configuration cannot change while a job is active")
            self.config = copy.deepcopy(config)
            if rewrite_api_key is not None:
                self.rewrite_api_key = rewrite_api_key
            self.last_error = None
            self.last_error_code = None
            if changed & MODEL_FIELDS and self.worker is not None:
                worker, self.worker = self.worker, None
                self.worker_generation += 1
                self.model_state = "unloaded"
                self.backend = None
                self.device = None
                worker.stop()

    def cancel(self, job_id: str) -> dict[str, Any]:
        worker_to_stop = None
        with self._condition:
            self._prune_locked()
            job = self.jobs.get(job_id)
            if job is None:
                self._add_tombstone_locked(job_id)
                return {"id": job_id, "state": "cancelled"}
            if job.state in ("done", "error", "cancelled"):
                return {"id": job_id, "state": job.state}
            if self.active_id == job_id:
                worker_to_stop, self.worker = self.worker, None
                self.worker_generation += 1
                self.worker_stopping = worker_to_stop is not None
                self.active_id = None
                self.model_state = "unloaded"
                self.backend = None
                self.device = None
                self.last_error = None
                self.last_error_code = None
            else:
                try:
                    self.pending.remove(job_id)
                except ValueError:
                    pass
            job.state = "cancelled"
            job.audio = None
            job.text = None
            job.raw_text = None
            job.local_text = None
            job.processing_warning = None
            job.error = None
            job.error_code = None
            job.timings = None
            job.updated = time.monotonic()
            self._add_tombstone_locked(job_id)
            self._condition.notify_all()
        if worker_to_stop is not None:
            worker_to_stop.stop(terminate=True)
            with self._condition:
                self.worker_stopping = False
                self._condition.notify_all()
        return {"id": job_id, "state": "cancelled"}

    def use_local(self, job_id: str) -> Optional[dict[str, Any]]:
        """Stop the active rewrite and finish from its saved local transcript."""
        worker_to_stop = None
        with self._condition:
            self._prune_locked()
            job = self.jobs.get(job_id)
            if (job is None or job.state != "rewriting" or job.local_text is None or
                    self.active_id != job_id):
                return None
            worker_to_stop, self.worker = self.worker, None
            self.worker_generation += 1
            self.worker_stopping = worker_to_stop is not None
            self.active_id = None
            self.model_state = "unloaded" if worker_to_stop is not None else "ready"
            job.state = "done"
            job.text = job.local_text
            job.audio = None
            job.processing_warning = None
            job.updated = time.monotonic()
            job.timings = dict(job.timings or {})
            job.timings["rewrite_seconds"] = 0.0
            job.timings["total_seconds"] = max(0.0, job.updated - (job.started or job.updated))
            self._condition.notify_all()
        if worker_to_stop is not None:
            worker_to_stop.stop(terminate=True)
            with self._condition:
                self.worker_stopping = False
                self._condition.notify_all()
        return job.public()

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "model_state": self.model_state,
                "backend": self.backend or self.config["backend"],
                "device": self.device or self.config["device"],
                "queue_depth": len(self.pending),
                "active_jobs": 1 if self.active_id else 0,
                "version": VERSION,
                "last_error": self.last_error,
                "last_error_code": self.last_error_code,
            }

    def wait(self, job_id: str, timeout: Optional[float] = None) -> Optional[dict[str, Any]]:
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            result = self.get(job_id)
            if result is None or result["state"] in ("done", "error", "cancelled"):
                return result
            if deadline is not None and time.monotonic() >= deadline:
                return result
            time.sleep(0.05)

    def _fail_active_locked(self, error: str, code: str = "worker_unavailable") -> None:
        job = self.jobs.get(self.active_id or "")
        if job:
            job.state = "error"
            job.audio = None
            job.error = error[:MAX_ERROR_CHARS]
            job.error_code = code
            job.updated = time.monotonic()
        self.last_error = error[:MAX_ERROR_CHARS]
        self.last_error_code = code
        self.model_state = "error"
        self.active_id = None

    def _process_message(self, msg: dict[str, Any], generation: int) -> None:
        worker_to_stop = None
        with self._condition:
            if generation != self.worker_generation:
                return
            if msg.get("type") == "worker_exit":
                self._fail_active_locked(f"recognition worker exited unexpectedly ({msg.get('exitcode')})")
                worker_to_stop, self.worker = self.worker, None
                self.worker_generation += 1
                self.worker_stopping = worker_to_stop is not None
                self._condition.notify_all()
            else:
                job_id = msg.get("id")
                job = self.jobs.get(job_id or "")
                if not job or job.state == "cancelled":
                    return
                if msg.get("type") == "state":
                    job.state = msg["state"]
                    if msg["state"] == "rewriting" and not job.warmup:
                        if isinstance(msg.get("raw_text"), str):
                            job.raw_text = msg["raw_text"]
                        if isinstance(msg.get("local_text"), str):
                            job.local_text = msg["local_text"]
                        if isinstance(msg.get("timings"), dict):
                            job.timings = msg["timings"]
                    job.updated = time.monotonic()
                    self.model_state = msg["state"]
                    if msg.get("backend"):
                        self.backend = msg["backend"]
                    if msg.get("device"):
                        self.device = msg["device"]
                    return
                if msg.get("type") == "result":
                    job.state = msg.get("state", "error")
                    job.audio = None
                    job.updated = time.monotonic()
                    if job.state == "done":
                        job.text = "" if job.warmup else str(msg.get("text", ""))
                        if not job.warmup:
                            job.raw_text = str(msg.get("raw_text", job.text or ""))
                            job.local_text = str(msg.get("local_text", job.text or ""))
                            warning = msg.get("processing_warning")
                            job.processing_warning = str(warning)[:200] if warning else None
                        job.timings = msg.get("timings")
                        self.backend = msg.get("backend", self.backend)
                        self.device = msg.get("device", self.device)
                        self.model_state = "ready"
                        self.last_error = None
                        self.last_error_code = None
                    else:
                        job.error = str(msg.get("error", "recognition failed"))[:MAX_ERROR_CHARS]
                        job.error_code = str(msg.get("code", "recognition_failed"))
                        self.model_state = "error"
                        self.last_error = job.error
                        self.last_error_code = job.error_code
                    if self.active_id == job.id:
                        self.active_id = None
                    self._condition.notify_all()
        if worker_to_stop is not None:
            worker_to_stop.stop(terminate=True)
            with self._condition:
                self.worker_stopping = False
                self._condition.notify_all()

    def _run(self) -> None:
        while True:
            task = None
            worker = None
            create_worker = False
            factory_config = None
            factory_generation = None
            with self._condition:
                if self._stopping:
                    break
                if self.worker_stopping:
                    self._condition.wait(timeout=0.1)
                    continue
                if self.active_id is None and self.pending:
                    job_id = self.pending.popleft()
                    job = self.jobs.get(job_id)
                    if job and job.state == "queued":
                        self.active_id = job_id
                        job.started = time.monotonic()
                        job.state = "loading"
                        job.updated = job.started
                        task = {"id": job_id, "warmup": job.warmup, "audio": job.audio,
                                "queue_seconds": max(0.0, job.started - job.created),
                                "config": copy.deepcopy(self.config),
                                "rewrite_api_key": self.rewrite_api_key}
                        job.audio = None
                        if self.worker is None:
                            create_worker = True
                            factory_config = copy.deepcopy(self.config)
                            factory_generation = self.worker_generation
                        else:
                            worker = self.worker
                if worker is None and not create_worker:
                    worker = self.worker
                generation = self.worker_generation
                active_id = self.active_id
                if task is None and worker is None and not create_worker:
                    self._condition.wait(timeout=0.2)
                    continue
            if create_worker:
                try:
                    new_worker = self.worker_factory(factory_config)
                except Exception as exc:
                    with self._condition:
                        if (not self._stopping and self.worker_generation == factory_generation and
                                self.active_id == active_id and self.active_id == (task or {}).get("id")):
                            self._fail_active_locked(f"could not start recognition worker: {exc}")
                            self._condition.notify_all()
                    continue
                with self._condition:
                    install_worker = (not self._stopping and self.worker is None and
                                      self.worker_generation == factory_generation and
                                      self.active_id == active_id and self.active_id == task["id"])
                    if install_worker:
                        self.worker = new_worker
                        self.worker_generation += 1
                        worker = new_worker
                        generation = self.worker_generation
                    self._condition.notify_all()
                if not install_worker:
                    # Cancellation or shutdown won while process startup was outside the lock.
                    # Disposal can itself block while joining a child, so keep it out of the lock.
                    new_worker.stop(terminate=True)
                    continue
            if task is not None and worker is not None:
                try:
                    worker.submit(task)
                except Exception as exc:
                    worker_to_stop = None
                    with self._condition:
                        if generation == self.worker_generation and self.active_id == task["id"]:
                            self._fail_active_locked(f"could not submit recognition task: {exc}")
                            worker_to_stop, self.worker = self.worker, None
                            self.worker_generation += 1
                        else:
                            worker_to_stop = worker
                    if worker_to_stop:
                        worker_to_stop.stop(terminate=True)
                    continue
            if worker is not None and active_id:
                msg = worker.poll(timeout=0.1)
                if msg:
                    self._process_message(msg, generation)

    def close(self) -> None:
        with self._condition:
            self._stopping = True
            worker, self.worker = self.worker, None
            terminate_worker = self.active_id is not None
            self.worker_generation += 1
            self.worker_stopping = False
            for job in self.jobs.values():
                if self._is_live(job):
                    job.state = "cancelled"
                    job.audio = None
                    job.updated = time.monotonic()
            self.pending.clear()
            self.active_id = None
            self._condition.notify_all()
        if worker:
            worker.stop(terminate=terminate_worker)
        self._thread.join(timeout=2)


class BoundedHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    allow_reuse_address = True
    request_queue_size = 16

    def __init__(self, address, handler, app, max_threads=MAX_HTTP_THREADS):
        self.app = app
        self._thread_slots = threading.BoundedSemaphore(max_threads)
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        if not self._thread_slots.acquire(blocking=False):
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._thread_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._thread_slots.release()


class VoiceApp:
    def __init__(self, store: ConfigStore, coordinator: Optional[Coordinator] = None):
        self.store = store
        self.coordinator = coordinator or Coordinator(store.get(), rewrite_api_key=store.get_rewrite_api_key())
        if coordinator is not None:
            coordinator.rewrite_api_key = store.get_rewrite_api_key()
        self.last_access = time.monotonic()
        self._access_lock = threading.Lock()
        self._stopping = threading.Event()
        self._preview_slots = threading.BoundedSemaphore(2)

    def touch(self):
        with self._access_lock:
            self.last_access = time.monotonic()

    def idle_expired(self) -> bool:
        with self._access_lock:
            last_access = self.last_access
        return time.monotonic() - last_access >= self.store.get()["idle_seconds"] and not self.coordinator.has_live_jobs()


def _content_length(handler: BaseHTTPRequestHandler, maximum: int) -> int:
    raw = handler.headers.get("Content-Length")
    if raw is None:
        raise ValueError("Content-Length is required")
    try:
        size = int(raw)
    except ValueError as exc:
        raise ValueError("invalid Content-Length") from exc
    if size <= 0:
        raise ValueError("request body is empty")
    if size > maximum:
        raise OverflowError("request body is too large")
    if handler.headers.get("Transfer-Encoding"):
        raise ValueError("chunked transfer encoding is not supported")
    return size


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "OpenCodeLocalVoice/0.2.0"
    sys_version = ""

    @property
    def app(self) -> VoiceApp:
        return self.server.app  # type: ignore[attr-defined]

    def log_message(self, fmt, *args):
        # Never log authorization headers, paths, query nonces, or transcript data.
        return

    def setup(self):
        super().setup()
        self.connection.settimeout(10.0)

    def _send_json(self, code: int, obj: dict[str, Any], extra_headers: Optional[dict[str, str]] = None):
        if "error" in obj and "code" not in obj:
            obj = dict(obj)
            obj["code"] = {400: "invalid_request", 401: "unauthorized", 403: "forbidden",
                           404: "not_found", 409: "conflict", 413: "too_large",
                           429: "queue_full", 500: "internal_error", 504: "timeout"}.get(code, "request_failed")
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.close_connection = True
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self._cors_headers()
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_empty(self, code: int):
        self.close_connection = True
        self.send_response(code)
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self._cors_headers()
        self.end_headers()

    def _cors_headers(self):
        origin = self.headers.get("Origin")
        if origin and self._origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def _origin_allowed(self, origin: str) -> bool:
        try:
            normalized = _validate_origin(origin)
        except ConfigError:
            return False
        return normalized in self.app.store.get()["allowed_origins"]

    def _check_origin(self) -> bool:
        origin = self.headers.get("Origin")
        return origin is None or self._origin_allowed(origin)

    def _check_host(self) -> bool:
        try:
            parsed = urllib.parse.urlsplit("//" + self.headers.get("Host", ""))
            return (parsed.hostname in ("127.0.0.1", "localhost") and
                    parsed.port == self.server.server_address[1])
        except ValueError:
            return False

    def _authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "")
        if not supplied.startswith("Bearer "):
            return False
        return secrets.compare_digest(supplied[7:], self.app.store.token)

    def _read_json(self) -> dict[str, Any]:
        size = _content_length(self, MAX_JSON_BYTES)
        try:
            result = json.loads(self.rfile.read(size).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("request body must be valid UTF-8 JSON") from exc
        if not isinstance(result, dict):
            raise ValueError("request body must be a JSON object")
        return result

    def _preview_config_and_key(self, body: dict[str, Any], *, fixed_test: bool = False) -> tuple[dict[str, Any], str]:
        allowed = {"config", "rewrite_api_key"} if fixed_test else {"config", "rewrite_api_key", "text"}
        unknown = set(body) - allowed
        if unknown:
            raise ConfigError("request contains an unknown field")
        overrides = body.get("config", {})
        if not isinstance(overrides, dict):
            raise ConfigError("config must be a JSON object")
        overrides = dict(overrides)
        # The renderer may pass the public GET /config object. Ignore its
        # computed status bit, and apply all overrides only to this request.
        overrides.pop("rewrite_key_configured", None)
        if set(overrides) - CONFIG_FIELDS:
            raise ConfigError("preview config contains an unsupported field")
        config = validate_config({**self.app.store.get(), **overrides})
        if "rewrite_api_key" in body:
            try:
                api_key = voice_text.validate_rewrite_api_key(body["rewrite_api_key"])
            except voice_text.TextConfigError as exc:
                raise ConfigError(str(exc)) from exc
        else:
            api_key = self.app.store.get_rewrite_api_key()
        return config, api_key

    def _preview_text(self, body: dict[str, Any], *, fixed_test: bool = False) -> dict[str, Any]:
        config, api_key = self._preview_config_and_key(body, fixed_test=fixed_test)
        raw_text = (
            "This is a local voice rewriting connection test. Keep the meaning and return only the text."
            if fixed_test else body.get("text")
        )
        if not isinstance(raw_text, str) or len(raw_text) > voice_text.MAX_REWRITE_TEXT_CHARS:
            raise ValueError("text must be text up to 100000 characters")
        started = time.monotonic()
        local_started = time.monotonic()
        local_warning = None
        try:
            selected_language = config.get("language")
            local_text = voice_text.local_transform(
                raw_text, config, selected_language if selected_language != "auto" else None)
        except Exception:
            local_text = raw_text
            local_warning = "文本整理未完成，已保留本地识别结果。"
        local_seconds = time.monotonic() - local_started
        text = local_text
        processing_warning = local_warning
        rewrite_seconds = 0.0
        if fixed_test or (config.get("text_mode") == "ai" and local_warning is None):
            rewrite_started = time.monotonic()
            selected_language = config.get("language")
            text, rewrite_warning = voice_text.rewrite_text(
                local_text, config, api_key=api_key,
                recognized_language=selected_language if selected_language != "auto" else None)
            rewrite_seconds = time.monotonic() - rewrite_started
            processing_warning = rewrite_warning
        timings = {"local_seconds": local_seconds, "rewrite_seconds": rewrite_seconds,
                   "total_seconds": time.monotonic() - started}
        if fixed_test:
            return {"ok": processing_warning is None,
                    "message": "AI 改写连接成功。" if processing_warning is None
                    else "AI 改写连接失败，请检查模型、地址、密钥和网络设置。"}
        result = {"raw_text": raw_text, "local_text": local_text, "text": text,
                  "timings": timings}
        if processing_warning:
            result["processing_warning"] = processing_warning
        return result

    def _read_audio(self) -> bytes:
        max_audio = self.app.store.get()["max_seconds"] * 16000 * 2 + 65536
        size = _content_length(self, max_audio)
        data = self.rfile.read(size)
        if len(data) != size:
            raise ValueError("request body ended before Content-Length")
        validate_wav16k(data, self.app.store.get()["max_seconds"])
        return data

    def _request_gate(self, require_auth: bool = True) -> bool:
        if not self._check_host():
            self._send_json(403, {"error": "Host is not allowed"})
            return False
        if not self._check_origin():
            self._send_json(403, {"error": "origin is not allowed"})
            return False
        if require_auth and not self._authorized():
            self._send_json(401, {"error": "unauthorized"}, {"WWW-Authenticate": "Bearer"})
            return False
        self.app.touch()
        return True

    def handle_expect_100(self):
        if not self._check_host():
            self._send_json(403, {"error": "Host is not allowed"})
            return False
        if not self._check_origin():
            self._send_json(403, {"error": "origin is not allowed"})
            return False
        if not self._authorized():
            self._send_json(401, {"error": "unauthorized"}, {"WWW-Authenticate": "Bearer"})
            return False
        return super().handle_expect_100()

    def do_OPTIONS(self):
        if not self._check_host():
            self._send_json(403, {"error": "Host is not allowed"})
            return
        if not self._check_origin():
            self._send_json(403, {"error": "origin is not allowed"})
            return
        self.app.touch()
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Job-Id")
        self.send_header("Access-Control-Max-Age", "600")
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/health":
            if not self._request_gate(require_auth=False):
                return
            query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
            challenge = query.get("challenge", [""])[0]
            if not 16 <= len(challenge) <= 256:
                self._send_json(400, {"error": "challenge must be 16 to 256 characters"})
                return
            self._send_json(200, {"service": SERVICE_NAME, "protocol": PROTOCOL, "version": VERSION,
                                  "proof": hmac_proof(self.app.store.token, challenge)})
            return
        if not self._request_gate():
            return
        if parsed.path == "/v1/config":
            self._send_json(200, self.app.store.public())
        elif parsed.path == "/v1/status":
            self._send_json(200, self.app.coordinator.status())
        elif parsed.path.startswith("/v1/jobs/"):
            job_id = parsed.path[len("/v1/jobs/"):]
            result = self.app.coordinator.get(job_id)
            self._send_json(200 if result else 404, result or {"error": "job not found"})
        else:
            self._send_json(404, {"error": "not found"})

    def do_PATCH(self):
        if not self._request_gate():
            return
        if urllib.parse.urlsplit(self.path).path != "/v1/config":
            self._send_json(404, {"error": "not found"})
            return
        try:
            patch = self._read_json()
            if not isinstance(patch, dict):
                raise ConfigError("configuration patch must be a JSON object")
            # Job enqueue and config commit share the coordinator condition:
            # no POST can become live between the idle check and disk commit.
            # The lock order is coordinator condition -> ConfigStore lock.
            with self.app.coordinator._condition:
                current = self.app.store.get()
                public_patch = {key: value for key, value in patch.items()
                                if key not in voice_text.CONFIG_PATCH_CREDENTIAL_FIELDS}
                if "port" in public_patch and public_patch["port"] != current["port"]:
                    self._send_json(409, {"error": "port cannot change while the service is running"})
                    return
                candidate = validate_config({**current, **public_patch})
                changed = {key for key in CONFIG_FIELDS if candidate[key] != current[key]}
                if "rewrite_api_key" in patch:
                    try:
                        requested_key = voice_text.validate_rewrite_api_key(patch["rewrite_api_key"])
                    except voice_text.TextConfigError as exc:
                        raise ConfigError(str(exc)) from exc
                    if requested_key != self.app.store.get_rewrite_api_key():
                        changed.add("rewrite_api_key")
                if self.app.coordinator.has_live_jobs() and changed:
                    self._send_json(409, {"error": "configuration cannot change while a job is active"})
                    return
                # ConfigStore.update validates and persists before changing its
                # in-memory copy. Runtime state remains untouched if that fails.
                updated, changed = self.app.store.update(patch)
                if changed:
                    self.app.coordinator.update_config(updated, changed,
                                                       self.app.store.get_rewrite_api_key())
            self._send_json(200, self.app.store.public())
        except OverflowError as exc:
            self._send_json(413, {"error": str(exc)})
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})
        except RuntimeError as exc:
            self._send_json(409, {"error": str(exc)})
        except OSError:
            self._send_json(500, {"error": "could not persist configuration", "code": "config_write_failed"})

    def do_POST(self):
        if not self._request_gate():
            return
        path = urllib.parse.urlsplit(self.path).path
        if path == "/v1/shutdown":
            raw_length = self.headers.get("Content-Length")
            try:
                empty_body = raw_length is None or int(raw_length) == 0
            except ValueError:
                empty_body = False
            if self.headers.get("Transfer-Encoding") or not empty_body:
                self._send_json(400, {"error": "shutdown request body must be empty"})
                return
            if not self.app.coordinator.request_shutdown_if_idle():
                self._send_json(409, {"error": "service is busy"})
                return
            self._send_json(202, {"status": "shutting_down"})
            # shutdown() waits for serve_forever and therefore must run after
            # this response has been written and on a different thread.
            threading.Thread(target=self.server.shutdown, name="voice-http-shutdown", daemon=True).start()
            return
        if path == "/v1/text":
            if not self.app._preview_slots.acquire(blocking=False):
                self._send_json(429, {"error": "text preview capacity is busy", "code": "preview_busy"})
                return
            try:
                body = self._read_json()
                result = self._preview_text(body)
                self._send_json(200, result)
            except OverflowError as exc:
                self._send_json(413, {"error": str(exc)})
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
            finally:
                self.app._preview_slots.release()
            return
        if path == "/v1/rewrite/test":
            if not self.app._preview_slots.acquire(blocking=False):
                self._send_json(429, {"ok": False, "message": "AI 测试并发已满，请稍后重试。",
                                      "code": "preview_busy"})
                return
            try:
                body = self._read_json()
                if "text" in body:
                    raise ValueError("rewrite test does not accept transcript text")
                result = self._preview_text(body, fixed_test=True)
                self._send_json(200 if result["ok"] else 502, result)
            except OverflowError:
                self._send_json(413, {"ok": False, "message": "AI 测试请求过大。"})
            except ValueError:
                self._send_json(400, {"ok": False, "message": "AI 测试设置无效。"})
            finally:
                self.app._preview_slots.release()
            return
        if path.startswith("/v1/jobs/") and path.endswith("/use-local"):
            job_id = path[len("/v1/jobs/"):-len("/use-local")].rstrip("/")
            try:
                job_id = str(uuid.UUID(job_id))
            except ValueError:
                self._send_json(404, {"error": "job not found"})
                return
            try:
                if self.headers.get("Content-Length", "0") not in ("", "0"):
                    body = self._read_json()
                    if body:
                        raise ValueError("use-local body must be empty")
                result = self.app.coordinator.use_local(job_id)
                if result is None:
                    self._send_json(409, {"error": "local result is not available", "code": "local_result_unavailable"})
                else:
                    self._send_json(200, result)
            except OverflowError as exc:
                self._send_json(413, {"error": str(exc)})
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
            return
        if path == "/v1/warmup":
            try:
                if self.headers.get("Content-Length", "0") not in ("", "0"):
                    body = self._read_json()
                    if body:
                        raise ValueError("warmup body must be empty")
                job = self.app.coordinator.enqueue_warmup()
                self._send_json(202 if job.state not in ("done", "error") else 200,
                                {"id": job.id, "state": job.state})
            except QueueLimitError as exc:
                self._send_json(429, {"error": str(exc)})
            except OverflowError as exc:
                self._send_json(413, {"error": str(exc)})
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
            except ServiceStoppingError:
                self._send_json(503, {"error": "service is shutting down", "code": "service_shutting_down"})
            return
        if path not in ("/v1/jobs", "/inference"):
            self._send_json(404, {"error": "not found"})
            return
        try:
            audio = self._read_audio()
            if path == "/inference":
                job_id = str(uuid.uuid4())
            else:
                raw_id = self.headers.get("X-Job-Id", "")
                try:
                    parsed_id = uuid.UUID(raw_id)
                except (ValueError, AttributeError) as exc:
                    raise ValueError("X-Job-Id must be a UUID") from exc
                job_id = str(parsed_id)
            job, created = self.app.coordinator.enqueue(job_id, audio)
            if path == "/inference":
                result = self.app.coordinator.wait(job.id, timeout=self.app.store.get()["max_seconds"] * 10 + 120)
                if result and result["state"] == "done":
                    response = {"text": result.get("text", ""), "raw_text": result.get("raw_text", ""),
                                "local_text": result.get("local_text", ""), "timings": result.get("timings")}
                    if result.get("processing_warning"):
                        response["processing_warning"] = result["processing_warning"]
                    self._send_json(200, response)
                elif result and result["state"] == "error":
                    self._send_json(500, {"error": result.get("error", "recognition failed"),
                                          "code": result.get("code", "recognition_failed")})
                else:
                    self._send_json(504, {"error": "recognition timed out"})
            elif not created and job.state != "cancelled":
                self._send_json(200, job.public())
            else:
                self._send_json(202, job.public())
        except QueueLimitError as exc:
            self._send_json(429, {"error": str(exc)})
        except OverflowError as exc:
            self._send_json(413, {"error": str(exc)})
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})
        except ServiceStoppingError:
            self._send_json(503, {"error": "service is shutting down", "code": "service_shutting_down"})
        except Exception as exc:
            if isinstance(exc, queue.Full):
                self._send_json(429, {"error": "voice worker queue is full"})
            elif "queue is full" in str(exc):
                self._send_json(429, {"error": "voice queue is full"})
            else:
                self._send_json(500, {"error": str(exc)[:MAX_ERROR_CHARS]})

    def do_DELETE(self):
        if not self._request_gate():
            return
        path = urllib.parse.urlsplit(self.path).path
        if not path.startswith("/v1/jobs/"):
            self._send_json(404, {"error": "not found"})
            return
        job_id = path[len("/v1/jobs/"):]
        try:
            if job_id.startswith("warmup-"):
                uuid.UUID(job_id[7:])
            else:
                job_id = str(uuid.UUID(job_id))
        except ValueError:
            self._send_json(404, {"error": "job not found"})
            return
        self._send_json(200, self.app.coordinator.cancel(job_id))


def create_server(host: str = "127.0.0.1", port: Optional[int] = None,
                  store: Optional[ConfigStore] = None, coordinator: Optional[Coordinator] = None,
                  max_threads: int = MAX_HTTP_THREADS) -> BoundedHTTPServer:
    if host != "127.0.0.1":
        raise ValueError("OpenCode Local Voice must bind to 127.0.0.1")
    store = store or ConfigStore()
    config = store.get()
    app = VoiceApp(store, coordinator or Coordinator(config, rewrite_api_key=store.get_rewrite_api_key()))
    return BoundedHTTPServer((host, config["port"] if port is None else port), Handler, app, max_threads=max_threads)


def serve(store: Optional[ConfigStore] = None) -> None:
    server = create_server(store=store)
    stop = threading.Event()

    def idle_monitor():
        config = server.app.store.get()
        interval = max(0.5, min(5.0, config["idle_seconds"] / 10.0))
        while not stop.wait(interval):
            if server.app.idle_expired():
                server.shutdown()
                return

    threading.Thread(target=idle_monitor, name="voice-idle-watchdog", daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        stop.set()
        server.server_close()
        server.app.coordinator.close()


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="OpenCode Local Voice v0.3 service")
    parser.add_argument("--serve", action="store_true", help="run the local voice service")
    args = parser.parse_args(argv)
    if args.serve:
        serve()
        return 0
    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
