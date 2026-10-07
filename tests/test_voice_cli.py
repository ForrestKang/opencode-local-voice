"""Invalid CLI inputs must fail before starting the local service."""
import io
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from shared import voice_cli


class CliPreflightTests(unittest.TestCase):
    def test_invalid_recording_arguments_do_not_start_server(self):
        store = SimpleNamespace(get=lambda: {"max_seconds": 120})
        for arguments in (["--record"], ["--record", "--mic", "fake", "--duration", "0"],
                          ["--record", "--mic", "fake", "--duration", "121"]):
            with self.subTest(arguments=arguments), patch.object(voice_cli, "ConfigStore", return_value=store), \
                    patch.object(voice_cli, "ensure_server") as ensure, \
                    patch.object(voice_cli.sys, "stderr", io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    voice_cli.main(arguments)
                self.assertEqual(error.exception.code, 2)
                ensure.assert_not_called()

    def test_missing_audio_file_does_not_start_server(self):
        store = SimpleNamespace(get=lambda: {"max_seconds": 120})
        with patch.object(voice_cli, "ConfigStore", return_value=store), \
                patch.object(voice_cli, "ensure_server") as ensure, \
                patch.object(voice_cli.sys, "stderr", io.StringIO()):
            self.assertEqual(voice_cli.main(["--file", "missing-audio-file-for-cli-test.wav"]), 1)
            ensure.assert_not_called()
