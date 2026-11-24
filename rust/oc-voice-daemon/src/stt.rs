use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::config::{
    normalize_openai_endpoint, VoiceConfig, DEFAULT_REWRITE_PROMPT, DEFAULT_REWRITE_PROMPT_ZH,
};
use crate::crypto::random_hex;
use crate::text::{build_asr_hints, is_chinese_output};

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

fn build_agent(timeout_secs: u32) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(timeout_secs.max(1) as u64))
        .redirects(0)
        .build()
}

fn read_bounded_json(resp: ureq::Response) -> Result<Value, String> {
    let mut buf = Vec::new();
    resp.into_reader()
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut buf)
        .map_err(|_| "upstream response read failed".to_string())?;
    if buf.len() > MAX_RESPONSE_BYTES {
        return Err("upstream response exceeded size limit".to_string());
    }
    serde_json::from_slice(&buf).map_err(|_| "upstream returned invalid JSON".to_string())
}

pub fn transcribe_openai_compatible(
    wav_bytes: &[u8],
    cfg: &VoiceConfig,
    api_key: &str,
) -> Result<(String, Option<String>), String> {
    let url = normalize_openai_endpoint(&cfg.stt_base_url, "/audio/transcriptions")
        .map_err(|_| "云端 STT 接口地址未配置或无效".to_string())?;
    if cfg.stt_model.trim().is_empty() {
        return Err("云端 STT 模型名称未配置".to_string());
    }
    let boundary = format!(
        "----ocvoice{}",
        random_hex(12).unwrap_or_else(|_| "boundary1234".into())
    );
    let mut body: Vec<u8> = Vec::with_capacity(wav_bytes.len() + 1024);
    let push_field = |buf: &mut Vec<u8>, name: &str, value: &str| {
        buf.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        buf.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes(),
        );
    };
    push_field(&mut body, "model", cfg.stt_model.trim());
    push_field(&mut body, "response_format", "json");
    if cfg.language != "auto" && !cfg.language.is_empty() {
        push_field(&mut body, "language", &cfg.language);
    }
    let (prompt, _) = build_asr_hints(cfg);
    if !prompt.is_empty() {
        push_field(&mut body, "prompt", &prompt);
    }
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n",
    );
    body.extend_from_slice(wav_bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let agent = build_agent(cfg.stt_timeout);
    let mut req = agent
        .post(&url)
        .set("Content-Type", &format!("multipart/form-data; boundary={boundary}"))
        .set("Accept", "application/json");
    if !api_key.trim().is_empty() {
        req = req.set("Authorization", &format!("Bearer {}", api_key.trim()));
    }
    let resp = req.send_bytes(&body).map_err(|err| match err {
        ureq::Error::Status(code, _) => format!("云端语音识别请求失败（HTTP {code}）"),
        ureq::Error::Transport(_) => "云端语音识别连接失败或超时".to_string(),
    })?;
    if (300..400).contains(&resp.status()) {
        return Err("云端语音识别拒绝重定向响应".to_string());
    }
    let parsed = read_bounded_json(resp)?;
    let text = parsed
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "云端语音识别返回缺少 text 字段".to_string())?
        .trim()
        .to_string();
    let lang = parsed
        .get("language")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok((text, lang))
}

pub fn rewrite_text(
    local_text: &str,
    cfg: &VoiceConfig,
    api_key: &str,
    recognized_language: Option<&str>,
) -> Result<String, String> {
    let url = normalize_openai_endpoint(&cfg.rewrite_base_url, "/chat/completions")
        .map_err(|_| "AI 改写未完成，已保留本地识别结果。".to_string())?;
    if cfg.rewrite_model.trim().is_empty() {
        return Err("AI 改写未完成，已保留本地识别结果。".to_string());
    }
    let system_prompt = if cfg.rewrite_prompt.trim() == DEFAULT_REWRITE_PROMPT
        && is_chinese_output(local_text, recognized_language, &cfg.language)
    {
        DEFAULT_REWRITE_PROMPT_ZH
    } else {
        cfg.rewrite_prompt.trim()
    };
    let payload = json!({
        "model": cfg.rewrite_model.trim(),
        "temperature": 0,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": local_text }
        ]
    });
    let agent = build_agent(cfg.rewrite_timeout);
    let mut req = agent
        .post(&url)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json");
    if !api_key.trim().is_empty() {
        req = req.set("Authorization", &format!("Bearer {}", api_key.trim()));
    }
    let resp = req
        .send_json(payload)
        .map_err(|_| "AI 改写未完成，已保留本地识别结果。".to_string())?;
    if (300..400).contains(&resp.status()) {
        return Err("AI 改写未完成，已保留本地识别结果。".to_string());
    }
    let parsed = read_bounded_json(resp).map_err(|_| "AI 改写未完成，已保留本地识别结果。".to_string())?;
    let choice = parsed
        .get("choices")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .ok_or_else(|| "AI 改写未完成，已保留本地识别结果。".to_string())?;
    if choice.get("finish_reason").and_then(|v| v.as_str()) == Some("length") {
        return Err("AI 改写未完成，已保留本地识别结果。".to_string());
    }
    let content = choice
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "AI 改写未完成，已保留本地识别结果。".to_string())?;
    Ok(content)
}

pub fn fetch_remote_models(base_url: &str, api_key: &str, timeout_secs: u32) -> Result<Vec<String>, String> {
    let url = normalize_openai_endpoint(base_url, "/models")?;
    let agent = build_agent(timeout_secs.min(30));
    let mut req = agent.get(&url).set("Accept", "application/json");
    if !api_key.trim().is_empty() {
        req = req.set("Authorization", &format!("Bearer {}", api_key.trim()));
    }
    let resp = req.call().map_err(|err| match err {
        ureq::Error::Status(code, _) => format!("获取远端模型列表失败（HTTP {code}）"),
        ureq::Error::Transport(_) => "连接远端模型接口失败或超时".to_string(),
    })?;
    if (300..400).contains(&resp.status()) {
        return Err("远端模型接口拒绝重定向".to_string());
    }
    let parsed = read_bounded_json(resp)?;
    let arr = parsed
        .get("data")
        .and_then(|v| v.as_array())
        .or_else(|| parsed.as_array())
        .ok_or_else(|| "远端模型列表响应格式不受支持".to_string())?;
    let mut ids: Vec<String> = Vec::new();
    for item in arr.iter().take(500) {
        let id = item
            .as_str()
            .or_else(|| item.get("id").and_then(|v| v.as_str()))
            .map(|s| s.trim())
            .filter(|s| !s.is_empty());
        if let Some(id_str) = id {
            if !ids.iter().any(|x| x == id_str) {
                ids.push(id_str.to_string());
            }
        }
    }
    Ok(ids)
}

fn find_external_binary(explicit: &str, voice_home: &Path, names: &[&str]) -> Option<PathBuf> {
    if !explicit.trim().is_empty() {
        let p = PathBuf::from(explicit.trim());
        if p.is_file() {
            return Some(p);
        }
    }
    let search_dirs = [
        voice_home.join("engines"),
        voice_home.join("bin"),
        voice_home.parent().unwrap_or(voice_home).join("whisper").join("engines"),
    ];
    for dir in &search_dirs {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    if let Ok(path_env) = std::env::var("PATH") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        for dir in path_env.split(sep) {
            for name in names {
                let candidate = Path::new(dir).join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// Lightweight zero-Python offline runner supporting whisper.cpp (`whisper-cli`) GGUF models.
pub fn transcribe_whisper_cli(
    wav_bytes: &[u8],
    cfg: &VoiceConfig,
    voice_home: &Path,
) -> Result<(String, Option<String>), String> {
    let names: &[&str] = if cfg!(windows) {
        &["whisper-cli.exe", "main.exe"]
    } else {
        &["whisper-cli", "main"]
    };
    let bin = find_external_binary(&cfg.engine_path, voice_home, names).ok_or_else(|| {
        "未找到 whisper-cli 轻量离线引擎（可将 whisper-cli.exe 放入 local-voice/engines 目录或设置 engine_path）".to_string()
    })?;
    let model = PathBuf::from(cfg.model_path.trim());
    if !model.is_file() {
        return Err("whisper-cli 需要指向本地 GGUF 模型文件（如 ggml-large-v3-turbo-q5_0.bin）".to_string());
    }
    let tmp_id = random_hex(8).unwrap_or_else(|_| "clip".into());
    let tmp_wav = std::env::temp_dir().join(format!("oc-voice-{tmp_id}.wav"));
    fs::write(&tmp_wav, wav_bytes).map_err(|e| format!("写入临时音频失败: {e}"))?;

    let (prompt, _) = build_asr_hints(cfg);
    let mut cmd = Command::new(&bin);
    cmd.arg("-m").arg(&model).arg("-f").arg(&tmp_wav).arg("-nt").arg("-np");
    if cfg.language != "auto" && !cfg.language.is_empty() {
        cmd.arg("-l").arg(&cfg.language);
    } else {
        cmd.arg("-l").arg("auto");
    }
    cmd.arg("-t").arg(cfg.cpu_threads.to_string());
    if !prompt.is_empty() {
        cmd.arg("--prompt").arg(&prompt);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output();
    let _ = fs::remove_file(&tmp_wav);
    let output = output.map_err(|e| format!("启动 whisper-cli 失败: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("whisper-cli 识别失败: {}", stderr.trim()));
    }
    let text = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let lang = if cfg.language == "auto" {
        None
    } else {
        Some(cfg.language.clone())
    };
    Ok((text, lang))
}

pub fn silent_wav16k() -> Vec<u8> {
    let samples = 1600u32; // 0.1s at 16kHz mono 16-bit PCM
    let data_bytes = samples * 2;
    let mut buf = Vec::with_capacity(44 + data_bytes as usize);
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    buf.extend_from_slice(b"WAVEfmt ");
    buf.extend_from_slice(&16u32.to_le_bytes());
    buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
    buf.extend_from_slice(&1u16.to_le_bytes()); // mono
    buf.extend_from_slice(&16000u32.to_le_bytes());
    buf.extend_from_slice(&32000u32.to_le_bytes());
    buf.extend_from_slice(&2u16.to_le_bytes());
    buf.extend_from_slice(&16u16.to_le_bytes());
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&data_bytes.to_le_bytes());
    buf.resize(44 + data_bytes as usize, 0);
    buf
}

pub fn wav_duration_seconds(wav: &[u8]) -> Result<f64, String> {
    if wav.len() < 44 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return Err("音频不是有效的 WAV 格式".to_string());
    }
    let mut pos = 12usize;
    let mut byte_rate = 0u32;
    let mut data_size = 0u32;
    while pos + 8 <= wav.len() {
        let id = &wav[pos..pos + 4];
        let size = u32::from_le_bytes([wav[pos + 4], wav[pos + 5], wav[pos + 6], wav[pos + 7]]);
        let payload_start = pos + 8;
        let payload_end = payload_start.saturating_add(size as usize).min(wav.len());
        if id == b"fmt " && payload_end >= payload_start + 12 {
            byte_rate = u32::from_le_bytes([
                wav[payload_start + 8],
                wav[payload_start + 9],
                wav[payload_start + 10],
                wav[payload_start + 11],
            ]);
        } else if id == b"data" {
            data_size = if size == 0 || size == u32::MAX {
                (wav.len() - payload_start) as u32
            } else {
                size.min((wav.len() - payload_start) as u32)
            };
        }
        let step = (size as usize) + ((size as usize) & 1);
        pos = payload_start.saturating_add(step);
    }
    if byte_rate == 0 {
        return Err("WAV 头部缺少有效采样率信息".to_string());
    }
    Ok((data_size as f64) / (byte_rate as f64))
}
