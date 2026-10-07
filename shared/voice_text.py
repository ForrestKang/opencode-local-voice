"""Local transcript formatting and optional OpenAI-compatible rewriting.

This module deliberately keeps local transforms deterministic and makes the
network rewrite an explicit, bounded operation. Speech recognition remains a
successful job when rewriting is unavailable: callers receive the local text
and a safe warning instead.
"""
from __future__ import annotations

import copy
import json
import re
import urllib.parse
import urllib.request
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

TEXT_CONFIG_FIELDS = frozenset(DEFAULT_TEXT_CONFIG)
CONFIG_PATCH_CREDENTIAL_FIELDS = frozenset({"rewrite_api_key"})

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


def validate_rewrite_api_key(value: Any) -> str:
    value = _bounded_text(value, "rewrite_api_key", MAX_REWRITE_KEY_CHARS)
    if any(ord(char) < 0x20 or ord(char) > 0x7E for char in value):
        raise TextConfigError("rewrite_api_key contains unsupported characters")
    return value.strip()


def normalize_rewrite_url(value: str) -> str:
    """Return an OpenAI-compatible chat-completions URL after strict checks."""
    if not isinstance(value, str) or not value or len(value) > 2048 or any(ord(c) < 0x21 or ord(c) == 0x7F for c in value):
        raise TextConfigError("rewrite_base_url must be a valid HTTP(S) endpoint")
    try:
        parsed = urllib.parse.urlsplit(value)
        hostname = parsed.hostname
        _ = parsed.port
    except ValueError as exc:
        raise TextConfigError("rewrite_base_url must be a valid HTTP(S) endpoint") from exc
    if not hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise TextConfigError("rewrite_base_url cannot contain credentials, query, or fragment")
    scheme = parsed.scheme.casefold()
    loopback_hosts = {"localhost", "127.0.0.1", "::1"}
    if scheme != "https" and not (scheme == "http" and hostname.casefold() in loopback_hosts):
        raise TextConfigError("rewrite_base_url must use HTTPS or local loopback HTTP")
    path = parsed.path.rstrip("/")
    if path.casefold().endswith("/v1/chat/completions"):
        endpoint_path = path
    elif path.casefold().endswith("/chat/completions"):
        endpoint_path = path
    elif path.casefold().endswith("/v1"):
        endpoint_path = path + "/chat/completions"
    else:
        endpoint_path = path + "/v1/chat/completions"
    netloc = parsed.netloc
    return urllib.parse.urlunsplit((scheme, netloc, endpoint_path, "", ""))


def build_asr_hints(config: dict[str, Any], maximum: int = 1900) -> tuple[str, str]:
    """Build a bounded initial prompt and hotword string for local Whisper."""
    terms: list[str] = []
    if config.get("vocabulary_preset", "coding") == "coding":
        terms.extend(CODING_VOCABULARY)
    terms.extend(config.get("vocabulary", []))
    deduped: list[str] = []
    seen: set[str] = set()
    for term in terms:
        if term not in seen:
            deduped.append(term)
            seen.add(term)
    vocabulary = ", ".join(deduped)
    base = str(config.get("initial_prompt", "")).strip()
    hint = (base + (". " if base and vocabulary else "") + vocabulary).strip()
    hint = hint[:maximum].rstrip(" ,;.")
    # CTranslate2/faster-whisper consumes one hotword string. Keep it independently
    # bounded because the decoder handles this option differently from prompt text.
    hotwords = ", ".join(deduped)[:MAX_VOCABULARY_TOTAL_CHARS].rstrip(" ,")
    return hint, hotwords


def _protected_spans(text: str) -> list[tuple[int, int]]:
    patterns = (
        re.compile(r"(?ms)^ {0,3}(`{3,}|~{3,})[^\n]*\n.*?^ {0,3}\1[ \t]*(?=\n|$)"),
        re.compile(r"(`+)[^`\n]*?\1"),
        re.compile(r"(?i)\b(?:https?://|www\.)[^\s<>]+"),
        re.compile(r"(?<![\w.+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![\w.-])", re.IGNORECASE),
        re.compile(r"(?<![\w])(?:[A-Za-z]:[\\/][^\s<>\"']+|\\\\[^\\/\s]+[\\/][^\s<>\"']+)"),
        re.compile(r"(?<![\w])/(?:[^/\s]+/)+[^\s<>\"']*"),
        # Relative paths are easy to damage with comma and space conversions too.
        re.compile(r"(?<![\w:/])(?:\.{1,2}/)?[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+(?![\w/])"),
        re.compile(r"(?<![\w:])(?:\.{1,2}\\)?[A-Za-z0-9_.-]+(?:\\[A-Za-z0-9_.-]+)+(?![\w\\])"),
        re.compile(r"(?<![\w.])\d+(?:\.\d+){1,}\b"),
        # Keep common numeric formats and measurements intact, including their gap to a unit.
        re.compile(
            r"(?<![\w.])[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?"
            r"(?:\s?(?:%|％|°[CF]|℃|℉|ms|msec|s|sec|secs|second|seconds|min|mins|h|hr|hrs|day|days|"
            r"hz|khz|mhz|ghz|thz|b|byte|bytes|kb|mb|gb|tb|kib|mib|gib|tib|px|dp|rpm|"
            r"mv|kv|v|mw|kw|w|ma|ua|a|mah|wh|kwh|dbm|db|mm|cm|km|kg|mg|g|lb|lbs|°|c|f))?"
            r"(?!\w)",
            re.IGNORECASE,
        ),
        re.compile(r"(?<!\d)\d{4}-\d{1,2}-\d{1,2}(?!\d)|(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?!\d)"),
        re.compile(r"(?<![A-Za-z0-9_])(?:[A-Za-z]+[a-z][A-Z][A-Za-z0-9]*|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+|[A-Za-z_]*\d+[A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*|[A-Za-z_]\w*(?:(?:::|\.|->)[A-Za-z_]\w*)+)(?![A-Za-z0-9_])"),
        # Protect common source syntax even when recognition did not say "backtick".
        re.compile(r"(?<![A-Za-z0-9_$])(?:(?:const|let|var|def)\s+)?[A-Za-z_$][\w$]*\s*(?:=|:=|=>)\s*[^\n,，。！？.!?;；:：`]{1,180}(?:;)?"),
        re.compile(r"(?<![A-Za-z0-9_$])(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\([^()\n]{0,180}\)"),
        re.compile(r"(?i)\b(?:git|npm|npx|pnpm|yarn|bun|pip|uv|python|node|cargo|docker|curl|ffmpeg)\s+(?:clone|install|add|run|test|build|status|diff|checkout|commit|push|pull|exec|create|open|serve|start|--?[\w-]+)\b[^\n,，。！？.!?;；:：`]{0,180}(?:;)?"),
        re.compile(r"\bC\+\+|\b[A-Za-z]+#"),
    )
    found: list[tuple[int, int]] = []
    for pattern in patterns:
        for match in pattern.finditer(text):
            start, end = match.span()
            if pattern.pattern.startswith(("(?i)\\b(?:https?://", "(?<![\\w])(?:[A-Za-z]:",
                                          "(?<![\\w:/])(?:\\.{1,2}/)?", "(?<![\\w:])(?:\\.{1,2}\\\\)?")):
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


def apply_replacements(text: str, replacements: list[dict[str, str]]) -> str:
    """Apply literal, longest-first, single-pass replacements outside code/URLs."""
    ordered = sorted(replacements, key=lambda item: (-len(item["from"]), item["from"]))
    if not ordered:
        return text
    alternatives: list[str] = []
    target_by_group: dict[str, str] = {}
    for item in ordered:
        source = re.escape(item["from"])
        if item["from"][0].isascii() and item["from"][0].isalnum():
            source = r"(?<![A-Za-z0-9_])" + source
        if item["from"][-1].isascii() and item["from"][-1].isalnum():
            source += r"(?![A-Za-z0-9_])"
        group = f"R{len(alternatives)}"
        alternatives.append(f"(?P<{group}>{source})")
        target_by_group[group] = item["to"]
    combined = re.compile("|".join(alternatives))
    return _map_safe_spans(
        text,
        lambda segment: combined.sub(lambda match: target_by_group[match.lastgroup or ""], segment),
    )


def _choose_punctuation(mode: str, recognized_language: str | None, text: str) -> str:
    if mode != "auto":
        return mode
    if (recognized_language or "").casefold().startswith(("zh", "yue")):
        return "zh"
    cjk = sum("\u3400" <= char <= "\u9fff" for char in text)
    letters = sum(char.isalpha() for char in text)
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


def _clean_segment(segment: str, mode: str, space_mode: str) -> str:
    leading_match = re.match(r"^[ \t\n]*", segment)
    trailing_match = re.search(r"[ \t\n]*$", segment)
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
    body = re.sub(r"[ \t]+", " ", body)
    body = re.sub(r" *\n *", "\n", body)
    body = re.sub(r"\n{3,}", "\n\n", body)
    if space_mode == "smart":
        body = re.sub(r"(?<=[\u3400-\u9fff]) +(?=[\u3400-\u9fff])", "", body)
        body = re.sub(r"(?<=[\u3400-\u9fff])(?=[A-Za-z0-9])", " ", body)
        body = re.sub(r"(?<=[A-Za-z0-9])(?=[\u3400-\u9fff])", " ", body)
        body = re.sub(r"\s+([,，。！？!?;；:：])", r"\1", body)
        body = re.sub(r"([,，。！？!?;；:：])(?=[A-Za-z0-9])", r"\1 ", body)
    elif space_mode == "space-to-comma":
        comma = "，" if mode == "zh" else ","
        # This automatic mode targets pauses between Chinese word groups.
        # Keep ordinary English word gaps such as "hello world" readable.
        body = re.sub(r"(?<=[\u3400-\u9fff])[ \t]+(?=[\u3400-\u9fff])", comma, body)
    elif space_mode == "comma-to-space":
        # Absorb whitespace next to the converted delimiter so "word, word"
        # stays one space wide rather than creating a doubled gap.
        body = re.sub(r"[ \t]*[,，]+[ \t]*", " ", body)
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


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Reject redirects so Authorization can never be forwarded elsewhere."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


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
    request = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")
    if opener is None:
        opener = urllib.request.build_opener(_NoRedirectHandler()).open
    response_context = opener(request, timeout=timeout)
    with response_context as response:
        raw = response.read(MAX_REWRITE_RESPONSE_BYTES + 1)
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
    final, warning = rewrite_text(local, config, api_key=api_key, opener=opener)
    return local, final, warning
