"""Local transcript formatting and optional OpenAI-compatible rewriting.

This module deliberately keeps local transforms deterministic and makes the
network rewrite an explicit, bounded operation. Speech recognition remains a
successful job when rewriting is unavailable: callers receive the local text
and a safe warning instead.
"""
from __future__ import annotations

import copy
import functools
import io
import json
import re
import threading
import time
import urllib.parse
import uuid
from typing import Any, Callable


DEFAULT_REWRITE_PROMPT = (
    "Improve the transcript's readability while preserving the speaker's exact meaning, "
    "intent, facts, technical terms, uncertainty, and point of view. Do not add, infer, "
    "or omit information. Return only the rewritten text."
)
DEFAULT_REWRITE_PROMPT_ZH = (
    "在改善文本可读性的同时，准确保留说话者的原意、意图、事实、技术术语、不确定性和观点。"
    "不得添加、推断或省略信息。只输出改写后的文本。"
)

DEFAULT_TEXT_CONFIG: dict[str, Any] = {
    "vocabulary_preset": "coding",
    "vocabulary": [],
    "replacements": [],
    "punctuation_mode": "auto",
    "space_mode": "preserve",
    "text_mode": "clean",
    "prompt_template": "{text}",
    "rewrite_base_url": "",
    "rewrite_model": "",
    "rewrite_prompt": DEFAULT_REWRITE_PROMPT,
    "rewrite_timeout": 15,
}

DEFAULT_STT_CONFIG: dict[str, Any] = {
    "stt_base_url": "",
    "stt_model": "",
    "stt_timeout": 30,
}

TEXT_CONFIG_FIELDS = frozenset(DEFAULT_TEXT_CONFIG)
STT_CONFIG_FIELDS = frozenset(DEFAULT_STT_CONFIG)
CONFIG_PATCH_CREDENTIAL_FIELDS = frozenset({"rewrite_api_key", "stt_api_key"})

# Intentionally a recognition hint rather than a correction table. These terms
# bias Whisper without forcing broad substitutions into the user's transcript.
CODING_VOCABULARY = (
    "OpenCode", "Whisper", "faster-whisper", "CTranslate2", "CUDA", "MLX",
    "Python", "TypeScript", "JavaScript", "React", "API", "HTTP", "JSON",
    "GitHub", "VS Code", "CLI", "GPU", "CPU", "Git", "Node.js",
    "函数", "接口", "变量", "报错", "终端", "插件", "仓库", "代码", "项目", "模型",
)

MAX_VOCABULARY_ITEMS = 100
MAX_VOCABULARY_ITEM_CHARS = 80
MAX_VOCABULARY_TOTAL_CHARS = 4096
MAX_REPLACEMENTS = 100
MAX_REPLACEMENT_ITEM_CHARS = 80
MAX_REPLACEMENT_TOTAL_CHARS = 8192
MAX_REWRITE_KEY_CHARS = 4096
MAX_REWRITE_TEXT_CHARS = 100_000
MAX_REWRITE_RESPONSE_BYTES = 1_000_000

_SAFE_WARNING = "AI 改写未完成，已保留本地识别结果。"
_LOCAL_WARNING = "文本整理未完成，已保留本地识别结果。"


class TextConfigError(ValueError):
    pass


def _bounded_text(value: Any, name: str, maximum: int, *, allow_empty: bool = True) -> str:
    if not isinstance(value, str) or len(value) > maximum or (not allow_empty and not value.strip()):
        qualifier = f" up to {maximum} characters" if allow_empty else f" with 1 to {maximum} characters"
        raise TextConfigError(f"{name} must be text{qualifier}")
    if any(ord(char) < 0x20 and char not in "\t\n\r" for char in value):
        raise TextConfigError(f"{name} contains unsupported control characters")
    return value


def _single_line_text(value: Any, name: str, maximum: int, *, allow_empty: bool = True) -> str:
    value = _bounded_text(value, name, maximum, allow_empty=allow_empty)
    if any(char in value for char in "\r\n\t"):
        raise TextConfigError(f"{name} must not contain tabs or line breaks")
    return value


def validate_replacements(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list) or len(value) > MAX_REPLACEMENTS:
        raise TextConfigError(f"replacements must be a list of at most {MAX_REPLACEMENTS} items")
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    total = 0
    for item in value:
        if not isinstance(item, dict) or set(item) != {"from", "to"}:
            raise TextConfigError("each replacement must contain only from and to text")
        source = _single_line_text(item["from"], "replacement from", MAX_REPLACEMENT_ITEM_CHARS, allow_empty=False).strip()
        target = _single_line_text(item["to"], "replacement to", MAX_REPLACEMENT_ITEM_CHARS).strip()
        if not source:
            raise TextConfigError("replacement from cannot be empty")
        if source in seen:
            raise TextConfigError("replacement sources must be unique")
        seen.add(source)
        total += len(source) + len(target)
        if total > MAX_REPLACEMENT_TOTAL_CHARS:
            raise TextConfigError("replacement text exceeds the total size limit")
        result.append({"from": source, "to": target})
    return result


def validate_text_config(config: dict[str, Any]) -> dict[str, Any]:
    """Merge and validate text-only fields while preserving existing configs."""
    if not isinstance(config, dict):
        raise TextConfigError("configuration must be a JSON object")
    unknown = set(config) - TEXT_CONFIG_FIELDS
    if unknown:
        raise TextConfigError("unknown text configuration field(s): " + ", ".join(sorted(unknown)))
    result = copy.deepcopy(DEFAULT_TEXT_CONFIG)
    result.update(copy.deepcopy(config))

    if result["vocabulary_preset"] not in ("none", "coding"):
        raise TextConfigError("vocabulary_preset must be none or coding")
    vocabulary = result["vocabulary"]
    if not isinstance(vocabulary, list) or len(vocabulary) > MAX_VOCABULARY_ITEMS:
        raise TextConfigError(f"vocabulary must be a list of at most {MAX_VOCABULARY_ITEMS} items")
    clean_vocabulary: list[str] = []
    seen_vocabulary: set[str] = set()
    total_vocabulary = 0
    for term in vocabulary:
        normalized_term = _single_line_text(term, "vocabulary item", MAX_VOCABULARY_ITEM_CHARS, allow_empty=False).strip()
        if not normalized_term:
            raise TextConfigError("vocabulary items cannot be empty")
        if normalized_term not in seen_vocabulary:
            clean_vocabulary.append(normalized_term)
            seen_vocabulary.add(normalized_term)
            total_vocabulary += len(normalized_term)
    if total_vocabulary > MAX_VOCABULARY_TOTAL_CHARS:
        raise TextConfigError("vocabulary exceeds the total size limit")
    result["vocabulary"] = clean_vocabulary

    result["replacements"] = validate_replacements(result["replacements"])
    if result["punctuation_mode"] not in ("auto", "zh", "en", "none"):
        raise TextConfigError("punctuation_mode must be auto, zh, en, or none")
    if result["space_mode"] not in ("preserve", "smart", "space-to-comma", "comma-to-space"):
        raise TextConfigError("space_mode must be preserve, smart, space-to-comma, or comma-to-space")
    if result["text_mode"] not in ("original", "clean", "coding-prompt", "analysis-prompt", "custom", "ai"):
        raise TextConfigError("text_mode must be original, clean, coding-prompt, analysis-prompt, custom, or ai")
    result["prompt_template"] = _bounded_text(result["prompt_template"], "prompt_template", 6000)
    if result["prompt_template"].count("{text}") != 1:
        raise TextConfigError("prompt_template must contain exactly one {text} placeholder")

    result["rewrite_base_url"] = _bounded_text(result["rewrite_base_url"], "rewrite_base_url", 2048).strip()
    if result["rewrite_base_url"]:
        normalize_rewrite_url(result["rewrite_base_url"])
    result["rewrite_model"] = _bounded_text(result["rewrite_model"], "rewrite_model", 256).strip()
    result["rewrite_prompt"] = _bounded_text(result["rewrite_prompt"], "rewrite_prompt", 4000, allow_empty=False).strip()
    timeout = result["rewrite_timeout"]
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 5 <= timeout <= 60:
        raise TextConfigError("rewrite_timeout must be an integer from 5 to 60")
    return result


def validate_api_key_value(value: Any, field: str = "rewrite_api_key") -> str:
    value = _bounded_text(value, field, MAX_REWRITE_KEY_CHARS).strip()
    if any(ord(char) < 0x20 or ord(char) > 0x7E for char in value):
        raise TextConfigError(f"{field} contains unsupported characters")
    return value


def validate_rewrite_api_key(value: Any) -> str:
    return validate_api_key_value(value, "rewrite_api_key")


def validate_stt_api_key(value: Any) -> str:
    return validate_api_key_value(value, "stt_api_key")


def _normalize_openai_url(value: str, suffix: str, field: str) -> str:
    """Validate an OpenAI-compatible HTTP(S) endpoint and normalize its path."""
    if not isinstance(value, str) or not value or len(value) > 2048 or any(ord(c) < 0x21 or ord(c) == 0x7F for c in value):
        raise TextConfigError(f"{field} must be a valid HTTP(S) endpoint")
    try:
        parsed = urllib.parse.urlsplit(value)
        hostname = parsed.hostname
        _ = parsed.port
    except ValueError as exc:
        raise TextConfigError(f"{field} must be a valid HTTP(S) endpoint") from exc
    if not hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise TextConfigError(f"{field} cannot contain credentials, query, or fragment")
    scheme = parsed.scheme.casefold()
    loopback_hosts = {"localhost", "127.0.0.1", "::1"}
    if scheme != "https" and not (scheme == "http" and hostname.casefold() in loopback_hosts):
        raise TextConfigError(f"{field} must use HTTPS or local loopback HTTP")
    path = parsed.path.rstrip("/")
    v1_suffix = "/v1" + suffix
    if path.casefold().endswith(v1_suffix) or path.casefold().endswith(suffix):
        endpoint_path = path
    elif path.casefold().endswith("/v1"):
        endpoint_path = path + suffix
    else:
        endpoint_path = path + v1_suffix
    netloc = parsed.netloc
    return urllib.parse.urlunsplit((scheme, netloc, endpoint_path, "", ""))


def normalize_rewrite_url(value: str) -> str:
    """Return an OpenAI-compatible chat-completions URL after strict checks."""
    return _normalize_openai_url(value, "/chat/completions", "rewrite_base_url")


def normalize_stt_url(value: str) -> str:
    """Return an OpenAI-compatible audio-transcriptions URL after strict checks."""
    return _normalize_openai_url(value, "/audio/transcriptions", "stt_base_url")


def normalize_models_url(value: str, field: str = "base_url") -> str:
    """Return an OpenAI-compatible GET /models URL after strict endpoint checks."""
    if not isinstance(value, str):
        raise TextConfigError(f"{field} must be a valid HTTP(S) endpoint")
    candidate = value.strip()
    if candidate:
        try:
            parsed = urllib.parse.urlsplit(candidate)
        except ValueError as exc:
            raise TextConfigError(f"{field} must be a valid HTTP(S) endpoint") from exc
        path = parsed.path.rstrip("/")
        lowered = path.casefold()
        for suffix in ("/chat/completions", "/audio/transcriptions"):
            if lowered.endswith(suffix):
                path = path[:-len(suffix)]
                break
        candidate = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query, parsed.fragment))
    return _normalize_openai_url(candidate, "/models", field)


MAX_REMOTE_MODELS_BYTES = 2 * 1024 * 1024
MAX_REMOTE_MODEL_COUNT = 500


@functools.lru_cache(maxsize=8)
def _build_asr_hints_cached(preset: str, vocab_items: tuple[str, ...], base: str, maximum: int,
                            language: str = "auto") -> tuple[str, str]:
    terms: list[str] = []
    if preset == "coding":
        terms.extend(CODING_VOCABULARY)
    terms.extend(vocab_items)
    deduped: list[str] = []
    seen: set[str] = set()
    for term in terms:
        if term not in seen:
            deduped.append(term)
            seen.add(term)
    # Keep full technical vocabulary in CTranslate2 hotwords so it biases decoding
    # without feeding Whisper an unpunctuated English word list as initial_prompt.
    hotwords = ", ".join(deduped)[:MAX_VOCABULARY_TOTAL_CHARS].rstrip(" ,")
    anchor_terms = [item for item in vocab_items if item]
    if preset == "coding" and "OpenCode" not in anchor_terms:
        anchor_terms.insert(0, "OpenCode")
    if language == "en":
        lead = (
            base.rstrip(" .") + ". "
            if base
            else "Transcribe naturally with commas, periods, and question marks. "
        )
        tail = (", ".join(anchor_terms) + ".") if anchor_terms else ""
    else:
        # Whisper follows the punctuation style of the prompt context rather than meta-instructions.
        # Keep the anchor domain-neutral so it does not collide with technical speech or trigger tails.
        zh_style_anchor = "嗯，好的，明白。如果有问题，我们再确认一下。"
        if base:
            has_zh_punct = any(ch in base for ch in "，。！？")
            lead = base.rstrip(" .。") + ". " + ("" if has_zh_punct else zh_style_anchor)
        else:
            lead = zh_style_anchor
        tail = ("、".join(anchor_terms) + "。") if anchor_terms else ""
    hint = (lead + tail).strip()[:maximum].rstrip(" ,;.")
    return hint, hotwords


def build_asr_hints(config: dict[str, Any], maximum: int = 1900) -> tuple[str, str]:
    """Build a bounded initial prompt and hotword string for local Whisper."""
    preset = config.get("vocabulary_preset", "coding")
    raw_vocab = config.get("vocabulary", [])
    vocab_items = tuple(raw_vocab) if isinstance(raw_vocab, (list, tuple)) else ()
    base = str(config.get("initial_prompt", "")).strip()
    language = str(config.get("language", "auto") or "auto").strip()
    return _build_asr_hints_cached(str(preset), vocab_items, base, int(maximum), language)


# Hoist regex compilation to module scope; the second flag identifies URL/path rules
# whose trailing sentence punctuation should stay outside the protected span.
_PROTECTED_PATTERNS: tuple[tuple[re.Pattern[str], bool], ...] = (
    (re.compile(r"(?ms)^ {0,3}(`{3,}|~{3,})[^\n]*\n.*?^ {0,3}\1[ \t]*(?=\n|$)"), False),
    (re.compile(r"(`+)[^`\n]*?\1"), False),
    (re.compile(r"(?i)\b(?:https?://|www\.)[^\s<>]+"), True),
    (re.compile(r"(?<![\w.+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![\w.-])", re.IGNORECASE), False),
    (re.compile(r"(?<![\w])(?:[A-Za-z]:[\\/][^\s<>\"']+|\\\\[^\\/\s]+[\\/][^\s<>\"']+)"), True),
    (re.compile(r"(?<![\w])/(?:[^/\s]+/)+[^\s<>\"']*"), False),
    # Relative paths are easy to damage with comma and space conversions too.
    (re.compile(r"(?<![\w:/])(?:\.{1,2}/)?[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+(?![\w/])"), True),
    (re.compile(r"(?<![\w:])(?:\.{1,2}\\)?[A-Za-z0-9_.-]+(?:\\[A-Za-z0-9_.-]+)+(?![\w\\])"), True),
    (re.compile(r"(?<![\w.])\d+(?:\.\d+){1,}\b"), False),
    # Keep common numeric formats and measurements intact, including their gap to a unit.
    (
        re.compile(
            r"(?<![\w.])[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?"
            r"(?:\s?(?:%|％|°[CF]|℃|℉|ms|msec|s|sec|secs|second|seconds|min|mins|h|hr|hrs|day|days|"
            r"hz|khz|mhz|ghz|thz|b|byte|bytes|kb|mb|gb|tb|kib|mib|gib|tib|px|dp|rpm|"
            r"mv|kv|v|mw|kw|w|ma|ua|a|mah|wh|kwh|dbm|db|mm|cm|km|kg|mg|g|lb|lbs|°|c|f))?"
            r"(?!\w)",
            re.IGNORECASE,
        ),
        False,
    ),
    (re.compile(r"(?<!\d)\d{4}-\d{1,2}-\d{1,2}(?!\d)|(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?!\d)"), False),
    (re.compile(r"(?<![A-Za-z0-9_])(?:[A-Za-z]+[a-z][A-Z][A-Za-z0-9]*|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+|[A-Za-z_]*\d+[A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*|[A-Za-z_]\w*(?:(?:::|\.|->)[A-Za-z_]\w*)+)(?![A-Za-z0-9_])"), False),
    # Protect common source syntax even when recognition did not say "backtick".
    (re.compile(r"(?<![A-Za-z0-9_$])(?:(?:const|let|var|def)\s+)?[A-Za-z_$][\w$]*\s*(?:=|:=|=>)\s*[^\n,，。！？.!?;；:：`]{1,180}(?:;)?"), False),
    (re.compile(r"(?<![A-Za-z0-9_$])(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\([^()\n]{0,180}\)"), False),
    (re.compile(r"(?i)\b(?:git|npm|npx|pnpm|yarn|bun|pip|uv|python|node|cargo|docker|curl|ffmpeg)\s+(?:clone|install|add|run|test|build|status|diff|checkout|commit|push|pull|exec|create|open|serve|start|--?[\w-]+)\b[^\n,，。！？.!?;；:：`]{0,180}(?:;)?"), False),
    (re.compile(r"\bC\+\+|\b[A-Za-z]+#"), False),
)


def _protected_spans(text: str) -> list[tuple[int, int]]:
    found: list[tuple[int, int]] = []
    for pattern, strip_trailing_punct in _PROTECTED_PATTERNS:
        for match in pattern.finditer(text):
            start, end = match.span()
            if strip_trailing_punct:
                # URLs and paths commonly appear before sentence punctuation; leave that
                # punctuation available for language conversion.
                while end > start and text[end - 1] in ".,!?;:，。！？；：":
                    end -= 1
            if start < end:
                found.append((start, end))
    found.sort()
    merged: list[tuple[int, int]] = []
    for start, end in found:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return merged


def _map_safe_spans(text: str, transform: Callable[[str], str]) -> str:
    spans = _protected_spans(text)
    if not spans:
        return transform(text)
    pieces: list[str] = []
    cursor = 0
    for start, end in spans:
        if start > cursor:
            pieces.append(transform(text[cursor:start]))
        pieces.append(text[start:end])
        cursor = end
    pieces.append(transform(text[cursor:]))
    return "".join(pieces)


@functools.lru_cache(maxsize=16)
def _compile_replacements(pairs: tuple[tuple[str, str], ...]) -> tuple[re.Pattern[str], dict[str, str]]:
    ordered = sorted(pairs, key=lambda item: (-len(item[0]), item[0]))
    alternatives: list[str] = []
    target_by_group: dict[str, str] = {}
    for src, dst in ordered:
        source = re.escape(src)
        if src[0].isascii() and src[0].isalnum():
            source = r"(?<![A-Za-z0-9_])" + source
        if src[-1].isascii() and src[-1].isalnum():
            source += r"(?![A-Za-z0-9_])"
        group = f"R{len(alternatives)}"
        alternatives.append(f"(?P<{group}>{source})")
        target_by_group[group] = dst
    return re.compile("|".join(alternatives)), target_by_group


def apply_replacements(text: str, replacements: list[dict[str, str]]) -> str:
    """Apply literal, longest-first, single-pass replacements outside code/URLs."""
    if not replacements:
        return text
    pairs = tuple((item["from"], item["to"]) for item in replacements)
    combined, target_by_group = _compile_replacements(pairs)
    return _map_safe_spans(
        text,
        lambda segment: combined.sub(lambda match: target_by_group[match.lastgroup or ""], segment),
    )


def _choose_punctuation(mode: str, recognized_language: str | None, text: str) -> str:
    if mode != "auto":
        return mode
    cjk = sum("\u3400" <= char <= "\u9fff" for char in text)
    letters = sum(char.isalpha() for char in text)
    if cjk == 0 and letters > 0:
        return "en"
    if (recognized_language or "").casefold().startswith(("zh", "yue")):
        return "zh"
    return "zh" if cjk and cjk >= max(1, letters // 4) else "en"


def _chinese_output(text: str, recognized_language: str | None = None,
                    configured_language: str | None = None) -> bool:
    for language in (recognized_language, configured_language):
        code = (language or "").casefold().replace("_", "-")
        if code.startswith(("zh", "yue", "cmn", "chinese")):
            return True
        if code and code != "auto":
            return False
    cjk = sum("\u3400" <= char <= "\u9fff" for char in text)
    letters = sum(char.isalpha() for char in text)
    return bool(cjk and cjk >= max(1, letters // 4))


_TO_ZH = str.maketrans({",": "，", ".": "。", "?": "？", "!": "！", ";": "；", ":": "：",
                        "(": "（", ")": "）", "[": "【", "]": "】"})
_TO_EN = str.maketrans({"，": ",", "。": ".", "？": "?", "！": "!", "；": ";", "：": ":",
                        "（": "(", "）": ")", "【": "[", "】": "]"})


def _punctuate(segment: str, mode: str) -> str:
    if mode == "zh":
        return segment.translate(_TO_ZH)
    if mode == "en":
        return segment.translate(_TO_EN)
    return segment


_RE_LEADING_WS = re.compile(r"^[ \t\n]*")
_RE_TRAILING_WS = re.compile(r"[ \t\n]*$")
_RE_MULTI_SPACE = re.compile(r"[ \t]+")
_RE_NEWLINE_SPACE = re.compile(r" *\n *")
_RE_MULTI_NEWLINE = re.compile(r"\n{3,}")
_RE_SMART_CJK_SPACE = re.compile(r"(?<=[\u3400-\u9fff]) +(?=[\u3400-\u9fff])")
_RE_SMART_CJK_ASCII = re.compile(r"(?<=[\u3400-\u9fff])(?=[A-Za-z0-9])")
_RE_SMART_ASCII_CJK = re.compile(r"(?<=[A-Za-z0-9])(?=[\u3400-\u9fff])")
_RE_SMART_BEFORE_PUNCT = re.compile(r"\s+([,，。！？!?;；:：])")
_RE_SMART_AFTER_PUNCT = re.compile(r"([,，。！？!?;；:：])(?=[A-Za-z0-9])")
_RE_SPACE_TO_COMMA_CJK = re.compile(r"(?<=[\u3400-\u9fff])[ \t]+(?=[\u3400-\u9fff])")
_RE_COMMA_TO_SPACE = re.compile(r"[ \t]*[,，]+[ \t]*")
_ZH_SENTENCE_PUNCT = ",，。！？!?;；:：、"
_RE_ZH_CLAUSE_CONNECTOR = re.compile(
    r"(但是|不过|然后|所以|而且|因为|如果|另外|顺便|比如|还有|同时|并且|或者|就是)"
)
_RE_ZH_QUESTION = re.compile(
    r"(?:[吗呢么]$|(?:能不能|是不是|可不可以|有没有|为什么|怎么|哪里|多少|什么|好不好|行不行|对不对))"
)


def _smart_cjk_space_to_comma_or_join(body: str, mode: str) -> str:
    """Turn long Chinese pause spaces into commas while still joining short stray spaces."""
    if mode != "zh":
        return _RE_SMART_CJK_SPACE.sub("", body)

    def decide(match: re.Match[str]) -> str:
        start, end = match.span()
        # Count CJK chars since the previous punctuation or whitespace on the left.
        left_cjk = 0
        idx = start - 1
        while idx >= 0 and body[idx] not in _ZH_SENTENCE_PUNCT and body[idx] not in " \t\n":
            if "\u3400" <= body[idx] <= "\u9fff":
                left_cjk += 1
            idx -= 1
        right_cjk = 0
        idx = end
        while idx < len(body) and body[idx] not in _ZH_SENTENCE_PUNCT and body[idx] not in " \t\n":
            if "\u3400" <= body[idx] <= "\u9fff":
                right_cjk += 1
            idx += 1
        if left_cjk >= 4 and right_cjk >= 3:
            return "，"
        return ""

    return _RE_SMART_CJK_SPACE.sub(decide, body)


def _auto_punctuate_chinese_line(line: str) -> str:
    stripped = line.rstrip(" \t")
    if not stripped:
        return line
    cjk_count = sum("\u3400" <= ch <= "\u9fff" for ch in stripped)
    if cjk_count < 10:
        return line
    result = stripped
    # Collapse Whisper artifacts like "，。" at clause ends and upgrade obvious "[吗呢]。" to "？".
    result = re.sub(r"[，,]([。！？])", r"\1", result)
    result = re.sub(r"([吗呢])。", r"\1？", result)
    # Insert commas before clear clause-starting connectors inside any long unpunctuated Chinese span.
    spans = _protected_spans(result)

    def in_protected(pos: int) -> bool:
        return any(s <= pos < e for s, e in spans)

    inserts: list[int] = []
    # Split around existing inner punctuation so partially punctuated long sentences also get clause breaks.
    seg_start = 0
    punct_boundaries = [m.start() for m in re.finditer(r"[，。！？；：,.!?;:]", result) if not in_protected(m.start())]
    punct_boundaries.append(len(result))
    for seg_end in punct_boundaries:
        chunk = result[seg_start:seg_end]
        chunk_cjk = sum("\u3400" <= ch <= "\u9fff" for ch in chunk)
        if chunk_cjk >= 14:
            last_break = seg_start
            for match in _RE_ZH_CLAUSE_CONNECTOR.finditer(result, seg_start, seg_end):
                pos = match.start()
                if in_protected(pos):
                    continue
                if pos > seg_start and result[pos - 1] in _ZH_SENTENCE_PUNCT + " \t":
                    continue
                left_cjk = sum("\u3400" <= ch <= "\u9fff" for ch in result[last_break:pos])
                right_cjk = sum("\u3400" <= ch <= "\u9fff" for ch in result[pos:seg_end])
                if left_cjk >= 6 and right_cjk >= 4:
                    inserts.append(pos)
                    last_break = pos
        seg_start = seg_end + 1
    if inserts:
        pieces: list[str] = []
        cursor = 0
        for pos in inserts:
            pieces.append(result[cursor:pos])
            pieces.append("，")
            cursor = pos
        pieces.append(result[cursor:])
        result = "".join(pieces)
    if result.endswith("，") and cjk_count >= 10:
        tail = re.split(r"[。！？!?]", result[:-1])[-1]
        result = result[:-1] + ("？" if _RE_ZH_QUESTION.search(tail) else "。")
    elif result[-1] not in "，。！？；：,.!?;:…—)]}》\"'":
        spans = _protected_spans(result)
        ends_inside_protected = any(s <= len(result) - 1 < e for s, e in spans)
        if not ends_inside_protected:
            tail = re.split(r"[。！？!?]", result)[-1]
            result += "？" if _RE_ZH_QUESTION.search(tail) else "。"
    return result


def _auto_punctuate_chinese(text: str) -> str:
    return "\n".join(_auto_punctuate_chinese_line(line) for line in text.split("\n"))


def _clean_segment(segment: str, mode: str, space_mode: str) -> str:
    leading_match = _RE_LEADING_WS.match(segment)
    trailing_match = _RE_TRAILING_WS.search(segment)
    leading = leading_match.group(0) if leading_match else ""
    trailing = trailing_match.group(0) if trailing_match else ""
    end = len(segment) - len(trailing) if trailing else len(segment)
    body = segment[len(leading):end]
    if not body:
        if space_mode == "preserve":
            return segment
        whitespace = leading + trailing
        return "\n" if "\n" in whitespace else (" " if whitespace else "")
    if space_mode == "preserve":
        # Preserve ordinary internal spaces exactly. "clean" still normalizes
        # transformed modes below; preservation is an explicit user choice.
        return leading + _punctuate(body, mode) + trailing
    prefix = "\n" if "\n" in leading else (" " if leading else "")
    suffix = "\n" if "\n" in trailing else (" " if trailing else "")
    body = _RE_MULTI_SPACE.sub(" ", body)
    body = _RE_NEWLINE_SPACE.sub("\n", body)
    body = _RE_MULTI_NEWLINE.sub("\n\n", body)
    if space_mode == "smart":
        body = _smart_cjk_space_to_comma_or_join(body, mode)
        body = _RE_SMART_CJK_ASCII.sub(" ", body)
        body = _RE_SMART_ASCII_CJK.sub(" ", body)
        body = _RE_SMART_BEFORE_PUNCT.sub(r"\1", body)
        body = _RE_SMART_AFTER_PUNCT.sub(r"\1 ", body)
    elif space_mode == "space-to-comma":
        comma = "，" if mode == "zh" else ","
        # This automatic mode targets pauses between Chinese word groups.
        # Keep ordinary English word gaps such as "hello world" readable.
        body = _RE_SPACE_TO_COMMA_CJK.sub(comma, body)
    elif space_mode == "comma-to-space":
        # Absorb whitespace next to the converted delimiter so "word, word"
        # stays one space wide rather than creating a doubled gap.
        body = _RE_COMMA_TO_SPACE.sub(" ", body)
    if space_mode == "smart" and body and prefix and body[0] in ",，。！？!?;；:：":
        prefix = "\n" if "\n" in prefix else ""
    if prefix == " " and body.startswith(" "):
        body = body.lstrip(" ")
    if suffix == " " and body.endswith(" "):
        body = body.rstrip(" ")
    return prefix + _punctuate(body, mode) + suffix


def _smart_space_around_protected(text: str) -> str:
    result = text
    for start, end in reversed(_protected_spans(text)):
        token = result[start:end]
        if not token:
            continue
        first, last = token[0], token[-1]
        if start and "\u3400" <= result[start - 1] <= "\u9fff" and first.isascii() and first.isalnum():
            result = result[:start] + " " + result[start:]
            end += 1
        if end < len(result) and "\u3400" <= result[end] <= "\u9fff" and last.isascii() and last.isalnum():
            result = result[:end] + " " + result[end:]
    return result


def local_transform(raw_text: str, config: dict[str, Any], recognized_language: str | None = None) -> str:
    mode = config.get("text_mode", "clean")
    if mode == "original":
        return raw_text
    text = apply_replacements(raw_text, config.get("replacements", []))
    punctuation = _choose_punctuation(config.get("punctuation_mode", "auto"), recognized_language, text)
    text = _map_safe_spans(text, lambda span: _clean_segment(span, punctuation, config.get("space_mode", "preserve"))).strip(" \t\n")
    if config.get("space_mode", "preserve") == "smart":
        text = _smart_space_around_protected(text)
    if punctuation == "zh" and config.get("space_mode", "preserve") != "comma-to-space":
        text = _auto_punctuate_chinese(text)
    use_chinese_prompt = _chinese_output(text, recognized_language, config.get("language"))
    if mode == "coding-prompt":
        prompt = (
            "请帮助处理以下编程请求。保留说话者明确提出的需求与限制；如缺少关键信息，请先询问。\n\n"
            if use_chinese_prompt else
            "Please help with the following coding request. Preserve the speaker's stated "
            "requirements and constraints, and ask if essential details are missing.\n\n"
        )
        return prompt + text
    if mode == "analysis-prompt":
        prompt = (
            "请先分析以下请求的目标、限制条件、假设与缺失信息。保留说话者原意；如关键信息不足，请简洁地询问后再行动。\n\n"
            if use_chinese_prompt else
            "Analyze the following request before acting. Identify its goal, constraints, "
            "assumptions, and any missing information. Preserve the speaker's meaning and "
            "ask a concise clarification if essential details are missing.\n\n"
        )
        return prompt + text
    if mode == "custom":
        return config["prompt_template"].replace("{text}", text)
    return text


class _HttpConnectionPool:
    """Thread-safe HTTP/HTTPS keep-alive connection pool with strict no-redirect semantics."""

    def __init__(self, *, max_per_host: int = 2, idle_ttl: float = 45.0):
        self._lock = threading.Lock()
        self._idle: dict[tuple[str, str, int], list[tuple[Any, float]]] = {}
        self._max_per_host = max_per_host
        self._idle_ttl = idle_ttl
        self._ssl_context: Any = None

    def _get_ssl_context(self) -> Any:
        if self._ssl_context is None:
            import ssl
            with self._lock:
                if self._ssl_context is None:
                    self._ssl_context = ssl.create_default_context()
        return self._ssl_context

    @staticmethod
    def _safe_close(conn: Any) -> None:
        try:
            conn.close()
        except Exception:
            pass

    @staticmethod
    def _configure_socket(conn: Any) -> None:
        import socket
        sock = getattr(conn, "sock", None)
        if sock is not None:
            try:
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass

    @staticmethod
    def _is_socket_healthy(conn: Any) -> bool:
        import select
        import socket
        import ssl
        sock = getattr(conn, "sock", None)
        if sock is None:
            return False
        try:
            if sock.fileno() < 0:
                return False
            if sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR) != 0:
                return False
            # TLS 1.3 servers commonly send NewSessionTicket right after the
            # handshake, making an idle SSLSocket readable without being closed.
            # Keep SSL sockets eligible for reuse and let stale-retry handle EOF.
            if isinstance(sock, ssl.SSLSocket):
                return True
            readable, _, _ = select.select([sock], [], [], 0)
            return not readable
        except (OSError, ValueError):
            return False

    def _acquire(self, scheme: str, host: str, port: int, timeout: float) -> tuple[Any, bool]:
        import http.client
        key = (scheme, host, port)
        now = time.monotonic()
        stale: list[Any] = []
        candidate: Any = None
        with self._lock:
            bucket = self._idle.get(key)
            while bucket:
                conn, ts = bucket.pop()
                if now - ts >= self._idle_ttl:
                    stale.append(conn)
                    continue
                candidate = conn
                break
            if bucket is not None and not bucket:
                self._idle.pop(key, None)
        for conn in stale:
            self._safe_close(conn)
        if candidate is not None:
            if self._is_socket_healthy(candidate):
                candidate.timeout = timeout
                if getattr(candidate, "sock", None) is not None:
                    candidate.sock.settimeout(timeout)
                return candidate, True
            self._safe_close(candidate)
        if scheme == "https":
            conn = http.client.HTTPSConnection(host, port, timeout=timeout, context=self._get_ssl_context())
        else:
            conn = http.client.HTTPConnection(host, port, timeout=timeout)
        return conn, False

    def _release(self, key: tuple[str, str, int], conn: Any, will_close: bool) -> None:
        if will_close or getattr(conn, "sock", None) is None:
            self._safe_close(conn)
            return
        now = time.monotonic()
        evicted: list[Any] = []
        with self._lock:
            bucket = self._idle.setdefault(key, [])
            fresh: list[tuple[Any, float]] = []
            for item_conn, ts in bucket:
                if now - ts < self._idle_ttl:
                    fresh.append((item_conn, ts))
                else:
                    evicted.append(item_conn)
            while len(fresh) >= self._max_per_host:
                old_conn, _ = fresh.pop(0)
                evicted.append(old_conn)
            fresh.append((conn, now))
            self._idle[key] = fresh
        for dead in evicted:
            self._safe_close(dead)

    @staticmethod
    def _parse_endpoint(endpoint: str) -> tuple[str, str, int, str]:
        parsed = urllib.parse.urlsplit(endpoint)
        scheme = parsed.scheme.casefold()
        host = parsed.hostname or ""
        port = parsed.port or (443 if scheme == "https" else 80)
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        return scheme, host, port, path

    def prewarm(self, endpoint: str, timeout: float = 3.0) -> bool:
        scheme, host, port, _ = self._parse_endpoint(endpoint)
        if not host or scheme not in ("http", "https"):
            return False
        key = (scheme, host, port)
        conn, reused = self._acquire(scheme, host, port, timeout)
        try:
            if not reused:
                conn.connect()
                self._configure_socket(conn)
            self._release(key, conn, False)
            return True
        except Exception:
            self._safe_close(conn)
            return False

    def _request(self, method: str, endpoint: str, *, body: bytes | None,
                 headers: dict[str, str], timeout: float, max_read_bytes: int) -> tuple[int, bytes]:
        import http.client
        import ssl
        scheme, host, port, path = self._parse_endpoint(endpoint)
        key = (scheme, host, port)
        req_headers = dict(headers)
        req_headers.setdefault("Connection", "keep-alive")
        transient_errors = (
            http.client.RemoteDisconnected,
            http.client.BadStatusLine,
            ConnectionResetError,
            BrokenPipeError,
            ConnectionAbortedError,
            ssl.SSLEOFError,
            ssl.SSLZeroReturnError,
        )
        for attempt in (0, 1):
            conn, reused = self._acquire(scheme, host, port, timeout)
            try:
                if not reused:
                    conn.connect()
                    self._configure_socket(conn)
                conn.request(method, path, body=body, headers=req_headers)
                response = conn.getresponse()
                status = response.status
                if 300 <= status < 400:
                    # Reject redirects immediately without reading redirect targets.
                    self._safe_close(conn)
                    return status, b""
                raw = response.read(max_read_bytes)
                if len(raw) >= max_read_bytes:
                    self._safe_close(conn)
                    return status, raw
                self._release(key, conn, getattr(response, "will_close", True))
                return status, raw
            except transient_errors:
                self._safe_close(conn)
                if reused and attempt == 0:
                    continue
                raise
            except ssl.SSLError:
                self._safe_close(conn)
                if reused and attempt == 0:
                    continue
                raise
            except Exception:
                self._safe_close(conn)
                raise
        raise RuntimeError("HTTP connection pool retry exhausted")

    def request_get(self, endpoint: str, *, headers: dict[str, str],
                    timeout: float, max_read_bytes: int) -> tuple[int, bytes]:
        return self._request("GET", endpoint, body=None, headers=headers,
                             timeout=timeout, max_read_bytes=max_read_bytes)

    def request_post(self, endpoint: str, *, body: bytes, headers: dict[str, str],
                     timeout: float, max_read_bytes: int) -> tuple[int, bytes]:
        return self._request("POST", endpoint, body=body, headers=headers,
                             timeout=timeout, max_read_bytes=max_read_bytes)

    def close_all(self) -> None:
        with self._lock:
            conns = [conn for bucket in self._idle.values() for conn, _ in bucket]
            self._idle.clear()
        for conn in conns:
            self._safe_close(conn)


_HTTP_POOL = _HttpConnectionPool()


def prewarm_endpoint(url: str, timeout: float = 3.0, *, allow_http: bool = False) -> bool:
    """Warm TCP/TLS connection to an HTTPS endpoint without issuing an HTTP request."""
    raw = str(url or "").strip()
    if not raw:
        return False
    try:
        parsed = urllib.parse.urlsplit(raw)
        scheme = parsed.scheme.casefold()
        if not parsed.hostname:
            return False
        # Plain loopback HTTP has negligible connect time and single-threaded test servers
        # can block if an idle socket is opened before a request arrives.
        if scheme != "https" and not (allow_http and scheme == "http"):
            return False
        return _HTTP_POOL.prewarm(raw, timeout=timeout)
    except Exception:
        return False


def close_http_pool() -> None:
    """Close all idle pooled HTTP/HTTPS client connections."""
    _HTTP_POOL.close_all()


def _rewrite_request(url: str, model: str, prompt: str, text: str, api_key: str,
                     timeout: int, opener: Callable | Any | None = None) -> str:
    endpoint = normalize_rewrite_url(url)
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": text},
        ],
        "temperature": 0.2,
        "max_tokens": 4096,
    }, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    if opener is not None:
        import urllib.request
        request = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")
        response_context = opener(request, timeout=timeout)
        with response_context as response:
            raw = response.read(MAX_REWRITE_RESPONSE_BYTES + 1)
    else:
        status, raw = _HTTP_POOL.request_post(
            endpoint,
            body=body,
            headers=headers,
            timeout=timeout,
            max_read_bytes=MAX_REWRITE_RESPONSE_BYTES + 1,
        )
        if status >= 300:
            raise RuntimeError(f"rewrite endpoint returned HTTP {status}")
    if len(raw) > MAX_REWRITE_RESPONSE_BYTES:
        raise ValueError("rewrite response is too large")
    payload = json.loads(raw.decode("utf-8"))
    choice = payload["choices"][0]
    if isinstance(choice, dict) and choice.get("finish_reason") in ("length", "content_filter"):
        raise ValueError("rewrite response is incomplete")
    content = choice["message"]["content"]
    if not isinstance(content, str) or not content.strip() or len(content) > MAX_REWRITE_TEXT_CHARS:
        raise ValueError("rewrite response has no usable text")
    return content.strip()


def rewrite_text(local_text: str, config: dict[str, Any], *, api_key: str = "",
                 recognized_language: str | None = None,
                 opener: Callable | Any | None = None) -> tuple[str, str | None]:
    """Run one explicit AI rewrite; return local text on every failure."""
    if not config.get("rewrite_base_url") or not config.get("rewrite_model"):
        return local_text, _SAFE_WARNING
    if len(local_text) > MAX_REWRITE_TEXT_CHARS:
        return local_text, _SAFE_WARNING
    try:
        prompt = config["rewrite_prompt"]
        if prompt == DEFAULT_REWRITE_PROMPT and _chinese_output(
                local_text, recognized_language, config.get("language")):
            prompt = DEFAULT_REWRITE_PROMPT_ZH
        result = _rewrite_request(config["rewrite_base_url"], config["rewrite_model"],
                                  prompt, local_text, api_key,
                                  config["rewrite_timeout"], opener=opener)
        return result, None
    except Exception:
        # Do not return an HTTP body, URL, model error, or any key material.
        return local_text, _SAFE_WARNING


def process_transcript(raw_text: str, config: dict[str, Any], *, recognized_language: str | None = None,
                       api_key: str = "", opener: Callable | Any | None = None) -> tuple[str, str, str | None]:
    """Return local and final output, and a safe nonfatal warning if needed."""
    try:
        local = local_transform(raw_text, config, recognized_language)
    except Exception:
        return raw_text, raw_text, _LOCAL_WARNING
    if config.get("text_mode") != "ai":
        return local, local, None
    final, warning = rewrite_text(
        local,
        config,
        api_key=api_key,
        recognized_language=recognized_language,
        opener=opener,
    )
    return local, final, warning


def validate_stt_config(raw: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalize OpenAI-compatible STT settings."""
    merged = {key: raw.get(key, DEFAULT_STT_CONFIG[key]) for key in DEFAULT_STT_CONFIG}
    stt_url = _bounded_text(merged["stt_base_url"], "stt_base_url", 2048).strip()
    if stt_url:
        stt_url = normalize_stt_url(stt_url)
    stt_model = _bounded_text(merged["stt_model"], "stt_model", 200).strip()
    timeout = merged["stt_timeout"]
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 5 <= timeout <= 120:
        raise TextConfigError("stt_timeout must be an integer between 5 and 120")
    return {
        "stt_base_url": stt_url,
        "stt_model": stt_model,
        "stt_timeout": timeout,
    }


def _redact_secret(message: str, api_key: str) -> str:
    cleaned = message
    if api_key and api_key in cleaned:
        cleaned = cleaned.replace(api_key, "[REDACTED]")
    return cleaned


def _build_multipart_wav(wav_bytes: bytes, *, model: str, language: str = "auto",
                         prompt: str = "", minimal: bool = False) -> tuple[bytes, str]:
    boundary = "ocvoice-" + uuid.uuid4().hex
    parts: list[bytes] = []

    def add_field(name: str, value: str) -> None:
        parts.append(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
            f"{value}\r\n".encode("utf-8")
        )

    add_field("model", model)
    if not minimal:
        add_field("response_format", "json")
        if language in ("zh", "en"):
            add_field("language", language)
        cleaned_prompt = prompt.strip()[:500]
        if cleaned_prompt:
            add_field("prompt", cleaned_prompt)
    parts.append(
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n'
        f"Content-Type: audio/wav\r\n\r\n".encode("utf-8")
        + wav_bytes
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def _extract_http_error_detail(raw_err: bytes, api_key: str) -> str:
    detail = ""
    try:
        parsed_err = json.loads(raw_err[:2048].decode("utf-8", errors="replace"))
        if isinstance(parsed_err, dict):
            err_obj = parsed_err.get("error")
            if isinstance(err_obj, dict) and isinstance(err_obj.get("message"), str):
                detail = err_obj["message"]
            elif isinstance(err_obj, str):
                detail = err_obj
            elif isinstance(parsed_err.get("message"), str):
                detail = parsed_err["message"]
    except Exception:
        detail = ""
    return _redact_secret(detail.strip(), api_key)[:160]


def _is_siliconflow_host(endpoint: str) -> bool:
    host = (urllib.parse.urlsplit(endpoint).hostname or "").casefold()
    return "siliconflow." in host


def _auth_failure_hint(endpoint: str) -> str:
    if _is_siliconflow_host(endpoint):
        return "（如使用硅基流动，请确认 Key 来自对应站点：国内站 api.siliconflow.cn 与国际站 api.siliconflow.com 密钥不互通）"
    return ""


def _parse_stt_http_error(raw_err: bytes, status: int, api_key: str, endpoint: str = "") -> RuntimeError:
    safe_detail = _extract_http_error_detail(raw_err, api_key)
    if status in (401, 403):
        hint = _auth_failure_hint(endpoint)
        detail_part = f"（{safe_detail}）" if safe_detail else ""
        return RuntimeError(f"语音识别接口鉴权失败，请检查 STT API Key{detail_part}{hint}")
    if safe_detail:
        return RuntimeError(f"语音识别接口返回 HTTP {status}: {safe_detail}")
    return RuntimeError(f"语音识别接口返回错误 HTTP {status}")


def transcribe_openai_compatible(wav_bytes: bytes, config: dict[str, Any], *,
                                 api_key: str = "", language: str = "auto",
                                 prompt: str = "", opener: Callable | Any | None = None) -> str:
    """Send 16kHz WAV audio to an OpenAI-compatible /v1/audio/transcriptions API."""
    url = str(config.get("stt_base_url", "")).strip()
    model = str(config.get("stt_model", "")).strip()
    if not url or not model:
        raise TextConfigError("请先在设置中配置语音识别接口地址和模型 ID")
    endpoint = normalize_stt_url(url)
    minimal_form = _is_siliconflow_host(endpoint) or model.startswith(("FunAudioLLM/", "TeleAI/"))
    timeout = config.get("stt_timeout", 30)
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 5 <= timeout <= 120:
        timeout = 30
    body, content_type = _build_multipart_wav(wav_bytes, model=model, language=language, prompt=prompt, minimal=minimal_form)
    headers = {"Content-Type": content_type, "Accept": "application/json"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    if opener is not None:
        from urllib import error as urllib_error, request as urllib_request
        request = urllib_request.Request(endpoint, data=body, headers=headers, method="POST")
        try:
            with opener(request, timeout=timeout) as response:
                raw = response.read(MAX_REWRITE_RESPONSE_BYTES + 1)
        except urllib_error.HTTPError as exc:
            try:
                err_bytes = exc.read(2048)
            except Exception:
                err_bytes = b""
            raise _parse_stt_http_error(err_bytes, exc.code, api_key, endpoint) from exc
        except Exception as exc:
            raise RuntimeError("语音识别接口请求失败，请检查网络、地址和防火墙设置") from exc
    else:
        try:
            status, raw = _HTTP_POOL.request_post(
                endpoint,
                body=body,
                headers=headers,
                timeout=timeout,
                max_read_bytes=MAX_REWRITE_RESPONSE_BYTES + 1,
            )
        except Exception as exc:
            raise RuntimeError("语音识别接口请求失败，请检查网络、地址和防火墙设置") from exc
        if status >= 300:
            raise _parse_stt_http_error(raw, status, api_key, endpoint)
    if len(raw) > MAX_REWRITE_RESPONSE_BYTES:
        raise RuntimeError("语音识别接口响应过大")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("语音识别接口返回了无效 JSON") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("text"), str):
        raise RuntimeError("语音识别接口响应缺少 text 字段")
    text = payload["text"].strip()
    if len(text) > MAX_REWRITE_TEXT_CHARS:
        raise RuntimeError("语音识别返回文本过长")
    return text


def _silent_wav16k(duration_ms: int = 300) -> bytes:
    import wave
    frames = max(1, int(16000 * duration_ms / 1000))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\x00\x00" * frames)
    return buf.getvalue()


def test_stt_connection(config: dict[str, Any], *, api_key: str = "",
                        opener: Callable | Any | None = None) -> dict[str, Any]:
    """Verify STT endpoint reachability, authentication, and model configuration."""
    started = time.monotonic()
    url = str(config.get("stt_base_url", "")).strip()
    model = str(config.get("stt_model", "")).strip()
    if not url or not model:
        return {"ok": False, "message": "请先填写语音识别接口地址和模型 ID。"}
    try:
        transcribe_openai_compatible(
            _silent_wav16k(),
            config,
            api_key=api_key,
            language=config.get("language", "auto"),
            opener=opener,
        )
        latency_ms = int((time.monotonic() - started) * 1000)
        return {"ok": True, "message": f"语音识别接口连接成功（{latency_ms} ms）。"}
    except Exception as exc:
        return {"ok": False, "message": str(exc)[:200]}


_STT_MODEL_HINTS = ("sensevoice", "telespeech", "whisper", "paraformer", "funasr", "asr", "speech", "audio")


def _extract_remote_model_ids(payload: Any, *, prioritize_stt: bool = False) -> list[str]:
    if isinstance(payload, dict):
        items = payload.get("data")
        if not isinstance(items, list):
            items = payload.get("models")
    elif isinstance(payload, list):
        items = payload
    else:
        return []
    if not isinstance(items, list):
        return []
    ids: list[str] = []
    seen: set[str] = set()
    for item in items:
        candidate = ""
        if isinstance(item, str):
            candidate = item.strip()
        elif isinstance(item, dict):
            raw = item.get("id") or item.get("name") or item.get("model") or ""
            if isinstance(raw, str):
                candidate = raw.strip()
        if not candidate or len(candidate) > 256 or candidate in seen:
            continue
        seen.add(candidate)
        ids.append(candidate)
    if prioritize_stt:
        speech = [item for item in ids if any(hint in item.casefold() for hint in _STT_MODEL_HINTS)]
        other = [item for item in ids if not any(hint in item.casefold() for hint in _STT_MODEL_HINTS)]
        ids = speech + other
    return ids[:MAX_REMOTE_MODEL_COUNT]


def fetch_remote_models(url: str, *, api_key: str = "", timeout: float = 15,
                        field: str = "base_url", opener: Callable | Any | None = None) -> dict[str, Any]:
    """Fetch model IDs from an OpenAI-compatible GET /models endpoint."""
    raw_url = str(url or "").strip()
    if not raw_url:
        return {"ok": False, "models": [], "message": "请先填写接口地址。"}
    try:
        endpoint = normalize_models_url(raw_url, field=field)
    except TextConfigError as exc:
        return {"ok": False, "models": [], "message": str(exc)}
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    timeout_s = max(3.0, min(float(timeout), 30.0))
    try:
        if opener is not None:
            from urllib import error as urllib_error, request as urllib_request
            request = urllib_request.Request(endpoint, headers=headers, method="GET")
            try:
                with opener(request, timeout=timeout_s) as response:
                    status = getattr(response, "status", 200)
                    raw = response.read(MAX_REMOTE_MODELS_BYTES + 1)
            except urllib_error.HTTPError as exc:
                status = exc.code
                raw = exc.read(1024)
        else:
            status, raw = _HTTP_POOL.request_get(
                endpoint,
                headers=headers,
                timeout=timeout_s,
                max_read_bytes=MAX_REMOTE_MODELS_BYTES + 1,
            )
    except Exception as exc:
        safe = _redact_secret(str(exc), api_key)[:160]
        return {"ok": False, "models": [], "message": f"获取模型列表失败：{safe}"}
    if status >= 300:
        detail = _extract_http_error_detail(raw, api_key)
        detail_part = f"（{detail}）" if detail else ""
        if status in (401, 403):
            return {
                "ok": False,
                "models": [],
                "message": f"鉴权失败（HTTP {status}）{detail_part}，请检查 API 密钥{_auth_failure_hint(endpoint)}。",
            }
        if status == 404:
            return {"ok": False, "models": [], "message": "该接口未提供 /models 列表，请直接手填模型名称。"}
        return {"ok": False, "models": [], "message": f"获取模型列表失败（HTTP {status}）{detail_part}。"}
    if len(raw) > MAX_REMOTE_MODELS_BYTES:
        return {"ok": False, "models": [], "message": "服务端返回的模型列表过大。"}
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception:
        return {"ok": False, "models": [], "message": "服务端返回的模型列表不是有效的 JSON。"}
    ids = _extract_remote_model_ids(parsed, prioritize_stt=(field == "stt_base_url"))
    if not ids:
        return {"ok": False, "models": [], "message": "接口可连通，但未返回可用模型，请手填模型名称。"}
    return {"ok": True, "models": ids, "message": f"已获取 {len(ids)} 个可用模型。"}
