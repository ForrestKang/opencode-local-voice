use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use crate::crypto::{write_atomic, SecretStore};

pub const DEFAULT_PORT: u16 = 47832;
pub const SERVICE_NAME: &str = "opencode-local-voice";
pub const PROTOCOL_VERSION: u32 = 1;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_REWRITE_PROMPT: &str = "Improve the transcript's readability while preserving the speaker's exact meaning, intent, facts, technical terms, uncertainty, and point of view. Do not add, infer, or omit information. Return only the rewritten text.";
pub const DEFAULT_REWRITE_PROMPT_ZH: &str = "请在不改变说话者原意、意图、事实、技术术语、不确定性与立场的前提下，优化这段语音转写文本的可读性、标点与断句。不要增添、臆测或删减信息，只返回改写后的文本。";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReplacementRule {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone)]
pub struct VoiceConfig {
    pub backend: String,
    pub device: String,
    pub model_path: String,
    pub engine_path: String,
    pub language: String,
    pub beam_size: u32,
    pub cpu_threads: u32,
    pub max_seconds: u32,
    pub idle_seconds: u32,
    pub warmup_on_record: bool,
    pub initial_prompt: String,
    pub allowed_origins: Vec<String>,
    pub port: u16,
    pub vocabulary_preset: String,
    pub vocabulary: Vec<String>,
    pub replacements: Vec<ReplacementRule>,
    pub punctuation_mode: String,
    pub space_mode: String,
    pub text_mode: String,
    pub prompt_template: String,
    pub rewrite_base_url: String,
    pub rewrite_model: String,
    pub rewrite_prompt: String,
    pub rewrite_timeout: u32,
    pub stt_base_url: String,
    pub stt_model: String,
    pub stt_timeout: u32,
}

impl VoiceConfig {
    pub fn default_with_port(port: u16) -> Self {
        Self {
            backend: "openai-compatible".to_string(),
            device: "auto".to_string(),
            model_path: String::new(),
            engine_path: String::new(),
            language: "auto".to_string(),
            beam_size: 1,
            cpu_threads: 4,
            max_seconds: 120,
            idle_seconds: 1800,
            warmup_on_record: true,
            initial_prompt: String::new(),
            allowed_origins: vec![
                format!("http://127.0.0.1:{port}"),
                format!("http://localhost:{port}"),
            ],
            port,
            vocabulary_preset: "coding".to_string(),
            vocabulary: Vec::new(),
            replacements: Vec::new(),
            punctuation_mode: "auto".to_string(),
            space_mode: "smart".to_string(),
            text_mode: "clean".to_string(),
            prompt_template: "{text}".to_string(),
            rewrite_base_url: String::new(),
            rewrite_model: String::new(),
            rewrite_prompt: DEFAULT_REWRITE_PROMPT.to_string(),
            rewrite_timeout: 15,
            stt_base_url: String::new(),
            stt_model: String::new(),
            stt_timeout: 30,
        }
    }

    pub fn from_json_value(raw: &Value) -> Result<Self, String> {
        let obj = raw
            .as_object()
            .ok_or_else(|| "configuration must be a JSON object".to_string())?;
        let port = match obj.get("port") {
            Some(v) => {
                let p = v.as_u64().ok_or("port must be an integer")?;
                if !(1024..=65535).contains(&p) {
                    return Err("port must be between 1024 and 65535".to_string());
                }
                p as u16
            }
            None => DEFAULT_PORT,
        };
        let mut cfg = Self::default_with_port(port);
        if let Some(v) = obj.get("backend") {
            let s = v.as_str().ok_or("backend must be a string")?.trim();
            if !matches!(
                s,
                "faster-whisper" | "mlx" | "sherpa-onnx" | "openai-compatible" | "whisper-cli"
            ) {
                return Err(format!("unsupported backend: {s}"));
            }
            cfg.backend = s.to_string();
        }
        if let Some(v) = obj.get("device") {
            let s = v.as_str().ok_or("device must be a string")?.trim();
            if !matches!(s, "auto" | "cuda" | "cpu" | "metal" | "vulkan") {
                return Err("device must be auto, cuda, cpu, metal, or vulkan".to_string());
            }
            cfg.device = s.to_string();
        }
        if let Some(v) = obj.get("model_path") {
            cfg.model_path = v.as_str().ok_or("model_path must be a string")?.trim().to_string();
        }
        if let Some(v) = obj.get("engine_path") {
            cfg.engine_path = v.as_str().ok_or("engine_path must be a string")?.trim().to_string();
        }
        if let Some(v) = obj.get("language") {
            let s = v.as_str().ok_or("language must be a string")?.trim();
            if s.is_empty() || s.len() > 16 {
                return Err("invalid language".to_string());
            }
            cfg.language = s.to_string();
        }
        if let Some(v) = obj.get("beam_size") {
            let n = v.as_u64().ok_or("beam_size must be an integer")?;
            if !(1..=10).contains(&n) {
                return Err("beam_size must be between 1 and 10".to_string());
            }
            cfg.beam_size = n as u32;
        }
        if let Some(v) = obj.get("cpu_threads") {
            let n = v.as_u64().ok_or("cpu_threads must be an integer")?;
            if !(1..=64).contains(&n) {
                return Err("cpu_threads must be between 1 and 64".to_string());
            }
            cfg.cpu_threads = n as u32;
        }
        if let Some(v) = obj.get("max_seconds") {
            let n = v.as_u64().ok_or("max_seconds must be an integer")?;
            if !(5..=600).contains(&n) {
                return Err("max_seconds must be between 5 and 600".to_string());
            }
            cfg.max_seconds = n as u32;
        }
        if let Some(v) = obj.get("idle_seconds") {
            let n = v.as_u64().ok_or("idle_seconds must be an integer")?;
            if n > 86400 {
                return Err("idle_seconds must be <= 86400".to_string());
            }
            cfg.idle_seconds = n as u32;
        }
        if let Some(v) = obj.get("warmup_on_record") {
            cfg.warmup_on_record = v.as_bool().ok_or("warmup_on_record must be boolean")?;
        }
        if let Some(v) = obj.get("initial_prompt") {
            let s = v.as_str().ok_or("initial_prompt must be a string")?;
            if s.chars().count() > 2000 {
                return Err("initial_prompt is too long".to_string());
            }
            cfg.initial_prompt = s.to_string();
        }
        if let Some(v) = obj.get("allowed_origins") {
            let arr = v.as_array().ok_or("allowed_origins must be an array")?;
            let mut origins = Vec::new();
            for item in arr {
                let s = item.as_str().ok_or("allowed_origins entries must be strings")?.trim();
                if !s.is_empty() && (s.starts_with("http://") || s.starts_with("https://")) {
                    origins.push(s.trim_end_matches('/').to_string());
                }
            }
            cfg.allowed_origins = origins;
        }
        if let Some(v) = obj.get("vocabulary_preset") {
            let s = v.as_str().ok_or("vocabulary_preset must be a string")?.trim();
            if !matches!(s, "none" | "coding") {
                return Err("vocabulary_preset must be none or coding".to_string());
            }
            cfg.vocabulary_preset = s.to_string();
        }
        if let Some(v) = obj.get("vocabulary") {
            let arr = v.as_array().ok_or("vocabulary must be an array")?;
            if arr.len() > 200 {
                return Err("vocabulary exceeds 200 entries".to_string());
            }
            let mut seen = HashSet::new();
            let mut list = Vec::new();
            for item in arr {
                let s = item.as_str().ok_or("vocabulary entries must be strings")?.trim();
                if !s.is_empty() && s.chars().count() <= 80 && seen.insert(s.to_string()) {
                    list.push(s.to_string());
                }
            }
            cfg.vocabulary = list;
        }
        if let Some(v) = obj.get("replacements") {
            let arr = v.as_array().ok_or("replacements must be an array")?;
            if arr.len() > 200 {
                return Err("replacements exceeds 200 entries".to_string());
            }
            let mut list = Vec::new();
            for item in arr {
                let m = item.as_object().ok_or("replacement rule must be an object")?;
                let from = m.get("from").and_then(|x| x.as_str()).unwrap_or("").trim();
                let to = m.get("to").and_then(|x| x.as_str()).unwrap_or("").trim();
                if from.is_empty() || from.chars().count() > 80 || to.chars().count() > 80 {
                    return Err("invalid replacement rule".to_string());
                }
                list.push(ReplacementRule {
                    from: from.to_string(),
                    to: to.to_string(),
                });
            }
            cfg.replacements = list;
        }
        if let Some(v) = obj.get("punctuation_mode") {
            let s = v.as_str().ok_or("punctuation_mode must be a string")?.trim();
            if !matches!(s, "auto" | "zh" | "en" | "none") {
                return Err("punctuation_mode must be auto, zh, en, or none".to_string());
            }
            cfg.punctuation_mode = s.to_string();
        }
        if let Some(v) = obj.get("space_mode") {
            let s = v.as_str().ok_or("space_mode must be a string")?.trim();
            if !matches!(s, "preserve" | "smart" | "space-to-comma" | "comma-to-space") {
                return Err(
                    "space_mode must be preserve, smart, space-to-comma, or comma-to-space"
                        .to_string(),
                );
            }
            cfg.space_mode = s.to_string();
        }
        if let Some(v) = obj.get("text_mode") {
            let s = v.as_str().ok_or("text_mode must be a string")?.trim();
            if !matches!(
                s,
                "original" | "clean" | "coding-prompt" | "analysis-prompt" | "custom" | "ai"
            ) {
                return Err("unsupported text_mode".to_string());
            }
            cfg.text_mode = s.to_string();
        }
        if let Some(v) = obj.get("prompt_template") {
            let s = v.as_str().ok_or("prompt_template must be a string")?;
            if !s.contains("{text}") || s.chars().count() > 4000 {
                return Err("prompt_template must include {text} and be <= 4000 chars".to_string());
            }
            cfg.prompt_template = s.to_string();
        }
        if let Some(v) = obj.get("rewrite_base_url") {
            cfg.rewrite_base_url = validate_endpoint_url(
                v.as_str().ok_or("rewrite_base_url must be a string")?,
                "rewrite_base_url",
            )?;
        }
        if let Some(v) = obj.get("rewrite_model") {
            let s = v.as_str().ok_or("rewrite_model must be a string")?.trim();
            if s.chars().count() > 200 {
                return Err("rewrite_model is too long".to_string());
            }
            cfg.rewrite_model = s.to_string();
        }
        if let Some(v) = obj.get("rewrite_prompt") {
            let s = v.as_str().ok_or("rewrite_prompt must be a string")?.trim();
            if s.chars().count() > 4000 {
                return Err("rewrite_prompt is too long".to_string());
            }
            cfg.rewrite_prompt = if s.is_empty() {
                DEFAULT_REWRITE_PROMPT.to_string()
            } else {
                s.to_string()
            };
        }
        if let Some(v) = obj.get("rewrite_timeout") {
            let n = v.as_u64().ok_or("rewrite_timeout must be an integer")?;
            if !(1..=120).contains(&n) {
                return Err("rewrite_timeout must be between 1 and 120".to_string());
            }
            cfg.rewrite_timeout = n as u32;
        }
        if let Some(v) = obj.get("stt_base_url") {
            cfg.stt_base_url = validate_endpoint_url(
                v.as_str().ok_or("stt_base_url must be a string")?,
                "stt_base_url",
            )?;
        }
        if let Some(v) = obj.get("stt_model") {
            let s = v.as_str().ok_or("stt_model must be a string")?.trim();
            if s.chars().count() > 200 {
                return Err("stt_model is too long".to_string());
            }
            cfg.stt_model = s.to_string();
        }
        if let Some(v) = obj.get("stt_timeout") {
            let n = v.as_u64().ok_or("stt_timeout must be an integer")?;
            if !(1..=120).contains(&n) {
                return Err("stt_timeout must be between 1 and 120".to_string());
            }
            cfg.stt_timeout = n as u32;
        }
        Ok(cfg)
    }

    pub fn to_json_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("backend".into(), Value::String(self.backend.clone()));
        m.insert("device".into(), Value::String(self.device.clone()));
        m.insert("model_path".into(), Value::String(self.model_path.clone()));
        if !self.engine_path.is_empty() {
            m.insert("engine_path".into(), Value::String(self.engine_path.clone()));
        }
        m.insert("language".into(), Value::String(self.language.clone()));
        m.insert("beam_size".into(), Value::from(self.beam_size));
        m.insert("cpu_threads".into(), Value::from(self.cpu_threads));
        m.insert("max_seconds".into(), Value::from(self.max_seconds));
        m.insert("idle_seconds".into(), Value::from(self.idle_seconds));
        m.insert("warmup_on_record".into(), Value::from(self.warmup_on_record));
        m.insert("initial_prompt".into(), Value::String(self.initial_prompt.clone()));
        m.insert(
            "allowed_origins".into(),
            Value::Array(self.allowed_origins.iter().cloned().map(Value::String).collect()),
        );
        m.insert("port".into(), Value::from(self.port));
        m.insert("vocabulary_preset".into(), Value::String(self.vocabulary_preset.clone()));
        m.insert(
            "vocabulary".into(),
            Value::Array(self.vocabulary.iter().cloned().map(Value::String).collect()),
        );
        m.insert(
            "replacements".into(),
            serde_json::to_value(&self.replacements).unwrap_or(Value::Array(vec![])),
        );
        m.insert("punctuation_mode".into(), Value::String(self.punctuation_mode.clone()));
        m.insert("space_mode".into(), Value::String(self.space_mode.clone()));
        m.insert("text_mode".into(), Value::String(self.text_mode.clone()));
        m.insert("prompt_template".into(), Value::String(self.prompt_template.clone()));
        m.insert("rewrite_base_url".into(), Value::String(self.rewrite_base_url.clone()));
        m.insert("rewrite_model".into(), Value::String(self.rewrite_model.clone()));
        m.insert("rewrite_prompt".into(), Value::String(self.rewrite_prompt.clone()));
        m.insert("rewrite_timeout".into(), Value::from(self.rewrite_timeout));
        m.insert("stt_base_url".into(), Value::String(self.stt_base_url.clone()));
        m.insert("stt_model".into(), Value::String(self.stt_model.clone()));
        m.insert("stt_timeout".into(), Value::from(self.stt_timeout));
        Value::Object(m)
    }

    pub fn to_public_json(&self, rewrite_key_set: bool, stt_key_set: bool) -> Value {
        let mut val = self.to_json_value();
        if let Some(m) = val.as_object_mut() {
            m.insert("rewrite_api_key_set".into(), Value::Bool(rewrite_key_set));
            m.insert("stt_api_key_set".into(), Value::Bool(stt_key_set));
        }
        val
    }
}

pub fn validate_endpoint_url(raw: &str, field: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let lowered = trimmed.to_ascii_lowercase();
    let is_https = lowered.starts_with("https://");
    let is_http = lowered.starts_with("http://");
    if !is_https && !is_http {
        return Err(format!("{field} must use https:// or loopback http://"));
    }
    let rest = if is_https { &trimmed[8..] } else { &trimmed[7..] };
    let authority = rest.split('/').next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return Err(format!("{field} must be a valid HTTP(S) endpoint without credentials"));
    }
    if is_http {
        let host = if authority.starts_with('[') {
            authority.split(']').next().unwrap_or("").trim_start_matches('[')
        } else {
            authority.split(':').next().unwrap_or("")
        };
        let lower_host = host.to_ascii_lowercase();
        if !matches!(lower_host.as_str(), "127.0.0.1" | "localhost" | "::1") {
            return Err(format!("{field} requires https:// for non-loopback hosts"));
        }
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

pub fn resolve_voice_home(explicit: Option<&str>) -> PathBuf {
    if let Some(p) = explicit {
        if !p.trim().is_empty() {
            return PathBuf::from(p.trim());
        }
    }
    if let Ok(env_home) = std::env::var("OPENCODE_VOICE_HOME") {
        if !env_home.trim().is_empty() {
            return PathBuf::from(env_home.trim());
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".config")
        .join("opencode")
        .join("local-voice")
}

pub struct ConfigStore {
    pub home: PathBuf,
    pub config_path: PathBuf,
    pub rewrite_secret: SecretStore,
    pub stt_secret: SecretStore,
}

impl ConfigStore {
    pub fn new(home: PathBuf) -> Self {
        let config_path = home.join("config.json");
        let rewrite_secret = SecretStore::new(&home, "rewrite_api_key");
        let stt_secret = SecretStore::new(&home, "stt_api_key");
        Self {
            home,
            config_path,
            rewrite_secret,
            stt_secret,
        }
    }

    pub fn load_or_init(&self) -> Result<VoiceConfig, String> {
        fs::create_dir_all(&self.home).map_err(|e| format!("create home failed: {e}"))?;
        if !self.config_path.exists() {
            let port = std::env::var("OPENCODE_STT_LOCAL_PORT")
                .ok()
                .and_then(|s| s.parse::<u16>().ok())
                .filter(|&p| p >= 1024)
                .unwrap_or(DEFAULT_PORT);
            let cfg = VoiceConfig::default_with_port(port);
            self.save(&cfg)?;
            return Ok(cfg);
        }
        let text = fs::read_to_string(&self.config_path)
            .map_err(|e| format!("failed to read config.json: {e}"))?;
        let trimmed = text.trim_start_matches('\u{feff}');
        let raw: Value =
            serde_json::from_str(trimmed).map_err(|e| format!("invalid config.json: {e}"))?;
        VoiceConfig::from_json_value(&raw)
    }

    pub fn save(&self, cfg: &VoiceConfig) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(&cfg.to_json_value())
            .map_err(|e| format!("serialize config failed: {e}"))?;
        let mut out = bytes;
        out.push(b'\n');
        write_atomic(&self.config_path, &out)
    }

    pub fn apply_patch(
        &self,
        current: &VoiceConfig,
        patch: &Map<String, Value>,
    ) -> Result<VoiceConfig, String> {
        let mut merged = current
            .to_json_value()
            .as_object()
            .cloned()
            .unwrap_or_default();
        let mut new_rewrite_key: Option<String> = None;
        let mut new_stt_key: Option<String> = None;
        for (k, v) in patch {
            if k == "rewrite_api_key" {
                let s = v.as_str().ok_or("rewrite_api_key must be a string")?;
                new_rewrite_key = Some(s.to_string());
                continue;
            }
            if k == "stt_api_key" {
                let s = v.as_str().ok_or("stt_api_key must be a string")?;
                new_stt_key = Some(s.to_string());
                continue;
            }
            if k == "rewrite_api_key_set" || k == "stt_api_key_set" {
                continue;
            }
            merged.insert(k.clone(), v.clone());
        }
        let validated = VoiceConfig::from_json_value(&Value::Object(merged))?;
        if let Some(k) = new_rewrite_key {
            self.rewrite_secret.write(&k)?;
        }
        if let Some(k) = new_stt_key {
            self.stt_secret.write(&k)?;
        }
        self.save(&validated)?;
        Ok(validated)
    }
}

pub fn normalize_openai_endpoint(base: &str, suffix: &str) -> Result<String, String> {
    let cleaned = validate_endpoint_url(base, "endpoint")?;
    if cleaned.is_empty() {
        return Err("endpoint URL is empty".to_string());
    }
    let lowered = cleaned.to_ascii_lowercase();
    if lowered.ends_with(suffix) {
        return Ok(cleaned);
    }
    let trimmed = cleaned.trim_end_matches('/');
    // Strip known sibling paths when deriving /models
    let mut stem = trimmed;
    for sibling in ["/chat/completions", "/audio/transcriptions", "/models"] {
        if stem.to_ascii_lowercase().ends_with(sibling) {
            stem = &stem[..stem.len() - sibling.len()];
            break;
        }
    }
    Ok(format!("{}{}", stem.trim_end_matches('/'), suffix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_url_rejects_remote_http_and_allows_loopback() {
        assert!(validate_endpoint_url("http://api.example.com/v1", "url").is_err());
        assert!(validate_endpoint_url("http://127.0.0.1:8080/v1/", "url").is_ok());
        assert!(validate_endpoint_url("https://api.openai.com/v1/", "url").is_ok());
    }

    #[test]
    fn normalize_openai_endpoints_work() {
        assert_eq!(
            normalize_openai_endpoint("https://api.example.com/v1/", "/audio/transcriptions").unwrap(),
            "https://api.example.com/v1/audio/transcriptions"
        );
        assert_eq!(
            normalize_openai_endpoint("https://api.example.com/v1/audio/transcriptions", "/models").unwrap(),
            "https://api.example.com/v1/models"
        );
    }
}
