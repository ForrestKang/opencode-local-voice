"""Transcript formatting, schema validation, and optional rewrite tests."""
from __future__ import annotations

import copy
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shared import voice_text, voice_server


class VoiceTextConfigTests(unittest.TestCase):
    def test_legacy_config_migration_adds_safe_text_defaults(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp) / "voice-home"
            home.mkdir()
            old = {"backend": "auto", "device": "auto", "model_path": "/local/model",
                   "language": "auto", "beam_size": 1, "cpu_threads": 2,
                   "max_seconds": 120, "idle_seconds": 1800, "warmup_on_record": True,
                   "initial_prompt": "FPGA", "allowed_origins": ["http://localhost:47832"],
                   "port": 47832}
            (home / "config.json").write_text(json.dumps(old), encoding="utf-8")
            store = voice_server.ConfigStore(home)
            config = store.get()
            self.assertEqual(config["vocabulary_preset"], "coding")
            self.assertEqual(config["text_mode"], "clean")
            self.assertEqual(config["punctuation_mode"], "auto")
            self.assertEqual(config["space_mode"], "preserve")
            self.assertNotIn("shortcuts", config)
            disk = json.loads(store.config_path.read_text(encoding="utf-8"))
            self.assertEqual(disk, config)

    def test_validation_bounds_vocabulary_replacements_templates_and_timeout(self):
        base = voice_server._default_config()
        valid = copy.deepcopy(base)
        valid.update({"vocabulary": [" FPGA ", "FPGA"],
                      "replacements": [{"from": "old name", "to": "new name"}],
                      "prompt_template": "Fix this: {text}"})
        result = voice_server.validate_config(valid)
        self.assertEqual(result["vocabulary"], ["FPGA"])
        for patch_value in (
            {"vocabulary": ["x" * 81]},
            {"vocabulary": ["x"] * 101},
            {"replacements": [{"from": "", "to": "x"}]},
            {"replacements": [{"from": "a", "to": "x"}, {"from": "a", "to": "y"}]},
            {"prompt_template": "missing text"},
            {"prompt_template": "{text} {text}"},
            {"rewrite_timeout": 4},
            {"rewrite_timeout": True},
            {"text_mode": "semantic-local-ai"},
            {"vocabulary": ["two\nlines"]},
            {"replacements": [{"from": "old\nname", "to": "new"}]},
        ):
            with self.subTest(patch=patch_value), self.assertRaises(voice_server.ConfigError):
                voice_server.validate_config({**base, **patch_value})

    def test_shortcuts_are_not_a_service_setting_and_spaces_remain_ordinary_text(self):
        with self.assertRaises(voice_server.ConfigError):
            voice_server.validate_config({**voice_server._default_config(), "shortcuts": {"toggle": "Ctrl+K"}})
        config = voice_server._default_config()
        config.update({"text_mode": "clean", "punctuation_mode": "none", "space_mode": "preserve"})
        self.assertEqual(voice_text.local_transform("a b", config), "a b")

    def test_rewrite_url_requires_https_or_loopback_and_normalizes_endpoint(self):
        self.assertEqual(voice_text.normalize_rewrite_url("https://api.example/v1"),
                         "https://api.example/v1/chat/completions")
        self.assertEqual(voice_text.normalize_rewrite_url("https://api.example"),
                         "https://api.example/v1/chat/completions")
        self.assertEqual(voice_text.normalize_rewrite_url("https://api.example/v1/chat/completions"),
                         "https://api.example/v1/chat/completions")
        self.assertEqual(voice_text.normalize_rewrite_url("http://localhost:8080/custom"),
                         "http://localhost:8080/custom/v1/chat/completions")
        for value in ("http://example.com", "https://user:pass@example.com", "https://a.test/?k=v",
                      "https://a.test/#frag", "file:///tmp/model", "https://a.test:bad"):
            with self.subTest(url=value), self.assertRaises(voice_text.TextConfigError):
                voice_text.normalize_rewrite_url(value)


class LocalTranscriptTests(unittest.TestCase):
    def setUp(self):
        self.config = voice_server._default_config()

    def test_replacements_are_longest_first_non_cascading_and_english_bounded(self):
        self.config["replacements"] = [
            {"from": "open code", "to": "OpenCode"},
            {"from": "OpenCode", "to": "Next"},
            {"from": "API", "to": "A P I"},
        ]
        self.config["punctuation_mode"] = "none"
        result = voice_text.local_transform("open code, API myAPI `open code` https://open code.test", self.config, "en")
        self.assertEqual(result, "OpenCode, A P I myAPI `open code` https://open code.test")
        self.config["replacements"] = [
            {"from": "micro phone", "to": "microphone"},
            {"from": "micro", "to": "mic"},
        ]
        self.assertEqual(voice_text.apply_replacements("micro phone micro", self.config["replacements"]),
                         "microphone mic")

    def test_code_urls_paths_identifiers_and_decimals_are_protected(self):
        self.config.update({"punctuation_mode": "zh", "space_mode": "space-to-comma"})
        source = "hi there 3.14 and `x = 1.2` https://example.test/a?b=1 C:\\src\\main.py foo_bar hello world"
        result = voice_text.local_transform(source, self.config, "en")
        self.assertIn("3.14", result)
        self.assertIn("`x = 1.2`", result)
        self.assertIn("https://example.test/a?b=1", result)
        self.assertIn("C:\\src\\main.py", result)
        self.assertIn("foo_bar", result)
        self.assertIn("hi there", result)
        self.assertIn("hello world", result)
        self.assertIn("你好，世界", voice_text.local_transform("你好 世界", self.config, "zh"))

    def test_unquoted_code_paths_emails_and_measurement_units_are_protected(self):
        self.config.update({"punctuation_mode": "zh", "space_mode": "space-to-comma"})
        source = (
            "const message = \"hello world\"; foo(bar, baz) run npm install package; "
            "src/main.py ./config/test.json dev@example.com 3.5 GHz 100 ms 1,000 KB"
        )
        result = voice_text.local_transform(source, self.config, "en")
        for safe_value in (
            'const message = "hello world";', "foo(bar, baz)", "npm install package",
            "src/main.py", "./config/test.json", "dev@example.com", "3.5 GHz", "100 ms", "1,000 KB",
        ):
            with self.subTest(safe_value=safe_value):
                self.assertIn(safe_value, result)
        self.assertEqual(voice_text.local_transform("hello there", self.config, "en"), "hello there")
        self.assertEqual(voice_text.local_transform("你好 世界", self.config, "zh"), "你好，世界")

        self.config.update({"punctuation_mode": "zh", "space_mode": "preserve"})
        ending = voice_text.local_transform("src/main.py. version 3.5.", self.config, "zh")
        self.assertEqual(ending, "src/main.py。 version 3.5。")

    def test_mixed_language_auto_punctuation_and_space_conversion(self):
        self.config.update({"punctuation_mode": "auto", "space_mode": "comma-to-space"})
        zh = voice_text.local_transform("你好，世界, OpenCode 3.5.", self.config, "zh")
        self.assertEqual(zh, "你好 世界 OpenCode 3.5。")
        en = voice_text.local_transform("hello，world, version 3.5.", self.config, "en")
        self.assertEqual(en, "hello world version 3.5.")
        # Pure English transcript with a misdetected "zh" language tag must keep English punctuation.
        self.config.update({"punctuation_mode": "auto", "space_mode": "preserve"})
        pure_en = voice_text.local_transform("Please check Python API in OpenCode.", self.config, "zh")
        self.assertEqual(pure_en, "Please check Python API in OpenCode.")

    def test_chinese_auto_segmentation_and_smart_pause_commas(self):
        # Smart mode turns long Chinese pause spaces into commas while still joining stray short spaces.
        self.config.update({"punctuation_mode": "zh", "space_mode": "smart", "text_mode": "clean"})
        paused = voice_text.local_transform(
            "我记得设置里面有优化标点符号的选项 你帮我也优化一下 能不能清楚识别出来呢",
            self.config,
            "zh",
        )
        self.assertEqual(paused, "我记得设置里面有优化标点符号的选项，你帮我也优化一下，能不能清楚识别出来呢？")

        # Continuous unpunctuated Chinese still breaks on clear clause connectors and adds ending punctuation.
        continuous = voice_text.local_transform(
            "请帮我检查一下 OpenCode 的 Python 接口如果有报错就先看日志然后再修改配置文件",
            self.config,
            "zh",
        )
        self.assertEqual(continuous, "请帮我检查一下 OpenCode 的 Python 接口，如果有报错就先看日志，然后再修改配置文件。")

        # Partially punctuated long Chinese clauses also get connector breaks, and "[吗呢]。"/"，。" are normalized.
        partial = voice_text.local_transform(
            "请帮我检查一下OpenCode的Python接口。如果有报错就先看日志然后再修改配置文件，。",
            self.config,
            "zh",
        )
        self.assertEqual(partial, "请帮我检查一下 OpenCode 的 Python 接口。如果有报错就先看日志，然后再修改配置文件。")
        question_fix = voice_text.local_transform(
            "帮我把TypeScript配置和API接口检查一下。如果没有问题的话就可以直接运行测试好吗。",
            self.config,
            "zh",
        )
        self.assertEqual(question_fix, "帮我把 TypeScript 配置和 API 接口检查一下。如果没有问题的话就可以直接运行测试好吗？")

        # comma-to-space explicitly removes commas, so auto-punctuation must not re-insert them.
        self.config.update({"punctuation_mode": "zh", "space_mode": "comma-to-space", "text_mode": "clean"})
        no_reinsert = voice_text.local_transform(
            "请帮我检查一下接口如果有报错就先看日志然后再修改配置文件",
            self.config,
            "zh",
        )
        self.assertNotIn("，", no_reinsert)

        # punctuation_mode=none and text_mode=original never insert punctuation.
        self.config.update({"punctuation_mode": "none", "space_mode": "smart"})
        raw_unpunct = "我之前试过就是没法自动断句能不能清楚识别出来呢"
        self.assertEqual(voice_text.local_transform(raw_unpunct, self.config, "zh"), raw_unpunct)
        self.config.update({"punctuation_mode": "zh", "text_mode": "original"})
        self.assertEqual(voice_text.local_transform(raw_unpunct, self.config, "zh"), raw_unpunct)

    def test_preserve_and_smart_keep_english_word_gaps_and_measurements(self):
        sentence = "English words stay readable at 3.5 GHz and 100 ms."
        self.config.update({"punctuation_mode": "none", "space_mode": "preserve"})
        self.assertEqual(voice_text.local_transform(sentence, self.config, "en"), sentence)
        self.config["space_mode"] = "smart"
        self.assertEqual(voice_text.local_transform(sentence, self.config, "en"), sentence)
        mixed = voice_text.local_transform("中文 OpenCode handles English words 3.5 GHz", self.config, "zh")
        self.assertIn("OpenCode handles English words", mixed)
        self.assertIn("3.5 GHz", mixed)

    def test_smart_spacing_only_changes_safe_prose(self):
        self.config.update({"punctuation_mode": "zh", "space_mode": "smart"})
        result = voice_text.local_transform("你 好  OpenCode , API 2.4", self.config, "zh")
        self.assertEqual(result, "你好 OpenCode， API 2.4")

    def test_original_clean_coding_prompt_and_custom_modes(self):
        original = "  keep   exact, text  "
        self.config.update({"text_mode": "original", "punctuation_mode": "zh", "space_mode": "space-to-comma"})
        self.assertEqual(voice_text.local_transform(original, self.config, "zh"), original)
        self.config.update({"text_mode": "clean", "punctuation_mode": "none", "space_mode": "preserve"})
        self.assertEqual(voice_text.local_transform(original, self.config, "en"), "keep   exact, text")
        self.config["text_mode"] = "coding-prompt"
        wrapped = voice_text.local_transform("add a test", self.config, "en")
        self.assertIn("Please help with the following coding request.", wrapped)
        self.assertTrue(wrapped.endswith("add a test"))
        self.config["text_mode"] = "analysis-prompt"
        analysis = voice_text.local_transform("explain the failure", self.config, "en")
        self.assertIn("Analyze the following request before acting.", analysis)
        self.assertTrue(analysis.endswith("explain the failure"))
        chinese = voice_text.local_transform("请修复这个问题", self.config, "zh")
        self.assertIn("请先分析以下请求", chinese)
        self.assertTrue(chinese.endswith("请修复这个问题"))
        self.config["text_mode"] = "coding-prompt"
        chinese_coding = voice_text.local_transform("写一个测试", self.config, "auto")
        self.assertIn("请帮助处理以下编程请求", chinese_coding)
        self.config.update({"text_mode": "custom", "prompt_template": "Issue: {text}\nEnd"})
        self.assertEqual(voice_text.local_transform(" fix ", self.config, "en"), "Issue: fix\nEnd")

    def test_vocabulary_hints_include_coding_preset_and_are_bounded(self):
        config = voice_server._default_config()
        config["initial_prompt"] = "project context"
        config["vocabulary"] = ["MyFramework"]
        prompt, hotwords = voice_text.build_asr_hints(config)
        self.assertTrue(prompt.startswith("project context."))
        self.assertIn("OpenCode", prompt)
        self.assertIn("MyFramework", prompt)
        self.assertIn("CTranslate2", hotwords)
        config.update({"initial_prompt": "x" * 2048, "vocabulary": ["y" * 80] * 100})
        prompt, hotwords = voice_text.build_asr_hints(config)
        self.assertLessEqual(len(prompt), 1900)
        self.assertLessEqual(len(hotwords), voice_text.MAX_VOCABULARY_TOTAL_CHARS)
        zh_prompt, zh_hotwords = voice_text.build_asr_hints({"language": "auto", "vocabulary_preset": "coding", "vocabulary": [], "initial_prompt": ""})
        self.assertIn("，", zh_prompt)
        self.assertIn("。", zh_prompt)
        self.assertIn("OpenCode", zh_hotwords)
        self.assertIn("CTranslate2", zh_hotwords)

    def test_optional_ai_success_uses_compatible_request_and_never_changes_local_mode(self):
        seen = {}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, limit):
                seen["read_limit"] = limit
                return json.dumps({"choices": [{"message": {"content": "rewritten"}}]}).encode()

        def opener(request, timeout):
            seen["url"] = request.full_url
            seen["timeout"] = timeout
            seen["headers"] = dict(request.header_items())
            seen["body"] = json.loads(request.data.decode())
            return Response()

        self.config.update({"text_mode": "ai", "rewrite_base_url": "https://api.example/v1",
                            "rewrite_model": "local-choice", "rewrite_timeout": 9})
        local, text, warning = voice_text.process_transcript("  hello   world ", self.config, api_key="secret-test", opener=opener)
        self.assertEqual((local, text, warning), ("hello   world", "rewritten", None))
        self.assertEqual(seen["url"], "https://api.example/v1/chat/completions")
        self.assertEqual(seen["timeout"], 9)
        self.assertEqual(seen["headers"]["Authorization"], "Bearer secret-test")
        self.assertEqual(seen["body"]["messages"][1]["content"], "hello   world")
        self.assertEqual(seen["body"]["messages"][0]["content"], voice_text.DEFAULT_REWRITE_PROMPT)
        self.config["rewrite_prompt"] = voice_text.DEFAULT_REWRITE_PROMPT
        voice_text.rewrite_text("你好，请解释", self.config, api_key="secret-test", opener=opener)
        self.assertEqual(seen["body"]["messages"][0]["content"], voice_text.DEFAULT_REWRITE_PROMPT_ZH)
        self.config["text_mode"] = "clean"
        self.assertEqual(voice_text.process_transcript("  hello   world ", self.config, api_key="secret-test", opener=opener),
                         ("hello   world", "hello   world", None))

    def test_ai_failures_preserve_local_result_without_exposing_endpoint_or_key(self):
        self.config.update({"text_mode": "ai", "rewrite_base_url": "https://api.example/v1",
                            "rewrite_model": "private-model", "rewrite_timeout": 5})
        local, text, warning = voice_text.process_transcript(
            " keep   my words ", self.config, api_key="super-secret",
            opener=lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("sensitive URL/key")),
        )
        self.assertEqual((local, text), ("keep   my words", "keep   my words"))
        self.assertEqual(warning, "AI 改写未完成，已保留本地识别结果。")
        self.assertNotIn("super-secret", warning)
        self.assertNotIn("api.example", warning)
        self.config["rewrite_base_url"] = ""
        self.assertEqual(voice_text.process_transcript("hello", self.config),
                         ("hello", "hello", "AI 改写未完成，已保留本地识别结果。"))

    def test_ai_limits_and_bad_response_fall_back_safely(self):
        self.config.update({"text_mode": "ai", "rewrite_base_url": "https://api.example",
                            "rewrite_model": "m"})

        class LargeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, limit):
                return b"x" * limit

        local, text, warning = voice_text.process_transcript("safe fallback", self.config,
                                                              opener=lambda *_args, **_kwargs: LargeResponse())
        self.assertEqual((local, text), ("safe fallback", "safe fallback"))
        self.assertEqual(warning, "AI 改写未完成，已保留本地识别结果。")
        truncated = {
            "choices": [{"message": {"content": "partial output"}, "finish_reason": "length"}]
        }

        class TruncatedResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit):
                return json.dumps(truncated).encode()

        local, text, warning = voice_text.process_transcript(
            "complete local transcript", self.config,
            opener=lambda *_args, **_kwargs: TruncatedResponse(),
        )
        self.assertEqual((local, text), ("complete local transcript", "complete local transcript"))
        self.assertEqual(warning, "AI 改写未完成，已保留本地识别结果。")
        self.assertEqual(voice_text.process_transcript("x" * 100_001, self.config),
                         ("x" * 100_001, "x" * 100_001, "AI 改写未完成，已保留本地识别结果。"))

    def test_default_rewrite_client_rejects_redirect_before_forwarding_api_key(self):
        received_at_target = threading.Event()

        class TargetHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                received_at_target.set()
                self.send_response(200)
                self.end_headers()

            def log_message(self, *_args):
                return

        target = HTTPServer(("127.0.0.1", 0), TargetHandler)
        target_thread = threading.Thread(target=target.serve_forever, daemon=True)
        target_thread.start()

        class RedirectHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(302)
                self.send_header("Location", f"http://localhost:{target.server_address[1]}/steal")
                self.end_headers()

            def log_message(self, *_args):
                return

        redirect = HTTPServer(("127.0.0.1", 0), RedirectHandler)
        redirect_thread = threading.Thread(target=redirect.serve_forever, daemon=True)
        redirect_thread.start()
        try:
            self.config.update({"text_mode": "ai", "rewrite_base_url":
                                f"http://127.0.0.1:{redirect.server_address[1]}/v1",
                                "rewrite_model": "local-test", "rewrite_timeout": 5})
            local, final, warning = voice_text.process_transcript("keep this", self.config,
                                                                  api_key="must-not-forward")
            self.assertEqual((local, final), ("keep this", "keep this"))
            self.assertEqual(warning, "AI 改写未完成，已保留本地识别结果。")
            self.assertFalse(received_at_target.wait(0.2), "redirect target must never receive the API key")
        finally:
            redirect.shutdown()
            target.shutdown()
            redirect.server_close()
            target.server_close()
            redirect_thread.join(timeout=1)
            target_thread.join(timeout=1)

    def test_warmup_path_skips_transcript_processing_entirely(self):
        tasks = [
            {"id": "warmup-test", "warmup": True, "audio": None, "config": self.config},
            None,
        ]

        class InQueue:
            def get(self):
                return tasks.pop(0)

        class OutQueue:
            def __init__(self):
                self.items = []

            def put(self, item):
                self.items.append(item)

        class Engine:
            backend = "test"
            device = "cpu"
            config = self.config

            def transcribe(self, _audio):
                return "must not be exposed", "en"

        output = OutQueue()
        with patch.object(voice_server, "decode_wav16k", return_value=(object(), 0.25)), \
                patch.object(voice_server, "make_silence_wav", return_value=b"warmup"), \
                patch.object(voice_text, "local_transform", side_effect=AssertionError("warmup must skip local text")), \
                patch.object(voice_text, "rewrite_text", side_effect=AssertionError("warmup must skip optimizer")):
            voice_server.recognition_worker_main(self.config, InQueue(), output,
                                                 backend_factory=lambda _cfg: Engine())
        result = next(item for item in output.items if item.get("type") == "result")
        self.assertEqual(result["state"], "done")
        self.assertEqual(result["text"], "")
        self.assertEqual(result["raw_text"], "")
        self.assertIsNone(result["processing_warning"])


class OpenAiSttTests(unittest.TestCase):
    def test_stt_url_normalization_and_validation(self):
        self.assertEqual(
            voice_text.normalize_stt_url("https://api.groq.com/openai/v1"),
            "https://api.groq.com/openai/v1/audio/transcriptions",
        )
        self.assertEqual(
            voice_text.normalize_stt_url("http://127.0.0.1:8000"),
            "http://127.0.0.1:8000/v1/audio/transcriptions",
        )
        for bad in (
            "http://remote.example.com/v1",
            "https://user:pass@api.example.com/v1",
            "https://api.example.com/v1?x=1",
        ):
            with self.assertRaises(voice_text.TextConfigError):
                voice_text.normalize_stt_url(bad)
        with self.assertRaises(voice_text.TextConfigError):
            voice_text.validate_stt_config({"stt_timeout": True})
        with self.assertRaises(voice_text.TextConfigError):
            voice_text.validate_stt_config({"stt_timeout": 121})

    def test_openai_compatible_multipart_upload_no_redirect_and_secret_redaction(self):
        captured = {}
        received_redirect_target = threading.Event()

        class SttHandler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                captured["path"] = self.path
                captured["auth"] = self.headers.get("Authorization")
                captured["content_type"] = self.headers.get("Content-Type", "")
                captured["body"] = self.rfile.read(length)
                if self.path.startswith("/fail-secret"):
                    payload = json.dumps({"error": {"message": "bad key: sk-secret-999"}}).encode("utf-8")
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                payload = json.dumps({"text": "  hello OpenCode  "}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        class RedirectHandler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                _ = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.send_response(307)
                self.send_header("Location", f"http://127.0.0.1:{target.server_address[1]}/v1/audio/transcriptions")
                self.send_header("Content-Length", "0")
                self.end_headers()

        class RedirectTargetHandler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                received_redirect_target.set()
                self.send_response(200)
                self.end_headers()

        stt_srv = HTTPServer(("127.0.0.1", 0), SttHandler)
        redir_srv = HTTPServer(("127.0.0.1", 0), RedirectHandler)
        target = HTTPServer(("127.0.0.1", 0), RedirectTargetHandler)
        threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in (stt_srv, redir_srv, target)]
        for t in threads:
            t.start()
        try:
            wav_bytes = voice_text._silent_wav16k()
            cfg = {"stt_base_url": f"http://127.0.0.1:{stt_srv.server_address[1]}/v1",
                   "stt_model": "whisper-large-v3-turbo", "stt_timeout": 10}
            text = voice_text.transcribe_openai_compatible(
                wav_bytes, cfg, api_key="sk-secret-999", language="zh", prompt="OpenCode")
            self.assertEqual(text, "hello OpenCode")
            self.assertEqual(captured["path"], "/v1/audio/transcriptions")
            self.assertEqual(captured["auth"], "Bearer sk-secret-999")
            self.assertIn("multipart/form-data; boundary=", captured["content_type"])
            self.assertIn(b'name="model"\r\n\r\nwhisper-large-v3-turbo', captured["body"])
            self.assertIn(b'name="language"\r\n\r\nzh', captured["body"])
            self.assertIn(wav_bytes, captured["body"])

            test_ok = voice_text.test_stt_connection(cfg, api_key="sk-secret-999")
            self.assertTrue(test_ok["ok"], test_ok)

            # Secret must be redacted from error messages
            fail_cfg = {"stt_base_url": f"http://127.0.0.1:{stt_srv.server_address[1]}/fail-secret/audio/transcriptions",
                        "stt_model": "whisper-large-v3-turbo", "stt_timeout": 10}
            with self.assertRaises(RuntimeError) as ctx:
                voice_text.transcribe_openai_compatible(wav_bytes, fail_cfg, api_key="sk-secret-999")
            self.assertNotIn("sk-secret-999", str(ctx.exception))
            self.assertIn("[REDACTED]", str(ctx.exception))

            # Redirect must never forward credentials
            redir_cfg = {"stt_base_url": f"http://127.0.0.1:{redir_srv.server_address[1]}/v1",
                         "stt_model": "whisper-1", "stt_timeout": 10}
            with self.assertRaises(RuntimeError):
                voice_text.transcribe_openai_compatible(wav_bytes, redir_cfg, api_key="sk-secret-999")
            self.assertFalse(received_redirect_target.wait(0.2))
        finally:
            for s in (stt_srv, redir_srv, target):
                s.shutdown()
                s.server_close()
            for t in threads:
                t.join(timeout=1)

    def test_http_connection_pool_reuses_sockets_recovers_stale_and_prewarms(self):
        from http.server import ThreadingHTTPServer

        voice_text.close_http_pool()
        seen_client_ports = []
        close_after_reply = False

        class KeepAliveHandler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_OPTIONS(self):
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.send_header("Connection", "keep-alive")
                self.end_headers()

            def do_POST(self):
                seen_client_ports.append(self.client_address[1])
                size = int(self.headers.get("Content-Length", "0"))
                _ = self.rfile.read(size)
                payload = json.dumps({"text": f"call {len(seen_client_ports)}"}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                if close_after_reply:
                    self.send_header("Connection", "close")
                    self.close_connection = True
                else:
                    self.send_header("Connection", "keep-alive")
                self.end_headers()
                self.wfile.write(payload)

        srv = ThreadingHTTPServer(("127.0.0.1", 0), KeepAliveHandler)
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{srv.server_address[1]}/v1"
            cfg = {"stt_base_url": base, "stt_model": "whisper-1", "stt_timeout": 5}
            wav_bytes = voice_text._silent_wav16k()

            self.assertFalse(voice_text.prewarm_endpoint(base, timeout=1.0, allow_http=False))
            self.assertTrue(voice_text.prewarm_endpoint(base, timeout=2.0, allow_http=True))

            self.assertEqual(voice_text.transcribe_openai_compatible(wav_bytes, cfg), "call 1")
            self.assertEqual(voice_text.transcribe_openai_compatible(wav_bytes, cfg), "call 2")
            self.assertEqual(voice_text.transcribe_openai_compatible(wav_bytes, cfg), "call 3")
            self.assertEqual(len(set(seen_client_ports)), 1, f"expected Keep-Alive socket reuse, got {seen_client_ports}")

            # Force server close on reply, then verify pool cleanly reconnects on subsequent call.
            close_after_reply = True
            self.assertEqual(voice_text.transcribe_openai_compatible(wav_bytes, cfg), "call 4")
            close_after_reply = False
            self.assertEqual(voice_text.transcribe_openai_compatible(wav_bytes, cfg), "call 5")
            self.assertEqual(len(seen_client_ports), 5)
            self.assertEqual(len(set(seen_client_ports)), 2)
        finally:
            voice_text.close_http_pool()
            srv.shutdown()
            srv.server_close()
            thread.join(timeout=2)

    def test_fetch_remote_models_url_normalization_parsing_and_errors(self):
        self.assertEqual(
            voice_text.normalize_models_url("https://api.openai.com"),
            "https://api.openai.com/v1/models",
        )
        self.assertEqual(
            voice_text.normalize_models_url("https://api.groq.com/openai/v1"),
            "https://api.groq.com/openai/v1/models",
        )
        self.assertEqual(
            voice_text.normalize_models_url("https://api.example.com/v1/chat/completions", "rewrite_base_url"),
            "https://api.example.com/v1/models",
        )
        self.assertEqual(
            voice_text.normalize_models_url("https://api.example.com/v1/audio/transcriptions", "stt_base_url"),
            "https://api.example.com/v1/models",
        )
        with self.assertRaises(voice_text.TextConfigError):
            voice_text.normalize_models_url("http://insecure.example.com/v1", "stt_base_url")

        seen = {}

        class ModelsHandler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                seen["path"] = self.path
                seen["auth"] = self.headers.get("Authorization")
                if self.path.startswith("/auth-fail"):
                    self.send_response(401)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if self.path.startswith("/not-found"):
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                payload = json.dumps({
                    "data": [
                        {"id": "Qwen/Qwen2.5-7B-Instruct"},
                        {"id": "whisper-large-v3-turbo"},
                        {"id": "whisper-large-v3-turbo"},
                        {"id": "gpt-4o-mini"},
                        {"id": ""},
                    ]
                }).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        srv = HTTPServer(("127.0.0.1", 0), ModelsHandler)
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{srv.server_address[1]}/v1"
            ok = voice_text.fetch_remote_models(base, api_key="sk-secret-abc", field="stt_base_url")
            self.assertTrue(ok["ok"], ok)
            self.assertEqual(ok["models"], ["whisper-large-v3-turbo", "Qwen/Qwen2.5-7B-Instruct", "gpt-4o-mini"])
            self.assertEqual(seen["path"], "/v1/models")
            self.assertEqual(seen["auth"], "Bearer sk-secret-abc")

            ok_rw = voice_text.fetch_remote_models(base, api_key="sk-secret-abc", field="rewrite_base_url")
            self.assertEqual(ok_rw["models"], ["Qwen/Qwen2.5-7B-Instruct", "whisper-large-v3-turbo", "gpt-4o-mini"])

            sf_body, _ = voice_text._build_multipart_wav(b"RIFF", model="FunAudioLLM/SenseVoiceSmall", language="zh", prompt="OpenCode", minimal=True)
            self.assertNotIn(b'name="response_format"', sf_body)
            self.assertNotIn(b'name="language"', sf_body)
            self.assertEqual(voice_text.validate_stt_api_key(" sk-abc\r\n "), "sk-abc")

            unauth = voice_text.fetch_remote_models(
                f"http://127.0.0.1:{srv.server_address[1]}/auth-fail/v1",
                api_key="sk-secret-abc",
            )
            self.assertFalse(unauth["ok"])
            self.assertIn("HTTP 401", unauth["message"])
            self.assertNotIn("sk-secret-abc", unauth["message"])

            missing = voice_text.fetch_remote_models(f"http://127.0.0.1:{srv.server_address[1]}/not-found/v1")
            self.assertFalse(missing["ok"])
            self.assertIn("/models", missing["message"])

            # Custom opener raising urllib.error.HTTPError must be handled cleanly.
            import io as _io
            from urllib.error import HTTPError as _HTTPError

            def failing_opener(_req, timeout=15):
                raise _HTTPError(
                    "https://api.example.com/v1/models", 401, "Unauthorized", {}, _io.BytesIO(b'{"error":{"message":"bad key"}}')
                )

            opener_err = voice_text.fetch_remote_models(
                "https://api.example.com/v1", api_key="sk-secret-abc", opener=failing_opener
            )
            self.assertFalse(opener_err["ok"])
            self.assertIn("HTTP 401", opener_err["message"])
            self.assertIn("bad key", opener_err["message"])
            self.assertNotIn("sk-secret-abc", opener_err["message"])
        finally:
            voice_text.close_http_pool()
            srv.shutdown()
            srv.server_close()
            thread.join(timeout=2)

    def test_process_transcript_forwards_recognized_language_to_rewrite_prompt(self):
        seen_prompts = []

        def opener(request, timeout=15):
            payload = json.loads(request.data.decode("utf-8"))
            seen_prompts.append(payload["messages"][0]["content"])
            body = json.dumps({"choices": [{"message": {"content": "改写结果"}, "finish_reason": "stop"}]}).encode("utf-8")

            class _Resp:
                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return False

                def read(self, _n=-1):
                    return body

            return _Resp()

        cfg = voice_text.validate_text_config({
            "text_mode": "ai",
            "rewrite_base_url": "https://api.example.com/v1",
            "rewrite_model": "test-model",
        })
        # Pure ASCII text with recognized_language="zh" must still receive the Chinese prompt.
        local, final, warning = voice_text.process_transcript(
            "API JSON HTTP", cfg, recognized_language="zh", api_key="sk-test", opener=opener
        )
        self.assertEqual((local, final, warning), ("API JSON HTTP", "改写结果", None))
        self.assertEqual(seen_prompts, [voice_text.DEFAULT_REWRITE_PROMPT_ZH])

    def test_http_pool_keeps_ssl_sockets_and_retries_on_ssl_eof(self):
        import ssl

        class FakeSSLSocket(ssl.SSLSocket):
            def __init__(self, so_error=0):
                self._so_error = so_error

            def fileno(self):
                return 42

            def getsockopt(self, _level, _optname):
                return self._so_error

        class FakeConn:
            def __init__(self, sock):
                self.sock = sock
                self.timeout = 5.0
                self.closed = False
                self.connected = False

            def connect(self):
                self.connected = True

            def close(self):
                self.closed = True

        # Healthy SSLSocket must remain reusable (TLS 1.3 NewSessionTicket is readable).
        self.assertTrue(voice_text._HttpConnectionPool._is_socket_healthy(FakeConn(FakeSSLSocket(0))))
        self.assertFalse(voice_text._HttpConnectionPool._is_socket_healthy(FakeConn(FakeSSLSocket(104))))

        # Stale SSL socket raising SSLEOFError on first attempt must retry cleanly on a fresh connection.
        pool = voice_text._HttpConnectionPool()
        calls = []

        class FirstEofConn:
            sock = object()

            def request(self, *_args, **_kwargs):
                calls.append("stale")
                raise ssl.SSLEOFError("EOF occurred in violation of protocol")

            def close(self):
                calls.append("stale_close")

        class FreshResp:
            status = 200
            will_close = True

            def read(self, _limit):
                return b'{"text":"recovered"}'

        class FreshConn:
            sock = None

            def connect(self):
                calls.append("fresh_connect")

            def request(self, *_args, **_kwargs):
                calls.append("fresh_request")

            def getresponse(self):
                return FreshResp()

            def close(self):
                calls.append("fresh_close")

        seq = iter([(FirstEofConn(), True), (FreshConn(), False)])
        pool._acquire = lambda *_args, **_kwargs: next(seq)  # type: ignore[method-assign]
        status, body = pool.request_post("https://example.com/v1/audio/transcriptions", body=b"hi", headers={}, timeout=5, max_read_bytes=1024)
        self.assertEqual((status, body), (200, b'{"text":"recovered"}'))
        self.assertEqual(calls, ["stale", "stale_close", "fresh_connect", "fresh_request", "fresh_close"])

    def test_http_pool_concurrent_stress_with_periodic_server_close(self):
        from concurrent.futures import ThreadPoolExecutor
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        voice_text.close_http_pool()
        counter_lock = threading.Lock()
        served = [0]

        class StressHandler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_POST(self):
                size = int(self.headers.get("Content-Length", "0"))
                _ = self.rfile.read(size)
                with counter_lock:
                    served[0] += 1
                    seq = served[0]
                payload = json.dumps({"text": f"ok-{seq}"}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                if seq % 4 == 0:
                    self.send_header("Connection", "close")
                    self.close_connection = True
                else:
                    self.send_header("Connection", "keep-alive")
                self.end_headers()
                self.wfile.write(payload)

        srv = ThreadingHTTPServer(("127.0.0.1", 0), StressHandler)
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{srv.server_address[1]}/v1"
            cfg = {"stt_base_url": base, "stt_model": "whisper-1", "stt_timeout": 10}
            wav_bytes = voice_text._silent_wav16k()

            def call_one(_idx):
                return voice_text.transcribe_openai_compatible(wav_bytes, cfg)

            with ThreadPoolExecutor(max_workers=6) as executor:
                results = list(executor.map(call_one, range(30)))
            self.assertEqual(len(results), 30)
            self.assertTrue(all(item.startswith("ok-") for item in results))
            self.assertEqual(served[0], 30)
        finally:
            voice_text.close_http_pool()
            srv.shutdown()
            srv.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
