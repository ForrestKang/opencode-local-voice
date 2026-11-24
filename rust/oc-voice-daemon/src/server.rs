use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::config::{
    ConfigStore, VoiceConfig, PROTOCOL_VERSION, SERVICE_NAME, VERSION,
};
use crate::crypto::{constant_time_eq, hex_encode, hmac_sha256, random_hex};
use crate::stt::{
    fetch_remote_models, rewrite_text, silent_wav16k, transcribe_openai_compatible,
    transcribe_whisper_cli, wav_duration_seconds,
};
use crate::text::local_transform;

const MAX_AUDIO_BYTES: usize = 10 * 1024 * 1024;
const MAX_JSON_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone)]
pub struct JobRecord {
    pub id: String,
    pub state: String,
    pub raw_text: String,
    pub local_text: String,
    pub text: String,
    pub language: Option<String>,
    pub warning: Option<String>,
    pub error: Option<String>,
    pub backend: String,
    pub device: String,
    pub audio_seconds: f64,
    pub queue_seconds: f64,
    pub load_seconds: f64,
    pub inference_seconds: f64,
    pub local_seconds: f64,
    pub rewrite_seconds: f64,
    pub total_seconds: f64,
    pub cancelled: bool,
    pub use_local_requested: bool,
    pub created_at: Instant,
}

impl JobRecord {
    fn new(id: String, backend: String, device: String, audio_seconds: f64) -> Self {
        Self {
            id,
            state: "queued".to_string(),
            raw_text: String::new(),
            local_text: String::new(),
            text: String::new(),
            language: None,
            warning: None,
            error: None,
            backend,
            device,
            audio_seconds,
            queue_seconds: 0.0,
            load_seconds: 0.0,
            inference_seconds: 0.0,
            local_seconds: 0.0,
            rewrite_seconds: 0.0,
            total_seconds: 0.0,
            cancelled: false,
            use_local_requested: false,
            created_at: Instant::now(),
        }
    }

    fn is_live(&self) -> bool {
        matches!(
            self.state.as_str(),
            "queued" | "loading" | "transcribing" | "rewriting"
        )
    }

    fn to_public_json(&self) -> Value {
        json!({
            "id": self.id,
            "state": self.state,
            "raw_text": self.raw_text,
            "local_text": self.local_text,
            "text": self.text,
            "language": self.language,
            "warning": self.warning,
            "processing_warning": self.warning,
            "error": self.error,
            "backend": self.backend,
            "device": self.device,
            "timings": {
                "queue_seconds": self.queue_seconds,
                "load_seconds": self.load_seconds,
                "inference_seconds": self.inference_seconds,
                "local_seconds": self.local_seconds,
                "rewrite_seconds": self.rewrite_seconds,
                "total_seconds": self.total_seconds,
                "audio_seconds": self.audio_seconds,
            }
        })
    }
}

struct QueuedTask {
    id: String,
    wav_bytes: Option<Vec<u8>>,
}

struct CoordinatorState {
    jobs: HashMap<String, JobRecord>,
    job_order: VecDeque<String>,
    queue: VecDeque<QueuedTask>,
    last_activity: Instant,
}

pub struct AppState {
    pub store: ConfigStore,
    pub token: String,
    pub config: Mutex<VoiceConfig>,
    coord_lock: Mutex<CoordinatorState>,
    coord_cv: Condvar,
    pub shutdown: AtomicBool,
}

impl AppState {
    pub fn new(store: ConfigStore, token: String, cfg: VoiceConfig) -> Arc<Self> {
        Arc::new(Self {
            store,
            token,
            config: Mutex::new(cfg),
            coord_lock: Mutex::new(CoordinatorState {
                jobs: HashMap::new(),
                job_order: VecDeque::new(),
                queue: VecDeque::new(),
                last_activity: Instant::now(),
            }),
            coord_cv: Condvar::new(),
            shutdown: AtomicBool::new(false),
        })
    }

    fn touch_activity(&self) {
        if let Ok(mut guard) = self.coord_lock.lock() {
            guard.last_activity = Instant::now();
        }
    }

    fn active_job_count(&self) -> usize {
        self.coord_lock
            .lock()
            .map(|g| g.jobs.values().filter(|j| j.is_live()).count())
            .unwrap_or(0)
    }

    fn start_worker(self: &Arc<Self>) {
        let app = Arc::clone(self);
        thread::spawn(move || loop {
            let task = {
                let mut guard = app.coord_lock.lock().unwrap();
                while guard.queue.is_empty() && !app.shutdown.load(Ordering::SeqCst) {
                    guard = app.coord_cv.wait(guard).unwrap();
                }
                if app.shutdown.load(Ordering::SeqCst) {
                    return;
                }
                guard.queue.pop_front()
            };
            if let Some(task) = task {
                app.process_task(task);
            }
        });
    }

    fn process_task(&self, task: QueuedTask) {
        let cfg = self.config.lock().unwrap().clone();
        let job_start = Instant::now();
        {
            let mut guard = self.coord_lock.lock().unwrap();
            if let Some(job) = guard.jobs.get_mut(&task.id) {
                if job.cancelled {
                    job.state = "cancelled".to_string();
                    self.coord_cv.notify_all();
                    return;
                }
                job.queue_seconds = job.created_at.elapsed().as_secs_f64();
                job.state = if task.wav_bytes.is_none() {
                    "done".to_string()
                } else {
                    "transcribing".to_string()
                };
                if task.wav_bytes.is_none() {
                    job.total_seconds = job.created_at.elapsed().as_secs_f64();
                }
            }
            self.coord_cv.notify_all();
        }
        let Some(wav_bytes) = task.wav_bytes else {
            return;
        };

        let t_inf = Instant::now();
        let stt_result = match cfg.backend.as_str() {
            "openai-compatible" => {
                let key = self.store.stt_secret.read().unwrap_or_default();
                transcribe_openai_compatible(&wav_bytes, &cfg, &key)
            }
            "whisper-cli" => transcribe_whisper_cli(&wav_bytes, &cfg, &self.store.home),
            other => Err(format!(
                "当前 Rust 守护进程暂不直接托管 {other}；请切换 backend 为 openai-compatible / whisper-cli，或使用本机 Python 后端"
            )),
        };
        let inf_secs = t_inf.elapsed().as_secs_f64();

        let (raw_text, recognized_lang) = match stt_result {
            Ok(v) => v,
            Err(err_msg) => {
                let mut guard = self.coord_lock.lock().unwrap();
                if let Some(job) = guard.jobs.get_mut(&task.id) {
                    if !job.cancelled {
                        job.state = "error".to_string();
                        job.error = Some(err_msg);
                        job.inference_seconds = inf_secs;
                        job.total_seconds = job_start.elapsed().as_secs_f64();
                    }
                }
                self.coord_cv.notify_all();
                return;
            }
        };

        let t_local = Instant::now();
        let local_text = local_transform(&raw_text, &cfg, recognized_lang.as_deref());
        let local_secs = t_local.elapsed().as_secs_f64();

        let need_ai = cfg.text_mode == "ai" && !local_text.is_empty();
        {
            let mut guard = self.coord_lock.lock().unwrap();
            if let Some(job) = guard.jobs.get_mut(&task.id) {
                if job.cancelled {
                    job.state = "cancelled".to_string();
                    self.coord_cv.notify_all();
                    return;
                }
                job.raw_text = raw_text.clone();
                job.local_text = local_text.clone();
                job.language = recognized_lang.clone();
                job.inference_seconds = inf_secs;
                job.local_seconds = local_secs;
                if need_ai && !job.use_local_requested {
                    job.state = "rewriting".to_string();
                } else {
                    job.text = local_text.clone();
                    job.state = "done".to_string();
                    job.total_seconds = job_start.elapsed().as_secs_f64();
                }
            }
            self.coord_cv.notify_all();
        }
        if !need_ai {
            return;
        }

        let t_rw = Instant::now();
        let key = self.store.rewrite_secret.read().unwrap_or_default();
        let rw_res = rewrite_text(&local_text, &cfg, &key, recognized_lang.as_deref());
        let rw_secs = t_rw.elapsed().as_secs_f64();

        let mut guard = self.coord_lock.lock().unwrap();
        if let Some(job) = guard.jobs.get_mut(&task.id) {
            if job.cancelled || job.state == "done" || job.use_local_requested {
                return;
            }
            job.rewrite_seconds = rw_secs;
            match rw_res {
                Ok(rewritten) => {
                    job.text = rewritten;
                }
                Err(warn_msg) => {
                    job.text = local_text;
                    job.warning = Some(warn_msg);
                }
            }
            job.state = "done".to_string();
            job.total_seconds = job_start.elapsed().as_secs_f64();
        }
        self.coord_cv.notify_all();
    }
}

struct HttpRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn parse_query(raw: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for pair in raw.split('&') {
        if pair.is_empty() {
            continue;
        }
        let mut it = pair.splitn(2, '=');
        let k = it.next().unwrap_or("").to_string();
        let v = it.next().unwrap_or("").to_string();
        map.insert(k, v);
    }
    map
}

fn read_http_request(stream: &mut TcpStream) -> Result<Option<HttpRequest>, (u16, String)> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| (500, e.to_string()))?);
    let mut request_line = String::new();
    let n = reader
        .read_line(&mut request_line)
        .map_err(|_| (400, "failed to read request line".to_string()))?;
    if n == 0 {
        return Ok(None);
    }
    let parts: Vec<&str> = request_line.trim().split_whitespace().collect();
    if parts.len() < 2 {
        return Err((400, "malformed HTTP request line".to_string()));
    }
    let method = parts[0].to_ascii_uppercase();
    let full_target = parts[1];
    let (path, query) = match full_target.split_once('?') {
        Some((p, q)) => (p.to_string(), parse_query(q)),
        None => (full_target.to_string(), HashMap::new()),
    };

    let mut headers = HashMap::new();
    let mut header_count = 0usize;
    loop {
        let mut line = String::new();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|_| (400, "failed to read headers".to_string()))?;
        if bytes == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        header_count += 1;
        if header_count > 64 {
            return Err((431, "too many headers".to_string()));
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let content_len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    let max_body = if path == "/v1/jobs" {
        MAX_AUDIO_BYTES
    } else {
        MAX_JSON_BYTES
    };
    if content_len > max_body {
        return Err((413, "request body exceeds maximum allowed size".to_string()));
    }
    let mut body = vec![0u8; content_len];
    if content_len > 0 {
        reader
            .read_exact(&mut body)
            .map_err(|_| (400, "incomplete request body".to_string()))?;
    }
    Ok(Some(HttpRequest {
        method,
        path,
        query,
        headers,
        body,
    }))
}

fn write_json_response(
    stream: &mut TcpStream,
    status: u16,
    value: &Value,
    cors_origin: Option<&str>,
    keep_alive: bool,
) {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        _ => "Internal Server Error",
    };
    let payload = if status == 204 {
        Vec::new()
    } else {
        serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec())
    };
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: {}\r\n",
        payload.len(),
        if keep_alive { "keep-alive" } else { "close" }
    );
    if let Some(origin) = cors_origin {
        head.push_str(&format!(
            "Access-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Headers: Authorization, Content-Type, X-Job-Id\r\nAccess-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS\r\nVary: Origin\r\n"
        ));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    if !payload.is_empty() {
        let _ = stream.write_all(&payload);
    }
    let _ = stream.flush();
}

fn check_cors(app: &AppState, req: &HttpRequest) -> Result<Option<String>, (u16, String)> {
    let Some(origin) = req.headers.get("origin") else {
        return Ok(None);
    };
    let clean = origin.trim().trim_end_matches('/');
    let cfg = app.config.lock().unwrap();
    if cfg.allowed_origins.iter().any(|o| o.eq_ignore_ascii_case(clean)) {
        Ok(Some(clean.to_string()))
    } else {
        Err((403, "origin is not allowed".to_string()))
    }
}

fn check_bearer(app: &AppState, req: &HttpRequest) -> bool {
    let Some(auth) = req.headers.get("authorization") else {
        return false;
    };
    let Some(token) = auth.strip_prefix("Bearer ").or_else(|| auth.strip_prefix("bearer ")) else {
        return false;
    };
    constant_time_eq(token.trim().as_bytes(), app.token.as_bytes())
}

fn valid_job_id(id: &str) -> bool {
    (8..=80).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn handle_request(app: &Arc<AppState>, req: HttpRequest) -> (u16, Value, Option<String>) {
    let cors = match check_cors(app, &req) {
        Ok(o) => o,
        Err((code, msg)) => return (code, json!({ "error": msg, "code": "FORBIDDEN" }), None),
    };
    if req.method == "OPTIONS" {
        return (204, json!({}), cors);
    }
    app.touch_activity();

    // Unauthenticated identity endpoint
    if req.method == "GET" && req.path == "/health" {
        let mut out = Map::new();
        out.insert("ok".into(), Value::Bool(true));
        out.insert("service".into(), Value::String(SERVICE_NAME.into()));
        out.insert("protocol".into(), Value::from(PROTOCOL_VERSION));
        out.insert("version".into(), Value::String(VERSION.into()));
        out.insert("runtime".into(), Value::String("rust".into()));
        if let Some(nonce) = req.query.get("challenge") {
            if !nonce.is_empty() && nonce.len() <= 128 {
                let proof = hex_encode(&hmac_sha256(app.token.as_bytes(), nonce.as_bytes()));
                out.insert("proof".into(), Value::String(proof));
            }
        }
        return (200, Value::Object(out), cors);
    }

    if !check_bearer(app, &req) {
        return (
            401,
            json!({ "error": "unauthorized", "code": "UNAUTHORIZED" }),
            cors,
        );
    }

    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/v1/status") => {
            let cfg = app.config.lock().unwrap().clone();
            let active = app.active_job_count();
            (
                200,
                json!({
                    "service": SERVICE_NAME,
                    "protocol": PROTOCOL_VERSION,
                    "version": VERSION,
                    "runtime": "rust",
                    "state": if active > 0 { "busy" } else { "idle" },
                    "active_jobs": active,
                    "backend": cfg.backend,
                    "device": cfg.device,
                    "model_path": cfg.model_path,
                    "port": cfg.port,
                }),
                cors,
            )
        }
        ("GET", "/v1/config") => {
            let cfg = app.config.lock().unwrap().clone();
            let rw_set = app.store.rewrite_secret.exists();
            let stt_set = app.store.stt_secret.exists();
            (200, cfg.to_public_json(rw_set, stt_set), cors)
        }
        ("PATCH", "/v1/config") => {
            let parsed: Value = match serde_json::from_slice(&req.body) {
                Ok(v) => v,
                Err(_) => return (400, json!({ "error": "invalid JSON body", "code": "invalid_request" }), cors),
            };
            let Some(patch) = parsed.as_object() else {
                return (400, json!({ "error": "config patch must be an object", "code": "invalid_request" }), cors);
            };
            let mut cfg_guard = app.config.lock().unwrap();
            match app.store.apply_patch(&cfg_guard, patch) {
                Ok(updated) => {
                    *cfg_guard = updated.clone();
                    let rw_set = app.store.rewrite_secret.exists();
                    let stt_set = app.store.stt_secret.exists();
                    (200, updated.to_public_json(rw_set, stt_set), cors)
                }
                Err(msg) => (400, json!({ "error": msg, "code": "invalid_request" }), cors),
            }
        }
        ("POST", "/v1/shutdown") => {
            app.shutdown.store(true, Ordering::SeqCst);
            app.coord_cv.notify_all();
            (200, json!({ "ok": true, "state": "stopping" }), cors)
        }
        ("GET", "/v1/models") => {
            let cfg = app.config.lock().unwrap().clone();
            (
                200,
                json!({
                    "backend": cfg.backend,
                    "runtime": "rust",
                    "models": [],
                    "downloading": false,
                }),
                cors,
            )
        }
        ("POST", "/v1/warmup") => (202, json!({ "ok": true, "state": "ready", "runtime": "rust" }), cors),
        ("POST", "/v1/text") | ("POST", "/v1/text/preview") => {
            let parsed: Value = match serde_json::from_slice(&req.body) {
                Ok(v) => v,
                Err(_) => return (400, json!({ "error": "invalid JSON body", "code": "invalid_request" }), cors),
            };
            let Some(obj) = parsed.as_object() else {
                return (400, json!({ "error": "body must be JSON object", "code": "invalid_request" }), cors);
            };
            let raw_text = obj.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let lang = obj.get("language").and_then(|v| v.as_str());
            let mut merged = app
                .config
                .lock()
                .unwrap()
                .to_json_value()
                .as_object()
                .cloned()
                .unwrap_or_default();
            // Support both nested {"config": {...}} and flat overrides
            let override_map = obj.get("config").and_then(|v| v.as_object()).unwrap_or(obj);
            for (k, v) in override_map {
                if matches!(
                    k.as_str(),
                    "text" | "config" | "rewrite_api_key" | "stt_api_key"
                ) {
                    continue;
                }
                merged.insert(k.clone(), v.clone());
            }
            let effective = match VoiceConfig::from_json_value(&Value::Object(merged)) {
                Ok(c) => c,
                Err(msg) => return (400, json!({ "error": msg, "code": "invalid_request" }), cors),
            };
            let local = local_transform(raw_text, &effective, lang);
            if effective.text_mode == "ai" && !local.is_empty() {
                let supplied_key = obj
                    .get("rewrite_api_key")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| app.store.rewrite_secret.read().unwrap_or_default());
                match rewrite_text(&local, &effective, &supplied_key, lang) {
                    Ok(rewritten) => (
                        200,
                        json!({ "local_text": local, "text": rewritten, "warning": Value::Null, "text_mode": effective.text_mode }),
                        cors,
                    ),
                    Err(warn) => (
                        200,
                        json!({ "local_text": local, "text": local, "warning": warn, "text_mode": effective.text_mode }),
                        cors,
                    ),
                }
            } else {
                (
                    200,
                    json!({ "local_text": local, "text": local, "warning": Value::Null, "text_mode": effective.text_mode }),
                    cors,
                )
            }
        }
        ("POST", "/v1/stt/test") => {
            let parsed: Value = serde_json::from_slice(&req.body).unwrap_or_else(|_| json!({}));
            let obj = parsed.as_object().cloned().unwrap_or_default();
            let override_map = obj.get("config").and_then(|v| v.as_object()).unwrap_or(&obj);
            let mut merged = app.config.lock().unwrap().to_json_value().as_object().cloned().unwrap_or_default();
            for (k, v) in override_map {
                if k != "stt_api_key" && k != "config" {
                    merged.insert(k.clone(), v.clone());
                }
            }
            let effective = match VoiceConfig::from_json_value(&Value::Object(merged)) {
                Ok(c) => c,
                Err(msg) => return (400, json!({ "error": msg, "code": "invalid_request" }), cors),
            };
            let key = obj
                .get("stt_api_key")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| app.store.stt_secret.read().unwrap_or_default());
            let wav = silent_wav16k();
            match transcribe_openai_compatible(&wav, &effective, &key) {
                Ok((text, _)) => (200, json!({ "ok": true, "text": text }), cors),
                Err(msg) => (400, json!({ "ok": false, "error": msg }), cors),
            }
        }
        ("POST", "/v1/stt/models") => {
            let parsed: Value = serde_json::from_slice(&req.body).unwrap_or_else(|_| json!({}));
            let obj = parsed.as_object().cloned().unwrap_or_default();
            let override_map = obj.get("config").and_then(|v| v.as_object()).unwrap_or(&obj);
            let cfg = app.config.lock().unwrap().clone();
            let base = override_map
                .get("stt_base_url")
                .and_then(|v| v.as_str())
                .unwrap_or(&cfg.stt_base_url);
            let key = obj
                .get("stt_api_key")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| app.store.stt_secret.read().unwrap_or_default());
            match fetch_remote_models(base, &key, cfg.stt_timeout) {
                Ok(models) => (200, json!({ "ok": true, "models": models }), cors),
                Err(msg) => (400, json!({ "ok": false, "error": msg }), cors),
            }
        }
        ("POST", "/v1/rewrite/test") => {
            let parsed: Value = serde_json::from_slice(&req.body).unwrap_or_else(|_| json!({}));
            let obj = parsed.as_object().cloned().unwrap_or_default();
            let override_map = obj.get("config").and_then(|v| v.as_object()).unwrap_or(&obj);
            let mut merged = app.config.lock().unwrap().to_json_value().as_object().cloned().unwrap_or_default();
            for (k, v) in override_map {
                if k != "rewrite_api_key" && k != "config" {
                    merged.insert(k.clone(), v.clone());
                }
            }
            let effective = match VoiceConfig::from_json_value(&Value::Object(merged)) {
                Ok(c) => c,
                Err(msg) => return (400, json!({ "error": msg, "code": "invalid_request" }), cors),
            };
            let key = obj
                .get("rewrite_api_key")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| app.store.rewrite_secret.read().unwrap_or_default());
            match rewrite_text("Hello world.", &effective, &key, Some("en")) {
                Ok(text) => (200, json!({ "ok": true, "text": text }), cors),
                Err(msg) => (400, json!({ "ok": false, "error": msg }), cors),
            }
        }
        ("POST", "/v1/rewrite/models") => {
            let parsed: Value = serde_json::from_slice(&req.body).unwrap_or_else(|_| json!({}));
            let obj = parsed.as_object().cloned().unwrap_or_default();
            let override_map = obj.get("config").and_then(|v| v.as_object()).unwrap_or(&obj);
            let cfg = app.config.lock().unwrap().clone();
            let base = override_map
                .get("rewrite_base_url")
                .and_then(|v| v.as_str())
                .unwrap_or(&cfg.rewrite_base_url);
            let key = obj
                .get("rewrite_api_key")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| app.store.rewrite_secret.read().unwrap_or_default());
            match fetch_remote_models(base, &key, cfg.rewrite_timeout) {
                Ok(models) => (200, json!({ "ok": true, "models": models }), cors),
                Err(msg) => (400, json!({ "ok": false, "error": msg }), cors),
            }
        }
        ("POST", "/v1/jobs") => handle_create_job(app, &req, cors),
        _ => {
            if let Some(rest) = req.path.strip_prefix("/v1/jobs/") {
                if let Some(job_id) = rest.strip_suffix("/use-local") {
                    if req.method == "POST" {
                        return handle_use_local(app, job_id, cors);
                    }
                } else if !rest.contains('/') {
                    if req.method == "GET" {
                        return handle_get_job(app, rest, &req.query, cors);
                    }
                    if req.method == "DELETE" {
                        return handle_delete_job(app, rest, cors);
                    }
                }
            }
            (404, json!({ "error": "not found", "code": "NOT_FOUND" }), cors)
        }
    }
}

fn handle_create_job(
    app: &Arc<AppState>,
    req: &HttpRequest,
    cors: Option<String>,
) -> (u16, Value, Option<String>) {
    let job_id = match req.headers.get("x-job-id") {
        Some(id) if valid_job_id(id) => id.clone(),
        Some(_) => return (400, json!({ "error": "invalid X-Job-Id", "code": "INVALID_JOB" }), cors),
        None => random_hex(12).unwrap_or_else(|_| "job00000001".into()),
    };

    // Idempotent duplicate check
    {
        let guard = app.coord_lock.lock().unwrap();
        if let Some(existing) = guard.jobs.get(&job_id) {
            return (202, existing.to_public_json(), cors);
        }
    }

    let content_type = req
        .headers
        .get("content-type")
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    let (wav_opt, audio_seconds) = if content_type.contains("application/json") {
        let parsed: Value = match serde_json::from_slice(&req.body) {
            Ok(v) => v,
            Err(_) => return (400, json!({ "error": "invalid JSON", "code": "invalid_request" }), cors),
        };
        if parsed.get("warmup").and_then(|v| v.as_bool()) == Some(true) {
            (None, 0.0)
        } else {
            return (400, json!({ "error": "expected audio/wav or warmup JSON", "code": "INVALID_AUDIO" }), cors);
        }
    } else {
        let dur = match wav_duration_seconds(&req.body) {
            Ok(d) => d,
            Err(msg) => return (400, json!({ "error": msg, "code": "INVALID_AUDIO" }), cors),
        };
        let max_sec = app.config.lock().unwrap().max_seconds as f64;
        if dur <= 0.0 || dur > max_sec + 1.0 {
            return (400, json!({ "error": "音频时长超出允许范围", "code": "INVALID_AUDIO" }), cors);
        }
        (Some(req.body.clone()), dur)
    };

    let cfg = app.config.lock().unwrap().clone();
    let job = JobRecord::new(job_id.clone(), cfg.backend, cfg.device, audio_seconds);
    let pub_json = job.to_public_json();
    {
        let mut guard = app.coord_lock.lock().unwrap();
        guard.jobs.insert(job_id.clone(), job);
        guard.job_order.push_back(job_id.clone());
        while guard.job_order.len() > 64 {
            if let Some(oldest) = guard.job_order.pop_front() {
                if guard.jobs.get(&oldest).is_some_and(|j| !j.is_live()) {
                    guard.jobs.remove(&oldest);
                }
            }
        }
        guard.queue.push_back(QueuedTask {
            id: job_id,
            wav_bytes: wav_opt,
        });
        app.coord_cv.notify_all();
    }
    (202, pub_json, cors)
}

fn handle_get_job(
    app: &Arc<AppState>,
    job_id: &str,
    query: &HashMap<String, String>,
    cors: Option<String>,
) -> (u16, Value, Option<String>) {
    if !valid_job_id(job_id) {
        return (400, json!({ "error": "invalid job id", "code": "INVALID_JOB" }), cors);
    }
    let wait_secs: f64 = query
        .get("wait")
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0)
        .clamp(0.0, 15.0);
    let after_state = query.get("after_state").map(|s| s.as_str()).unwrap_or("");

    let mut guard = app.coord_lock.lock().unwrap();
    let deadline = Instant::now() + Duration::from_secs_f64(wait_secs);
    loop {
        let Some(job) = guard.jobs.get(job_id) else {
            return (404, json!({ "error": "job not found", "code": "NOT_FOUND" }), cors);
        };
        let state_changed = !after_state.is_empty() && job.state != after_state;
        if !job.is_live() || state_changed || wait_secs <= 0.0 || Instant::now() >= deadline {
            return (200, job.to_public_json(), cors);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return (200, job.to_public_json(), cors);
        }
        let (next_guard, _) = app.coord_cv.wait_timeout(guard, remaining).unwrap();
        guard = next_guard;
    }
}

fn handle_delete_job(
    app: &Arc<AppState>,
    job_id: &str,
    cors: Option<String>,
) -> (u16, Value, Option<String>) {
    if !valid_job_id(job_id) {
        return (400, json!({ "error": "invalid job id", "code": "INVALID_JOB" }), cors);
    }
    let mut guard = app.coord_lock.lock().unwrap();
    let Some(job) = guard.jobs.get_mut(job_id) else {
        return (404, json!({ "error": "job not found", "code": "NOT_FOUND" }), cors);
    };
    job.cancelled = true;
    if job.is_live() {
        job.state = "cancelled".to_string();
    }
    let snapshot = job.to_public_json();
    app.coord_cv.notify_all();
    (200, snapshot, cors)
}

fn handle_use_local(
    app: &Arc<AppState>,
    job_id: &str,
    cors: Option<String>,
) -> (u16, Value, Option<String>) {
    if !valid_job_id(job_id) {
        return (400, json!({ "error": "invalid job id", "code": "INVALID_JOB" }), cors);
    }
    let mut guard = app.coord_lock.lock().unwrap();
    let Some(job) = guard.jobs.get_mut(job_id) else {
        return (404, json!({ "error": "job not found", "code": "NOT_FOUND" }), cors);
    };
    if job.state != "rewriting" {
        return (409, json!({ "error": "job is not currently rewriting", "code": "INVALID_STATE" }), cors);
    }
    job.use_local_requested = true;
    job.text = job.local_text.clone();
    job.state = "done".to_string();
    job.total_seconds = job.created_at.elapsed().as_secs_f64();
    let snapshot = job.to_public_json();
    app.coord_cv.notify_all();
    (200, snapshot, cors)
}

fn serve_connection(app: Arc<AppState>, mut stream: TcpStream) {
    let _ = stream.set_nodelay(true);
    loop {
        if app.shutdown.load(Ordering::SeqCst) {
            break;
        }
        match read_http_request(&mut stream) {
            Ok(Some(req)) => {
                let close_requested = req
                    .headers
                    .get("connection")
                    .map(|v| v.eq_ignore_ascii_case("close"))
                    .unwrap_or(false);
                let keep_alive = !close_requested && !app.shutdown.load(Ordering::SeqCst);
                let (status, val, cors) = handle_request(&app, req);
                let final_keep_alive = keep_alive && !app.shutdown.load(Ordering::SeqCst);
                write_json_response(&mut stream, status, &val, cors.as_deref(), final_keep_alive);
                if !final_keep_alive {
                    break;
                }
            }
            Ok(None) => break,
            Err((code, msg)) => {
                write_json_response(
                    &mut stream,
                    code,
                    &json!({ "error": msg, "code": "BAD_REQUEST" }),
                    None,
                    false,
                );
                break;
            }
        }
    }
}

pub fn run_server(app: Arc<AppState>) -> Result<(), String> {
    let port = app.config.lock().unwrap().port;
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("failed to bind 127.0.0.1:{port}: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("set_nonblocking failed: {e}"))?;
    app.start_worker();

    while !app.shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _addr)) => {
                let _ = stream.set_nonblocking(false);
                let state = Arc::clone(&app);
                thread::spawn(move || serve_connection(state, stream));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                // Check idle expiration periodically
                let idle_limit = app.config.lock().unwrap().idle_seconds;
                if idle_limit > 0 {
                    let expired = {
                        let guard = app.coord_lock.lock().unwrap();
                        let active = guard.jobs.values().any(|j| j.is_live());
                        !active && guard.last_activity.elapsed() >= Duration::from_secs(idle_limit as u64)
                    };
                    if expired {
                        app.shutdown.store(true, Ordering::SeqCst);
                        app.coord_cv.notify_all();
                        break;
                    }
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => {
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
    Ok(())
}
