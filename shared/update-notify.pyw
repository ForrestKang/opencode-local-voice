"""Show a short native Windows message for a recovery failure.

Only the fixed, user-facing sentence is read into the dialog.  Recovery
details remain in the maintenance log and are never echoed by this helper.
"""
from __future__ import annotations

import argparse
import ctypes
from pathlib import Path


DEFAULT_MESSAGE = "本地语音暂不可用，请查看恢复日志或重启 OpenCode。"
ALLOWED_MESSAGES = {
    DEFAULT_MESSAGE,
    "本地语音暂不可用，已启动官方 OpenCode。",
    "本地语音暂不可用，请查看恢复日志。",
    "语音恢复正在进行，请稍后重试。",
    "请先退出 OpenCode，完成语音恢复后再启动。",
    "更新等待超时，语音暂不可用。",
    "更新已取消，已保留原版语音入口。",
    "更新已取消，官方 OpenCode 包已保留。",
    "更新未替换 OpenCode，已保留原版语音入口。",
    "更新后的本地语音暂不可用，官方 OpenCode 包已保留。",
    "OpenCode 已更新，但语音快捷方式需要重新维护。",
    "OpenCode 已更新，请稍后重新启动以使用语音。",
}


def read_message(filename: str | None) -> str:
    if not filename:
        return DEFAULT_MESSAGE
    try:
        text = Path(filename).read_text(encoding="utf-8-sig").strip()
    except Exception:
        return DEFAULT_MESSAGE
    # The core writes one of these fixed sentences.  Never echo arbitrary
    # details from a stale or corrupted message file into a native dialog.
    return text if text in ALLOWED_MESSAGES else DEFAULT_MESSAGE


def show(message: str) -> None:
    try:
        ctypes.windll.user32.MessageBoxW(None, message, "OpenCode 本地语音", 0x10)
    except Exception:
        pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--message-file")
    try:
        args, _ = parser.parse_known_args(argv)
        show(read_message(args.message_file))
    except Exception:
        show(DEFAULT_MESSAGE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
