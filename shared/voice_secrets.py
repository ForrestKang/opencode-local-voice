"""Private storage for the optional rewrite API key.

Windows uses the current user's DPAPI context. POSIX stores the value in a
0600 file. A pre-DPAPI plaintext Windows file is upgraded when it is read.
"""
from __future__ import annotations

import base64
import ctypes
import os
import secrets
import stat
from pathlib import Path
from typing import Any


_DPAPI_PREFIX = b"DPAPI1:"
_CRYPTPROTECT_UI_FORBIDDEN = 0x1


class SecretStorageError(RuntimeError):
    pass


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_ulong), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


def _make_blob(data: bytes) -> tuple[_DataBlob, Any]:
    buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    return _DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte))), buffer


def _dpapi(data: bytes, *, decrypt: bool) -> bytes:
    if os.name != "nt":
        raise SecretStorageError("DPAPI is only available on Windows")
    crypt32 = ctypes.WinDLL("crypt32.dll", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32.dll", use_last_error=True)
    source, source_buffer = _make_blob(data)
    destination = _DataBlob()
    if decrypt:
        function = crypt32.CryptUnprotectData
        function.argtypes = [ctypes.POINTER(_DataBlob), ctypes.c_void_p, ctypes.POINTER(_DataBlob),
                             ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(_DataBlob)]
        function.restype = ctypes.c_int
        ok = function(ctypes.byref(source), None, None, None, None,
                      _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(destination))
    else:
        function = crypt32.CryptProtectData
        function.argtypes = [ctypes.POINTER(_DataBlob), ctypes.c_wchar_p, ctypes.POINTER(_DataBlob),
                             ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(_DataBlob)]
        function.restype = ctypes.c_int
        ok = function(ctypes.byref(source), "OpenCode Local Voice", None, None, None,
                      _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(destination))
    # Keep the source buffer live until the native call has returned.
    _ = source_buffer
    if not ok:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(destination.pbData, destination.cbData)
    finally:
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        kernel32.LocalFree(destination.pbData)


class SecretStore:
    def __init__(self, home: Path):
        self.home = Path(home)
        self.path = self.home / "rewrite_api_key"

    def _protect(self, value: str) -> bytes:
        raw = value.encode("utf-8")
        if os.name == "nt":
            return _DPAPI_PREFIX + base64.b64encode(_dpapi(raw, decrypt=False)) + b"\n"
        return raw + b"\n"

    def _unprotect(self, raw: bytes) -> str:
        if os.name == "nt" and raw.startswith(_DPAPI_PREFIX):
            try:
                ciphertext = base64.b64decode(raw[len(_DPAPI_PREFIX):].strip(), validate=True)
                raw = _dpapi(ciphertext, decrypt=True)
            except Exception as exc:
                raise SecretStorageError("rewrite credential cannot be decrypted for this Windows user") from exc
        elif os.name == "nt":
            # Migrate an older plaintext file to the user's DPAPI store.
            try:
                legacy = raw.rstrip(b"\r\n").decode("utf-8")
            except UnicodeDecodeError as exc:
                raise SecretStorageError("legacy rewrite credential is invalid") from exc
            if (not legacy or len(legacy) > 4096 or
                    any(ord(char) < 0x20 or ord(char) > 0x7E for char in legacy)):
                raise SecretStorageError("legacy rewrite credential is invalid")
            self.write(legacy)
            return legacy
        try:
            return raw.rstrip(b"\r\n").decode("utf-8")
        except UnicodeDecodeError as exc:
            raise SecretStorageError("rewrite credential file is invalid") from exc

    def read(self) -> str:
        try:
            raw = self.path.read_bytes()
        except FileNotFoundError:
            return ""
        except OSError as exc:
            raise SecretStorageError("rewrite credential file is unreadable") from exc
        try:
            value = self._unprotect(raw)
        except SecretStorageError:
            raise
        except Exception as exc:
            raise SecretStorageError("rewrite credential file is invalid") from exc
        if os.name != "nt":
            try:
                os.chmod(self.path, stat.S_IRUSR | stat.S_IWUSR)
            except OSError as exc:
                raise SecretStorageError("could not secure rewrite credential file") from exc
        return value

    def write(self, value: str) -> None:
        if not value:
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass
            except OSError as exc:
                raise SecretStorageError("could not clear rewrite credential") from exc
            return
        try:
            data = self._protect(value)
            tmp = self.home / (".rewrite-key-" + secrets.token_hex(8) + ".tmp")
            fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(fd, "wb") as output:
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
                if os.name != "nt":
                    os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
                os.replace(tmp, self.path)
                if os.name != "nt":
                    os.chmod(self.path, stat.S_IRUSR | stat.S_IWUSR)
            finally:
                try:
                    tmp.unlink()
                except FileNotFoundError:
                    pass
        except SecretStorageError:
            raise
        except Exception as exc:
            raise SecretStorageError("could not persist rewrite credential") from exc

    def migrate_legacy_text(self, value: str) -> str:
        """Move a key found inside legacy config.json to the private store."""
        current = self.read()
        if not current and value:
            self.write(value)
            return value
        return current
