"""Candidate packaging must never include user data or local credentials."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release_tool", ROOT / "tools/package-release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
verify_spec = importlib.util.spec_from_file_location("verify_release", ROOT / "tools/verify-release.py")
verify_release = importlib.util.module_from_spec(verify_spec)
verify_spec.loader.exec_module(verify_release)


class ReleaseTests(unittest.TestCase):
    def test_windows_candidate_contains_shared_runtime_and_verified_hash_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            result = release.build(Path(directory) / "candidate.zip", "windows")
            with zipfile.ZipFile(result["file"]) as archive:
                names = archive.namelist()
                prefix = names[0].split("/")[0] + "/"
                self.assertIn(prefix + "shared/voice_server.py", names)
                self.assertIn(prefix + "shared/desktop-bridge.cjs", names)
                self.assertIn(prefix + "shared/voice_text.py", names)
                self.assertIn(prefix + "shared/voice_secrets.py", names)
                self.assertIn(prefix + "shared/feature-update.cjs", names)
                self.assertIn(prefix + "windows/install-feature-preview.ps1", names)
                self.assertIn(prefix + "windows/install.ps1", names)
                self.assertNotIn(prefix + "macos/install.sh", names)
                self.assertNotIn(prefix + "tests/bridge.test.cjs", names)
                self.assertNotIn(prefix + "package.json", names)
                self.assertIn(prefix + "tools/make-web-script.py", names)
                for name in names:
                    self.assertNotIn("node_modules", name)
                    self.assertNotIn("test-results", name)
                    self.assertFalse(name.endswith(".personal.user.js"))
                    self.assertNotIn("/token", name)
                    self.assertNotIn("/.git/", name)
                manifest = archive.read(prefix + "CONTENTS.sha256").decode()
                for line in manifest.splitlines():
                    digest, relative = line.split("  ", 1)
                    self.assertEqual(hashlib.sha256(archive.read(prefix + relative)).hexdigest(), digest)

    def test_shell_scripts_keep_executable_zip_attributes(self):
        with tempfile.TemporaryDirectory() as directory:
            result = release.build(Path(directory) / "candidate.zip", "macos")
            with zipfile.ZipFile(result["file"]) as archive:
                name = next(name for name in archive.namelist() if name.endswith("macos/install.sh"))
                self.assertEqual((archive.getinfo(name).external_attr >> 16) & 0o777, 0o755)

    def test_build_refuses_unknown_platform_and_missing_source_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "Unknown release platform"):
                release.build(Path(directory) / "invalid.zip", "../private")
            with patch.object(release, "release_files", return_value=[Path(directory) / "missing.md"]):
                with self.assertRaisesRegex(ValueError, "existing regular files"):
                    release.build(Path(directory) / "missing.zip")

    def test_archive_verifier_rejects_tampering_and_private_payloads(self):
        version = (ROOT / "VERSION").read_text().strip()
        prefix = f"opencode-local-voice-{version}/"
        with tempfile.TemporaryDirectory() as directory:
            source = release.build(Path(directory) / "good.zip", "windows")
            self.assertEqual(verify_release.verify_archive(source["file"], version, "windows"), source["files"])
            with zipfile.ZipFile(source["file"]) as archive:
                entries = {name: archive.read(name) for name in archive.namelist()}
            for extra, expected in ((prefix + "README.md", "hash mismatch"),
                                    (prefix + "shared/token", "private ZIP entry"),
                                    (prefix + "../outside.md", "Unsafe")):
                with self.subTest(extra=extra):
                    broken = Path(directory) / "broken.zip"
                    altered = {**entries, extra: b"tampered"}
                    with zipfile.ZipFile(broken, "w") as archive:
                        for name, content in altered.items():
                            archive.writestr(name, content)
                    with self.assertRaisesRegex(ValueError, expected):
                        verify_release.verify_archive(broken, version, "windows")


if __name__ == "__main__":
    unittest.main()
