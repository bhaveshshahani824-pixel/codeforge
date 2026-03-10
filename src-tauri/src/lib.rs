use tauri::{AppHandle, Emitter, Manager};
use std::path::PathBuf;
use std::sync::Mutex;

// ── Helpers ───────────────────────────────────────────────────────────────────

fn models_dir(_app: &AppHandle) -> PathBuf {
    #[cfg(target_os = "windows")]
    let dir = PathBuf::from(r"D:\OfflineAI\models");
    #[cfg(not(target_os = "windows"))]
    let dir = {
        let base = _app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        base.join("models")
    };
    std::fs::create_dir_all(&dir).ok();
    dir
}

fn server_exe(app: &AppHandle) -> PathBuf {
    models_dir(app)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from(r"D:\OfflineAI"))
        .join("llama-server.exe")
}

// ── Server process state ───────────────────────────────────────────────────────

pub struct ServerState {
    process: Mutex<Option<std::process::Child>>,
    stop_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl ServerState {
    fn new() -> Self {
        ServerState {
            process: Mutex::new(None),
            stop_tx: Mutex::new(None),
        }
    }
}

const SERVER_PORT: u16 = 8088;

// ── RAM detection ─────────────────────────────────────────────────────────────

#[tauri::command]
fn get_system_ram() -> u64 {
    #[cfg(target_os = "windows")]
    {
        use std::mem;
        #[repr(C)]
        struct MemStatusEx {
            dw_length: u32, dw_memory_load: u32,
            ull_total_phys: u64, ull_avail_phys: u64,
            ull_total_page_file: u64, ull_avail_page_file: u64,
            ull_total_virtual: u64, ull_avail_virtual: u64,
            ull_avail_ext_virtual: u64,
        }
        extern "system" { fn GlobalMemoryStatusEx(lp_buffer: *mut MemStatusEx) -> i32; }
        let mut s: MemStatusEx = unsafe { mem::zeroed() };
        s.dw_length = mem::size_of::<MemStatusEx>() as u32;
        unsafe { GlobalMemoryStatusEx(&mut s) };
        s.ull_total_phys / (1024 * 1024)
    }
    #[cfg(not(target_os = "windows"))]
    { 8192 }
}

// ── Disk space detection ──────────────────────────────────────────────────────

#[tauri::command]
fn get_free_disk_space(app: AppHandle) -> u64 {
    let path = models_dir(&app);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        extern "system" {
            fn GetDiskFreeSpaceExW(
                lpDirectoryName: *const u16,
                lpFreeBytesAvailableToCaller: *mut u64,
                lpTotalNumberOfBytes: *mut u64,
                lpTotalNumberOfFreeBytes: *mut u64,
            ) -> i32;
        }
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut free: u64 = 0;
        let mut total: u64 = 0;
        let mut total_free: u64 = 0;
        unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, &mut total_free); }
        free / (1024 * 1024)
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = path; 50 * 1024 }
}

// ── Model management commands ─────────────────────────────────────────────────

#[tauri::command]
fn get_models_dir_path(app: AppHandle) -> String {
    models_dir(&app).to_string_lossy().to_string()
}

#[tauri::command]
fn list_model_files(app: AppHandle, model_id: String) -> Vec<String> {
    let model_dir = models_dir(&app).join(&model_id);
    let mut files = Vec::new();
    walk_dir(&model_dir, &model_dir, &mut files);
    files
}

fn walk_dir(base: &std::path::Path, dir: &std::path::Path, out: &mut Vec<String>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk_dir(base, &path, out);
            } else if let Ok(rel) = path.strip_prefix(base) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

#[tauri::command]
fn delete_model(app: AppHandle, model_id: String) -> Result<(), String> {
    let dir = models_dir(&app).join(&model_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn download_file(
    app: AppHandle,
    url: String,
    model_id: String,
    file_path: String,
    token: Option<String>,
) -> Result<(), String> {
    let dest = models_dir(&app).join(&model_id).join(&file_path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let client = reqwest::Client::new();
    let mut req = client.get(&url);
    if let Some(tok) = &token {
        req = req.header("Authorization", format!("Bearer {}", tok));
    }
    let response = req.send().await.map_err(|e| format!("Network error: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {} for {}", response.status(), url));
    }

    let total = response.content_length().unwrap_or(0);
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::File::create(&dest)
        .await.map_err(|e: std::io::Error| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e: std::io::Error| e.to_string())?;
        downloaded += chunk.len() as u64;
        if last_emit.elapsed().as_millis() >= 300 || downloaded == total {
            let _ = app.emit("dl-progress", serde_json::json!({
                "file": file_path, "downloaded": downloaded, "total": total
            }));
            last_emit = std::time::Instant::now();
        }
    }
    Ok(())
}

// ── llama-server setup ────────────────────────────────────────────────────────

#[tauri::command]
fn is_server_ready(app: AppHandle) -> bool {
    server_exe(&app).exists()
}

#[tauri::command]
async fn setup_llama_server(app: AppHandle) -> Result<(), String> {
    let dest_exe = server_exe(&app);
    if dest_exe.exists() {
        return Ok(());
    }

    // Fetch the latest llama.cpp release from GitHub
    let client = reqwest::Client::builder()
        .user_agent("offlineai/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let releases_url = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";
    let release: serde_json::Value = client
        .get(releases_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch release info: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse release info: {}", e))?;

    // Find Windows CPU zip: prefer noavx (works on all CPUs) > avx > avx2/cpu
    let assets = release["assets"]
        .as_array()
        .ok_or("Could not find assets in llama.cpp release")?;

    let asset_url = assets.iter()
        .find(|a| a["name"].as_str().map(|n| {
            n.contains("win") && n.contains("noavx") && n.contains("x64") && n.ends_with(".zip")
        }).unwrap_or(false))
        .or_else(|| assets.iter().find(|a| a["name"].as_str().map(|n| {
            n.contains("win") && n.contains("-avx-") && n.contains("x64") && n.ends_with(".zip")
        }).unwrap_or(false)))
        .or_else(|| assets.iter().find(|a| a["name"].as_str().map(|n| {
            n.contains("win") && (n.contains("cpu") || n.contains("avx2")) && n.contains("x64") && n.ends_with(".zip")
        }).unwrap_or(false)))
        .and_then(|a| a["browser_download_url"].as_str())
        .ok_or("Could not find llama.cpp Windows CPU release asset")?
        .to_string();

    let tag = release["tag_name"].as_str().unwrap_or("unknown");
    let _ = app.emit("setup-progress", serde_json::json!({
        "step": "downloading", "tag": tag, "url": asset_url
    }));

    // Download the zip
    let response = client
        .get(&asset_url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    let total = response.content_length().unwrap_or(0);
    use futures_util::StreamExt;

    let mut bytes = Vec::with_capacity(total as usize);
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        bytes.extend_from_slice(&chunk);
        downloaded += chunk.len() as u64;
        if last_emit.elapsed().as_millis() >= 300 {
            let _ = app.emit("setup-progress", serde_json::json!({
                "step": "downloading", "downloaded": downloaded, "total": total
            }));
            last_emit = std::time::Instant::now();
        }
    }

    let _ = app.emit("setup-progress", serde_json::json!({ "step": "extracting" }));

    // Extract llama-server.exe from the zip
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("Zip error: {}", e))?;

    // Extract all .exe and .dll files (llama-server needs companion DLLs)
    let parent = dest_exe.parent().unwrap();
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let mut found_server = false;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if name.ends_with(".exe") || name.ends_with(".dll") {
            let file_name = std::path::Path::new(&name)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| name.clone());
            if file_name == "llama-server.exe" { found_server = true; }
            let dest = parent.join(&file_name);
            let mut out = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
    }
    if !found_server {
        return Err("llama-server.exe not found in zip".into());
    }

    let _ = app.emit("setup-progress", serde_json::json!({ "step": "done" }));
    Ok(())
}

// ── Reset server binary (force re-download on next setup) ────────────────────

#[tauri::command]
async fn reset_server(app: AppHandle) -> Result<(), String> {
    let exe = server_exe(&app);
    if exe.exists() {
        std::fs::remove_file(&exe).map_err(|e| format!("Failed to remove server exe: {}", e))?;
    }
    // Remove crash log too
    if let Some(parent) = exe.parent() {
        let _ = std::fs::remove_file(parent.join("llama-server-crash.log"));
    }
    Ok(())
}

// ── Stop ongoing generation ───────────────────────────────────────────────────

#[tauri::command]
async fn stop_generate(state: tauri::State<'_, ServerState>) -> Result<(), String> {
    let mut lock = state.stop_tx.lock().unwrap();
    if let Some(tx) = lock.take() {
        let _ = tx.send(());
    }
    Ok(())
}

// ── Excel sheet reader ────────────────────────────────────────────────────────

#[tauri::command]
fn read_excel_sheets(path: String) -> Result<serde_json::Value, String> {
    use calamine::{open_workbook_auto, Reader, Data};

    let mut workbook = open_workbook_auto(&path)
        .map_err(|e| format!("Cannot open Excel file: {}", e))?;
    let sheet_names = workbook.sheet_names().to_vec();
    let mut sheets = Vec::new();

    for name in &sheet_names {
        if let Ok(range) = workbook.worksheet_range(name) {
            let rows: Vec<Vec<String>> = range
                .rows()
                .map(|row| {
                    row.iter()
                        .map(|cell| match cell {
                            Data::Empty => String::new(),
                            Data::String(s) => s.clone(),
                            Data::Float(f) => {
                                if f.fract() == 0.0 && f.abs() < 1e15 {
                                    format!("{}", *f as i64)
                                } else {
                                    format!("{:.2}", f)
                                }
                            }
                            Data::Int(i) => i.to_string(),
                            Data::Bool(b) => b.to_string(),
                            Data::DateTime(d) => format!("{:.5}", d),
                            Data::DateTimeIso(s) => s.clone(),
                            Data::DurationIso(s) => s.clone(),
                            Data::Error(e) => format!("#{:?}", e),
                        })
                        .collect()
                })
                .filter(|row: &Vec<String>| row.iter().any(|c| !c.is_empty()))
                .collect();

            if !rows.is_empty() {
                sheets.push(serde_json::json!({ "name": name, "rows": rows }));
            }
        }
    }

    Ok(serde_json::json!({ "sheets": sheets }))
}

// ── Model loading / inference ─────────────────────────────────────────────────

#[tauri::command]
async fn load_model(
    app: AppHandle,
    state: tauri::State<'_, ServerState>,
    model_id: String,
    file: String,
) -> Result<(), String> {
    // Kill any existing server
    {
        let mut lock = state.process.lock().unwrap();
        if let Some(mut child) = lock.take() {
            let _ = child.kill();
        }
    }

    let exe = server_exe(&app);
    if !exe.exists() {
        return Err("llama-server.exe not found. Run setup first.".into());
    }

    let model_path = models_dir(&app).join(&model_id).join(&file);
    if !model_path.exists() {
        return Err(format!("Model file not found: {}", model_path.display()));
    }

    // Redirect stderr to a log file so we can read crash details
    let log_path = exe.parent()
        .unwrap_or(std::path::Path::new("."))
        .join("llama-server-crash.log");
    let stderr_file = std::fs::File::create(&log_path)
        .map(std::process::Stdio::from)
        .unwrap_or_else(|_| std::process::Stdio::null());

    let child = std::process::Command::new(&exe)
        .current_dir(exe.parent().unwrap_or(std::path::Path::new(".")))
        .arg("--model").arg(&model_path)
        .arg("--port").arg(SERVER_PORT.to_string())
        .arg("--ctx-size").arg("32768")
        .stdout(std::process::Stdio::null())
        .stderr(stderr_file)
        .spawn()
        .map_err(|e| format!("Failed to start llama-server: {}", e))?;

    {
        let mut lock = state.process.lock().unwrap();
        *lock = Some(child);
    }

    // Wait for server to be ready (poll /health)
    let client = reqwest::Client::new();
    let health_url = format!("http://127.0.0.1:{}/health", SERVER_PORT);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);

    loop {
        if std::time::Instant::now() > deadline {
            return Err("Timeout waiting for llama-server to become ready".into());
        }
        // Check if the process died before we even get a health response
        let exited = {
            let mut lock = state.process.lock().unwrap();
            if let Some(ref mut child) = *lock {
                matches!(child.try_wait(), Ok(Some(_)))
            } else {
                true
            }
        };
        if exited {
            let crash_info = std::fs::read_to_string(&log_path).unwrap_or_default();
            let detail = if crash_info.trim().is_empty() {
                "No output captured. Likely: (1) missing VC++ runtime, or (2) CPU lacks AVX2 support.".to_string()
            } else {
                crash_info.lines().take(5).collect::<Vec<_>>().join(" | ")
            };
            return Err(format!("llama-server crashed: {}", detail));
        }
        match client.get(&health_url).send().await {
            Ok(r) if r.status().is_success() => break,
            _ => tokio::time::sleep(std::time::Duration::from_millis(500)).await,
        }
    }

    Ok(())
}

#[tauri::command]
async fn unload_model(state: tauri::State<'_, ServerState>) -> Result<(), String> {
    let mut lock = state.process.lock().unwrap();
    if let Some(mut child) = lock.take() {
        let _ = child.kill();
    }
    Ok(())
}

#[tauri::command]
async fn generate(
    app: AppHandle,
    state: tauri::State<'_, ServerState>,
    prompt: String,
    max_tokens: u32,
    temperature: f32,
) -> Result<(), String> {
    use futures_util::StreamExt;

    // Set up cancellation channel so stop_generate can interrupt us
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut lock = state.stop_tx.lock().unwrap();
        *lock = Some(stop_tx);
    }

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "prompt": prompt,
        "n_predict": max_tokens,
        "temperature": temperature,
        "stream": true,
        "cache_prompt": true,
        "repeat_penalty": 1.1,
        "repeat_last_n": 64,
        "top_k": 40,
        "top_p": 0.95,
    });

    let response = client
        .post(format!("http://127.0.0.1:{}/completion", SERVER_PORT))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Inference request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Server error {}: {}", status, body));
    }

    let mut stream = response.bytes_stream();
    let mut buf = String::new();

    'outer: loop {
        // Race: next SSE chunk vs. stop signal
        let chunk = tokio::select! {
            biased;
            _ = &mut stop_rx => break 'outer,          // user pressed stop
            item = stream.next() => match item {
                Some(c) => c,
                None    => break 'outer,               // stream ended naturally
            }
        };

        let chunk = chunk.map_err(|e: reqwest::Error| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        // SSE: split on double-newline boundaries
        loop {
            if let Some(pos) = buf.find("\n\n") {
                let event = buf[..pos].to_string();
                buf = buf[pos + 2..].to_string();

                for line in event.lines() {
                    if let Some(data) = line.strip_prefix("data: ") {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                            if let Some(text) = json.get("content").and_then(|v| v.as_str()) {
                                if !text.is_empty() {
                                    let _ = app.emit("llm-token", text);
                                }
                            }
                            if json.get("stop").and_then(|v| v.as_bool()).unwrap_or(false) {
                                break 'outer;
                            }
                        }
                    }
                }
            } else {
                break;
            }
        }
    }

    let _ = app.emit("llm-done", ());
    Ok(())
}

// ── Extension Hub (desktop-only WebSocket server) ────────────────────────────
// Runs on ws://127.0.0.1:7471 — VS Code / Cursor extensions connect here.
// Each connected editor gets its own entry in HubState::clients.
// NOT compiled or started on Android / iOS — desktop only.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

/// Serialisable snapshot of a connected editor — sent to the frontend.
#[derive(Clone, serde::Serialize)]
pub struct HubClientInfo {
    pub id:            String,
    pub editor:        String, // "vscode" | "cursor" | "windsurf"
    pub file:          String,
    pub language:      String,
    pub selected_code: String,
    pub cursor_line:   u32,
}

/// Internal per-client state (not serialised — holds the send channel).
struct HubClient {
    info: HubClientInfo,
    tx:   tokio::sync::mpsc::UnboundedSender<String>,
}

/// Shared Hub state managed by Tauri.
pub struct HubState {
    clients: Arc<TokioMutex<HashMap<String, HubClient>>>,
}

impl HubState {
    fn new() -> Self {
        HubState { clients: Arc::new(TokioMutex::new(HashMap::new())) }
    }
}

/// Handle one WebSocket connection from an editor extension.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn handle_hub_connection(
    stream: tokio::net::TcpStream,
    app:    AppHandle,
    clients: Arc<TokioMutex<HashMap<String, HubClient>>>,
) {
    use tokio_tungstenite::{accept_async, tungstenite::Message};
    use futures_util::{SinkExt, StreamExt};

    let ws = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(_) => return,
    };
    let (mut ws_tx, mut ws_rx) = ws.split();

    // Channel so Tauri commands can push messages back to this editor.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    // Spawn a task that forwards queued messages to the WebSocket.
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let _ = ws_tx.send(Message::Text(msg.into())).await;
        }
    });

    // Read the first frame — must be a "hello" JSON.
    let first = match ws_rx.next().await {
        Some(Ok(Message::Text(t))) => t,
        _ => return,
    };
    let hello: serde_json::Value = match serde_json::from_str(&first) {
        Ok(v) => v,
        Err(_) => return,
    };
    if hello.get("type").and_then(|v| v.as_str()) != Some("hello") { return; }

    let id     = uuid::Uuid::new_v4().to_string();
    let editor = hello.get("editor").and_then(|v| v.as_str()).unwrap_or("vscode").to_string();

    let info = HubClientInfo {
        id: id.clone(), editor: editor.clone(),
        file: String::new(), language: String::new(),
        selected_code: String::new(), cursor_line: 0,
    };

    clients.lock().await.insert(id.clone(), HubClient { info: info.clone(), tx });
    let _ = app.emit("hub-client-connected", &info);

    // Message loop
    while let Some(msg) = ws_rx.next().await {
        let text = match msg {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) | Err(_) => break,
            _ => continue,
        };

        let val: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v, Err(_) => continue,
        };
        match val.get("type").and_then(|v| v.as_str()) {
            Some("context") => {
                let mut lock = clients.lock().await;
                if let Some(client) = lock.get_mut(&id) {
                    client.info.file          = val["file"].as_str().unwrap_or("").to_string();
                    client.info.language      = val["language"].as_str().unwrap_or("").to_string();
                    client.info.selected_code = val["selectedCode"].as_str().unwrap_or("").to_string();
                    client.info.cursor_line   = val["cursorLine"].as_u64().unwrap_or(0) as u32;
                    let _ = app.emit("hub-context-update", &client.info);
                }
            }
            Some("message") => {
                // Editor sent a chat message — forward to frontend.
                let _ = app.emit("hub-message", serde_json::json!({
                    "clientId": id,
                    "text": val["text"].as_str().unwrap_or("")
                }));
            }
            Some("pong") => {} // keepalive — ignore
            _ => {}
        }
    }

    // Disconnected — clean up.
    clients.lock().await.remove(&id);
    let _ = app.emit("hub-client-disconnected", serde_json::json!({ "id": id }));
}

/// Send a JSON message from OfflineAI back to a specific editor.
#[tauri::command]
async fn hub_send(
    hub: tauri::State<'_, HubState>,
    client_id: String,
    message: String,
) -> Result<(), String> {
    let lock = hub.clients.lock().await;
    if let Some(client) = lock.get(&client_id) {
        client.tx.send(message).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("Client {} not connected", client_id))
    }
}

/// Return the list of currently connected editor clients.
#[tauri::command]
async fn hub_get_clients(
    hub: tauri::State<'_, HubState>,
) -> Result<Vec<HubClientInfo>, String> {
    let lock = hub.clients.lock().await;
    Ok(lock.values().map(|c| c.info.clone()).collect())
}

// ── Pharma / Research connectors ─────────────────────────────────────────────

/// Extract plain text from a PDF file.
#[tauri::command]
async fn read_pdf(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Cannot read file: {e}"))?;
    pdf_extract::extract_text_from_mem(&bytes).map_err(|e| format!("PDF parse error: {e}"))
}

/// Strip XML tags, collapsing whitespace, to produce clean plain text.
fn strip_xml(xml: String) -> String {
    let mut out = String::with_capacity(xml.len() / 2);
    let mut in_tag = false;
    let mut prev_space = true;
    for ch in xml.chars() {
        match ch {
            '<' => {
                in_tag = true;
                if !prev_space { out.push(' '); prev_space = true; }
            }
            '>' => { in_tag = false; }
            _ if !in_tag => {
                if ch.is_whitespace() {
                    if !prev_space { out.push(' '); prev_space = true; }
                } else {
                    out.push(ch);
                    prev_space = false;
                }
            }
            _ => {}
        }
    }
    out.trim().to_string()
}

/// Extract plain text from a Word .docx file (ZIP + XML parsing).
#[tauri::command]
async fn read_docx(path: String) -> Result<String, String> {
    use std::io::Read;
    let file = std::fs::File::open(&path).map_err(|e| format!("Cannot open file: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Not a valid docx: {e}"))?;
    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|_| "word/document.xml not found — is this a valid .docx?".to_string())?
        .read_to_string(&mut xml)
        .map_err(|e| format!("Read error: {e}"))?;
    Ok(strip_xml(xml))
}

/// Search PubMed via NCBI Entrez API and return abstracts (requires internet).
#[tauri::command]
async fn pubmed_search(query: String, max_results: u32) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    // Step 1 — get PMIDs matching the query
    let search: serde_json::Value = client
        .get("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi")
        .query(&[
            ("db",      "pubmed"),
            ("term",    query.as_str()),
            ("retmax",  &max_results.to_string()),
            ("retmode", "json"),
        ])
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?
        .json()
        .await
        .map_err(|e| format!("JSON parse error: {e}"))?;

    let ids: Vec<String> = search["esearchresult"]["idlist"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect();

    if ids.is_empty() {
        return Err("No PubMed results found for this query.".to_string());
    }

    // Step 2 — fetch plain-text abstracts for those PMIDs
    let abstracts = client
        .get("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi")
        .query(&[
            ("db",      "pubmed"),
            ("id",      ids.join(",").as_str()),
            ("rettype", "abstract"),
            ("retmode", "text"),
        ])
        .send()
        .await
        .map_err(|e| format!("Network error fetching abstracts: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Text decode error: {e}"))?;

    Ok(abstracts)
}

// ── Entry point ───────────────────────────────────────────────────────────────

/// Fetch the latest version JSON from a URL (GitHub raw or any host).
/// Returns the JSON object so the frontend can compare versions and show a banner.
#[tauri::command]
async fn check_for_update(url: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("OfflineAI-UpdateCheck/1.0")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    let json = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Parse error: {e}"))?;
    Ok(json)
}

/// Download and install a pending update, then restart the app.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("Update check failed: {e}"))?;
    if let Some(upd) = update {
        upd.download_and_install(|_downloaded, _total| {}, || {})
            .await
            .map_err(|e| format!("Install failed: {e}"))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ServerState::new())
        .manage(HubState::new())
        .setup(|app| {
            // Start the Extension Hub WebSocket server — desktop only.
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                let hub_clients = app.state::<HubState>().clients.clone();
                let app_handle  = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let listener = match tokio::net::TcpListener::bind("127.0.0.1:7471").await {
                        Ok(l) => l,
                        Err(e) => {
                            eprintln!("[hub] Failed to bind port 7471: {e}");
                            return;
                        }
                    };
                    eprintln!("[hub] Listening on ws://127.0.0.1:7471");
                    loop {
                        match listener.accept().await {
                            Ok((stream, _)) => {
                                let app2    = app_handle.clone();
                                let clients = hub_clients.clone();
                                tauri::async_runtime::spawn(handle_hub_connection(stream, app2, clients));
                            }
                            Err(e) => eprintln!("[hub] Accept error: {e}"),
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_system_ram,
            get_free_disk_space,
            get_models_dir_path,
            list_model_files,
            download_file,
            delete_model,
            is_server_ready,
            setup_llama_server,
            reset_server,
            stop_generate,
            read_excel_sheets,
            load_model,
            unload_model,
            generate,
            hub_send,
            hub_get_clients,
            read_pdf,
            read_docx,
            pubmed_search,
            check_for_update,
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
