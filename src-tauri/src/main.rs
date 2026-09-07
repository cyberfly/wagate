#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::Manager;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

struct Runtime {
    child: Mutex<Option<CommandChild>>,
    port: u16,
    token: String,
    alive: Arc<AtomicBool>,
    client: reqwest::Client,
}

#[tauri::command]
async fn gateway_request(
    state: tauri::State<'_, Runtime>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if !state.alive.load(Ordering::SeqCst) {
        return Err("The gateway sidecar stopped. Close and reopen Wagate.".into());
    }
    if !(path.starts_with("/internal/") || path.starts_with("/v1/") || path == "/health")
        || path.contains(['\\', '#', '\r', '\n'])
    {
        return Err("Invalid gateway route".into());
    }
    let method = match method.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err("Invalid method".into()),
    };
    let mut request = state.client
        .request(method, format!("http://127.0.0.1:{}{}", state.port, path))
        .bearer_auth(&state.token);
    if let Some(value) = body {
        request = request.json(&value);
    }
    let response = request.send().await.map_err(|_| {
        "Cannot reach the local gateway. Check that the port is available or reopen Wagate.".to_string()
    })?;
    let status = response.status();
    let value: serde_json::Value = response.json().await
        .map_err(|_| "Invalid gateway response".to_string())?;
    if !status.is_success() {
        return Err(value.get("error").and_then(|v| v.as_str())
            .unwrap_or("Gateway request failed").to_string());
    }
    Ok(value)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let port = std::env::var("WAGATE_PORT")
                .unwrap_or("8787".into()).parse::<u16>()?;
            if port < 1024 {
                return Err("WAGATE_PORT must be 1024–65535".into());
            }
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let token = format!("desktop_{}{}",
                uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(55))
                .build()?;
            let (mut rx, child) = app.shell().sidecar("wagate-sidecar")?
                .env("WAGATE_PORT", port.to_string())
                .env("WAGATE_DATA_DIR", data_dir.to_string_lossy().as_ref())
                .env("WAGATE_DESKTOP", "1")
                .env("WAGATE_DESKTOP_TOKEN", &token)
                .spawn()?;
            let alive = Arc::new(AtomicBool::new(true));
            let monitor = alive.clone();
            app.manage(Runtime {
                child: Mutex::new(Some(child)), port, token, alive, client,
            });
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if matches!(event, CommandEvent::Terminated(_)) {
                        monitor.store(false, Ordering::SeqCst);
                    }
                }
                monitor.store(false, Ordering::SeqCst);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![gateway_request])
        .build(tauri::generate_context!())
        .expect("Cannot start Wagate")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Runtime>().child.lock().unwrap().take() {
                    // Request orderly SQLite/socket shutdown before the bounded kill fallback.
                    let _ = child.write(b"shutdown\n");
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    let _ = child.kill();
                }
            }
        });
}
