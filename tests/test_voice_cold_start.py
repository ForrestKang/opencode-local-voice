"""Deterministic cold-start responsiveness tests for the persistent worker."""
from __future__ import annotations

import builtins
import io
import json
import queue
import tempfile
import threading
import time
import unittest
import uuid
import wave
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from shared import voice_server
from shared.voice_server import ConfigStore, Coordinator, create_server


def wav16(seconds: float = 0.1) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\0\0" * int(16000 * seconds))
    return out.getvalue()


class ImmediateWorker:
    def __init__(self):
        self.output: queue.Queue = queue.Queue()
        self.submitted: list[str] = []
        self.stop_calls: list[bool] = []
        self.stop_under_lock: list[bool] = []
        self.stopped = threading.Event()
        self.coordinator: Coordinator | None = None

    def submit(self, task):
        self.submitted.append(task["id"])
        self.output.put({"type": "state", "id": task["id"], "state": "loading"})
        self.output.put({"type": "state", "id": task["id"], "state": "transcribing"})
        self.output.put({"type": "result", "id": task["id"], "state": "done",
                         "text": "fake transcript", "raw_text": "fake transcript",
                         "local_text": "fake transcript", "timings": {},
                         "backend": "cold-start-fake", "device": "cpu"})

    def poll(self, timeout=0.1):
        try:
            return self.output.get(timeout=timeout)
        except queue.Empty:
            return None

    def stop(self, terminate=False):
        self.stop_calls.append(bool(terminate))
        if self.coordinator is not None:
            self.stop_under_lock.append(self.coordinator._lock._is_owned())
        self.stopped.set()


class SlowFactory:
    def __init__(self, *, fail_first: bool = False):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.returned = threading.Event()
        self.fail_first = fail_first
        self.calls = 0
        self.workers: list[ImmediateWorker] = []
        self.created_under_lock = []
        self.coordinator: Coordinator | None = None

    def __call__(self, _config):
        self.calls += 1
        call = self.calls
        if self.coordinator is not None:
            self.created_under_lock.append(self.coordinator._lock._is_owned())
        self.entered.set()
        if not self.release.wait(8):
            raise TimeoutError("test worker factory release timed out")
        self.returned.set()
        if self.fail_first and call == 1:
            raise RuntimeError("injected cold worker startup failure")
        worker = ImmediateWorker()
        worker.coordinator = self.coordinator
        self.workers.append(worker)
        return worker


class VoiceColdStartTests(unittest.TestCase):
    def _wait_result(self, coordinator: Coordinator, job_id: str, timeout: float = 4):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = coordinator.get(job_id)
            if result and result["state"] in ("done", "error", "cancelled"):
                return result
            time.sleep(0.01)
        self.fail(f"job {job_id} did not complete")

    def test_http_audio_validation_does_not_import_numpy(self):
        with tempfile.TemporaryDirectory() as temp:
            store = ConfigStore(Path(temp) / "voice-home")
            coordinator = Coordinator(store.get(), worker_factory=lambda _config: ImmediateWorker())
            server = create_server(store=store, coordinator=coordinator, port=0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            job_id = str(uuid.uuid4())
            request = Request(
                f"http://127.0.0.1:{server.server_address[1]}/v1/jobs",
                data=wav16(), method="POST",
                headers={"Authorization": "Bearer " + store.token,
                         "X-Job-Id": job_id, "Content-Type": "audio/wav"},
            )
            original_import = builtins.__import__

            def reject_numpy(name, *args, **kwargs):
                if name == "numpy":
                    raise AssertionError("HTTP WAV validation must not import NumPy")
                return original_import(name, *args, **kwargs)

            try:
                with patch("builtins.__import__", side_effect=reject_numpy):
                    with urlopen(request, timeout=3) as response:
                        self.assertEqual(response.status, 202)
                        result = json.loads(response.read().decode("utf-8"))
                self.assertEqual(result["id"], job_id)
                self.assertIn(result["state"], ("queued", "loading", "done"))
            finally:
                server.shutdown()
                server.server_close()
                coordinator.close()
                thread.join(timeout=2)

    def test_http_enqueue_status_and_cancel_stay_responsive_during_worker_start(self):
        with tempfile.TemporaryDirectory() as temp:
            store = ConfigStore(Path(temp) / "voice-home")
            factory = SlowFactory()
            coordinator = Coordinator(store.get(), worker_factory=factory)
            factory.coordinator = coordinator
            server = create_server(store=store, coordinator=coordinator, port=0)
            server_thread = threading.Thread(target=server.serve_forever, daemon=True)
            server_thread.start()
            base = f"http://127.0.0.1:{server.server_address[1]}"

            def call(path, method="GET", body=None, headers=None):
                request = Request(base + path, data=body, method=method,
                                  headers={"Authorization": "Bearer " + store.token,
                                           **(headers or {})})
                try:
                    response = urlopen(request, timeout=4)
                except HTTPError as exc:
                    return exc.code, json.loads(exc.read().decode("utf-8"))
                with response:
                    raw = response.read()
                    return response.status, json.loads(raw.decode("utf-8")) if raw else {}

            try:
                status, warmup = call("/v1/warmup", "POST", b"{}",
                                      {"Content-Type": "application/json"})
                self.assertEqual(status, 202)
                self.assertTrue(factory.entered.wait(1), "worker factory did not enter cold-start gate")

                job_id = str(uuid.uuid4())
                responses = {}
                finished = {name: threading.Event() for name in ("enqueue", "status", "cancel")}

                def run(name, path, method="GET", body=None, headers=None):
                    try:
                        responses[name] = call(path, method, body, headers)
                    except Exception as exc:
                        responses[name] = exc
                    finally:
                        finished[name].set()

                threads = [
                    threading.Thread(target=run, args=("enqueue", "/v1/jobs", "POST", wav16(),
                                  {"X-Job-Id": job_id, "Content-Type": "audio/wav"}), daemon=True),
                    threading.Thread(target=run, args=("status", "/v1/status"), daemon=True),
                    threading.Thread(target=run, args=("cancel", f"/v1/jobs/{job_id}", "DELETE"), daemon=True),
                ]
                started = time.monotonic()
                for request_thread in threads:
                    request_thread.start()
                deadline = started + 1.0
                while time.monotonic() < deadline and not all(event.is_set() for event in finished.values()):
                    time.sleep(0.01)
                elapsed = time.monotonic() - started
                responsive = all(event.is_set() for event in finished.values())
                self.assertTrue(responsive,
                                "HTTP enqueue/status/cancel waited on worker_factory while it initialized")
                self.assertLess(elapsed, 1.0)
                self.assertEqual(responses["enqueue"][0], 202)
                self.assertEqual(responses["status"][0], 200)
                self.assertEqual(responses["cancel"][0], 200)
            finally:
                factory.release.set()
                for request_thread in locals().get("threads", []):
                    request_thread.join(timeout=2)
                server.shutdown()
                server.server_close()
                coordinator.close()
                server_thread.join(timeout=2)

    def test_cancel_during_worker_start_discards_and_disposes_late_worker(self):
        factory = SlowFactory()
        coordinator = Coordinator(voice_server._default_config(), worker_factory=factory)
        factory.coordinator = coordinator
        try:
            job_id = str(uuid.uuid4())
            coordinator.enqueue(job_id, wav16())
            self.assertTrue(factory.entered.wait(1))
            cancelled = {}
            finished = threading.Event()

            def cancel():
                cancelled["result"] = coordinator.cancel(job_id)
                finished.set()

            cancel_thread = threading.Thread(target=cancel, daemon=True)
            cancel_thread.start()
            self.assertTrue(finished.wait(0.75), "cancel blocked behind worker construction")
            self.assertEqual(cancelled["result"]["state"], "cancelled")
            factory.release.set()
            self.assertTrue(factory.returned.wait(2))
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and not factory.workers:
                time.sleep(0.01)
            self.assertEqual(factory.created_under_lock, [False])
            self.assertEqual(len(factory.workers), 1)
            worker = factory.workers[0]
            self.assertTrue(worker.stopped.wait(1), "late worker must be disposed after cancellation")
            self.assertEqual(worker.submitted, [], "cancelled audio must never reach the late worker")
            self.assertEqual(worker.stop_calls, [True])
            self.assertEqual(worker.stop_under_lock, [False])
        finally:
            factory.release.set()
            coordinator.close()

    def test_close_during_worker_start_disposes_late_worker_without_submitting_audio(self):
        factory = SlowFactory()
        coordinator = Coordinator(voice_server._default_config(), worker_factory=factory)
        factory.coordinator = coordinator
        job_id = str(uuid.uuid4())
        coordinator.enqueue(job_id, wav16())
        self.assertTrue(factory.entered.wait(1))
        finished = threading.Event()

        def close():
            coordinator.close()
            finished.set()

        close_thread = threading.Thread(target=close, daemon=True)
        close_thread.start()
        try:
            self.assertTrue(finished.wait(2.5), "close must not wait on worker startup while holding coordinator lock")
            factory.release.set()
            self.assertTrue(factory.returned.wait(2))
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and not factory.workers:
                time.sleep(0.01)
            self.assertEqual(factory.created_under_lock, [False])
            self.assertEqual(len(factory.workers), 1)
            worker = factory.workers[0]
            self.assertTrue(worker.stopped.wait(1), "late worker must be disposed after close")
            self.assertEqual(worker.submitted, [])
            self.assertEqual(worker.stop_calls, [True])
            self.assertEqual(worker.stop_under_lock, [False])
        finally:
            factory.release.set()
            close_thread.join(timeout=3)

    def test_worker_start_failure_fails_active_job_and_recovers_queued_job(self):
        factory = SlowFactory(fail_first=True)
        coordinator = Coordinator(voice_server._default_config(), worker_factory=factory)
        factory.coordinator = coordinator
        try:
            failed_id, queued_id = str(uuid.uuid4()), str(uuid.uuid4())
            coordinator.enqueue(failed_id, wav16())
            self.assertTrue(factory.entered.wait(1))
            coordinator.enqueue(queued_id, wav16())
            factory.release.set()
            failed = self._wait_result(coordinator, failed_id)
            completed = self._wait_result(coordinator, queued_id)
            self.assertEqual(failed["state"], "error")
            self.assertEqual(completed["state"], "done")
            self.assertEqual(completed["text"], "fake transcript")
            self.assertEqual(factory.calls, 2)
            self.assertTrue(all(not value for value in factory.created_under_lock))
        finally:
            factory.release.set()
            coordinator.close()


if __name__ == "__main__":
    unittest.main()
