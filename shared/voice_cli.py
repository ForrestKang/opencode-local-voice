#!/usr/bin/env python3
"""Cross-platform file/FFmpeg microphone client for OpenCode Local Voice."""
from __future__ import annotations

import argparse
import hmac
import io
import json
import math
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave
from pathlib import Path
from typing import Any, Optional

try:
    from .voice_server import ConfigStore, SERVICE_NAME, PROTOCOL, VERSION, hmac_proof
except ImportError:  # direct script launch
    from voice_server import ConfigStore, SERVICE_NAME, PROTOCOL, VERSION, hmac_proof


def _apply_config_path(value: Optional[str]) -> None:
    if not value:
        return
    path = Path(value).expanduser()
    if path.name == "config.json":
        home = path.parent
    elif path.suffix:
        raise ValueError("--config must name a directory or a config.json file")
    else:
        home = path
    os.environ["OPENCODE_VOICE_HOME"] = str(home.resolve())


def _read_json_response(url: str, method: str = "GET", token: Optional[str] = None,
                        data: Optional[bytes] = None, headers: Optional[dict[str, str]] = None,
                        timeout: float = 5.0) -> tuple[int, dict[str, Any]]:
    req_headers = dict(headers or {})
    if token is not None:
        req_headers["Authorization"] = "Bearer " + token
    if data is not None:
        req_headers.setdefault("Content-Type", "application/json")
    request = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(128 * 1024)
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
            return response.status, parsed
    except urllib.error.HTTPError as exc:
        raw = exc.read(128 * 1024)
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            parsed = {}
        return exc.code, parsed


def health_challenge(port: int, token: str, timeout: float = 1.0) -> bool:
    challenge = secrets.token_urlsafe(24)
    url = f"http://127.0.0.1:{port}/health?challenge={urllib.parse.quote(challenge, safe='')}"
    status, response = _read_json_response(url, timeout=timeout)
    if status != 200:
        raise RuntimeError("the configured local port is occupied by an unverified service")
    if (response.get("service") != SERVICE_NAME or response.get("protocol") != PROTOCOL or
            response.get("version") != VERSION or not isinstance(response.get("proof"), str)):
        raise RuntimeError("the configured local port did not prove OpenCode Local Voice identity")
    expected = hmac_proof(token, challenge)
    if not hmac.compare_digest(response["proof"], expected):
        raise RuntimeError("the configured local port has a different voice-service token")
    return True


def ensure_server(store: ConfigStore) -> None:
    config = store.get()
    try:
        health_challenge(config["port"], store.token)
        return
    except urllib.error.URLError:
        pass
    except TimeoutError:
        pass
    env = os.environ.copy()
    env["OPENCODE_VOICE_HOME"] = str(store.home)
    script = Path(__file__).resolve().with_name("voice_server.py")
    log_path = store.home / "service.log"
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    log_fd = os.open(str(log_path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        with os.fdopen(log_fd, "ab", buffering=0) as log_file:
            subprocess.Popen([sys.executable, str(script), "--serve"], cwd=str(script.parent.parent),
                             env=env, stdin=subprocess.DEVNULL, stdout=log_file, stderr=subprocess.STDOUT,
                             close_fds=True, creationflags=flags)
    except OSError as exc:
        raise RuntimeError(f"could not start local voice service: {exc}") from exc
    deadline = time.monotonic() + 20.0
    last_connection_error: Optional[Exception] = None
    while time.monotonic() < deadline:
        try:
            health_challenge(config["port"], store.token, timeout=0.8)
            return
        except urllib.error.URLError as exc:
            last_connection_error = exc
        except TimeoutError as exc:
            last_connection_error = exc
        time.sleep(0.2)
    detail = f": {last_connection_error}" if last_connection_error else ""
    raise RuntimeError(f"local voice service did not become ready within 20 seconds{detail}; see {log_path}")


def _ffmpeg_input(mic: str) -> list[str]:
    if sys.platform == "win32":
        value = mic if mic.startswith("audio=") else "audio=" + mic
        return ["-f", "dshow", "-i", value]
    if sys.platform == "darwin":
        value = mic if mic.startswith(":") else ":" + mic
        return ["-f", "avfoundation", "-i", value]
    if sys.platform.startswith("linux"):
        return ["-f", "pulse", "-i", mic]
    raise RuntimeError(f"microphone recording is unsupported on {sys.platform}")


def _canonicalize_ffmpeg_wav(data: bytes) -> bytes:
    """Rewrite pipe WAV headers using the actual in-memory frame count.

    FFmpeg cannot seek back to patch RIFF lengths on stdout, so it often writes
    0x7fffffff in the data-size field. wave.open accepts that header but the
    voice protocol intentionally requires an exact, bounded frame count.
    """
    try:
        with wave.open(io.BytesIO(data), "rb") as source:
            if source.getframerate() != 16000 or source.getnchannels() != 1 or source.getsampwidth() != 2:
                raise RuntimeError("FFmpeg did not return 16kHz mono s16 audio")
            frames = source.readframes(source.getnframes())
    except (wave.Error, EOFError) as exc:
        raise RuntimeError("FFmpeg returned an invalid WAV stream") from exc
    if not frames or len(frames) % 2:
        raise RuntimeError("FFmpeg returned truncated WAV frame data")
    output = io.BytesIO()
    with wave.open(output, "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(16000)
        target.writeframes(frames)
    return output.getvalue()


def _run_ffmpeg(args: list[str], timeout: float, failure: str) -> bytes:
    try:
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError as exc:
        raise RuntimeError(f"FFmpeg was not found: {args[0]}") from exc
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        process.kill()
        process.communicate()
        raise RuntimeError("FFmpeg operation timed out") from exc
    except KeyboardInterrupt:
        process.kill()
        process.communicate()
        raise
    if process.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace")[-1200:].strip()
        raise RuntimeError(failure + (f": {detail}" if detail else ""))
    if not stdout:
        raise RuntimeError("FFmpeg returned no audio")
    return stdout


def _convert_audio(source: str, limit_seconds: int, ffmpeg: str) -> bytes:
    args = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-i", source,
            # The small headroom lets us detect (rather than silently truncate)
            # an over-limit input while keeping FFmpeg output bounded.
            "-t", f"{limit_seconds + 0.1:.1f}", "-vn", "-ac", "1", "-ar", "16000",
            "-acodec", "pcm_s16le", "-f", "wav", "pipe:1"]
    raw = _run_ffmpeg(args, timeout=max(60, limit_seconds * 5), failure="FFmpeg could not decode the audio")
    canonical = _canonicalize_ffmpeg_wav(raw)
    with wave.open(io.BytesIO(canonical), "rb") as wav:
        if wav.getnframes() > limit_seconds * wav.getframerate():
            raise RuntimeError(f"audio duration exceeds the configured {limit_seconds} second limit")
    return canonical


def _record_audio(mic: str, duration: float, ffmpeg: str) -> bytes:
    args = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", *_ffmpeg_input(mic),
            "-t", f"{duration:.3f}", "-vn", "-ac", "1", "-ar", "16000",
            "-acodec", "pcm_s16le", "-f", "wav", "pipe:1"]
    raw = _run_ffmpeg(args, timeout=max(30, duration + 10),
                      failure="FFmpeg could not record from that microphone")
    return _canonicalize_ffmpeg_wav(raw)


def _post_audio(port: int, token: str, wav_bytes: bytes, job_id: str) -> dict[str, Any]:
    url = f"http://127.0.0.1:{port}/v1/jobs"
    status, response = _read_json_response(url, method="POST", token=token, data=wav_bytes,
                                           headers={"Content-Type": "audio/wav", "X-Job-Id": job_id}, timeout=30)
    if status not in (200, 202):
        raise RuntimeError(response.get("error", f"voice service rejected audio ({status})"))
    return response


def _get_job(port: int, token: str, job_id: str) -> dict[str, Any]:
    url = f"http://127.0.0.1:{port}/v1/jobs/{urllib.parse.quote(job_id, safe='-')}"
    status, response = _read_json_response(url, token=token, timeout=5)
    if status != 200:
        raise RuntimeError(response.get("error", f"voice service returned HTTP {status}"))
    return response


def _cancel_job(port: int, token: str, job_id: str) -> None:
    url = f"http://127.0.0.1:{port}/v1/jobs/{urllib.parse.quote(job_id, safe='-')}"
    _read_json_response(url, method="DELETE", token=token, timeout=3)


def _submit_warmup(port: int, token: str) -> str:
    status, response = _read_json_response(f"http://127.0.0.1:{port}/v1/warmup", method="POST",
                                           token=token, data=b"{}", timeout=5)
    if status not in (200, 202) or not isinstance(response.get("id"), str):
        raise RuntimeError(response.get("error", f"warmup failed ({status})"))
    return response["id"]


def _wait_job(port: int, token: str, job_id: str, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while True:
        job = _get_job(port, token, job_id)
        if job["state"] in ("done", "error", "cancelled"):
            return job
        if time.monotonic() >= deadline:
            raise TimeoutError("recognition job timed out")
        time.sleep(0.25)


def transcribe(wav_bytes: bytes, store: ConfigStore, timeout: float = 180.0,
               warmup_job_id: Optional[str] = None) -> str:
    ensure_server(store)  # prove identity before sending bearer token or audio
    config = store.get()
    port = config["port"]
    job_id = str(uuid.uuid4())
    try:
        accepted = _post_audio(port, store.token, wav_bytes, job_id)
        if accepted["state"] in ("done", "error", "cancelled"):
            job = accepted
        else:
            job = _wait_job(port, store.token, job_id, timeout=timeout)
    except BaseException:
        try:
            _cancel_job(port, store.token, job_id)
        except Exception:
            pass
        if warmup_job_id:
            try:
                _cancel_job(port, store.token, warmup_job_id)
            except Exception:
                pass
        raise
    if job["state"] == "error":
        raise RuntimeError(job.get("error", "recognition failed"))
    if job["state"] == "cancelled":
        raise RuntimeError("recognition was cancelled")
    return str(job.get("text", ""))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OpenCode Local Voice CLI")
    parser.add_argument("--serve", action="store_true", help="run the local voice service")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--file", metavar="AUDIO", help="transcribe an audio file through FFmpeg")
    source.add_argument("--record", action="store_true", help="record and transcribe using FFmpeg")
    parser.add_argument("--duration", type=float, default=10.0, help="recording length in seconds (default: 10)")
    parser.add_argument("--timeout", type=float, default=180.0,
                        help="maximum wait for recognition after upload (default: 180 seconds)")
    parser.add_argument("--mic", help="FFmpeg input name/index; required with --record")
    parser.add_argument("--config", help="configuration directory or its config.json path")
    parser.add_argument("--ffmpeg", default=os.environ.get("FFMPEG", "ffmpeg"), help="FFmpeg executable")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        _apply_config_path(args.config)
        if args.serve:
            if args.file or args.record:
                parser.error("--serve cannot be combined with --file or --record")
            try:
                from .voice_server import serve
            except ImportError:
                from voice_server import serve
            serve()
            return 0
        if not args.file and not args.record:
            parser.error("choose --file AUDIO, --record, or --serve")
        if not math.isfinite(args.timeout) or args.timeout <= 0:
            parser.error("--timeout must be a finite number greater than 0")
        if args.record:
            if not args.mic:
                parser.error("--record requires --mic")
            if not math.isfinite(args.duration) or args.duration <= 0:
                parser.error("--duration must be a finite number greater than 0")
        else:
            source_path = Path(args.file).expanduser().resolve()
            if not source_path.is_file():
                raise RuntimeError(f"audio file does not exist: {source_path}")
        store = ConfigStore()
        config = store.get()
        if args.record and args.duration > config["max_seconds"]:
            parser.error(f"--duration must be greater than 0 and no more than {config['max_seconds']} seconds")
        ensure_server(store)
        warmup_job_id: Optional[str] = None
        if args.record:
            if config["warmup_on_record"]:
                warmup_job_id = _submit_warmup(config["port"], store.token)
            try:
                # Model loading and microphone capture overlap; submit the audio
                # immediately afterward so the single worker processes it next.
                wav_bytes = _record_audio(args.mic, args.duration, args.ffmpeg)
            except BaseException:
                if warmup_job_id:
                    try:
                        _cancel_job(config["port"], store.token, warmup_job_id)
                    except Exception:
                        pass
                raise
        else:
            wav_bytes = _convert_audio(str(source_path), config["max_seconds"], args.ffmpeg)
        try:
            text = transcribe(wav_bytes, store, timeout=args.timeout, warmup_job_id=warmup_job_id)
        except BaseException:
            if warmup_job_id:
                try:
                    _cancel_job(config["port"], store.token, warmup_job_id)
                except Exception:
                    pass
            raise
        sys.stdout.write(text + ("\n" if not text.endswith("\n") else ""))
        return 0
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(f"voice-cli: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
