#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

struct Runtime {
    child: Mutex<Option<CommandChild>>,
    port: u16,
    token: String,
    data_dir: String,
    /// The sidecar process is running.
    alive: AtomicBool,
    /// The app is quitting; a sidecar exit is expected and final.
    exiting: AtomicBool,
    /// The sidecar kept dying and is no longer restarted.
    failed: AtomicBool,
    client: reqwest::Client,
    /// For the long-lived event stream: no overall timeout.
    events: reqwest::Client,
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Acts on one event from the sidecar's desktop stream.
fn handle_event(app: &tauri::AppHandle, name: &str, data: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else { return };
    let window = app.get_webview_window("main");
    match name {
        // The window refreshes what it shows.
        "changed" => {
            let _ = app.emit("gateway-changed", value);
        }
        "unread" => {
            let count = value["count"].as_i64().unwrap_or(0);
            if let Some(window) = &window {
                let _ = window.set_badge_count(if count > 0 { Some(count) } else { None });
            }
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_tooltip(Some(match count {
                    0 => "Wagate".to_string(),
                    1 => "Wagate: 1 unread chat".to_string(),
                    n => format!("Wagate: {n} unread chats"),
                }));
            }
        }
        // A message you are not looking at: the window is hidden or behind others.
        "notify" => {
            let watching = window
                .map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
                .unwrap_or(false);
            if !watching {
                let _ = app
                    .notification()
                    .builder()
                    .title(value["title"].as_str().unwrap_or("Wagate"))
                    .body(value["body"].as_str().unwrap_or("New message"))
                    .show();
            }
        }
        _ => {}
    }
}

/// Reads the sidecar's desktop event stream until it ends.
async fn stream_events(app: &tauri::AppHandle) {
    let state = app.state::<Runtime>();
    let request = state
        .events
        .get(format!("http://127.0.0.1:{}/internal/events", state.port))
        .bearer_auth(&state.token);
    let Ok(mut response) = request.send().await else { return };
    if !response.status().is_success() {
        return;
    }
    // Anything may have changed while the stream was down.
    let _ = app.emit("gateway-changed", serde_json::json!({ "profile": "*" }));
    let mut buffer: Vec<u8> = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        if state.exiting.load(Ordering::SeqCst) {
            return;
        }
        buffer.extend_from_slice(&chunk);
        while let Some(end) = buffer.windows(2).position(|w| w == b"\n\n") {
            let block = String::from_utf8_lossy(&buffer[..end]).into_owned();
            buffer.drain(..end + 2);
            let field = |name: &str| {
                block
                    .lines()
                    .find_map(|line| line.strip_prefix(name))
                    .map(|v| v.trim().to_string())
                    .unwrap_or_default()
            };
            handle_event(app, &field("event:"), &field("data:"));
        }
        if buffer.len() > 1_000_000 {
            return;
        }
    }
}

/// Follows the sidecar's events for as long as the app runs, reconnecting
/// after a sidecar restart.
fn follow_events(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        let state = app.state::<Runtime>();
        if state.exiting.load(Ordering::SeqCst) {
            return;
        }
        if state.alive.load(Ordering::SeqCst) {
            tauri::async_runtime::block_on(stream_events(&app));
        }
        std::thread::sleep(Duration::from_secs(1));
    });
}

/// Starts the sidecar and waits until it exits.
fn run_sidecar(app: &tauri::AppHandle) {
    let state = app.state::<Runtime>();
    let spawned = app.shell().sidecar("wagate-sidecar").and_then(|command| {
        command
            .env("WAGATE_PORT", state.port.to_string())
            .env("WAGATE_DATA_DIR", &state.data_dir)
            .env("WAGATE_DESKTOP", "1")
            .env("WAGATE_DESKTOP_TOKEN", &state.token)
            .spawn()
    });
    let Ok((mut rx, child)) = spawned else { return };
    {
        let mut slot = state.child.lock().unwrap();
        if state.exiting.load(Ordering::SeqCst) {
            let _ = child.kill();
            return;
        }
        *slot = Some(child);
    }
    state.alive.store(true, Ordering::SeqCst);
    while let Some(event) = rx.blocking_recv() {
        if matches!(event, CommandEvent::Terminated(_)) {
            break;
        }
    }
    state.alive.store(false, Ordering::SeqCst);
    state.child.lock().unwrap().take();
}

/// Keeps the sidecar running: a crash restarts it after a short, growing wait.
/// Five crashes in a row, each within a minute of starting, stop the retries,
/// so a sidecar that cannot start (such as a port in use) fails visibly.
fn supervise(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<Runtime>();
        let mut crashes = 0u32;
        loop {
            let started = Instant::now();
            run_sidecar(&app);
            if state.exiting.load(Ordering::SeqCst) {
                return;
            }
            if started.elapsed() > Duration::from_secs(60) {
                crashes = 0;
            }
            crashes += 1;
            if crashes > 5 {
                state.failed.store(true, Ordering::SeqCst);
                return;
            }
            std::thread::sleep(Duration::from_millis(500 << (crashes - 1).min(4)));
            if state.exiting.load(Ordering::SeqCst) {
                return;
            }
        }
    });
}

#[tauri::command]
async fn gateway_request(
    state: tauri::State<'_, Runtime>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if state.failed.load(Ordering::SeqCst) {
        return Err("The gateway stopped and could not be restarted. Close and reopen Wagate.".into());
    }
    if !state.alive.load(Ordering::SeqCst) {
        return Err("The gateway is restarting. This takes a few seconds.".into());
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
        // Opening Wagate again shows the running window instead of starting a
        // second copy, which could not bind the gateway port.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        // Closing the window keeps Wagate receiving messages in the background;
        // the tray icon (or the Dock) brings it back, and Quit stops it.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
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
                .timeout(Duration::from_secs(55))
                .build()?;
            let events = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                // The sidecar sends a heartbeat every 15 seconds.
                .read_timeout(Duration::from_secs(45))
                .build()?;
            app.manage(Runtime {
                child: Mutex::new(None),
                port,
                token,
                data_dir: data_dir.to_string_lossy().into_owned(),
                alive: AtomicBool::new(false),
                exiting: AtomicBool::new(false),
                failed: AtomicBool::new(false),
                client,
                events,
            });
            let open = MenuItem::with_id(app, "open", "Open Wagate", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Wagate", true, None::<&str>)?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("Wagate")
                .menu(&Menu::with_items(app, &[&open, &quit])?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            supervise(app.handle().clone());
            follow_events(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![gateway_request])
        .build(tauri::generate_context!())
        .expect("Cannot start Wagate")
        .run(|app, event| {
            // Clicking the Dock icon brings back a window closed to the background.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_window(app);
            }
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<Runtime>();
                state.exiting.store(true, Ordering::SeqCst);
                let child = state.child.lock().unwrap().take();
                if let Some(mut child) = child {
                    // Request orderly SQLite/socket shutdown before the bounded kill fallback.
                    let _ = child.write(b"shutdown\n");
                    std::thread::sleep(Duration::from_millis(300));
                    let _ = child.kill();
                }
            }
        });
}
