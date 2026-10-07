"""Protocol, security, queue, cancellation, and process-isolation tests."""
from __future__ import annotations

import json
import multiprocessing
import os
import queue
import socket
import tempfile
import threading
import time
import unittest
import uuid
import wave
import io
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import ModuleType, SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shared import voice_cli, voice_server
from shared.voice_server import (ConfigError, ConfigStore, Coordinator, MlxWhisperEngine,
                                 ProcessWorker, create_server, decode_wav16k, hmac_proof)
from shared.voice_cli import _canonicalize_ffmpeg_wav


BLOCK_MODE = False
BLOCK_STARTED = threading.Event()
BLOCK_RELEASE = threading.Event()
LAST_TERMINATED = False


class QuickFakeWorker:
    """Thread backed stand-in implementing ProcessWorker's tiny public surface."""
    def __init__(self, config):
        self.in_queue = queue.Queue()
        self.out_queue = queue.Queue()
        self.stopped = False
        self.block = BLOCK_MODE
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def submit(self, task):
        self.in_queue.put(task)

    def _run(self):
        while True:
            task = self.in_queue.get()
            if task is None:
                return
            self.out_queue.put({"type": "state", "id": task["id"], "state": "loading"})
            self.out_queue.put({"type": "state", "id": task["id"], "state": "transcribing"})
            if self.block:
                BLOCK_STARTED.set()
                BLOCK_RELEASE.wait(5)
            self.out_queue.put({
                "type": "result", "id": task["id"], "state": "done",
                "text": "fake transcript", "backend": "fake", "device": "cpu",
                "timings": {"queue_seconds": 0.0, "load_seconds": 0.0,
                            "inference_seconds": 0.01, "total_seconds": 0.01, "audio_seconds": 0.1},
            })

    def poll(self, timeout=0.1):
        try:
            return self.out_queue.get(timeout=timeout)
        except queue.Empty:
            return None

    def stop(self, terminate=False):
        global LAST_TERMINATED
        LAST_TERMINATED = bool(terminate)
        self.stopped = terminate
        BLOCK_RELEASE.set()
        try:
            self.in_queue.put_nowait(None)
        except queue.Full:
            pass
        self.thread.join(timeout=1)


def fake_mp_worker(config, in_queue, out_queue):
    """Importable multiprocessing target; the PID proves one persistent child."""
    pid = os.getpid()
    while True:
        task = in_queue.get()
        if task is None:
            return
        out_queue.put({"type": "state", "id": task["id"], "state": "loading"})
        out_queue.put({"type": "state", "id": task["id"], "state": "transcribing"})
        out_queue.put({
            "type": "result", "id": task["id"], "state": "done",
            "text": f"fake-pid:{pid}", "backend": "fake-process", "device": "cpu",
            "timings": {"queue_seconds": 0.0, "load_seconds": 0.0,
                        "inference_seconds": 0.0, "total_seconds": 0.0, "audio_seconds": 0.1},
        })


FAKE_ENGINE_LOADS = 0


class InjectedFakeBackend:
    backend = "injected-fake"
    device = "cpu"

    def __init__(self, config, load_index):
        self.config = config
        self.load_index = load_index

    def transcribe(self, audio):
        return (f"load:{self.load_index};pid:{os.getpid()};language:{self.config['language']};"
                f"beam:{self.config['beam_size']};prompt:{self.config['initial_prompt']}"), "en"


def injected_fake_backend_factory(config):
    global FAKE_ENGINE_LOADS
    FAKE_ENGINE_LOADS += 1
    return InjectedFakeBackend(config, FAKE_ENGINE_LOADS)


class SlowRewriteHandler(BaseHTTPRequestHandler):
    started = threading.Event()
    release = threading.Event()
    block = False
    response_text = "rewritten output"

    def do_POST(self):
        if self.headers.get("Content-Length"):
            self.rfile.read(int(self.headers["Content-Length"]))
        type(self).started.set()
        if type(self).block:
            type(self).release.wait(10)
        payload = json.dumps({"choices": [{"message": {"content": type(self).response_text}}]}).encode()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *_args):
        return


def wav16(seconds=0.1):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\0\0" * round(seconds * 16000))
    return output.getvalue()


class VoiceServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = ConfigStore(Path(self.temp.name) / "voice-home")
        self.store.update({"allowed_origins": ["http://localhost:4000"], "max_seconds": 5})
        self.coordinator = Coordinator(self.store.get(), worker_factory=QuickFakeWorker,
                                       result_ttl=20, tombstone_ttl=5)
        self.server = create_server(store=self.store, coordinator=self.coordinator, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.coordinator.close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def request(self, path, method="GET", token=None, body=None, headers=None):
        request_headers = dict(headers or {})
        if token is not None:
            request_headers["Authorization"] = "Bearer " + token
        request = Request(self.base + path, data=body, headers=request_headers, method=method)
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))
        with response:
            raw = response.read()
            return response.status, json.loads(raw.decode("utf-8")) if raw else {}

    def test_health_challenge_and_authentication_boundaries(self):
        challenge = "test-challenge-0123456789"
        status, health = self.request(f"/health?challenge={challenge}")
        self.assertEqual(status, 200)
        self.assertEqual(health["proof"], hmac_proof(self.store.token, challenge))
        self.assertNotIn("model_path", health)
        self.assertNotIn(self.store.token, json.dumps(health))

        status, _ = self.request("/v1/config")
        self.assertEqual(status, 401)
        status, _ = self.request("/v1/config", token=self.store.token,
                                 headers={"Origin": "https://attacker.invalid"})
        self.assertEqual(status, 403)
        status, config = self.request("/v1/config", token=self.store.token,
                                      headers={"Origin": "http://localhost:4000"})
        self.assertEqual(status, 200)
        self.assertIn("model_path", config)
        self.assertFalse(config["rewrite_key_configured"])
        self.assertNotIn("token", config)

    def test_rejected_requests_do_not_keep_idle_service_alive(self):
        stale_access = time.monotonic() - 120
        self.server.app.last_access = stale_access
        status, _ = self.request("/v1/config")
        self.assertEqual(status, 401)
        self.assertEqual(self.server.app.last_access, stale_access)
        status, _ = self.request("/v1/config", token=self.store.token,
                                 headers={"Origin": "https://attacker.invalid"})
        self.assertEqual(status, 403)
        self.assertEqual(self.server.app.last_access, stale_access)

    def test_jobs_http_protocol_and_status_redaction(self):
        job_id = str(uuid.uuid4())
        status, accepted = self.request("/v1/jobs", method="POST", token=self.store.token,
                                        body=wav16(), headers={"X-Job-Id": job_id, "Content-Type": "audio/wav"})
        self.assertEqual(status, 202)
        self.assertEqual(accepted, {"id": job_id, "state": "queued"})
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            status, job = self.request(f"/v1/jobs/{job_id}", token=self.store.token)
            if job["state"] == "done":
                break
            time.sleep(0.02)
        self.assertEqual(status, 200)
        self.assertEqual(job["text"], "fake transcript")
        self.assertEqual(job["raw_text"], "fake transcript")
        self.assertEqual(job["local_text"], "fake transcript")
        self.assertIn("inference_seconds", job["timings"])

        status, current = self.request("/v1/status", token=self.store.token)
        self.assertEqual(status, 200)
        self.assertEqual(current["model_state"], "ready")
        self.assertNotIn("text", current)
        self.assertNotIn("model_path", current)
        self.assertNotIn(self.store.token, json.dumps(current))

    def test_rewrite_key_is_write_only_and_text_settings_do_not_reload_worker(self):
        warmup = self.coordinator.enqueue_warmup()
        self.assertEqual(self.coordinator.wait(warmup.id, timeout=3)["state"], "done")
        worker_before = self.coordinator.worker
        self.assertIsNotNone(worker_before)

        secret = "private-rewrite-key-value"
        body = json.dumps({"rewrite_api_key": secret, "text_mode": "ai",
                           "rewrite_base_url": "https://rewrite.example/v1",
                           "rewrite_model": "model-a"}).encode()
        status, updated = self.request("/v1/config", method="PATCH", token=self.store.token,
                                       body=body, headers={"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertTrue(updated["rewrite_key_configured"])
        self.assertNotIn(secret, json.dumps(updated))
        self.assertNotIn("rewrite_api_key", updated)
        self.assertEqual(self.store.get_rewrite_api_key(), secret)
        self.assertNotIn("rewrite_api_key", self.store.get())
        self.assertNotIn("rewrite_api_key", json.loads(self.store.config_path.read_text(encoding="utf-8")))
        key_file = self.store.rewrite_key_path.read_bytes()
        if os.name == "nt":
            self.assertTrue(key_file.startswith(b"DPAPI1:"))
            self.assertNotIn(secret.encode(), key_file)
        else:
            self.assertEqual(key_file.decode().strip(), secret)
            self.assertEqual(self.store.rewrite_key_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.coordinator.rewrite_api_key, secret)
        self.assertIs(self.coordinator.worker, worker_before,
                      "text and credential changes must not reload the persistent speech model")

        status, current = self.request("/v1/config", token=self.store.token)
        self.assertEqual(status, 200)
        self.assertTrue(current["rewrite_key_configured"])
        self.assertNotIn(secret, json.dumps(current))
        status, current = self.request("/v1/status", token=self.store.token)
        self.assertEqual(status, 200)
        self.assertNotIn(secret, json.dumps(current))

        status, cleared = self.request("/v1/config", method="PATCH", token=self.store.token,
                                       body=b'{"rewrite_api_key":""}',
                                       headers={"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertFalse(cleared["rewrite_key_configured"])
        self.assertFalse(self.store.rewrite_key_path.exists())

    def test_legacy_plaintext_key_and_experimental_bindings_are_migrated(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp) / "voice-home"
            home.mkdir()
            old_key = "legacy-secret-to-migrate"
            old_config = voice_server._default_config()
            old_config["shortcuts"] = {"toggle": "Ctrl+K"}
            old_config["rewrite_api_key"] = old_key
            (home / "config.json").write_text(json.dumps(old_config), encoding="utf-8")
            store = ConfigStore(home)
            self.assertEqual(store.get_rewrite_api_key(), old_key)
            disk_config = json.loads(store.config_path.read_text(encoding="utf-8"))
            self.assertNotIn("rewrite_api_key", disk_config)
            self.assertNotIn("shortcuts", disk_config)
            self.assertTrue(store.public()["rewrite_key_configured"])
            protected = store.rewrite_key_path.read_bytes()
            if os.name == "nt":
                self.assertTrue(protected.startswith(b"DPAPI1:"))
                self.assertNotIn(old_key.encode(), protected)
            else:
                self.assertEqual(protected.decode().strip(), old_key)
                self.assertEqual(store.rewrite_key_path.stat().st_mode & 0o777, 0o600)

    def test_legacy_separate_plaintext_key_is_upgraded_on_read(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp) / "voice-home"
            home.mkdir()
            key = "plain-key-from-previous-install"
            (home / "rewrite_api_key").write_text(key + "\n", encoding="utf-8")
            store = ConfigStore(home)
            self.assertEqual(store.get_rewrite_api_key(), key)
            data = store.rewrite_key_path.read_bytes()
            if os.name == "nt":
                self.assertTrue(data.startswith(b"DPAPI1:"))
                self.assertNotIn(key.encode(), data)
            else:
                self.assertEqual(data.decode().strip(), key)
                self.assertEqual(store.rewrite_key_path.stat().st_mode & 0o777, 0o600)

    def test_text_preview_is_authenticated_request_local_and_ai_only_when_selected(self):
        status, _ = self.request("/v1/text", method="POST", body=b'{"text":"hello"}')
        self.assertEqual(status, 401)
        status, _ = self.request("/v1/text", method="POST", token=self.store.token,
                                 body=b'{"text":"hello"}', headers={"Origin": "https://bad.test"})
        self.assertEqual(status, 403)

        body = json.dumps({"text": "  hello   world ", "config": {
            "text_mode": "clean", "punctuation_mode": "none", "space_mode": "preserve"
        }}).encode()
        with patch.object(voice_server.voice_text, "rewrite_text", side_effect=AssertionError("clean preview must be local")):
            status, result = self.request("/v1/text", method="POST", token=self.store.token,
                                          body=body, headers={"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(result["raw_text"], "  hello   world ")
        self.assertEqual(result["local_text"], "hello   world")
        self.assertEqual(result["text"], "hello   world")
        self.assertIn("local_seconds", result["timings"])
        self.assertEqual(self.store.get()["text_mode"], "clean", "preview overrides must not persist")

        secret = "request-only-secret"
        ai_body = json.dumps({"text": "say the result", "rewrite_api_key": secret,
                              "config": {"text_mode": "ai", "rewrite_base_url": "https://api.test/v1",
                                         "rewrite_model": "mock"}}).encode()
        with patch.object(voice_server.voice_text, "rewrite_text",
                          return_value=("optimized text", None)) as rewrite:
            status, result = self.request("/v1/text", method="POST", token=self.store.token,
                                          body=ai_body, headers={"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(result["text"], "optimized text")
        self.assertEqual(result["local_text"], "say the result")
        self.assertEqual(rewrite.call_args.kwargs["api_key"], secret)
        self.assertNotIn(secret, json.dumps(result))
        self.assertFalse(self.store.public()["rewrite_key_configured"])

    def test_rewrite_test_uses_fixed_sentence_and_preview_limit_is_bounded(self):
        body = json.dumps({"config": {"rewrite_base_url": "https://api.test/v1",
                                       "rewrite_model": "mock"}}).encode()
        with patch.object(voice_server.voice_text, "rewrite_text",
                          return_value=("tested", None)) as rewrite:
            status, result = self.request("/v1/rewrite/test", method="POST", token=self.store.token,
                                          body=body, headers={"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(result, {"ok": True, "message": "AI 改写连接成功。"})
        fixed = rewrite.call_args.args[0]
        self.assertEqual(fixed, "This is a local voice rewriting connection test. Keep the meaning and return only the text.")

        self.server.app._preview_slots.acquire()
        self.server.app._preview_slots.acquire()
        try:
            status, result = self.request("/v1/text", method="POST", token=self.store.token,
                                          body=b'{"text":"hello"}',
                                          headers={"Content-Type": "application/json"})
            self.assertEqual(status, 429)
            self.assertEqual(result["code"], "preview_busy")
        finally:
            self.server.app._preview_slots.release()
            self.server.app._preview_slots.release()

    def test_use_local_endpoint_requires_rewriting_result_and_returns_local_done_job(self):
        job_id = str(uuid.uuid4())
        job = voice_server.Job(job_id, b"unused")
        with self.coordinator._condition:
            job.state = "rewriting"
            job.raw_text = "recognized words"
            job.local_text = "formatted words"
            job.timings = {"local_seconds": 0.01}
            self.coordinator.jobs[job_id] = job
            self.coordinator.active_id = job_id

        status, denied = self.request(f"/v1/jobs/{job_id}/use-local", method="POST",
                                      body=b"{}", headers={"Content-Type": "application/json"})
        self.assertEqual(status, 401)
        self.assertEqual(denied["code"], "unauthorized")
        status, done = self.request(f"/v1/jobs/{job_id}/use-local", method="POST",
                                    token=self.store.token, body=b"{}",
                                    headers={"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(done["state"], "done")
        self.assertEqual(done["raw_text"], "recognized words")
        self.assertEqual(done["local_text"], "formatted words")
        self.assertEqual(done["text"], "formatted words")
        self.assertEqual(done["timings"]["rewrite_seconds"], 0.0)
        status, unavailable = self.request(f"/v1/jobs/{job_id}/use-local", method="POST",
                                           token=self.store.token, body=b"{}",
                                           headers={"Content-Type": "application/json"})
        self.assertEqual(status, 409)
        self.assertEqual(unavailable["code"], "local_result_unavailable")

    def test_audio_duration_limit_and_cancel_before_upload_tombstone(self):
        too_long = str(uuid.uuid4())
        status, error = self.request("/v1/jobs", method="POST", token=self.store.token,
                                     body=wav16(5.1), headers={"X-Job-Id": too_long})
        self.assertEqual(status, 400)
        self.assertIn("duration", error["error"])

        before_upload = str(uuid.uuid4())
        status, cancelled = self.request(f"/v1/jobs/{before_upload}", method="DELETE", token=self.store.token)
        self.assertEqual(status, 200)
        self.assertEqual(cancelled["state"], "cancelled")
        status, result = self.request("/v1/jobs", method="POST", token=self.store.token,
                                      body=wav16(), headers={"X-Job-Id": before_upload})
        self.assertEqual(status, 202)
        self.assertEqual(result["state"], "cancelled")

    def test_unchanged_config_patch_during_job_is_safe_and_successful(self):
        global BLOCK_MODE
        BLOCK_MODE = True
        BLOCK_STARTED.clear()
        BLOCK_RELEASE.clear()
        before = self.store.config_path.read_bytes()
        try:
            job_id = str(uuid.uuid4())
            status, _ = self.request("/v1/jobs", method="POST", token=self.store.token,
                                     body=wav16(), headers={"X-Job-Id": job_id})
            self.assertEqual(status, 202)
            self.assertTrue(BLOCK_STARTED.wait(2))
            worker = self.coordinator.worker
            status, config = self.request("/v1/config", method="PATCH", token=self.store.token,
                                           body=json.dumps({"beam_size": self.store.get()["beam_size"]}).encode(),
                                           headers={"Content-Type": "application/json"})
            self.assertEqual(status, 200, config)
            self.assertEqual(self.store.config_path.read_bytes(), before)
            self.assertIs(self.coordinator.worker, worker)
            self.assertTrue(self.coordinator.has_live_jobs())
            self.assertFalse(worker.stopped)
        finally:
            BLOCK_MODE = False
            BLOCK_RELEASE.set()

    def test_config_patch_is_rejected_during_active_job_and_port_is_fixed(self):
        global BLOCK_MODE, LAST_TERMINATED
        BLOCK_MODE = True
        LAST_TERMINATED = False
        BLOCK_STARTED.clear()
        BLOCK_RELEASE.clear()
        try:
            job_id = str(uuid.uuid4())
            status, _ = self.request("/v1/jobs", method="POST", token=self.store.token,
                                     body=wav16(), headers={"X-Job-Id": job_id})
            self.assertEqual(status, 202)
            self.assertTrue(BLOCK_STARTED.wait(2))
            next_id = str(uuid.uuid4())
            status, queued = self.request("/v1/jobs", method="POST", token=self.store.token,
                                          body=wav16(), headers={"X-Job-Id": next_id})
            self.assertEqual(status, 202)
            self.assertEqual(queued["state"], "queued")
            status, conflict = self.request("/v1/config", method="PATCH", token=self.store.token,
                                            body=json.dumps({"beam_size": 2}).encode(),
                                            headers={"Content-Type": "application/json"})
            self.assertEqual(status, 409)
            self.assertIn("active", conflict["error"])
            status, conflict = self.request("/v1/config", method="PATCH", token=self.store.token,
                                            body=b'{"port":47833}',
                                            headers={"Content-Type": "application/json"})
            self.assertEqual(status, 409)
            status, cancelled = self.request(f"/v1/jobs/{job_id}", method="DELETE", token=self.store.token)
            self.assertEqual(status, 200)
            self.assertEqual(cancelled["state"], "cancelled")
            self.assertTrue(LAST_TERMINATED)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                following = self.coordinator.get(next_id)
                if following and following["state"] == "done":
                    break
                time.sleep(0.02)
            self.assertEqual(following["state"], "done", "cancelling one job must keep other clients' queued work")
            self.assertEqual(self.coordinator.queue_depth(), 0)
        finally:
            BLOCK_RELEASE.set()
            BLOCK_MODE = False

    def test_config_write_failure_preserves_disk_and_runtime_state(self):
        original = self.store.get()
        with patch.object(self.store, "_write_atomic", side_effect=OSError("disk full")):
            status, response = self.request("/v1/config", method="PATCH", token=self.store.token,
                                            body=b'{"beam_size":2}',
                                            headers={"Content-Type": "application/json"})
        self.assertEqual(status, 500)
        self.assertEqual(response["code"], "config_write_failed")
        self.assertEqual(self.store.get(), original)
        self.assertEqual(json.loads(self.store.config_path.read_text(encoding="utf-8")), original)
        self.assertEqual(self.coordinator.config, original)

    def test_config_commit_serializes_job_post_until_after_persistence(self):
        write_entered = threading.Event()
        allow_write = threading.Event()
        enqueue_arrived = threading.Event()
        allow_enqueue = threading.Event()
        patch_result = {}
        post_result = {}
        failures = []
        original_write = self.store._write_atomic
        original_enqueue = self.coordinator.enqueue

        def blocked_write(config):
            write_entered.set()
            if not allow_write.wait(3):
                raise OSError("test write gate timed out")
            original_write(config)

        def blocked_enqueue(*args, **kwargs):
            enqueue_arrived.set()
            if not allow_enqueue.wait(3):
                raise RuntimeError("test enqueue gate timed out")
            return original_enqueue(*args, **kwargs)

        def send_patch():
            try:
                patch_result["value"] = self.request("/v1/config", method="PATCH", token=self.store.token,
                                                      body=b'{"beam_size":2}',
                                                      headers={"Content-Type": "application/json"})
            except BaseException as exc:
                failures.append(exc)

        job_id = str(uuid.uuid4())

        def send_job():
            try:
                post_result["value"] = self.request("/v1/jobs", method="POST", token=self.store.token,
                                                     body=wav16(), headers={"X-Job-Id": job_id})
            except BaseException as exc:
                failures.append(exc)

        with patch.object(self.store, "_write_atomic", side_effect=blocked_write), \
                patch.object(self.coordinator, "enqueue", side_effect=blocked_enqueue):
            post_thread = threading.Thread(target=send_job)
            post_thread.start()
            patch_thread = threading.Thread(target=send_patch)
            try:
                self.assertTrue(enqueue_arrived.wait(2), "POST did not reach coordinator enqueue")
                patch_thread.start()
                self.assertTrue(write_entered.wait(2), "PATCH did not reach persistence")
                allow_enqueue.set()
                time.sleep(0.1)
                self.assertNotIn("value", post_result, "POST must wait behind the config commit lock")
            finally:
                allow_enqueue.set()
                allow_write.set()
                if patch_thread.ident is not None:
                    patch_thread.join(timeout=3)
                post_thread.join(timeout=3)

        self.assertFalse(patch_thread.is_alive())
        self.assertFalse(post_thread.is_alive())
        self.assertFalse(failures, failures)
        self.assertEqual(patch_result["value"][0], 200)
        self.assertEqual(post_result["value"][0], 202)
        self.assertEqual(self.store.get()["beam_size"], 2)
        self.assertEqual(self.coordinator.config["beam_size"], 2)

    def test_shutdown_rejects_unknown_token_and_busy_service(self):
        global BLOCK_MODE, BLOCK_STARTED, BLOCK_RELEASE
        status, response = self.request("/v1/shutdown", method="POST", token="A" * 43, body=b"")
        self.assertEqual(status, 401)
        self.assertEqual(response["code"], "unauthorized")
        self.assertTrue(self.thread.is_alive())
        status, response = self.request("/v1/shutdown", method="POST", token=self.store.token, body=b"{}")
        self.assertEqual(status, 400)
        self.assertEqual(response["error"], "shutdown request body must be empty")
        self.assertTrue(self.thread.is_alive())

        BLOCK_MODE = True
        BLOCK_STARTED.clear()
        BLOCK_RELEASE.clear()
        try:
            job_id = str(uuid.uuid4())
            status, _ = self.request("/v1/jobs", method="POST", token=self.store.token,
                                     body=wav16(), headers={"X-Job-Id": job_id})
            self.assertEqual(status, 202)
            self.assertTrue(BLOCK_STARTED.wait(2))
            status, response = self.request("/v1/shutdown", method="POST", token=self.store.token, body=b"")
            self.assertEqual(status, 409)
            self.assertEqual(response, {"error": "service is busy", "code": "conflict"})
            self.assertTrue(self.thread.is_alive())
            self.request(f"/v1/jobs/{job_id}", method="DELETE", token=self.store.token)
        finally:
            BLOCK_RELEASE.set()
            BLOCK_MODE = False

    def test_idle_shutdown_sends_response_then_stops_listener(self):
        status, response = self.request("/v1/shutdown", method="POST", token=self.store.token, body=b"")
        self.assertEqual(status, 202)
        self.assertEqual(response, {"status": "shutting_down"})
        self.thread.join(timeout=3)
        self.assertFalse(self.thread.is_alive(), "shutdown must run outside the response handler")
        address = self.server.server_address
        self.server.server_close()
        with self.assertRaises(OSError):
            socket.create_connection(address, timeout=0.2)


class ConfigAndWorkerTests(unittest.TestCase):
    def test_first_run_migrates_legacy_environment_atomically_and_hides_token(self):
        with tempfile.TemporaryDirectory() as temp:
            model = str(Path(temp) / "local-model")
            env = {
                "OPENCODE_STT_LOCAL_PORT": "48001",
                "OPENCODE_WHISPER_MODEL_DIR": model,
                "OPENCODE_STT_DEVICE": "cpu",
                "OPENCODE_STT_BEAM": "3",
            }
            old = {key: os.environ.get(key) for key in env}
            os.environ.update(env)
            try:
                store = ConfigStore(Path(temp) / "state")
            finally:
                for key, value in old.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value
            config = json.loads(store.config_path.read_text(encoding="utf-8"))
            self.assertEqual(config["port"], 48001)
            self.assertEqual(config["model_path"], model)
            self.assertEqual(config["device"], "cpu")
            self.assertEqual(config["beam_size"], 3)
            self.assertNotIn("token", config)
            self.assertGreaterEqual(len(store.token), 40)
            if os.name != "nt":
                self.assertEqual(store.token_path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(store.config_path.stat().st_mode & 0o777, 0o600)

    def test_corrupt_existing_token_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp) / "voice-home"
            home.mkdir()
            (home / "token").write_text("broken\n", encoding="ascii")
            with self.assertRaises(ConfigError):
                ConfigStore(home)

    def test_config_store_accepts_string_home_and_port_range_matches_clients(self):
        with tempfile.TemporaryDirectory() as temp:
            store = ConfigStore(str(Path(temp) / "voice-home"))
            with self.assertRaises(ConfigError):
                store.update({"port": 1023})
            self.assertEqual(store.get()["port"], 47832)

    def test_faster_whisper_receives_bounded_vocabulary_prompt_and_hotwords(self):
        captured = {}

        class Model:
            def transcribe(self, _audio, **kwargs):
                captured.update(kwargs)
                return [SimpleNamespace(text=" recognized")], SimpleNamespace(language="en")

        config = voice_server._default_config()
        config["initial_prompt"] = "Context"
        config["vocabulary"] = ["CustomFramework"]
        engine = voice_server.FasterWhisperEngine.__new__(voice_server.FasterWhisperEngine)
        engine.config = config
        engine.model = Model()
        text, language = engine._transcribe_once(object())
        self.assertEqual((text, language), ("recognized", "en"))
        self.assertTrue(captured["initial_prompt"].startswith("Context."))
        self.assertIn("OpenCode", captured["initial_prompt"])
        self.assertIn("CustomFramework", captured["hotwords"])
        self.assertLessEqual(len(captured["initial_prompt"]), 1900)

    def test_mlx_043_greedy_omits_unsupported_beam_option(self):
        captured = {}

        def fake_transcribe(audio, **kwargs):
            captured.update(kwargs)
            return {"text": "mlx fake", "language": "en"}

        with tempfile.TemporaryDirectory() as temp:
            config = ConfigStore(Path(temp) / "voice-home").get()
            config.update({"backend": "mlx", "device": "auto", "model_path": temp, "beam_size": 1})
            mlx_module = ModuleType("mlx")
            mlx_module.__path__ = []
            mlx_core = ModuleType("mlx.core")
            mlx_core.float16 = "float16"
            mlx_whisper = ModuleType("mlx_whisper")
            mlx_whisper.__path__ = []
            mlx_whisper.transcribe = fake_transcribe
            load_models = ModuleType("mlx_whisper.load_models")
            load_models.load_model = lambda model_path, dtype: (model_path, dtype)
            transcribe_module = ModuleType("mlx_whisper.transcribe")
            transcribe_module.ModelHolder = type("ModelHolder", (), {"model": None, "model_path": None})
            with patch.dict(sys.modules, {
                    "mlx": mlx_module, "mlx.core": mlx_core,
                    "mlx_whisper": mlx_whisper,
                    "mlx_whisper.load_models": load_models,
                    "mlx_whisper.transcribe": transcribe_module,
            }):
                engine = MlxWhisperEngine(config)
                text, language = engine.transcribe(object())
                self.assertEqual((text, language), ("mlx fake", "en"))
                self.assertNotIn("beam_size", captured)
                self.assertEqual(engine.device, "metal")
                engine.config = {**config, "beam_size": 2}
                with self.assertRaisesRegex(RuntimeError, "greedy decoding only"):
                    engine.transcribe(object())

    def test_windows_cuda_runtime_uses_only_venv_nvidia_dll_dirs_and_keeps_handles(self):
        with tempfile.TemporaryDirectory() as temp:
            prefix = Path(temp) / "venv"
            site_packages = prefix / "Lib" / "site-packages"
            cublas = site_packages / "nvidia" / "cublas" / "bin"
            cudnn = site_packages / "nvidia" / "cudnn" / "bin"
            for directory in (cublas, cudnn):
                directory.mkdir(parents=True)
                (directory / "runtime.dll").touch()
            handles = []
            registered = []
            with patch.object(voice_server.sys, "prefix", str(prefix)), \
                    patch.object(voice_server.sys, "platform", "win32"), \
                    patch.object(voice_server.sysconfig, "get_path", return_value=str(site_packages)), \
                    patch.dict(os.environ, {"PATH": "original-path"}), \
                    patch.object(voice_server.os, "add_dll_directory", create=True,
                                 side_effect=lambda path: registered.append(path) or object()), \
                    patch.object(voice_server, "_CUDA_RUNTIME_HANDLES", handles), \
                    patch.object(voice_server, "_CUDA_RUNTIME_REGISTERED_DIRS", set()):
                found = voice_server._prepare_cuda_runtime()
                self.assertEqual(found, [cublas, cudnn])
                self.assertEqual(registered, [str(cublas), str(cudnn)])
                self.assertEqual(len(handles), 2)
                self.assertEqual(os.environ["PATH"].split(os.pathsep)[:2], [str(cublas), str(cudnn)])

    def test_linux_cuda_runtime_preloads_venv_shared_libraries_by_absolute_path(self):
        with tempfile.TemporaryDirectory() as temp:
            site_packages = Path(temp) / "site-packages"
            cublas = site_packages / "nvidia" / "cublas" / "lib" / "libcublas.so.12"
            cudnn = site_packages / "nvidia" / "cudnn" / "lib" / "libcudnn.so.9"
            cublas.parent.mkdir(parents=True)
            cudnn.parent.mkdir(parents=True)
            cublas.touch()
            cudnn.touch()
            calls = []
            with patch.object(voice_server, "_python_venv_site_packages", return_value=site_packages), \
                    patch.object(voice_server.sys, "platform", "linux"), \
                    patch.object(voice_server.ctypes, "CDLL",
                                 side_effect=lambda path, mode: calls.append((path, mode)) or object()), \
                    patch.object(voice_server, "_CUDA_RUNTIME_HANDLES", []), \
                    patch.object(voice_server, "_CUDA_RUNTIME_PRELOADED", set()):
                found = voice_server._prepare_cuda_runtime()
            self.assertEqual(found, [cublas.parent, cudnn.parent])
            self.assertEqual([path for path, _mode in calls], [str(cublas.resolve()), str(cudnn.resolve())])
            self.assertTrue(all(Path(path).is_absolute() for path, _mode in calls))

    def test_cli_record_submits_warmup_before_capture_and_cancels_if_capture_is_interrupted(self):
        with tempfile.TemporaryDirectory() as temp:
            events = []
            output = io.StringIO()
            with patch.dict(os.environ, {"OPENCODE_VOICE_HOME": str(Path(temp) / "voice-home")}), \
                    patch.object(voice_cli, "ensure_server", side_effect=lambda store: events.append("health")), \
                    patch.object(voice_cli, "_submit_warmup",
                                 side_effect=lambda port, token: events.append("warmup") or "warmup-1"), \
                    patch.object(voice_cli, "_record_audio",
                                 side_effect=lambda *args: events.append("capture") or b"wav"), \
                    patch.object(voice_cli, "transcribe",
                                 side_effect=lambda wav, store, **kwargs: events.append(("submit", kwargs)) or "ok"), \
                    patch.object(voice_cli.sys, "stdout", output):
                result = voice_cli.main(["--record", "--mic", "fake", "--duration", "0.1", "--timeout", "12"])
            self.assertEqual(result, 0)
            self.assertEqual(events[:3], ["health", "warmup", "capture"])
            self.assertEqual(events[3][0], "submit")
            self.assertEqual(events[3][1]["timeout"], 12.0)
            self.assertEqual(events[3][1]["warmup_job_id"], "warmup-1")
            self.assertEqual(output.getvalue(), "ok\n")

            events.clear()
            with patch.dict(os.environ, {"OPENCODE_VOICE_HOME": str(Path(temp) / "voice-home")}), \
                    patch.object(voice_cli, "ensure_server"), \
                    patch.object(voice_cli, "_submit_warmup", return_value="warmup-2"), \
                    patch.object(voice_cli, "_record_audio", side_effect=KeyboardInterrupt), \
                    patch.object(voice_cli, "_cancel_job", side_effect=lambda *args: events.append(args)):
                result = voice_cli.main(["--record", "--mic", "fake", "--duration", "0.1"])
            self.assertEqual(result, 130)
            self.assertEqual(events, [(47832, ConfigStore(Path(temp) / "voice-home").token, "warmup-2")])

    def test_cli_file_conversion_bounds_probe_audio_and_rejects_long_files(self):
        with patch.object(voice_cli, "_run_ffmpeg", return_value=wav16(5.1)) as run_ffmpeg:
            with self.assertRaisesRegex(RuntimeError, "exceeds the configured 5 second limit"):
                voice_cli._convert_audio("input.wav", 5, "ffmpeg")
            args = run_ffmpeg.call_args.args[0]
            self.assertEqual(args[args.index("-t") + 1], "5.1")
            self.assertNotIn(";", args)
        with patch.object(voice_cli, "_run_ffmpeg", return_value=wav16(5.0)):
            canonical = voice_cli._convert_audio("input.wav", 5, "ffmpeg")
        _audio, duration = decode_wav16k(canonical, 5)
        self.assertEqual(duration, 5.0)

    def test_ffmpeg_unknown_length_wav_is_rewritten_to_exact_size(self):
        unknown = bytearray(wav16())
        unknown[4:8] = (0x7FFFFFFF).to_bytes(4, "little")
        unknown[40:44] = (0x7FFFFFFF).to_bytes(4, "little")
        canonical = _canonicalize_ffmpeg_wav(bytes(unknown))
        audio, seconds = decode_wav16k(canonical, 5)
        self.assertEqual(len(audio), 1600)
        self.assertAlmostEqual(seconds, 0.1)
        self.assertEqual(int.from_bytes(canonical[40:44], "little"), len(canonical) - 44)

    def test_retained_jobs_are_bounded_and_oldest_terminal_is_evicted(self):
        with tempfile.TemporaryDirectory() as temp:
            store = ConfigStore(Path(temp) / "voice-home")
            coordinator = Coordinator(store.get(), worker_factory=QuickFakeWorker,
                                      result_ttl=1000, max_retained_jobs=2)
            try:
                ids = [str(uuid.uuid4()) for _ in range(3)]
                for job_id in ids:
                    coordinator.enqueue(job_id, b"test")
                    result = coordinator.wait(job_id, timeout=3)
                    self.assertEqual(result["state"], "done")
                self.assertIsNone(coordinator.get(ids[0]))
                self.assertIsNotNone(coordinator.get(ids[1]))
                self.assertIsNotNone(coordinator.get(ids[2]))
            finally:
                coordinator.close()

    def test_real_persistent_multiprocessing_fake_worker(self):
        with tempfile.TemporaryDirectory() as temp:
            store = ConfigStore(Path(temp) / "voice-home")
            coordinator = Coordinator(store.get(),
                                      worker_factory=lambda config: ProcessWorker(
                                          config, target=fake_mp_worker,
                                          context=multiprocessing.get_context("spawn")),
                                      result_ttl=10)
            try:
                first_id, second_id = str(uuid.uuid4()), str(uuid.uuid4())
                coordinator.enqueue(first_id, b"first")
                first = coordinator.wait(first_id, timeout=10)
                self.assertEqual(first["state"], "done")
                coordinator.enqueue(second_id, b"second")
                second = coordinator.wait(second_id, timeout=10)
                self.assertEqual(second["state"], "done")
                self.assertEqual(first["text"], second["text"], "both jobs must use the same persistent child")
                self.assertEqual(coordinator.status()["backend"], "fake-process")
            finally:
                coordinator.close()

    def test_real_worker_accepts_injected_backend_and_dynamic_decode_config(self):
        global FAKE_ENGINE_LOADS
        FAKE_ENGINE_LOADS = 0
        with tempfile.TemporaryDirectory() as temp:
            store = ConfigStore(Path(temp) / "voice-home")
            coordinator = Coordinator(
                store.get(),
                worker_factory=lambda config: ProcessWorker(
                    config, target_args=(injected_fake_backend_factory,),
                    context=multiprocessing.get_context("spawn")),
                result_ttl=10,
            )
            try:
                first_id = str(uuid.uuid4())
                coordinator.enqueue(first_id, wav16())
                first = coordinator.wait(first_id, timeout=10)
                self.assertEqual(first["state"], "done")
                self.assertIn("load:1;", first["text"])

                changed = store.get()
                changed.update({"language": "zh", "beam_size": 2, "initial_prompt": "FPGA"})
                coordinator.update_config(changed, {"language", "beam_size", "initial_prompt"})
                second_id = str(uuid.uuid4())
                coordinator.enqueue(second_id, wav16())
                second = coordinator.wait(second_id, timeout=10)
                self.assertEqual(second["state"], "done")
                self.assertIn("load:1;", second["text"], "non-model settings must not rebuild the model")
                self.assertIn("language:zh;beam:2;prompt:FPGA", second["text"])
                self.assertEqual(first["text"].split("pid:", 1)[1].split(";", 1)[0],
                                 second["text"].split("pid:", 1)[1].split(";", 1)[0])
            finally:
                coordinator.close()

    def test_real_worker_rewrite_state_use_local_cancellation_and_queued_job_recovery(self):
        SlowRewriteHandler.started.clear()
        SlowRewriteHandler.release.clear()
        SlowRewriteHandler.block = True
        SlowRewriteHandler.response_text = "rewritten output"
        remote = HTTPServer(("127.0.0.1", 0), SlowRewriteHandler)
        remote_thread = threading.Thread(target=remote.serve_forever, daemon=True)
        remote_thread.start()
        temp = tempfile.TemporaryDirectory()
        store = ConfigStore(Path(temp.name) / "voice-home")
        config_patch = {
            "text_mode": "ai",
            "rewrite_base_url": f"http://127.0.0.1:{remote.server_address[1]}/v1",
            "rewrite_model": "local-fake-model",
            "rewrite_timeout": 8,
            "rewrite_api_key": "integration-secret",
        }
        store.update(config_patch)
        coordinator = Coordinator(
            store.get(),
            worker_factory=lambda current: ProcessWorker(
                current, target=voice_server.recognition_worker_main,
                context=multiprocessing.get_context("spawn"),
                target_args=(injected_fake_backend_factory,),
            ),
            result_ttl=20,
            rewrite_api_key=store.get_rewrite_api_key(),
        )
        service = create_server(store=store, coordinator=coordinator, port=0)
        service_thread = threading.Thread(target=service.serve_forever, daemon=True)
        service_thread.start()
        service_base = f"http://127.0.0.1:{service.server_address[1]}"

        def service_request(path, method="GET", body=None, headers=None):
            request_headers = {"Authorization": "Bearer " + store.token, **(headers or {})}
            request = Request(service_base + path, data=body, headers=request_headers, method=method)
            try:
                response = urlopen(request, timeout=6)
            except HTTPError as exc:
                return exc.code, json.loads(exc.read().decode("utf-8"))
            with response:
                raw = response.read()
                return response.status, json.loads(raw.decode("utf-8")) if raw else {}

        def wait_http_job(job_id, timeout=15):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                status, result = service_request(f"/v1/jobs/{job_id}")
                if status != 200:
                    raise AssertionError(f"job poll returned HTTP {status}: {result}")
                if result["state"] in ("done", "error", "cancelled"):
                    return result
                time.sleep(0.02)
            self.fail(f"HTTP job {job_id} did not reach a terminal state")

        try:
            first_id, queued_id = str(uuid.uuid4()), str(uuid.uuid4())
            content_headers = {"Content-Type": "audio/wav", "X-Job-Id": first_id}
            status, accepted = service_request("/v1/jobs", "POST", wav16(), content_headers)
            self.assertEqual(status, 202)
            self.assertEqual(accepted["state"], "queued")
            self.assertTrue(SlowRewriteHandler.started.wait(10), "fake OpenAI-compatible endpoint was not called")
            status, queued = service_request("/v1/jobs", "POST", wav16(),
                                             {"Content-Type": "audio/wav", "X-Job-Id": queued_id})
            self.assertEqual(status, 202)
            self.assertEqual(queued["state"], "queued")
            deadline = time.monotonic() + 5
            progress = None
            while time.monotonic() < deadline:
                status, progress = service_request(f"/v1/jobs/{first_id}")
                if progress and progress["state"] == "rewriting":
                    break
                time.sleep(0.02)
            self.assertIsNotNone(progress)
            self.assertEqual(progress["state"], "rewriting")
            self.assertIn("pid:", progress["raw_text"])
            self.assertIn("pid:", progress["local_text"])
            self.assertIn("inference_seconds", progress["timings"])

            stopped_worker = coordinator.worker
            status, local_result = service_request(f"/v1/jobs/{first_id}/use-local", "POST", b"{}",
                                                   {"Content-Type": "application/json"})
            self.assertEqual(status, 200)
            self.assertEqual(local_result["state"], "done")
            self.assertEqual(local_result["text"], local_result["local_text"])
            self.assertEqual(local_result["raw_text"], progress["raw_text"])
            self.assertFalse(stopped_worker.process.is_alive(), "use-local must stop the blocked rewrite process")

            SlowRewriteHandler.release.set()
            completed = wait_http_job(queued_id)
            self.assertEqual(completed["state"], "done")
            self.assertEqual(completed["text"], "rewritten output")
            self.assertNotIn("processing_warning", completed)
            second_pid = completed["raw_text"].split("pid:", 1)[1].split(";", 1)[0]
            first_pid = local_result["raw_text"].split("pid:", 1)[1].split(";", 1)[0]
            self.assertNotEqual(first_pid, second_pid, "queued work must rebuild the terminated worker")

            SlowRewriteHandler.started.clear()
            SlowRewriteHandler.release.clear()
            SlowRewriteHandler.block = True
            cancel_id, after_cancel_id = str(uuid.uuid4()), str(uuid.uuid4())
            status, _ = service_request("/v1/jobs", "POST", wav16(),
                                        {"Content-Type": "audio/wav", "X-Job-Id": cancel_id})
            self.assertEqual(status, 202)
            self.assertTrue(SlowRewriteHandler.started.wait(10))
            status, _ = service_request("/v1/jobs", "POST", wav16(),
                                        {"Content-Type": "audio/wav", "X-Job-Id": after_cancel_id})
            self.assertEqual(status, 202)
            cancelled_worker = coordinator.worker
            status, cancelled = service_request(f"/v1/jobs/{cancel_id}", "DELETE")
            self.assertEqual(status, 200)
            self.assertEqual(cancelled["state"], "cancelled")
            self.assertFalse(cancelled_worker.process.is_alive(), "cancelling active inference must stop its owned worker process")
            SlowRewriteHandler.block = False
            SlowRewriteHandler.release.set()
            after_cancel = wait_http_job(after_cancel_id)
            self.assertEqual(after_cancel["state"], "done")
            self.assertEqual(after_cancel["text"], "rewritten output")
        finally:
            SlowRewriteHandler.block = False
            SlowRewriteHandler.release.set()
            service.shutdown()
            service.server_close()
            service_thread.join(timeout=2)
            coordinator.close()
            remote.shutdown()
            remote.server_close()
            remote_thread.join(timeout=2)
            temp.cleanup()


if __name__ == "__main__":
    unittest.main()
