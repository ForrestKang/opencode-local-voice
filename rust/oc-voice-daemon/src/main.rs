mod config;
mod crypto;
mod server;
mod stt;
mod text;

use serde_json::{json, Value};
use std::env;
use std::process::ExitCode;
use std::time::Duration;

use config::{resolve_voice_home, ConfigStore, PROTOCOL_VERSION, SERVICE_NAME, VERSION};
use crypto::{constant_time_eq, hex_encode, hmac_sha256, random_hex, read_or_create_token};
use server::{run_server, AppState};

fn print_usage() {
    eprintln!(
        "oc-voice-daemon {VERSION}\nUsage:\n  oc-voice-daemon --serve [--voice-home DIR] [--port PORT]\n  oc-voice-daemon health [--voice-home DIR]\n  oc-voice-daemon stop-service [--voice-home DIR]\n  oc-voice-daemon --version"
    );
}

fn probe_running(port: u16, token: &str) -> Result<Value, String> {
    let nonce = random_hex(16)?;
    let url = format!("http://127.0.0.1:{port}/health?challenge={nonce}");
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(2))
        .redirects(0)
        .build();
    let resp = agent
        .get(&url)
        .call()
        .map_err(|_| "service not running".to_string())?;
    let val: Value = resp
        .into_json()
        .map_err(|_| "invalid health response".to_string())?;
    let expected = hex_encode(&hmac_sha256(token.as_bytes(), nonce.as_bytes()));
    let proof = val.get("proof").and_then(|v| v.as_str()).unwrap_or("");
    if val.get("service").and_then(|v| v.as_str()) != Some(SERVICE_NAME)
        || val.get("protocol").and_then(|v| v.as_u64()) != Some(PROTOCOL_VERSION as u64)
        || !constant_time_eq(proof.as_bytes(), expected.as_bytes())
    {
        return Err("port is occupied by a foreign service".to_string());
    }
    Ok(val)
}

fn stop_running(port: u16, token: &str) -> Result<Value, String> {
    if probe_running(port, token).is_err() {
        return Ok(json!({ "port": port, "state": "not_running" }));
    }
    let url = format!("http://127.0.0.1:{port}/v1/shutdown");
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(3))
        .redirects(0)
        .build();
    let _ = agent
        .post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .send_bytes(&[]);
    Ok(json!({ "port": port, "state": "stopped" }))
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let mut mode = "serve".to_string();
    let mut explicit_home: Option<String> = None;
    let mut port_override: Option<u16> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--serve" | "serve" => mode = "serve".to_string(),
            "health" | "--health" => mode = "health".to_string(),
            "stop-service" | "--stop-service" => mode = "stop-service".to_string(),
            "--version" | "-V" => {
                println!("oc-voice-daemon {VERSION}");
                return ExitCode::SUCCESS;
            }
            "--help" | "-h" => {
                print_usage();
                return ExitCode::SUCCESS;
            }
            "--voice-home" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("missing value for --voice-home");
                    return ExitCode::FAILURE;
                }
                explicit_home = Some(args[i].clone());
            }
            "--port" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("missing value for --port");
                    return ExitCode::FAILURE;
                }
                match args[i].parse::<u16>() {
                    Ok(p) if p >= 1024 => port_override = Some(p),
                    _ => {
                        eprintln!("invalid --port");
                        return ExitCode::FAILURE;
                    }
                }
            }
            other => {
                eprintln!("unknown argument: {other}");
                print_usage();
                return ExitCode::FAILURE;
            }
        }
        i += 1;
    }

    let home = resolve_voice_home(explicit_home.as_deref());
    let store = ConfigStore::new(home.clone());
    let mut cfg = match store.load_or_init() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[oc-voice-daemon] {e}");
            return ExitCode::FAILURE;
        }
    };
    if let Some(p) = port_override {
        cfg.port = p;
    }
    let token = match read_or_create_token(&home) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[oc-voice-daemon] {e}");
            return ExitCode::FAILURE;
        }
    };

    match mode.as_str() {
        "health" => match probe_running(cfg.port, &token) {
            Ok(val) => {
                println!("{val}");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("[oc-voice-daemon] {e}");
                ExitCode::FAILURE
            }
        },
        "stop-service" => match stop_running(cfg.port, &token) {
            Ok(service) => {
                println!(
                    "{}",
                    json!({ "home": home.to_string_lossy(), "service": service })
                );
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("[oc-voice-daemon] {e}");
                ExitCode::FAILURE
            }
        },
        _ => {
            let app = AppState::new(store, token, cfg);
            if let Err(e) = run_server(app) {
                eprintln!("[oc-voice-daemon] {e}");
                return ExitCode::FAILURE;
            }
            ExitCode::SUCCESS
        }
    }
}
