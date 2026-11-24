use crate::config::{ReplacementRule, VoiceConfig};

const CODING_VOCABULARY: &[&str] = &[
    "OpenCode", "Whisper", "faster-whisper", "CTranslate2", "CUDA", "MLX",
    "Python", "TypeScript", "JavaScript", "React", "API", "HTTP", "JSON",
    "GitHub", "VS Code", "CLI", "GPU", "CPU", "Git", "Node.js",
    "函数", "接口", "变量", "报错", "终端", "插件", "仓库", "代码", "项目", "模型",
];

const ZH_CLAUSE_CONNECTORS: &[&str] = &[
    "但是", "不过", "然后", "所以", "而且", "因为", "如果",
    "另外", "顺便", "比如", "还有", "同时", "并且", "或者", "就是",
];

const ZH_QUESTION_ENDINGS: &[&str] = &[
    "吗", "呢", "么", "吧吗", "好不好", "行不行", "对不对", "是不是", "能不能", "可以吗", "行吗", "好吗",
];

const ZH_QUESTION_PHRASES: &[&str] = &[
    "能不能", "可不可以", "是不是", "有没有", "好不好", "行不行", "怎么", "为什么", "为啥", "哪里", "哪个", "多少", "什么",
];

#[inline]
pub fn is_cjk(ch: char) -> bool {
    ('\u{3400}'..='\u{9fff}').contains(&ch)
}

pub fn count_cjk(s: &str) -> usize {
    s.chars().filter(|&c| is_cjk(c)).count()
}

pub fn is_chinese_output(text: &str, recognized_language: Option<&str>, config_language: &str) -> bool {
    if count_cjk(text) > 0 {
        return true;
    }
    if let Some(lang) = recognized_language {
        if lang.to_ascii_lowercase().starts_with("zh") {
            return true;
        }
    }
    config_language.to_ascii_lowercase().starts_with("zh")
}

pub fn build_asr_hints(cfg: &VoiceConfig) -> (String, String) {
    let mut terms: Vec<String> = Vec::new();
    if cfg.vocabulary_preset == "coding" {
        for &t in CODING_VOCABULARY {
            terms.push(t.to_string());
        }
    }
    for t in &cfg.vocabulary {
        if !terms.contains(t) {
            terms.push(t.clone());
        }
    }
    let hotwords = terms.join(", ");
    let mut anchor: Vec<String> = cfg.vocabulary.clone();
    if cfg.vocabulary_preset == "coding" && !anchor.iter().any(|x| x == "OpenCode") {
        anchor.insert(0, "OpenCode".to_string());
    }
    let base = cfg.initial_prompt.trim();
    let prompt = if cfg.language.eq_ignore_ascii_case("en") {
        let lead = if !base.is_empty() {
            format!("{}. ", base.trim_end_matches(|c| c == ' ' || c == '.'))
        } else {
            "Transcribe naturally with commas, periods, and question marks. ".to_string()
        };
        let tail = if anchor.is_empty() {
            String::new()
        } else {
            format!("{}.", anchor.join(", "))
        };
        format!("{lead}{tail}")
    } else {
        let style = "嗯，好的，明白。如果有问题，我们再确认一下。";
        let lead = if !base.is_empty() {
            let has_zh = base.chars().any(|c| matches!(c, '，' | '。' | '！' | '？'));
            let cleaned = base.trim_end_matches(|c| c == ' ' || c == '.' || c == '。');
            if has_zh {
                format!("{cleaned}. ")
            } else {
                format!("{cleaned}. {style}")
            }
        } else {
            style.to_string()
        };
        let tail = if anchor.is_empty() {
            String::new()
        } else {
            format!("{}。", anchor.join("、"))
        };
        format!("{lead}{tail}")
    };
    (prompt.trim().to_string(), hotwords)
}

/// Find protected byte ranges (code blocks, inline backticks, URLs, paths, emails, dotted versions).
fn find_protected_spans(text: &str) -> Vec<(usize, usize)> {
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;

    while i < len {
        // Inline or fenced backticks
        if bytes[i] == b'`' {
            let start = i;
            let mut ticks = 0;
            while i < len && bytes[i] == b'`' {
                ticks += 1;
                i += 1;
            }
            let delim = "`".repeat(ticks);
            if let Some(rel) = text[i..].find(&delim) {
                let end = i + rel + ticks;
                spans.push((start, end));
                i = end;
                continue;
            } else {
                continue;
            }
        }
        // URLs: http://, https://, www.
        if text[i..].starts_with("http://")
            || text[i..].starts_with("https://")
            || text[i..].starts_with("www.")
        {
            let start = i;
            while i < len && !bytes[i].is_ascii_whitespace() && !matches!(bytes[i], b'<' | b'>') {
                i += 1;
            }
            let mut end = i;
            while end > start && matches!(bytes[end - 1], b'.' | b',' | b';' | b':' | b'!' | b'?') {
                end -= 1;
            }
            spans.push((start, end));
            continue;
        }
        // Windows drive paths like C:\foo\bar or D:/foo/bar
        if i + 2 < len
            && bytes[i].is_ascii_alphabetic()
            && bytes[i + 1] == b':'
            && (bytes[i + 2] == b'\\' || bytes[i + 2] == b'/')
            && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric())
        {
            let start = i;
            while i < len
                && !bytes[i].is_ascii_whitespace()
                && !matches!(bytes[i], b'<' | b'>' | b'"' | b'\'')
            {
                i += 1;
            }
            let mut end = i;
            while end > start && matches!(bytes[end - 1], b'.' | b',' | b';' | b'!' | b'?') {
                end -= 1;
            }
            spans.push((start, end));
            continue;
        }
        // Dotted versions / decimals like 1.19.5 or 3.14
        if bytes[i].is_ascii_digit() && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric()) {
            let start = i;
            let mut has_dot = false;
            let mut j = i;
            while j < len && bytes[j].is_ascii_digit() {
                j += 1;
            }
            while j + 1 < len && bytes[j] == b'.' && bytes[j + 1].is_ascii_digit() {
                has_dot = true;
                j += 1;
                while j < len && bytes[j].is_ascii_digit() {
                    j += 1;
                }
            }
            if has_dot {
                spans.push((start, j));
                i = j;
                continue;
            }
        }
        // Advance to next char boundary
        let ch = text[i..].chars().next().unwrap();
        i += ch.len_utf8();
    }
    spans
}

fn map_safe_spans<F>(text: &str, mut f: F) -> String
where
    F: FnMut(&str) -> String,
{
    let spans = find_protected_spans(text);
    if spans.is_empty() {
        return f(text);
    }
    let mut out = String::with_capacity(text.len() + 16);
    let mut cursor = 0;
    for (s, e) in spans {
        if s > cursor {
            out.push_str(&f(&text[cursor..s]));
        }
        out.push_str(&text[s..e]);
        cursor = e;
    }
    if cursor < text.len() {
        out.push_str(&f(&text[cursor..]));
    }
    out
}

pub fn apply_replacements(text: &str, rules: &[ReplacementRule]) -> String {
    if rules.is_empty() || text.is_empty() {
        return text.to_string();
    }
    let mut sorted: Vec<&ReplacementRule> = rules.iter().filter(|r| !r.from.is_empty()).collect();
    sorted.sort_by(|a, b| b.from.len().cmp(&a.from.len()));

    map_safe_spans(text, |segment| {
        let mut out = String::with_capacity(segment.len());
        let bytes = segment.as_bytes();
        let mut i = 0;
        while i < segment.len() {
            let mut matched: Option<&ReplacementRule> = None;
            for rule in &sorted {
                let flen = rule.from.len();
                if i + flen > segment.len() {
                    continue;
                }
                let slice = &segment[i..i + flen];
                let ascii_rule = rule.from.is_ascii();
                let is_eq = if ascii_rule {
                    slice.eq_ignore_ascii_case(&rule.from)
                } else {
                    slice == rule.from
                };
                if !is_eq {
                    continue;
                }
                if ascii_rule {
                    let prev_word = i > 0 && (bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
                    let next_word = i + flen < segment.len()
                        && (bytes[i + flen].is_ascii_alphanumeric() || bytes[i + flen] == b'_');
                    if prev_word || next_word {
                        continue;
                    }
                }
                matched = Some(rule);
                break;
            }
            if let Some(rule) = matched {
                out.push_str(&rule.to);
                i += rule.from.len();
            } else {
                let ch = segment[i..].chars().next().unwrap();
                out.push(ch);
                i += ch.len_utf8();
            }
        }
        out
    })
}

fn choose_punctuation<'a>(mode: &'a str, recognized_language: Option<&str>, text: &str) -> &'a str {
    if mode != "auto" {
        return mode;
    }
    let cjk = count_cjk(text);
    if cjk > 0 {
        return "zh";
    }
    let ascii_alpha = text.bytes().filter(|b| b.is_ascii_alphabetic()).count();
    if ascii_alpha > 0 {
        return "en";
    }
    if let Some(lang) = recognized_language {
        if lang.to_ascii_lowercase().starts_with("zh") {
            return "zh";
        }
    }
    "en"
}

fn convert_punctuation(segment: &str, mode: &str) -> String {
    if mode == "none" {
        return segment.to_string();
    }
    let mut out = String::with_capacity(segment.len() + 8);
    let chars: Vec<char> = segment.chars().collect();
    for (idx, &ch) in chars.iter().enumerate() {
        let prev = if idx > 0 { Some(chars[idx - 1]) } else { None };
        let next = chars.get(idx + 1).copied();
        if mode == "zh" {
            let mapped = match ch {
                ',' => '，',
                '?' => '？',
                '!' => '！',
                ';' => '；',
                ':' => {
                    // Preserve time like 12:30
                    if prev.is_some_and(|c| c.is_ascii_digit())
                        && next.is_some_and(|c| c.is_ascii_digit())
                    {
                        ':'
                    } else {
                        '：'
                    }
                }
                '.' => {
                    let around_ascii = prev.is_some_and(|c| c.is_ascii_alphanumeric())
                        && next.is_some_and(|c| c.is_ascii_alphanumeric());
                    let ellipsis = prev == Some('.') || next == Some('.');
                    if around_ascii || ellipsis { '.' } else { '。' }
                }
                _ => ch,
            };
            out.push(mapped);
        } else if mode == "en" {
            let mapped = match ch {
                '，' => ',',
                '。' => '.',
                '？' => '?',
                '！' => '!',
                '；' => ';',
                '：' => ':',
                _ => ch,
            };
            out.push(mapped);
        } else {
            out.push(ch);
        }
    }
    out
}

fn smart_cjk_space_to_comma_or_join(body: &str, punct_mode: &str) -> String {
    let chars: Vec<char> = body.chars().collect();
    let mut out = String::with_capacity(body.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == ' ' && i > 0 && i + 1 < chars.len() && is_cjk(chars[i - 1]) && is_cjk(chars[i + 1]) {
            if punct_mode == "zh" {
                let mut left_cjk = 0usize;
                let mut j = i;
                while j > 0 {
                    j -= 1;
                    let c = chars[j];
                    if matches!(c, '，' | '。' | '！' | '？' | '；' | '：' | ',' | '.' | '!' | '?' | ';' | ':' | '\n') {
                        break;
                    }
                    if is_cjk(c) {
                        left_cjk += 1;
                    }
                }
                let mut right_cjk = 0usize;
                let mut k = i + 1;
                while k < chars.len() {
                    let c = chars[k];
                    if matches!(c, '，' | '。' | '！' | '？' | '；' | '：' | ',' | '.' | '!' | '?' | ';' | ':' | ' ' | '\n') {
                        break;
                    }
                    if is_cjk(c) {
                        right_cjk += 1;
                    }
                    k += 1;
                }
                if left_cjk >= 4 && right_cjk >= 3 {
                    out.push('，');
                }
            }
            i += 1;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn clean_segment(segment: &str, punct_mode: &str, space_mode: &str) -> String {
    if space_mode == "preserve" {
        return convert_punctuation(segment, punct_mode);
    }
    // Collapse consecutive spaces (keep newlines)
    let mut collapsed = String::with_capacity(segment.len());
    let mut prev_space = false;
    for ch in segment.chars() {
        if ch == ' ' || ch == '\t' {
            if !prev_space {
                collapsed.push(' ');
                prev_space = true;
            }
        } else {
            prev_space = false;
            collapsed.push(ch);
        }
    }

    let processed = match space_mode {
        "smart" => {
            let s1 = smart_cjk_space_to_comma_or_join(&collapsed, punct_mode);
            // Insert space between CJK and ASCII alnum
            let chars: Vec<char> = s1.chars().collect();
            let mut s2 = String::with_capacity(s1.len() + 16);
            for (idx, &c) in chars.iter().enumerate() {
                if idx > 0 {
                    let p = chars[idx - 1];
                    if (is_cjk(p) && c.is_ascii_alphanumeric()) || (p.is_ascii_alphanumeric() && is_cjk(c)) {
                        s2.push(' ');
                    }
                }
                s2.push(c);
            }
            // Remove space before punctuation
            let mut s3 = String::with_capacity(s2.len());
            let c2: Vec<char> = s2.chars().collect();
            for (idx, &c) in c2.iter().enumerate() {
                if c == ' '
                    && idx + 1 < c2.len()
                    && matches!(c2[idx + 1], ',' | '，' | '。' | '！' | '？' | '!' | '?' | ';' | '；' | ':' | '：')
                {
                    continue;
                }
                s3.push(c);
            }
            s3
        }
        "space-to-comma" => {
            let comma = if punct_mode == "zh" { '，' } else { ',' };
            let chars: Vec<char> = collapsed.chars().collect();
            let mut out = String::with_capacity(collapsed.len());
            for (idx, &c) in chars.iter().enumerate() {
                if c == ' ' && idx > 0 && idx + 1 < chars.len() && is_cjk(chars[idx - 1]) && is_cjk(chars[idx + 1]) {
                    out.push(comma);
                } else {
                    out.push(c);
                }
            }
            out
        }
        "comma-to-space" => {
            let mut out = String::with_capacity(collapsed.len());
            for c in collapsed.chars() {
                if c == ',' || c == '，' {
                    if !out.ends_with(' ') {
                        out.push(' ');
                    }
                } else if c == ' ' && out.ends_with(' ') {
                    continue;
                } else {
                    out.push(c);
                }
            }
            out
        }
        _ => collapsed,
    };

    convert_punctuation(&processed, punct_mode)
}

fn looks_like_zh_question(clause: &str) -> bool {
    let trimmed = clause.trim_end_matches(|c| matches!(c, '，' | '。' | '？' | '！' | ',' | '.' | '?' | '!'));
    if ZH_QUESTION_ENDINGS.iter().any(|suf| trimmed.ends_with(suf)) {
        return true;
    }
    ZH_QUESTION_PHRASES.iter().any(|kw| trimmed.contains(kw))
}

fn auto_punctuate_chinese_line(line: &str) -> String {
    let stripped = line.trim();
    if stripped.is_empty() {
        return stripped.to_string();
    }
    let cjk_total = count_cjk(stripped);
    if cjk_total < 10 {
        return stripped.to_string();
    }

    // 1) Collapse "，。" / ",。" artifacts and upgrade obvious "[吗呢]。" -> "[吗呢]？"
    let mut s = stripped
        .replace("，。", "。")
        .replace(",。", "。")
        .replace("，？", "？")
        .replace("，！", "！")
        .replace("吗。", "吗？")
        .replace("呢。", "呢？");

    // 2) Insert commas before clear clause connectors inside any long unpunctuated Chinese span (>=14 CJK)
    let protected = find_protected_spans(&s);
    let in_protected = |pos: usize| protected.iter().any(|&(ps, pe)| pos >= ps && pos < pe);

    let mut boundaries: Vec<usize> = Vec::new();
    for (idx, ch) in s.char_indices() {
        if matches!(ch, '，' | '。' | '！' | '？' | '；' | '：' | ',' | '.' | '!' | '?' | ';' | ':')
            && !in_protected(idx)
        {
            boundaries.push(idx);
        }
    }
    boundaries.push(s.len());

    let mut inserts: Vec<usize> = Vec::new();
    let mut seg_start = 0usize;
    for &seg_end in &boundaries {
        if seg_end > seg_start {
            let chunk = &s[seg_start..seg_end];
            if count_cjk(chunk) >= 14 {
                let mut last_break = seg_start;
                let mut pos = seg_start;
                while pos < seg_end {
                    let mut matched_len = 0usize;
                    if !in_protected(pos) {
                        for &conn in ZH_CLAUSE_CONNECTORS {
                            if s[pos..seg_end].starts_with(conn) {
                                matched_len = conn.len();
                                break;
                            }
                        }
                    }
                    if matched_len > 0 {
                        let prev_ok = pos == seg_start
                            || !s[..pos].ends_with(|c: char| {
                                matches!(c, '，' | '。' | '！' | '？' | '；' | '：' | ',' | '.' | '!' | '?' | ';' | ':' | ' ' | '\t')
                            });
                        let left_cjk = count_cjk(&s[last_break..pos]);
                        let right_cjk = count_cjk(&s[pos..seg_end]);
                        if prev_ok && left_cjk >= 6 && right_cjk >= 4 {
                            inserts.push(pos);
                            last_break = pos;
                        }
                        pos += matched_len;
                    } else {
                        let ch = s[pos..].chars().next().unwrap();
                        pos += ch.len_utf8();
                    }
                }
            }
        }
        seg_start = if seg_end < s.len() {
            seg_end + s[seg_end..].chars().next().map(|c| c.len_utf8()).unwrap_or(1)
        } else {
            s.len()
        };
    }

    if !inserts.is_empty() {
        let mut rebuilt = String::with_capacity(s.len() + inserts.len() * 3);
        let mut cursor = 0;
        for pos in inserts {
            rebuilt.push_str(&s[cursor..pos]);
            rebuilt.push('，');
            cursor = pos;
        }
        rebuilt.push_str(&s[cursor..]);
        s = rebuilt;
    }

    // 3) Normalize trailing comma or missing terminal punctuation
    let last_clause = s
        .rsplit(|c| matches!(c, '。' | '！' | '？' | '!' | '?'))
        .next()
        .unwrap_or(&s);
    if s.ends_with('，') {
        s.pop();
        let tail = s
            .rsplit(|c| matches!(c, '。' | '！' | '？' | '!' | '?'))
            .next()
            .unwrap_or(&s);
        s.push(if looks_like_zh_question(tail) { '？' } else { '。' });
    } else if let Some(last_ch) = s.chars().last() {
        if !matches!(
            last_ch,
            '，' | '。' | '！' | '？' | '；' | '：' | ',' | '.' | '!' | '?' | ';' | ':' | '…' | '—' | ')' | ']' | '}' | '》' | '"' | '\''
        ) {
            let prot_after = find_protected_spans(&s);
            let last_pos = s.len() - last_ch.len_utf8();
            if !prot_after.iter().any(|&(ps, pe)| last_pos >= ps && last_pos < pe) {
                s.push(if looks_like_zh_question(last_clause) { '？' } else { '。' });
            }
        }
    }
    s
}

pub fn local_transform(raw_text: &str, cfg: &VoiceConfig, recognized_language: Option<&str>) -> String {
    if cfg.text_mode == "original" {
        return raw_text.to_string();
    }
    let replaced = apply_replacements(raw_text, &cfg.replacements);
    let punct = choose_punctuation(&cfg.punctuation_mode, recognized_language, &replaced);
    let mut text = map_safe_spans(&replaced, |span| {
        clean_segment(span, punct, &cfg.space_mode)
    })
    .trim_matches(|c| c == ' ' || c == '\t' || c == '\n')
    .to_string();

    if punct == "zh" && cfg.space_mode != "comma-to-space" {
        text = text
            .split('\n')
            .map(auto_punctuate_chinese_line)
            .collect::<Vec<_>>()
            .join("\n");
    }

    let use_zh = is_chinese_output(&text, recognized_language, &cfg.language);
    match cfg.text_mode.as_str() {
        "coding-prompt" => {
            let prefix = if use_zh {
                "请帮助处理以下编程请求。保留说话者明确提出的需求与限制；如缺少关键信息，请先询问。\n\n"
            } else {
                "Please help with the following coding request. Preserve the speaker's stated requirements and constraints, and ask if essential details are missing.\n\n"
            };
            format!("{prefix}{text}")
        }
        "analysis-prompt" => {
            let prefix = if use_zh {
                "请先分析以下请求的目标、限制条件、假设与缺失信息。保留说话者原意；如关键信息不足，请简洁地询问后再行动。\n\n"
            } else {
                "Analyze the following request before acting. Identify its goal, constraints, assumptions, and any missing information. Preserve the speaker's meaning and ask a concise clarification if essential details are missing.\n\n"
            };
            format!("{prefix}{text}")
        }
        "custom" => cfg.prompt_template.replace("{text}", &text),
        _ => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_auto_segmentation_and_smart_pause_commas() {
        let mut cfg = VoiceConfig::default_with_port(47832);
        cfg.punctuation_mode = "zh".into();
        cfg.space_mode = "smart".into();
        cfg.text_mode = "clean".into();

        let paused = local_transform(
            "我记得设置里面有优化标点符号的选项 你帮我也优化一下 能不能清楚识别出来呢",
            &cfg,
            Some("zh"),
        );
        assert_eq!(
            paused,
            "我记得设置里面有优化标点符号的选项，你帮我也优化一下，能不能清楚识别出来呢？"
        );

        let continuous = local_transform(
            "请帮我检查一下 OpenCode 的 Python 接口如果有报错就先看日志然后再修改配置文件",
            &cfg,
            Some("zh"),
        );
        assert_eq!(
            continuous,
            "请帮我检查一下 OpenCode 的 Python 接口，如果有报错就先看日志，然后再修改配置文件。"
        );

        let partial = local_transform(
            "帮我把TypeScript配置和API接口检查一下。如果没有问题的话就可以直接运行测试好吗。",
            &cfg,
            Some("zh"),
        );
        assert_eq!(
            partial,
            "帮我把 TypeScript 配置和 API 接口检查一下。如果没有问题的话就可以直接运行测试好吗？"
        );
    }

    #[test]
    fn pure_english_auto_punctuation_keeps_ascii_period_and_protects_urls() {
        let mut cfg = VoiceConfig::default_with_port(47832);
        cfg.punctuation_mode = "auto".into();
        cfg.space_mode = "smart".into();
        let en = local_transform("Check https://example.com/v1.2 in OpenCode.", &cfg, Some("zh"));
        assert_eq!(en, "Check https://example.com/v1.2 in OpenCode.");
    }
}
