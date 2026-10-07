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


if __name__ == "__main__":
    unittest.main()
