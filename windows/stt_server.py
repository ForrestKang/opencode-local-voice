import glob
import json
import os
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

# Electron starts this service with redirected streams. Windows otherwise uses
# cp950, which cannot encode some simplified Chinese transcription results.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    except (AttributeError, OSError, ValueError):
        pass

LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stt_server.log")
_log_lock = threading.Lock()

_dll_handles = []


def setup_cuda_dlls():
    if sys.platform != "win32":
        return False
    try:
        import ctranslate2

        site_packages = os.path.dirname(os.path.dirname(ctranslate2.__file__))
        dirs = sorted(glob.glob(os.path.join(site_packages, "nvidia", "*", "bin")))
        for d in dirs:
            _dll_handles.append(os.add_dll_directory(d))  # noqa: F821 (Windows only)
        if dirs:
            os.environ["PATH"] = ";".join(dirs) + ";" + os.environ.get("PATH", "")
        return bool(dirs)
    except Exception:
        return False

MODEL_DIR = os.environ.get("OPENCODE_WHISPER_MODEL_DIR") or os.path.join(
    os.environ.get("USERPROFILE") or os.path.expanduser("~"),
    ".config",
    "opencode",
    "whisper-models",
    "large-v3-turbo",
)
IDLE_TIMEOUT_SEC = int(os.environ.get("OPENCODE_WHISPER_IDLE_SEC") or "1800")
_last_request = time.time()
_model = None
_lock = threading.Lock()


def log(msg):
    # Diagnostics must never turn a successful recognition into HTTP 500.
    line = "[stt] %s" % msg
    try:
        with _log_lock:
            if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > 1048576:
                os.replace(LOG_PATH, LOG_PATH + ".1")
            with open(LOG_PATH, "a", encoding="utf-8") as output:
                output.write(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " " + line + "\n")
    except Exception:
        pass
    try:
        print(line, flush=True)
    except (OSError, UnicodeError, ValueError):
        pass


def read_wav16k(path):
    with wave.open(path, "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("expected 16kHz mono s16 wav")
        data = w.readframes(w.getnframes())
    return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0


def get_model():
    global _model
    with _lock:
        if _model is None:
            has_cuda_libs = setup_cuda_dlls()
            from faster_whisper import WhisperModel

            prefer = (os.environ.get("OPENCODE_STT_DEVICE") or "auto").lower()
            env_threads = os.environ.get("OPENCODE_STT_THREADS")
            if env_threads:
                threads = int(env_threads)
            elif sys.platform == "darwin":
                threads = min(8, os.cpu_count() or 4)
            else:
                threads = min(16, os.cpu_count() or 4)
            attempts = []
            if prefer in ("auto", "cuda") and has_cuda_libs:
                attempts.append(("cuda", "float16"))
            if prefer in ("auto", "cpu") or not attempts:
                attempts.append(("cpu", "int8"))
                attempts.append(("cpu", "float32"))
            last_error = None
            for device, compute in attempts:
                try:
                    log("loading model from %s (device=%s, compute=%s) ..." % (MODEL_DIR, device, compute))
                    t0 = time.time()
                    kwargs = {"cpu_threads": threads} if device == "cpu" else {}
                    _model = WhisperModel(MODEL_DIR, device=device, compute_type=compute, **kwargs)
                    log("model loaded in %.1fs on %s" % (time.time() - t0, device))
                    break
                except Exception as exc:
                    last_error = exc
                    log("load on %s failed: %s" % (device, str(exc)[:200]))
            if _model is None:
                raise RuntimeError("failed to load model: %s" % last_error)
    return _model


CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Private-Network": "true",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        global _last_request
        _last_request = time.time()
        if self.path.split("?")[0] == "/health":
            self._json(200, {"ok": True, "model": MODEL_DIR, "language_mode": "auto"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        global _last_request
        _last_request = time.time()
        if self.path.split("?")[0] != "/inference":
            self._json(404, {"error": "not found"})
            return
        try:
            size = int(self.headers.get("Content-Length") or 0)
            data = self.rfile.read(size) if size else b""
            if not data:
                self._json(400, {"error": "empty body"})
                return
            # Always detect the spoken language. Older running desktop clients
            # still send X-Language: zh; that header must not force Chinese.
            fd, path = tempfile.mkstemp(suffix=".wav")
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            try:
                t0 = time.time()
                audio = read_wav16k(path)
                segments, info = get_model().transcribe(
                    audio,
                    language=None,
                    beam_size=5,
                    vad_filter=True,
                    condition_on_previous_text=False,
                )
                text = "".join(s.text for s in segments).strip()
                log(
                    "transcribed %.2fs audio in %.1fs (%d characters)"
                    % (getattr(info, "duration", 0), time.time() - t0, len(text))
                )
            finally:
                try:
                    os.unlink(path)
                except OSError:
                    pass
            self._json(200, {"text": text})
        except Exception as exc:
            log("inference failed: %s" % exc)
            self._json(500, {"error": str(exc)})


def idle_watchdog():
    while True:
        time.sleep(60)
        if time.time() - _last_request > IDLE_TIMEOUT_SEC:
            log("idle timeout, exiting")
            os._exit(0)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("OPENCODE_STT_LOCAL_PORT") or "47832")
    log("loading model ...")
    get_model()
    threading.Thread(target=idle_watchdog, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    log("listening on 127.0.0.1:%d" % port)
    server.serve_forever()


if __name__ == "__main__":
    main()
