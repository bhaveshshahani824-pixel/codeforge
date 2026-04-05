use tauri::{AppHandle, Emitter, Manager};
use std::path::PathBuf;
use std::sync::Mutex;

// ── Helpers ───────────────────────────────────────────────────────────────────

fn models_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("models");
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
    dl_cancel: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl ServerState {
    fn new() -> Self {
        ServerState {
            process: Mutex::new(None),
            stop_tx: Mutex::new(None),
            dl_cancel: Mutex::new(None),
        }
    }
}

const SERVER_PORT: u16 = 8088;

// ── Security Shield state ─────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct ShieldEntry {
    path: String,
    file_name: String,
    file_type: String,
    decoy_path: Option<String>,
    baseline_mtime: u64,
    baseline_size: u64,
    baseline_atime: u64,
}

#[derive(Clone, serde::Serialize)]
struct ShieldLogEntry {
    id: u64,
    timestamp: String,
    path: String,
    file_name: String,
    event: String,
}

#[derive(Default)]
struct ShieldState {
    entries: std::sync::Mutex<std::collections::HashMap<String, ShieldEntry>>,
    log: std::sync::Mutex<Vec<ShieldLogEntry>>,
    counter: std::sync::atomic::AtomicU64,
}

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
    if !dir.exists() {
        return Ok(());
    }
    // Retry loop: Windows holds file handles briefly after process kill.
    let mut last_err = String::new();
    for attempt in 0..6 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(600));
        }
        match std::fs::remove_dir_all(&dir) {
            Ok(_) => return Ok(()),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(format!("Could not delete model files (file may still be in use): {}", last_err))
}

#[tauri::command]
async fn download_file(
    app: AppHandle,
    state: tauri::State<'_, ServerState>,
    url: String,
    model_id: String,
    file_path: String,
    token: Option<String>,
) -> Result<(), String> {
    let dest = models_dir(&app).join(&model_id).join(&file_path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Register a cancel channel so cancel_download can abort this transfer.
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut lock = state.dl_cancel.lock().unwrap();
        *lock = Some(cancel_tx);
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

    loop {
        let item = tokio::select! {
            biased;
            _ = &mut cancel_rx => {
                // User cancelled — drop file handle then delete the partial file.
                drop(file);
                let _ = tokio::fs::remove_file(&dest).await;
                return Err("cancelled".to_string());
            }
            item = stream.next() => item,
        };
        let chunk = match item {
            Some(c) => c.map_err(|e| e.to_string())?,
            None => break,
        };
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

#[tauri::command]
async fn cancel_download(state: tauri::State<'_, ServerState>) -> Result<(), String> {
    let mut lock = state.dl_cancel.lock().unwrap();
    if let Some(tx) = lock.take() {
        let _ = tx.send(());
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

// ── Agent tools ───────────────────────────────────────────────────────────────

#[tauri::command]
fn list_directory(path: String) -> Result<serde_json::Value, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for entry in entries.flatten() {
        let meta = entry.metadata().ok();
        items.push(serde_json::json!({
            "name": entry.file_name().to_string_lossy().to_string(),
            "is_dir": meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            "size_kb": meta.as_ref().map(|m| m.len() / 1024).unwrap_or(0)
        }));
    }
    Ok(serde_json::json!(items))
}

const ALLOWED_CMDS: &[&str] = &[
    "dir", "ls", "python", "python3", "git", "node", "npm",
    "type", "cat", "echo", "whoami", "ipconfig", "ifconfig",
    "find", "grep", "pwd", "date", "time",
    // Workflow Autopilot extended allowlist
    "curl", "wget", "ping", "tracert", "traceroute", "nslookup",
    "systeminfo", "tasklist", "taskkill", "wmic", "net",
    "copy", "move", "del", "mkdir", "rmdir", "rename",
    "powershell", "where", "which",
    "java", "mvn", "gradle", "pip", "pip3", "cargo", "go",
    "dotnet", "make", "cmake",
    "set", "env", "printenv",
    "head", "tail", "sort", "uniq", "wc",
    "zip", "unzip", "tar",
    "ffmpeg", "convert", "magick",
];

#[tauri::command]
async fn run_shell_command(command: String) -> Result<serde_json::Value, String> {
    let cmd_lower = command.trim().to_lowercase();
    let allowed = ALLOWED_CMDS.iter().any(|a| cmd_lower.starts_with(a));
    if !allowed {
        return Err(format!(
            "Command '{}' not in allowlist. Allowed prefixes: {}",
            command,
            ALLOWED_CMDS.join(", ")
        ));
    }
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" })
            .args(if cfg!(windows) { vec!["/C", &command] } else { vec!["-c", &command] })
            .output()
    }).await.map_err(|e| e.to_string())?.map_err(|e: std::io::Error| e.to_string())?;
    Ok(serde_json::json!({
        "stdout": String::from_utf8_lossy(&output.stdout).to_string(),
        "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
        "exit_code": output.status.code().unwrap_or(-1)
    }))
}

/// Read a text file from disk (agent tool).
#[tauri::command]
fn read_file_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Cannot read '{}': {}", path, e))
}

// ── Screen capture ────────────────────────────────────────────────────────────

/// Capture the primary monitor and return base64-encoded PNG.
#[tauri::command]
async fn take_screenshot() -> Result<String, String> {
    let tmp_path = std::env::temp_dir().join("offlineai_screen.png");
    let tmp_str = tmp_path.to_string_lossy().into_owned();

    // PowerShell GDI screenshot — works on all Windows 10+ machines with no extra deps
    let script = format!(
        "Add-Type -AssemblyName System.Drawing,System.Windows.Forms; \
         $s=[System.Windows.Forms.Screen]::PrimaryScreen; \
         $b=New-Object System.Drawing.Bitmap($s.Bounds.Width,$s.Bounds.Height); \
         $g=[System.Drawing.Graphics]::FromImage($b); \
         $g.CopyFromScreen($s.Bounds.X,$s.Bounds.Y,0,0,$s.Bounds.Size); \
         $b.Save('{}'); \
         $g.Dispose(); $b.Dispose()",
        tmp_str.replace('\'', "''")
    );

    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e: std::io::Error| e.to_string())?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Screenshot error: {}", err.trim()));
    }

    let bytes = std::fs::read(&tmp_path).map_err(|e| format!("Read error: {e}"))?;
    Ok(base64_encode(&bytes))
}

/// OCR the given image file using Windows.Media.Ocr (WinRT, Windows 10+).
/// Returns plain extracted text.
#[tauri::command]
async fn ocr_screen(image_path: String) -> Result<String, String> {
    // Write PS script to temp file to avoid command-line length limits
    let script_path = std::env::temp_dir().join("offlineai_ocr.ps1");
    let img_escaped = image_path.replace('\'', "''");

    let script = format!(
        r#"Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$asTaskG = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {{ $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' }})[0]
function Await($t, $r) {{
    $tt = $asTaskG.MakeGenericMethod($r); $n = $tt.Invoke($null, @($t)); $n.Wait(-1)|Out-Null; $n.Result
}}
try {{
    $f = Await([Windows.Storage.StorageFile]::GetFileFromPathAsync('{}')) ([Windows.Storage.StorageFile])
    $s = Await($f.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStream])
    $d = Await([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bm = Await($d.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    $res = Await($eng.RecognizeAsync($bm)) ([Windows.Media.Ocr.OcrResult])
    Write-Output $res.Text
}} catch {{ Write-Output "OCR_ERROR: $_" }}"#,
        img_escaped
    );

    std::fs::write(&script_path, &script).map_err(|e| e.to_string())?;
    let script_str = script_path.to_string_lossy().into_owned();

    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", &script_str])
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e: std::io::Error| e.to_string())?;

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() { "No text found in image".into() } else { err });
    }
    Ok(text)
}

// ── Conversation persistence (stored on client machine, never on our servers) ─

fn get_db_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path().app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("offlineai"))
        .join("conversations.json")
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct StoredMessage {
    role:       String,
    content:    String,
    model:      String,
    tokens:     u32,
    timestamp:  u64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct StoredConversation {
    id:        String,
    title:     String,
    timestamp: u64,
    language:  String,
    messages:  Vec<StoredMessage>,
}

fn read_conv_db(path: &std::path::Path) -> Vec<StoredConversation> {
    if !path.exists() { return vec![]; }
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_conv_db(path: &std::path::Path, convs: &[StoredConversation]) {
    if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
    if let Ok(json) = serde_json::to_string_pretty(convs) {
        let _ = std::fs::write(path, json);
    }
}

#[tauri::command]
fn db_save_conversation(app: tauri::AppHandle, conversation: StoredConversation) -> Result<(), String> {
    let path = get_db_path(&app);
    let mut convs = read_conv_db(&path);
    if let Some(pos) = convs.iter().position(|c| c.id == conversation.id) {
        convs[pos] = conversation;
    } else {
        convs.insert(0, conversation);
        if convs.len() > 500 { convs.truncate(500); }
    }
    write_conv_db(&path, &convs);
    Ok(())
}

#[tauri::command]
fn db_get_conversations(app: tauri::AppHandle, limit: Option<usize>) -> Vec<StoredConversation> {
    let path  = get_db_path(&app);
    let convs = read_conv_db(&path);
    let lim   = limit.unwrap_or(50);
    convs.into_iter().take(lim).collect()
}

#[tauri::command]
fn db_delete_conversation(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path  = get_db_path(&app);
    let convs = read_conv_db(&path).into_iter().filter(|c| c.id != id).collect::<Vec<_>>();
    write_conv_db(&path, &convs);
    Ok(())
}

#[tauri::command]
fn db_get_stats(app: tauri::AppHandle) -> serde_json::Value {
    let path  = get_db_path(&app);
    let convs = read_conv_db(&path);
    let total_msgs: usize  = convs.iter().map(|c| c.messages.len()).sum();
    let claude_msgs: usize = convs.iter().flat_map(|c| c.messages.iter()).filter(|m| m.model == "claude").count();
    let local_msgs: usize  = convs.iter().flat_map(|c| c.messages.iter()).filter(|m| m.model == "local").count();
    let total_tokens: u64  = convs.iter().flat_map(|c| c.messages.iter()).map(|m| m.tokens as u64).sum();
    serde_json::json!({
        "totalConversations": convs.len(),
        "totalMessages":      total_msgs,
        "claudeMessages":     claude_msgs,
        "localMessages":      local_msgs,
        "totalTokens":        total_tokens,
        "storagePath":        path.to_string_lossy()
    })
}

/// Return the path where take_screenshot / capture_region save the PNG.
/// The frontend passes this directly to ocr_screen so paths always match.
#[tauri::command]
fn get_screenshot_path() -> String {
    std::env::temp_dir()
        .join("offlineai_screen.png")
        .to_string_lossy()
        .to_string()
}

/// List all visible top-level windows with their screen bounds.
/// Returns [{title, process, x, y, width, height}].
#[tauri::command]
async fn list_windows() -> Result<Vec<serde_json::Value>, String> {
    let script_path = std::env::temp_dir().join("offlineai_windows.ps1");

    // Raw string — no format! needed, no escaping headaches.
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WH {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@
$results = @()
Get-Process |
  Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -ne "" } |
  ForEach-Object {
    $r = New-Object WH+RECT
    if ([WH]::GetWindowRect($_.MainWindowHandle, [ref]$r)) {
      $w = $r.R - $r.L; $h = $r.B - $r.T
      if ($w -gt 80 -and $h -gt 80) {
        $results += [ordered]@{
          title   = $_.MainWindowTitle
          process = $_.ProcessName
          x       = [int]$r.L
          y       = [int]$r.T
          width   = [int]$w
          height  = [int]$h
        }
      }
    }
  }
if ($results.Count -eq 0) { Write-Output '[]'; exit }
@($results) | ConvertTo-Json -Compress
"#;

    std::fs::write(&script_path, script).map_err(|e| e.to_string())?;
    let script_str = script_path.to_string_lossy().into_owned();

    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", &script_str])
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e: std::io::Error| e.to_string())?;

    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() || raw == "[]" {
        return Ok(vec![]);
    }

    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or(serde_json::Value::Array(vec![]));

    Ok(match parsed {
        serde_json::Value::Array(arr) => arr,
        obj @ serde_json::Value::Object(_) => vec![obj],
        _ => vec![],
    })
}

/// Capture a specific region of the primary monitor (screen coordinates).
/// Saves the cropped PNG to the same temp file as take_screenshot so OCR
/// works identically. Returns the cropped image as base64-encoded PNG.
#[tauri::command]
async fn capture_region(x: i32, y: i32, width: i32, height: i32) -> Result<String, String> {
    let tmp_path  = std::env::temp_dir().join("offlineai_screen.png");
    let script_path = std::env::temp_dir().join("offlineai_capture.ps1");

    // Use forward slashes — both PowerShell and Windows handle them fine.
    let save_path = tmp_path.to_string_lossy().replace('\\', "/");

    // Positional format! params: {0}=x {1}=y {2}=width {3}=height {4}=path
    // `{{` and `}}` produce literal `{` and `}` in the final string (valid PS).
    let script = format!(
        "Add-Type -AssemblyName System.Drawing,System.Windows.Forms\n\
         $scr=[System.Windows.Forms.Screen]::PrimaryScreen\n\
         $bFull=New-Object System.Drawing.Bitmap($scr.Bounds.Width,$scr.Bounds.Height)\n\
         $g=[System.Drawing.Graphics]::FromImage($bFull)\n\
         $g.CopyFromScreen($scr.Bounds.X,$scr.Bounds.Y,0,0,$bFull.Size)\n\
         $cX=[Math]::Max(0,({0})-$scr.Bounds.X)\n\
         $cY=[Math]::Max(0,({1})-$scr.Bounds.Y)\n\
         $cW=[Math]::Min(({2}),$scr.Bounds.Width-$cX)\n\
         $cH=[Math]::Min(({3}),$scr.Bounds.Height-$cY)\n\
         if($cW -gt 0 -and $cH -gt 0){{\n\
             $b2=$bFull.Clone([System.Drawing.Rectangle]::new($cX,$cY,$cW,$cH),$bFull.PixelFormat)\n\
             $b2.Save('{4}')\n\
             $b2.Dispose()\n\
         }}else{{$bFull.Save('{4}')}}\n\
         $g.Dispose();$bFull.Dispose()",
        x, y, width, height, save_path
    );

    std::fs::write(&script_path, &script).map_err(|e| e.to_string())?;
    let script_str = script_path.to_string_lossy().into_owned();

    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", &script_str])
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e: std::io::Error| e.to_string())?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() { "capture_region failed".into() } else { err });
    }

    let bytes = std::fs::read(&tmp_path).map_err(|e| format!("Read error: {e}"))?;
    Ok(base64_encode(&bytes))
}

/// Minimal base64 encoder — avoids an extra crate dependency.
fn base64_encode(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for c in data.chunks(3) {
        let b0 = c[0] as usize;
        let b1 = if c.len() > 1 { c[1] as usize } else { 0 };
        let b2 = if c.len() > 2 { c[2] as usize } else { 0 };
        out.push(T[b0 >> 2] as char);
        out.push(T[((b0 & 3) << 4) | (b1 >> 4)] as char);
        out.push(if c.len() > 1 { T[((b1 & 15) << 2) | (b2 >> 6)] as char } else { '=' });
        out.push(if c.len() > 2 { T[b2 & 63] as char } else { '=' });
    }
    out
}

#[tauri::command]
fn get_local_ip() -> Option<String> {
    use std::net::UdpSocket;
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    Some(socket.local_addr().ok()?.ip().to_string())
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
        .arg("--ctx-size").arg("20480")
        .arg("--threads").arg("4")
        .arg("--batch-size").arg("512")
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
    repeat_penalty: Option<f32>,
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
        "repeat_penalty": repeat_penalty.unwrap_or(1.15),
        "repeat_last_n": 256,
        "frequency_penalty": 0.1,
        "presence_penalty": 0.05,
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

// ── Excel Add-in HTTP server ──────────────────────────────────────────────────
// Serves the taskpane.html and taskpane.js files on http://localhost:8089
// so the Office add-in manifest can load them from Excel's task pane.

const ADDIN_HTML:     &str = include_str!("../assets/excel-addin/taskpane.html");
const ADDIN_JS:       &str = include_str!("../assets/excel-addin/taskpane.js");
const WORD_HTML:      &str = include_str!("../assets/word-addin/taskpane.html");
const WORD_JS:        &str = include_str!("../assets/word-addin/taskpane.js");
const PPT_HTML:       &str = include_str!("../assets/powerpoint-addin/taskpane.html");
const PPT_JS:         &str = include_str!("../assets/powerpoint-addin/taskpane.js");

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn handle_addin_http(mut stream: tokio::net::TcpStream) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // Read until end of HTTP headers (\r\n\r\n) to avoid deadlock on large requests
    let mut buf = vec![0u8; 8192];
    let mut total = 0;
    loop {
        match stream.read(&mut buf[total..]).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                total += n;
                if buf[..total].windows(4).any(|w| w == b"\r\n\r\n") { break; }
                if total >= buf.len() { break; }
            }
        }
    }
    let req = String::from_utf8_lossy(&buf[..total]);
    let first_line = req.lines().next().unwrap_or("");
    let (content_type, body): (&str, &str) = if first_line.contains("taskpane.js") {
        ("application/javascript", ADDIN_JS)
    } else {
        ("text/html; charset=utf-8", ADDIN_HTML)
    };
    let body_bytes = body.as_bytes();
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
        body_bytes.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    let _ = stream.write_all(body_bytes).await;
}

// ── Word Add-in HTTP server (port 8090) ──────────────────────────────────────
#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn handle_word_addin_http(mut stream: tokio::net::TcpStream) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut buf = vec![0u8; 8192];
    let mut total = 0;
    loop {
        match stream.read(&mut buf[total..]).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                total += n;
                if buf[..total].windows(4).any(|w| w == b"\r\n\r\n") { break; }
                if total >= buf.len() { break; }
            }
        }
    }
    let req = String::from_utf8_lossy(&buf[..total]);
    let first_line = req.lines().next().unwrap_or("");
    let (content_type, body): (&str, &str) = if first_line.contains("taskpane.js") {
        ("application/javascript", WORD_JS)
    } else {
        ("text/html; charset=utf-8", WORD_HTML)
    };
    let body_bytes = body.as_bytes();
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
        body_bytes.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    let _ = stream.write_all(body_bytes).await;
}

// ── PowerPoint Add-in HTTP server (port 8091) ─────────────────────────────────
#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn handle_ppt_addin_http(mut stream: tokio::net::TcpStream) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut buf = vec![0u8; 8192];
    let mut total = 0;
    loop {
        match stream.read(&mut buf[total..]).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                total += n;
                if buf[..total].windows(4).any(|w| w == b"\r\n\r\n") { break; }
                if total >= buf.len() { break; }
            }
        }
    }
    let req = String::from_utf8_lossy(&buf[..total]);
    let first_line = req.lines().next().unwrap_or("");
    let (content_type, body): (&str, &str) = if first_line.contains("taskpane.js") {
        ("application/javascript", PPT_JS)
    } else {
        ("text/html; charset=utf-8", PPT_HTML)
    };
    let body_bytes = body.as_bytes();
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
        body_bytes.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    let _ = stream.write_all(body_bytes).await;
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
            Some("excel_query") => {
                // Excel add-in pre-computes ratios/lookups in JS and sends:
                //   dataStr     — compact human-readable table
                //   computedStr — pre-calculated result (if found)
                //   hasComputed — whether JS resolved the answer
                let question          = val["question"].as_str().unwrap_or("").to_string();
                let data_str         = val["dataStr"].as_str().unwrap_or("").to_string();
                let computed_str     = val["computedStr"].as_str().unwrap_or("").to_string();
                let has_computed     = val["hasComputed"].as_bool().unwrap_or(false);
                let suggested_tokens = val["suggestedTokens"].as_u64().unwrap_or(600) as u32;

                // Build prompt differently depending on whether JS already computed the answer
                let prompt = if has_computed {
                    format!(
                        "<|im_start|>system\n\
You are a financial analyst assistant. A calculation has already been performed for the user.\
<|im_end|>\n\
<|im_start|>user\n\
EXCEL DATA:\n{data_str}\n\
{computed_str}\n\
QUESTION: {question}\n\
The pre-computed result above is correct. Present it clearly to the user, explain what it means \
in plain English, and add brief financial interpretation (is this good/bad/normal for the industry?). \
Be concise — 3-5 sentences max.\
<|im_end|>\n\
<|im_start|>assistant\n"
                    )
                } else {
                    format!(
                        "<|im_start|>system\n\
You are a financial analyst assistant. The user has selected cells from an Excel spreadsheet.\n\
Rules:\n\
- Use ONLY the exact values shown below. Never invent or assume numbers.\n\
- If you need to calculate something, show your working step by step.\n\
- If a required value is missing, say so clearly — do not guess.\n\
- Be concise. No padding or restating the question.\
<|im_end|>\n\
<|im_start|>user\n\
EXCEL DATA:\n{data_str}\n\
QUESTION: {question}\
<|im_end|>\n\
<|im_start|>assistant\n"
                    )
                };

                // Grab tx without holding the lock during streaming
                let tx_opt = {
                    let lock = clients.lock().await;
                    lock.get(&id).map(|c| c.tx.clone())
                };

                if let Some(tx) = tx_opt {
                    let port = SERVER_PORT;
                    tauri::async_runtime::spawn(async move {
                        use futures_util::StreamExt;
                        let client = reqwest::Client::new();
                        // Use dynamic token budget sent from JS (estimateTokens),
                        // capped at 1500 for safety. Minimum 200 to never cut off.
                        let n_predict = suggested_tokens.max(200).min(1500);
                        let body = serde_json::json!({
                            "prompt": prompt,
                            "n_predict": n_predict,
                            "temperature": 0.5,
                            "stream": true,
                            "repeat_penalty": 1.1,
                            "top_k": 40,
                            "top_p": 0.95,
                        });
                        let res = match client
                            .post(format!("http://127.0.0.1:{port}/completion"))
                            .json(&body).send().await {
                            Ok(r) => r,
                            Err(e) => {
                                let _ = tx.send(serde_json::json!({"type":"error","message":e.to_string()}).to_string());
                                return;
                            }
                        };
                        let mut stream = res.bytes_stream();
                        let mut buf = String::new();
                        'stream: while let Some(chunk) = stream.next().await {
                            if let Ok(bytes) = chunk {
                                buf.push_str(&String::from_utf8_lossy(&bytes));
                                loop {
                                    if let Some(pos) = buf.find("\n\n") {
                                        let event = buf[..pos].to_string();
                                        buf = buf[pos + 2..].to_string();
                                        for line in event.lines() {
                                            if let Some(data) = line.strip_prefix("data: ") {
                                                if let Ok(j) = serde_json::from_str::<serde_json::Value>(data) {
                                                    if let Some(text) = j["content"].as_str() {
                                                        if !text.is_empty() {
                                                            let _ = tx.send(serde_json::json!({"type":"token","content":text}).to_string());
                                                        }
                                                    }
                                                    if j["stop"].as_bool().unwrap_or(false) {
                                                        let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                                                        break 'stream;
                                                    }
                                                }
                                            }
                                        }
                                    } else { break; }
                                }
                            }
                        }
                        let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                    });
                }
            }
            // ── Browser: Translate page content to target language ────────────
            Some("translate_page") => {
                let content          = val["content"].as_str().unwrap_or("").to_string();
                let target_lang      = val["targetLang"].as_str().unwrap_or("English").to_string();
                let source_hint      = val["sourceHint"].as_str().unwrap_or("Auto-detect").to_string();
                let page_title       = val["pageTitle"].as_str().unwrap_or("").to_string();
                let suggested_tokens = val["suggestedTokens"].as_u64().unwrap_or(2000) as u32;

                let title_line = if page_title.is_empty() {
                    String::new()
                } else {
                    format!("Article title: {page_title}\n\n")
                };

                let source_line = if source_hint == "Auto-detect" {
                    "Detect the source language automatically.".to_string()
                } else {
                    format!("Source language: {source_hint}")
                };

                let prompt = format!(
                    "<|im_start|>system\n\
You are a professional translator. Translate the provided article text to {target_lang}.\n\
{source_line}\n\
\n\
Translation rules:\n\
- Output ONLY the translated text — no headers like \"Translation:\", no explanations, no notes\n\
- Preserve paragraph structure: keep blank lines between paragraphs exactly as in the original\n\
- Preserve any bullet points, numbered lists, or headings format\n\
- Keep proper nouns, brand names, and URLs exactly as they appear — do not translate them\n\
- Keep technical terms in their standard {target_lang} equivalent if one exists\n\
- Match the tone: formal text stays formal, casual text stays casual\n\
- If the text ends with [content truncated...], include that marker as-is at the very end\n\
- Do NOT add a title or summary at the top — start translating immediately from the first word\
<|im_end|>\n\
<|im_start|>user\n\
{title_line}Translate the following to {target_lang}:\n\
\n\
{content}\
<|im_end|>\n\
<|im_start|>assistant\n"
                );

                let tx_opt = {
                    let lock = clients.lock().await;
                    lock.get(&id).map(|c| c.tx.clone())
                };
                if let Some(tx) = tx_opt {
                    let port = SERVER_PORT;
                    // Translation tokens ≈ input tokens (1:1 ratio), allow generous budget
                    let n_predict = suggested_tokens.max(500).min(3000);
                    tauri::async_runtime::spawn(async move {
                        use futures_util::StreamExt;
                        let client = reqwest::Client::new();
                        let body = serde_json::json!({
                            "prompt":         prompt,
                            "n_predict":      n_predict,
                            "temperature":    0.3,   // low temp for faithful translation
                            "stream":         true,
                            "repeat_penalty": 1.05,  // slightly above 1.0 — prevent repeated sentences
                            "stop":           ["<|im_end|>", "<|im_start|>"]
                        });
                        let res = match client
                            .post(format!("http://127.0.0.1:{port}/completion"))
                            .json(&body).send().await {
                            Ok(r) => r,
                            Err(e) => {
                                let _ = tx.send(serde_json::json!({"type":"error","message":e.to_string()}).to_string());
                                return;
                            }
                        };
                        let mut stream = res.bytes_stream();
                        let mut buf = String::new();
                        'stream: loop {
                            match stream.next().await {
                                Some(Ok(chunk)) => {
                                    buf.push_str(&String::from_utf8_lossy(&chunk));
                                    while let Some(pos) = buf.find('\n') {
                                        let line = buf[..pos].trim().to_string();
                                        buf = buf[pos+1..].to_string();
                                        if line.starts_with("data: ") {
                                            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&line["data: ".len()..]) {
                                                if let Some(tok) = j["content"].as_str() {
                                                    if !tok.is_empty() {
                                                        let _ = tx.send(serde_json::json!({"type":"token","content":tok}).to_string());
                                                    }
                                                }
                                                if j["stop"].as_bool().unwrap_or(false) {
                                                    let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                                                    break 'stream;
                                                }
                                            }
                                        }
                                    }
                                }
                                Some(Err(_)) | None => { break; }
                            }
                        }
                        let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                    });
                }
            }
            Some("browser_query") => {
                // Browser extension sends page content + user question
                let question        = val["question"].as_str().unwrap_or("").to_string();
                let page_title      = val["pageTitle"].as_str().unwrap_or("").to_string();
                let page_url        = val["pageUrl"].as_str().unwrap_or("").to_string();
                let page_content    = val["pageContent"].as_str().unwrap_or("").to_string();
                let selection       = val["selection"].as_str().unwrap_or("").to_string();
                let has_context     = val["hasContext"].as_bool().unwrap_or(false);
                let suggested_tokens = val["suggestedTokens"].as_u64().unwrap_or(600) as u32;

                let context_block = if !selection.is_empty() {
                    format!("\nSELECTED TEXT:\n{}\n", selection)
                } else if has_context && !page_content.is_empty() {
                    format!("\nPAGE CONTENT:\n{}\n", page_content)
                } else {
                    String::new()
                };

                let page_info = if !page_title.is_empty() {
                    format!("Page: {} ({})", page_title, page_url)
                } else {
                    format!("URL: {}", page_url)
                };

                let prompt = format!(
                    "<|im_start|>system\n\
You are a helpful AI assistant integrated into the user's browser via CodeForge.\n\
Rules:\n\
- Answer based on the page content provided when available\n\
- If no page content is provided, answer from your general knowledge\n\
- Be concise and direct\n\
- If asked to explain, give a thorough explanation\
<|im_end|>\n\
<|im_start|>user\n\
{page_info}\n\
{context_block}\n\
QUESTION: {question}\
<|im_end|>\n\
<|im_start|>assistant\n"
                );

                let tx_opt = {
                    let lock = clients.lock().await;
                    lock.get(&id).map(|c| c.tx.clone())
                };

                if let Some(tx) = tx_opt {
                    let port = SERVER_PORT;
                    let n_predict = suggested_tokens.max(200).min(1500);
                    tauri::async_runtime::spawn(async move {
                        use futures_util::StreamExt;
                        let client = reqwest::Client::new();
                        let body = serde_json::json!({
                            "prompt": prompt,
                            "n_predict": n_predict,
                            "temperature": 0.7,
                            "stream": true,
                            "repeat_penalty": 1.1,
                            "top_k": 40,
                            "top_p": 0.95,
                        });
                        let res = match client
                            .post(format!("http://127.0.0.1:{port}/completion"))
                            .json(&body).send().await {
                            Ok(r) => r,
                            Err(e) => {
                                let _ = tx.send(serde_json::json!({"type":"error","message":e.to_string()}).to_string());
                                return;
                            }
                        };
                        let mut stream = res.bytes_stream();
                        let mut buf = String::new();
                        'stream: loop {
                            match stream.next().await {
                                Some(Ok(chunk)) => {
                                    buf.push_str(&String::from_utf8_lossy(&chunk));
                                    while let Some(pos) = buf.find('\n') {
                                        let line = buf[..pos].trim().to_string();
                                        buf = buf[pos+1..].to_string();
                                        if line.starts_with("data: ") {
                                            let json_str = &line["data: ".len()..];
                                            if let Ok(j) = serde_json::from_str::<serde_json::Value>(json_str) {
                                                if let Some(tok) = j["content"].as_str() {
                                                    if !tok.is_empty() {
                                                        let _ = tx.send(serde_json::json!({"type":"token","content":tok}).to_string());
                                                    }
                                                }
                                                if j["stop"].as_bool().unwrap_or(false) {
                                                    let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                                                    break 'stream;
                                                }
                                            }
                                        }
                                    }
                                }
                                Some(Err(_)) | None => { break; }
                            }
                        }
                        let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                    });
                }
            }
            Some("excel_formula") => {
                // Excel add-in (Formula mode): user describes a formula they want inserted.
                // JS sends target cell, surrounding context, AND a full schema of all
                // sheets so the AI can generate cross-sheet / cross-workbook formulas.
                let request       = val["request"].as_str().unwrap_or("").to_string();
                let cell_address  = val["cellAddress"].as_str().unwrap_or("A1").to_string();
                let target_range  = val["targetRange"].as_str().unwrap_or(&cell_address).to_string();
                let row_count     = val["rowCount"].as_u64().unwrap_or(1) as usize;
                let _sheet_name   = val["sheetName"].as_str().unwrap_or("Sheet1").to_string();
                let workbook_name = val["workbookName"].as_str().unwrap_or("Workbook.xlsx").to_string();
                let context       = val["context"].as_str().unwrap_or("").to_string();
                let sheets_schema = val["sheetsSchema"].as_array().cloned().unwrap_or_default();

                // ── Build workbook structure block ────────────────────────────
                let mut wb_block = String::new();
                if !sheets_schema.is_empty() {
                    wb_block.push_str(&format!("WORKBOOK: \"{workbook_name}\"\n"));
                    wb_block.push_str("SHEETS AVAILABLE:\n");
                    for s in &sheets_schema {
                        let sname    = s["name"].as_str().unwrap_or("Sheet");
                        let rows     = s["rowCount"].as_u64().unwrap_or(0);
                        let is_active = s["isActive"].as_bool().unwrap_or(false);
                        let active_mark = if is_active { " ← ACTIVE (this is where the formula goes)" } else { "" };
                        // Format sheet name for formula use: quote if it contains spaces/special chars
                        let needs_quote = sname.contains(' ') || sname.contains('-') || sname.contains('.');
                        let formula_ref = if needs_quote { format!("'{sname}'!") } else { format!("{sname}!") };
                        wb_block.push_str(&format!("  [{formula_ref}]  \"{sname}\"{active_mark}  ({rows} rows)\n"));
                        if let Some(headers) = s["headers"].as_array() {
                            let hlist: Vec<String> = headers.iter().filter_map(|h| {
                                let col = h["col"].as_str()?;
                                let hdr = h["header"].as_str()?;
                                if hdr.is_empty() { return None; }
                                Some(format!("{col}: \"{hdr}\""))
                            }).collect();
                            if !hlist.is_empty() {
                                wb_block.push_str(&format!("    Columns → {}\n", hlist.join(", ")));
                            }
                        }
                        if let Some(keys) = s["sampleKeys"].as_array() {
                            let klist: Vec<&str> = keys.iter().filter_map(|k| k.as_str()).take(5).collect();
                            if !klist.is_empty() {
                                wb_block.push_str(&format!("    Sample keys (col A): {}\n", klist.join(", ")));
                            }
                        }
                    }
                }

                // ── Cross-sheet / cross-workbook reference guide ──────────────
                let ref_guide = "\
FORMULA REFERENCE RULES:\n\
Same sheet:       =A1  or  =SUM(A1:A10)\n\
Another sheet:    =SheetName!A1  or  =SUM(SheetName!A1:A10)\n\
Sheet with spaces:'My Sheet'!A1  (always quote sheet names containing spaces)\n\
VLOOKUP cross-sheet:  =VLOOKUP(A2, Employees!A:C, 2, FALSE)\n\
XLOOKUP cross-sheet:  =XLOOKUP(A2, Employees!A:A, Employees!C:C, \"Not found\")\n\
INDEX/MATCH cross-sheet: =INDEX(Employees!C:C, MATCH(A2, Employees!A:A, 0))\n\
Cross-workbook (must be open): =VLOOKUP(A2, '[OtherBook.xlsx]Sheet1'!A:C, 2, FALSE)\n\
Absolute column in lookup: use $A:$C to lock the lookup range (preferred)\n\
WHEN TO USE WHICH:\n\
- XLOOKUP  → preferred for Excel 365/2021 (more flexible, no column number)\n\
- VLOOKUP  → use when user asks for it, or for older Excel compatibility\n\
- INDEX/MATCH → use for leftward lookups or when match column is not the first\n\
- SUMIF/SUMIFS → aggregation across sheets: =SUMIF(Sheet2!A:A, A2, Sheet2!B:B)";

                let (output_rule, user_instruction, n_predict) = if row_count > 1 {
                    (
                        format!(
                            "You are an Excel formula expert. Generate {row_count} Excel formulas, one per line.\n\
Output rules:\n\
- Output ONLY formulas, one per line, no numbering, no explanation\n\
- Each line must start with =\n\
- Adjust row numbers per row (row 1 uses references at row 1, row 2 at row 2, etc.)\n\
- First formula goes in {cell_address}\n\
- Quote sheet names that contain spaces: 'My Sheet'!A1"
                        ),
                        format!("Generate {row_count} formulas (one per row) for target range {target_range} to: {request}"),
                        (row_count as u32) * 50 + 80,
                    )
                } else {
                    (
                        "You are an Excel formula expert. Generate a single valid Excel formula.\n\
Output rules:\n\
- Reply with ONLY the formula — start with =\n\
- No explanation, no markdown, no code fences — just the formula on one line\n\
- Use exact column letters and row numbers from the context provided\n\
- Use absolute references ($) for lookup arrays and headers\n\
- Quote sheet names that contain spaces: 'My Sheet'!A1\n\
- Choose the best function (XLOOKUP preferred over VLOOKUP for Excel 365)".to_string(),
                        format!("Generate an Excel formula for cell {cell_address} to: {request}"),
                        200u32,
                    )
                };

                let prompt = format!(
                    "<|im_start|>system\n\
{output_rule}\n\
\n\
{ref_guide}\
<|im_end|>\n\
<|im_start|>user\n\
{wb_block}\n\
ACTIVE SHEET CELL CONTEXT:\n\
{context}\n\
\n\
{user_instruction}\
<|im_end|>\n\
<|im_start|>assistant\n"
                );

                let tx_opt = {
                    let lock = clients.lock().await;
                    lock.get(&id).map(|c| c.tx.clone())
                };

                if let Some(tx) = tx_opt {
                    let port = SERVER_PORT;
                    tauri::async_runtime::spawn(async move {
                        use futures_util::StreamExt;
                        let client = reqwest::Client::new();
                        let body = serde_json::json!({
                            "prompt": prompt,
                            "n_predict": n_predict,
                            "temperature": 0.1,
                            "stream": true,
                            "repeat_penalty": 1.0,
                            "stop": ["<|im_end|>"],
                        });
                        let res = match client
                            .post(format!("http://127.0.0.1:{port}/completion"))
                            .json(&body).send().await {
                            Ok(r) => r,
                            Err(e) => {
                                let _ = tx.send(serde_json::json!({"type":"error","message":e.to_string()}).to_string());
                                return;
                            }
                        };
                        // No pre-filled "=" — the AI outputs the full formula starting with =
                        let mut stream = res.bytes_stream();
                        let mut buf = String::new();
                        'stream: loop {
                            match stream.next().await {
                                Some(Ok(chunk)) => {
                                    buf.push_str(&String::from_utf8_lossy(&chunk));
                                    while let Some(pos) = buf.find('\n') {
                                        let line = buf[..pos].trim().to_string();
                                        buf = buf[pos+1..].to_string();
                                        if line.starts_with("data: ") {
                                            let json_str = &line["data: ".len()..];
                                            if let Ok(j) = serde_json::from_str::<serde_json::Value>(json_str) {
                                                if let Some(tok) = j["content"].as_str() {
                                                    if !tok.is_empty() {
                                                        let _ = tx.send(serde_json::json!({"type":"token","content":tok}).to_string());
                                                    }
                                                }
                                                if j["stop"].as_bool().unwrap_or(false) {
                                                    let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                                                    break 'stream;
                                                }
                                            }
                                        }
                                    }
                                }
                                Some(Err(_)) | None => { break; }
                            }
                        }
                        let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                    });
                }
            }
            // ── Excel: Build mode — execute Office.js actions from JSON ──────
            Some("excel_build") => {
                let request      = val["request"].as_str().unwrap_or("").to_string();
                let sel_address  = val["selAddress"].as_str().unwrap_or("A1").to_string();
                let sheet_name   = val["sheetName"].as_str().unwrap_or("Sheet1").to_string();
                let context_str  = val["context"].as_str().unwrap_or("").to_string();
                let row_count    = val["rowCount"].as_u64().unwrap_or(1);
                let col_count    = val["columnCount"].as_u64().unwrap_or(1);

                let system_prompt = "You are an Excel automation expert integrated into CodeForge AI.\n\
Your job is to convert a natural language request into a JSON action list for Office.js.\n\
\n\
Output ONLY a valid JSON object: {\"actions\":[...]}   — no markdown fences, no explanation, nothing else.\n\
\n\
Available operations (use only these):\n\
- create_table:            { range?:\"auto\", hasHeaders?:bool, style?:\"TableStyleMedium9\"|\"TableStyleLight1\"|\"TableStyleDark11\", name?:string }\n\
- add_total_row:           { enabled?:true }\n\
- apply_filter:            { range?:\"auto\", columnIndex?:0, column?:\"A\", value?:string }\n\
- clear_filters:           {}\n\
- sort:                    { range?:\"auto\", column?:\"A\", columnIndex?:0, ascending?:bool }\n\
- format_header:           { bold?:bool, bgColor?:\"#hex\", textColor?:\"#hex\", fontSize?:number, italic?:bool }\n\
- format_range:            { range?:\"auto\", bold?:bool, bgColor?:\"#hex\", textColor?:\"#hex\", fontSize?:number, numberFormat?:string, wrapText?:bool, hAlign?:\"Left\"|\"Center\"|\"Right\" }\n\
- number_format:           { range?:\"auto\", format:string }  (e.g. \"#,##0.00\", \"$#,##0\", \"0%\", \"dd/mm/yyyy\")\n\
- conditional_format:      { range?:\"auto\", rule:\"greater_than\"|\"less_than\"|\"equal\"|\"between\"|\"not_equal\"|\"greater_or_equal\"|\"less_or_equal\", value:number, value2?:number, bgColor?:\"#hex\", textColor?:\"#hex\", bold?:bool }\n\
- clear_conditional_formats:{ range?:\"auto\" }\n\
- auto_fit_columns:        { range?:\"auto\" }\n\
- auto_fit_rows:           { range?:\"auto\" }\n\
- set_column_width:        { range?:\"auto\", width:number }\n\
- set_row_height:          { range?:\"auto\", height:number }\n\
- set_border:              { range?:\"auto\", style?:\"thin\"|\"medium\"|\"thick\"|\"dashed\"|\"dotted\"|\"none\", color?:\"#hex\" }\n\
- clear_formatting:        { range?:\"auto\" }\n\
- freeze_panes:            { rows?:1, cols?:0 }\n\
- unfreeze_panes:          {}\n\
- insert_chart:            { type:\"column\"|\"bar\"|\"line\"|\"pie\"|\"area\"|\"scatter\"|\"doughnut\", range?:\"auto\", title?:string, width?:480, height?:300 }\n\
- merge_cells:             { range?:\"auto\", across?:bool }\n\
- unmerge_cells:           { range?:\"auto\" }\n\
- add_sheet:               { name?:string, activate?:bool }\n\
- rename_sheet:            { name:string }\n\
\n\
Rules:\n\
- Use range:\"auto\" to mean the user's currently selected range\n\
- Combine multiple steps naturally, e.g. create_table + format_header + auto_fit_columns + freeze_panes\n\
- Output ONLY the JSON. Absolutely no other text.";

                let user_msg = format!(
                    "WORKBOOK CONTEXT:\n{context_str}\n\
Selected range: {sel_address} ({row_count} rows × {col_count} cols) on sheet \"{sheet_name}\"\n\
\n\
USER REQUEST: {request}"
                );

                let prompt = format!(
                    "<|im_start|>system\n{system_prompt}\n<|im_end|>\n\
<|im_start|>user\n{user_msg}\n<|im_end|>\n\
<|im_start|>assistant\n{{\"actions\":["
                );

                let tx_opt = { let lock = clients.lock().await; lock.get(&id).map(|c| c.tx.clone()) };
                if let Some(tx) = tx_opt {
                    let port = SERVER_PORT;
                    tauri::async_runtime::spawn(async move {
                        use futures_util::StreamExt;
                        // Pre-fill the opening of the JSON so the model continues from there
                        let _ = tx.send(serde_json::json!({"type":"token","content":"{\"actions\":["}).to_string());
                        let client = reqwest::Client::new();
                        let body = serde_json::json!({
                            "prompt":         prompt,
                            "n_predict":      500,
                            "temperature":    0.1,
                            "stream":         true,
                            "repeat_penalty": 1.05,
                            "stop":           ["<|im_end|>", "\n\n\n"],
                        });
                        let res = match client
                            .post(format!("http://127.0.0.1:{port}/completion"))
                            .json(&body).send().await {
                            Ok(r) => r,
                            Err(e) => { let _ = tx.send(serde_json::json!({"type":"error","message":e.to_string()}).to_string()); return; }
                        };
                        let mut stream = res.bytes_stream();
                        let mut buf    = String::new();
                        'stream: loop {
                            match stream.next().await {
                                Some(Ok(chunk)) => {
                                    buf.push_str(&String::from_utf8_lossy(&chunk));
                                    while let Some(pos) = buf.find('\n') {
                                        let line = buf[..pos].trim().to_string();
                                        buf = buf[pos+1..].to_string();
                                        if line.starts_with("data: ") {
                                            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&line["data: ".len()..]) {
                                                if let Some(tok) = j["content"].as_str() {
                                                    if !tok.is_empty() {
                                                        let _ = tx.send(serde_json::json!({"type":"token","content":tok}).to_string());
                                                    }
                                                }
                                                if j["stop"].as_bool().unwrap_or(false) {
                                                    let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                                                    break 'stream;
                                                }
                                            }
                                        }
                                    }
                                }
                                Some(Err(_)) | None => { break; }
                            }
                        }
                        let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                    });
                }
            }
            // ── VS Code: Quantum Rewrite ⚛ ───────────────────────────────────
            // Finds the exact function / logic block that needs changing,
            // returns structured XML so the extension can show a quantum diff panel.
            Some("quantum_rewrite") => {
                let change_desc      = val["changeDesc"].as_str().unwrap_or("").to_string();
                let current_file     = val["currentFile"].as_str().unwrap_or("file").to_string();
                let current_code     = val["currentCode"].as_str().unwrap_or("").to_string();
                let language         = val["language"].as_str().unwrap_or("code").to_string();
                let suggested_tokens = val["suggestedTokens"].as_u64().unwrap_or(900) as u32;
                let entangled_files  = val["entangledFiles"].as_array().cloned().unwrap_or_default();

                // Build entangled files block so AI has full context
                let mut entangled_block = String::new();
                for ef in &entangled_files {
                    let name    = ef["name"].as_str().unwrap_or("file");
                    let content = ef["content"].as_str().unwrap_or("");
                    entangled_block.push_str(&format!(
                        "\n--- Entangled file: {name} ---\n{content}\n"
                    ));
                }

                let system_prompt =
"You are a quantum code analyzer embedded in CodeForge AI.\n\
Your mission: find the EXACT function or logic block that must change to fulfill the user's request,\n\
then write the improved version.\n\
\n\
Respond using ONLY these XML tags — no preamble, no explanation outside the tags:\n\
\n\
<QR_FILE>filename.ext</QR_FILE>\n\
<QR_OLD>\n\
[EXACT verbatim code to replace — must be a literal substring of the file]\n\
</QR_OLD>\n\
<QR_NEW>\n\
[the replacement code]\n\
</QR_NEW>\n\
<QR_WHY>[one concise sentence: what changed and why]</QR_WHY>\n\
\n\
Rules:\n\
- QR_OLD must be copied VERBATIM from the source — it will be used as a find-and-replace target\n\
- QR_NEW replaces QR_OLD completely in-place, preserving surrounding indentation style\n\
- Make the MINIMUM change needed — only touch the function or block that is directly relevant\n\
- If changes span multiple functions, pick the single most impactful one\n\
- Output NOTHING outside the four XML tags";

                let user_msg = format!(
                    "CHANGE REQUEST: {change_desc}\n\
\n\
--- Primary file: {current_file} ({language}) ---\n\
{current_code}\
{entangled_block}"
                );

                let prompt = format!(
                    "<|im_start|>system\n{system_prompt}\n<|im_end|>\n\
<|im_start|>user\n{user_msg}\n<|im_end|>\n\
<|im_start|>assistant\n"
                );

                let tx_opt = { let lock = clients.lock().await; lock.get(&id).map(|c| c.tx.clone()) };
                if let Some(tx) = tx_opt {
                    let port = SERVER_PORT;
                    let n_predict = suggested_tokens.max(400).min(1400);
                    tauri::async_runtime::spawn(async move {
                        use futures_util::StreamExt;
                        let client = reqwest::Client::new();
                        let body = serde_json::json!({
                            "prompt":         prompt,
                            "n_predict":      n_predict,
                            "temperature":    0.2,
                            "stream":         true,
                            "repeat_penalty": 1.05,
                            "stop":           ["<|im_end|>"],
                        });
                        let res = match client
                            .post(format!("http://127.0.0.1:{port}/completion"))
                            .json(&body).send().await {
                            Ok(r) => r,
                            Err(e) => {
                                let _ = tx.send(serde_json::json!({"type":"error","message":e.to_string()}).to_string());
                                return;
                            }
                        };
                        let mut stream = res.bytes_stream();
                        let mut buf    = String::new();
                        'stream: loop {
                            match stream.next().await {
                                Some(Ok(chunk)) => {
                                    buf.push_str(&String::from_utf8_lossy(&chunk));
                                    while let Some(pos) = buf.find('\n') {
                                        let line = buf[..pos].trim().to_string();
                                        buf = buf[pos+1..].to_string();
                                        if line.starts_with("data: ") {
                                            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&line["data: ".len()..]) {
                                                if let Some(tok) = j["content"].as_str() {
                                                    if !tok.is_empty() {
                                                        let _ = tx.send(serde_json::json!({"type":"token","content":tok}).to_string());
                                                    }
                                                }
                                                if j["stop"].as_bool().unwrap_or(false) {
                                                    let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                                                    break 'stream;
                                                }
                                            }
                                        }
                                    }
                                }
                                Some(Err(_)) | None => { break; }
                            }
                        }
                        let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                    });
                }
            }
            // ── VS Code: Generate Unit Tests ──────────────────────────────────
            Some("test_generate") => {
                let code      = val["code"].as_str().unwrap_or("").to_string();
                let language  = val["language"].as_str().unwrap_or("").to_string();
                let framework = val["framework"].as_str().unwrap_or("Jest").to_string();
                let file_name = val["fileName"].as_str().unwrap_or("file").to_string();
                let suggested_tokens = val["suggestedTokens"].as_u64().unwrap_or(1200) as u32;

                let prompt = format!(
                    "<|im_start|>system\n\
You are a unit test expert integrated into VS Code via CodeForge.\n\
Generate comprehensive unit tests using {framework}.\n\
\n\
Critical rules:\n\
- Output ONLY raw test code — no markdown fences (no ```), no explanations\n\
- Import ONLY the specific functions being tested, not the whole module\n\
- Import path: use './{file_name}' without extension (e.g. import {{ myFn }} from './myFile')\n\
- Every single test MUST have at least one expect/assert statement — never write empty tests\n\
- For async functions: use async/await in the test, e.g. it('name', async () => {{ ... }})\n\
- For error cases: use expect(() => fn()).toThrow() or try/catch\n\
- Test cases to include for EVERY function:\n\
  1. Normal input → expected output\n\
  2. Edge cases: null, undefined, empty string '', 0, negative numbers, empty array []\n\
  3. Error case: invalid input should throw or return error\n\
- Never use .toBeTruthy() as the only assertion — use .toBe(), .toEqual(), .toThrow() etc.\n\
- Group tests with describe('{file_name}', () => {{ ... }})\
<|im_end|>\n\
<|im_start|>user\n\
Language: {language}\n\
File: {file_name}\n\
\n\
CODE TO TEST:\n\
{code}\
<|im_end|>\n\
<|im_start|>assistant\n"
                );
                let tx_opt = {
                    let lock = clients.lock().await;
                    lock.get(&id).map(|c| c.tx.clone())
                };
                if let Some(tx) = tx_opt {
                    let port = SERVER_PORT;
                    let n_predict = suggested_tokens.max(400).min(1500);
                    tauri::async_runtime::spawn(async move {
                        use futures_util::StreamExt;
                        let client = reqwest::Client::new();
                        let body = serde_json::json!({
                            "prompt": prompt, "n_predict": n_predict,
                            "temperature": 0.2, "stream": true,
                            "repeat_penalty": 1.1, "stop": ["<|im_end|>"]
                        });
                        let res = match client.post(format!("http://127.0.0.1:{port}/completion")).json(&body).send().await {
                            Ok(r) => r,
                            Err(e) => {
                                let _ = tx.send(serde_json::json!({"type":"error","message":e.to_string()}).to_string());
                                return;
                            }
                        };
                        let mut stream = res.bytes_stream();
                        let mut buf = String::new();
                        'stream: loop {
                            match stream.next().await {
                                Some(Ok(chunk)) => {
                                    buf.push_str(&String::from_utf8_lossy(&chunk));
                                    while let Some(pos) = buf.find('\n') {
                                        let line = buf[..pos].trim().to_string();
                                        buf = buf[pos+1..].to_string();
                                        if line.starts_with("data: ") {
                                            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&line["data: ".len()..]) {
                                                if let Some(tok) = j["content"].as_str() {
                                                    if !tok.is_empty() {
                                                        let _ = tx.send(serde_json::json!({"type":"token","content":tok}).to_string());
                                                    }
                                                }
                                                if j["stop"].as_bool().unwrap_or(false) {
                                                    let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                                                    break 'stream;
                                                }
                                            }
                                        }
                                    }
                                }
                                Some(Err(_)) | None => { break; }
                            }
                        }
                        let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                    });
                }
            }
            // ── VS Code: Inline Code Suggestion ───────────────────────────────
            Some("inline_suggest") => {
                let context     = val["context"].as_str().unwrap_or("").to_string();
                let line_prefix = val["linePrefix"].as_str().unwrap_or("").to_string();
                let language    = val["language"].as_str().unwrap_or("").to_string();
                let suggested_tokens = val["suggestedTokens"].as_u64().unwrap_or(80) as u32;

                // Build the prompt:
                // We show the context up to cursor, and explicitly tell the model
                // what text is already on the current partial line so it doesn't repeat it.
                let line_hint = if line_prefix.trim().is_empty() {
                    String::new()
                } else {
                    format!("\nThe current partial line already contains: `{}`\nContinue from AFTER that — do not repeat it.\n", line_prefix.trim())
                };

                let prompt = format!(
                    "<|im_start|>system\n\
You are a code completion engine. Your ONLY job is to output the missing code that goes at <CURSOR>.\n\
\n\
Strict rules:\n\
- Output ONLY the raw code that continues from <CURSOR> — nothing else\n\
- NO markdown fences, NO explanations, NO comments unless the surrounding code already has them\n\
- NEVER repeat any code that appears before <CURSOR>\n\
- Complete the current line first (just the remainder of the line), then add at most 2 more lines if they are the natural next step\n\
- Match the exact indentation style of the file (spaces vs tabs, same depth)\n\
- Stop at a logical boundary — one statement, one return, one if-block — do not generate an entire function\n\
- If there is nothing meaningful to complete, output a single newline and stop\
<|im_end|>\n\
<|im_start|>user\n\
Language: {language}\n\
{line_hint}\n\
{context}<CURSOR>\
<|im_end|>\n\
<|im_start|>assistant\n"
                );

                let tx_opt = {
                    let lock = clients.lock().await;
                    lock.get(&id).map(|c| c.tx.clone())
                };
                if let Some(tx) = tx_opt {
                    let port = SERVER_PORT;
                    let n_predict = suggested_tokens.max(20).min(120); // tight cap — inline completions should be short
                    tauri::async_runtime::spawn(async move {
                        use futures_util::StreamExt;
                        let client = reqwest::Client::new();
                        let body = serde_json::json!({
                            "prompt": prompt,
                            "n_predict": n_predict,
                            "temperature": 0.1,
                            "stream": true,
                            "repeat_penalty": 1.05,
                            // Stop on: chat delimiters, blank line (over-gen), comment start
                            "stop": ["<|im_end|>", "<|im_start|>", "\n\n", "//", "#", "/*"]
                        });
                        let res = match client.post(format!("http://127.0.0.1:{port}/completion")).json(&body).send().await {
                            Ok(r) => r,
                            Err(e) => {
                                let _ = tx.send(serde_json::json!({"type":"error","message":e.to_string()}).to_string());
                                return;
                            }
                        };
                        let mut stream = res.bytes_stream();
                        let mut buf = String::new();
                        'stream: loop {
                            match stream.next().await {
                                Some(Ok(chunk)) => {
                                    buf.push_str(&String::from_utf8_lossy(&chunk));
                                    while let Some(pos) = buf.find('\n') {
                                        let line = buf[..pos].trim().to_string();
                                        buf = buf[pos+1..].to_string();
                                        if line.starts_with("data: ") {
                                            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&line["data: ".len()..]) {
                                                if let Some(tok) = j["content"].as_str() {
                                                    if !tok.is_empty() {
                                                        let _ = tx.send(serde_json::json!({"type":"token","content":tok}).to_string());
                                                    }
                                                }
                                                if j["stop"].as_bool().unwrap_or(false) {
                                                    let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                                                    break 'stream;
                                                }
                                            }
                                        }
                                    }
                                }
                                Some(Err(_)) | None => { break; }
                            }
                        }
                        let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                    });
                }
            }
            // ── VS Code: Smart Debug ───────────────────────────────────────────
            Some("debug_query") => {
                let bug_desc       = val["bugDescription"].as_str().unwrap_or("").to_string();
                let current_file   = val["currentFile"].as_str().unwrap_or("").to_string();
                let current_code   = val["currentCode"].as_str().unwrap_or("").to_string();
                let language       = val["language"].as_str().unwrap_or("").to_string();
                let connected      = val["connectedFiles"].as_array().cloned().unwrap_or_default();
                let suggested_tokens = val["suggestedTokens"].as_u64().unwrap_or(1500) as u32;

                let mut connected_block = String::new();
                for cf in &connected {
                    let name    = cf["name"].as_str().unwrap_or("file");
                    let content = cf["content"].as_str().unwrap_or("");
                    connected_block.push_str(&format!("\n--- Connected file: {name} ---\n{content}\n"));
                }

                let prompt = format!(
                    "<|im_start|>system\n\
You are an expert debugger integrated into VS Code via CodeForge.\n\
Analyze the code, find the bug, and provide a fix.\n\
\n\
Your response must follow this EXACT structure — no deviations:\n\
\n\
PART 1 — one short paragraph explaining the root cause (2-4 sentences)\n\
\n\
PART 2 — the code changes block, EXACTLY as shown:\n\
<CHANGES>\n\
[{{\"file\":\"FILENAME\",\"description\":\"WHAT IS FIXED\",\"oldCode\":\"EXACT ORIGINAL CODE\",\"newCode\":\"FIXED CODE\"}}]\n\
</CHANGES>\n\
\n\
Rules for the CHANGES block:\n\
- oldCode: copy the EXACT lines from the file — same whitespace, same quotes, nothing changed\n\
- newCode: the corrected replacement for those exact lines\n\
- Only include files that actually need changes\n\
- Minimal changes only — do not refactor unrelated code\n\
- Use single quotes inside the JSON strings, not double quotes, to avoid breaking JSON\n\
- If no code change needed (e.g. config/env issue), write <CHANGES>[]</CHANGES>\
<|im_end|>\n\
<|im_start|>user\n\
BUG DESCRIPTION: {bug_desc}\n\
\n\
MAIN FILE: {current_file}\n\
```{language}\n\
{current_code}\n\
```\n\
{connected_block}\
<|im_end|>\n\
<|im_start|>assistant\n"
                );
                let tx_opt = {
                    let lock = clients.lock().await;
                    lock.get(&id).map(|c| c.tx.clone())
                };
                if let Some(tx) = tx_opt {
                    let port = SERVER_PORT;
                    let n_predict = suggested_tokens.max(500).min(1500);
                    tauri::async_runtime::spawn(async move {
                        use futures_util::StreamExt;
                        let client = reqwest::Client::new();
                        let body = serde_json::json!({
                            "prompt": prompt, "n_predict": n_predict,
                            "temperature": 0.2, "stream": true,
                            "repeat_penalty": 1.1, "stop": ["<|im_end|>"]
                        });
                        let res = match client.post(format!("http://127.0.0.1:{port}/completion")).json(&body).send().await {
                            Ok(r) => r,
                            Err(e) => {
                                let _ = tx.send(serde_json::json!({"type":"error","message":e.to_string()}).to_string());
                                return;
                            }
                        };
                        let mut stream = res.bytes_stream();
                        let mut buf = String::new();
                        'stream: loop {
                            match stream.next().await {
                                Some(Ok(chunk)) => {
                                    buf.push_str(&String::from_utf8_lossy(&chunk));
                                    while let Some(pos) = buf.find('\n') {
                                        let line = buf[..pos].trim().to_string();
                                        buf = buf[pos+1..].to_string();
                                        if line.starts_with("data: ") {
                                            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&line["data: ".len()..]) {
                                                if let Some(tok) = j["content"].as_str() {
                                                    if !tok.is_empty() {
                                                        let _ = tx.send(serde_json::json!({"type":"token","content":tok}).to_string());
                                                    }
                                                }
                                                if j["stop"].as_bool().unwrap_or(false) {
                                                    let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                                                    break 'stream;
                                                }
                                            }
                                        }
                                    }
                                }
                                Some(Err(_)) | None => { break; }
                            }
                        }
                        let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                    });
                }
            }
            // ── VS Code: Terminal Error Explainer ─────────────────────────────
            Some("terminal_error") => {
                let error_text   = val["errorText"].as_str().unwrap_or("").to_string();
                let current_file = val["currentFile"].as_str().unwrap_or("").to_string();
                let current_code = val["currentCode"].as_str().unwrap_or("").to_string();
                let language     = val["language"].as_str().unwrap_or("").to_string();
                let suggested_tokens = val["suggestedTokens"].as_u64().unwrap_or(800) as u32;

                let prompt = format!(
                    "<|im_start|>system\n\
You are a debugging expert integrated into VS Code via CodeForge.\n\
Diagnose the terminal error and give a clear, actionable fix.\n\
\n\
Step 1 — Identify error type:\n\
- MODULE NOT FOUND / Cannot find module / ModuleNotFoundError → dependency issue\n\
- SyntaxError / TypeError / ReferenceError / undefined is not a function → code bug\n\
- Permission denied / EACCES → permissions issue\n\
- Port already in use / EADDRINUSE → process conflict\n\
\n\
Step 2 — Respond based on type:\n\
\n\
For DEPENDENCY errors: explain which package is missing and give the exact install command (npm install X / pip install X). Do NOT output a FIX block.\n\
\n\
For CODE bugs: explain the cause in 2-3 sentences, then output:\n\
<FIX>\n\
[{{\"file\":\"FILENAME\",\"description\":\"WHAT IS FIXED\",\"oldCode\":\"EXACT ORIGINAL CODE\",\"newCode\":\"FIXED CODE\"}}]\n\
</FIX>\n\
\n\
For PERMISSION / PORT errors: explain the cause and the exact terminal command to resolve it. No FIX block needed.\n\
\n\
Rules for FIX block:\n\
- oldCode: exact verbatim lines from the file — same spacing, same quotes\n\
- newCode: minimal corrected replacement\n\
- Use single quotes inside JSON strings to avoid breaking JSON\n\
- If no code change needed, write <FIX>[]</FIX>\
<|im_end|>\n\
<|im_start|>user\n\
TERMINAL ERROR:\n\
{error_text}\n\
\n\
CURRENT FILE: {current_file}\n\
```{language}\n\
{current_code}\n\
```\
<|im_end|>\n\
<|im_start|>assistant\n"
                );
                let tx_opt = {
                    let lock = clients.lock().await;
                    lock.get(&id).map(|c| c.tx.clone())
                };
                if let Some(tx) = tx_opt {
                    let port = SERVER_PORT;
                    let n_predict = suggested_tokens.max(300).min(1000);
                    tauri::async_runtime::spawn(async move {
                        use futures_util::StreamExt;
                        let client = reqwest::Client::new();
                        let body = serde_json::json!({
                            "prompt": prompt, "n_predict": n_predict,
                            "temperature": 0.3, "stream": true,
                            "repeat_penalty": 1.1, "stop": ["<|im_end|>"]
                        });
                        let res = match client.post(format!("http://127.0.0.1:{port}/completion")).json(&body).send().await {
                            Ok(r) => r,
                            Err(e) => {
                                let _ = tx.send(serde_json::json!({"type":"error","message":e.to_string()}).to_string());
                                return;
                            }
                        };
                        let mut stream = res.bytes_stream();
                        let mut buf = String::new();
                        'stream: loop {
                            match stream.next().await {
                                Some(Ok(chunk)) => {
                                    buf.push_str(&String::from_utf8_lossy(&chunk));
                                    while let Some(pos) = buf.find('\n') {
                                        let line = buf[..pos].trim().to_string();
                                        buf = buf[pos+1..].to_string();
                                        if line.starts_with("data: ") {
                                            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&line["data: ".len()..]) {
                                                if let Some(tok) = j["content"].as_str() {
                                                    if !tok.is_empty() {
                                                        let _ = tx.send(serde_json::json!({"type":"token","content":tok}).to_string());
                                                    }
                                                }
                                                if j["stop"].as_bool().unwrap_or(false) {
                                                    let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                                                    break 'stream;
                                                }
                                            }
                                        }
                                    }
                                }
                                Some(Err(_)) | None => { break; }
                            }
                        }
                        let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                    });
                }
            }
            // ── Excel: Generate VBA Macro ─────────────────────────────────────
            Some("macro_query") => {
                let idea    = val["idea"].as_str().unwrap_or("").to_string();
                let history = val["history"].as_array().cloned().unwrap_or_default();
                let suggested_tokens = val["suggestedTokens"].as_u64().unwrap_or(1000) as u32;

                // Build conversation history block for multi-turn refinement
                let mut history_block = String::new();
                for turn in &history {
                    let role    = turn["role"].as_str().unwrap_or("user");
                    let content = turn["content"].as_str().unwrap_or("");
                    let tag     = if role == "assistant" { "assistant" } else { "user" };
                    history_block.push_str(&format!("<|im_start|>{tag}\n{content}<|im_end|>\n"));
                }

                let prompt = format!(
                    "<|im_start|>system\n\
You are an Excel VBA macro expert integrated into Microsoft Excel via CodeForge.\n\
\n\
When given a macro idea, follow this exact two-step process:\n\
\n\
STEP 1 — ANALYZE: Think about what the user wants. Identify any missing details that would \
affect how the macro works (e.g. which range, what threshold, what condition, whether to \
overwrite existing data, whether to run on selection or whole sheet, etc.)\n\
\n\
STEP 2 — DECIDE:\n\
- If 1 or more important details are MISSING or AMBIGUOUS: Do NOT write code yet. \
Start your reply with \"Before I build this macro, I need to clarify:\" then list \
2-3 specific numbered questions.\n\
- If the idea is CLEAR AND COMPLETE (or this is a follow-up with answers): Generate \
the full VBA macro immediately. Start with one sentence describing what the macro does, \
then write the complete Sub...End Sub block.\n\
\n\
VBA code rules:\n\
- Always add comments above each logical section\n\
- Use On Error GoTo ErrHandler with a proper error label\n\
- Use meaningful variable names (not x, y, i unless for loops)\n\
- Default to working on Selection unless user specifies otherwise\n\
- End with a MsgBox telling the user the macro completed\n\
- Never use .Select or .Activate — work directly with range objects\n\
- HIGHLIGHTING: to color a cell background use cell.Interior.Color = RGB(r,g,b) NEVER write text like \"Yellow\" into cells\n\
- CLEARING color: use cell.Interior.ColorIndex = xlNone\n\
- Common colors: Yellow=RGB(255,255,0), Green=RGB(0,255,0), Red=RGB(255,0,0), Orange=RGB(255,165,0), Blue=RGB(0,112,192)\n\
- CONDITIONAL FORMATTING via VBA: use cell.Interior.Color, not .FormatConditions, unless user specifically asks for Excel conditional formatting rules\n\
- Loop over ranges with: For Each cell In rng ... Next cell\
<|im_end|>\n\
{history_block}\
<|im_start|>user\n\
{idea}\
<|im_end|>\n\
<|im_start|>assistant\n"
                );

                let tx_opt = { let lock = clients.lock().await; lock.get(&id).map(|c| c.tx.clone()) };
                if let Some(tx) = tx_opt {
                    let port = SERVER_PORT;
                    let n_predict = suggested_tokens.max(400).min(1200);
                    tauri::async_runtime::spawn(async move {
                        use futures_util::StreamExt;
                        let client = reqwest::Client::new();
                        let body = serde_json::json!({"prompt":prompt,"n_predict":n_predict,"temperature":0.2,"stream":true,"repeat_penalty":1.1,"stop":["<|im_end|>"]});
                        let res = match client.post(format!("http://127.0.0.1:{port}/completion")).json(&body).send().await {
                            Ok(r) => r,
                            Err(e) => { let _ = tx.send(serde_json::json!({"type":"error","message":e.to_string()}).to_string()); return; }
                        };
                        let mut stream = res.bytes_stream(); let mut buf = String::new();
                        'stream: loop {
                            match stream.next().await {
                                Some(Ok(chunk)) => {
                                    buf.push_str(&String::from_utf8_lossy(&chunk));
                                    while let Some(pos) = buf.find('\n') {
                                        let line = buf[..pos].trim().to_string(); buf = buf[pos+1..].to_string();
                                        if line.starts_with("data: ") {
                                            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&line["data: ".len()..]) {
                                                if let Some(tok) = j["content"].as_str() { if !tok.is_empty() { let _ = tx.send(serde_json::json!({"type":"token","content":tok}).to_string()); } }
                                                if j["stop"].as_bool().unwrap_or(false) { let _ = tx.send(serde_json::json!({"type":"done"}).to_string()); break 'stream; }
                                            }
                                        }
                                    }
                                }
                                Some(Err(_)) | None => { break; }
                            }
                        }
                        let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                    });
                }
            }
            // ── Word: Ask about document ──────────────────────────────────────
            Some("word_query") => {
                let question       = val["question"].as_str().unwrap_or("").to_string();
                let doc_text       = val["docText"].as_str().unwrap_or("").to_string();
                let context_label  = val["contextLabel"].as_str().unwrap_or("Document").to_string();
                let suggested_tokens = val["suggestedTokens"].as_u64().unwrap_or(600) as u32;

                let prompt = format!(
                    "<|im_start|>system\n\
You are an expert writing assistant and grammar checker integrated into Microsoft Word via CodeForge.\n\
\n\
When answering questions about the document:\n\
- Be accurate and critical — never say text is correct if it has errors\n\
- For grammar/spelling checks: list EVERY error found with the correction. If no errors exist, say \"No errors found.\"\n\
- For grammar errors look for: subject-verb agreement, missing articles (a/an/the), wrong tense, capitalization, missing plurals, wrong prepositions\n\
- For summarize/explain tasks: be concise and structured\n\
- For rewrite/improve tasks: fix all grammar and make it professional\n\
- Never skip errors to be polite — the user needs accurate feedback\
<|im_end|>\n\
<|im_start|>user\n\
{context_label}:\n{doc_text}\n\nQUESTION: {question}\
<|im_end|>\n\
<|im_start|>assistant\n"
                );
                let tx_opt = { let lock = clients.lock().await; lock.get(&id).map(|c| c.tx.clone()) };
                if let Some(tx) = tx_opt {
                    let port = SERVER_PORT;
                    let n_predict = suggested_tokens.max(400).min(2000);
                    tauri::async_runtime::spawn(async move {
                        use futures_util::StreamExt;
                        let client = reqwest::Client::new();
                        let body = serde_json::json!({"prompt":prompt,"n_predict":n_predict,"temperature":0.2,"stream":true,"repeat_penalty":1.1,"stop":["<|im_end|>","<|im_start|>"]});
                        let res = match client.post(format!("http://127.0.0.1:{port}/completion")).json(&body).send().await {
                            Ok(r) => r,
                            Err(e) => { let _ = tx.send(serde_json::json!({"type":"error","message":e.to_string()}).to_string()); return; }
                        };
                        let mut stream = res.bytes_stream(); let mut buf = String::new();
                        'stream: loop {
                            match stream.next().await {
                                Some(Ok(chunk)) => {
                                    buf.push_str(&String::from_utf8_lossy(&chunk));
                                    while let Some(pos) = buf.find('\n') {
                                        let line = buf[..pos].trim().to_string(); buf = buf[pos+1..].to_string();
                                        if line.starts_with("data: ") {
                                            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&line["data: ".len()..]) {
                                                if let Some(tok) = j["content"].as_str() { if !tok.is_empty() { let _ = tx.send(serde_json::json!({"type":"token","content":tok}).to_string()); } }
                                                if j["stop"].as_bool().unwrap_or(false) { let _ = tx.send(serde_json::json!({"type":"done"}).to_string()); break 'stream; }
                                            }
                                        }
                                    }
                                }
                                Some(Err(_)) | None => { break; }
                            }
                        }
                        let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                    });
                }
            }
            // ── Word: Rewrite selected text ───────────────────────────────────
            Some("word_rewrite") => {
                let instruction    = val["instruction"].as_str().unwrap_or("").to_string();
                let selected_text  = val["selectedText"].as_str().unwrap_or("").to_string();
                let suggested_tokens = val["suggestedTokens"].as_u64().unwrap_or(800) as u32;

                let prompt = format!(
                    "<|im_start|>system\n\
You are a writing assistant integrated into Microsoft Word via CodeForge.\n\
Rules:\n\
- Rewrite the provided text according to the instruction\n\
- Return ONLY the rewritten text, no explanations or commentary\n\
- Preserve the meaning and key points unless instructed otherwise\
<|im_end|>\n\
<|im_start|>user\n\
ORIGINAL TEXT:\n{selected_text}\n\nINSTRUCTION: {instruction}\
<|im_end|>\n\
<|im_start|>assistant\n"
                );
                let tx_opt = { let lock = clients.lock().await; lock.get(&id).map(|c| c.tx.clone()) };
                if let Some(tx) = tx_opt {
                    let port = SERVER_PORT;
                    let n_predict = suggested_tokens.max(200).min(1500);
                    tauri::async_runtime::spawn(async move {
                        use futures_util::StreamExt;
                        let client = reqwest::Client::new();
                        let body = serde_json::json!({"prompt":prompt,"n_predict":n_predict,"temperature":0.4,"stream":true,"repeat_penalty":1.1,"stop":["<|im_end|>","<|im_start|>"]});
                        let res = match client.post(format!("http://127.0.0.1:{port}/completion")).json(&body).send().await {
                            Ok(r) => r,
                            Err(e) => { let _ = tx.send(serde_json::json!({"type":"error","message":e.to_string()}).to_string()); return; }
                        };
                        let mut stream = res.bytes_stream(); let mut buf = String::new();
                        'stream: loop {
                            match stream.next().await {
                                Some(Ok(chunk)) => {
                                    buf.push_str(&String::from_utf8_lossy(&chunk));
                                    while let Some(pos) = buf.find('\n') {
                                        let line = buf[..pos].trim().to_string(); buf = buf[pos+1..].to_string();
                                        if line.starts_with("data: ") {
                                            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&line["data: ".len()..]) {
                                                if let Some(tok) = j["content"].as_str() { if !tok.is_empty() { let _ = tx.send(serde_json::json!({"type":"token","content":tok}).to_string()); } }
                                                if j["stop"].as_bool().unwrap_or(false) { let _ = tx.send(serde_json::json!({"type":"done"}).to_string()); break 'stream; }
                                            }
                                        }
                                    }
                                }
                                Some(Err(_)) | None => { break; }
                            }
                        }
                        let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                    });
                }
            }
            // ── PowerPoint: Ask about slide ───────────────────────────────────
            Some("ppt_query") => {
                let question     = val["question"].as_str().unwrap_or("").to_string();
                let slide_text   = val["slideText"].as_str().unwrap_or("").to_string();
                let slide_index  = val["slideIndex"].as_u64().unwrap_or(1);
                let suggested_tokens = val["suggestedTokens"].as_u64().unwrap_or(600) as u32;

                let prompt = format!(
                    "<|im_start|>system\n\
You are an expert presentation analyst integrated into Microsoft PowerPoint via CodeForge.\n\
Rules:\n\
- Be accurate and critical — never say content is fine if it has issues\n\
- For consistency checks: compare all numbers/data points and flag any contradictions\n\
- For improvement suggestions: give specific, actionable changes\n\
- For content questions: answer only from what is in the slide — do not invent data\n\
- For grammar/clarity: list every issue found — do not skip errors to be polite\n\
- Keep answers structured with clear points\
<|im_end|>\n\
<|im_start|>user\n\
SLIDE {slide_index} CONTENT:\n{slide_text}\n\nQUESTION: {question}\
<|im_end|>\n\
<|im_start|>assistant\n"
                );
                let tx_opt = { let lock = clients.lock().await; lock.get(&id).map(|c| c.tx.clone()) };
                if let Some(tx) = tx_opt {
                    let port = SERVER_PORT;
                    let n_predict = suggested_tokens.max(200).min(1500);
                    tauri::async_runtime::spawn(async move {
                        use futures_util::StreamExt;
                        let client = reqwest::Client::new();
                        let body = serde_json::json!({"prompt":prompt,"n_predict":n_predict,"temperature":0.4,"stream":true,"repeat_penalty":1.1,"stop":["<|im_end|>","<|im_start|>"]});
                        let res = match client.post(format!("http://127.0.0.1:{port}/completion")).json(&body).send().await {
                            Ok(r) => r,
                            Err(e) => { let _ = tx.send(serde_json::json!({"type":"error","message":e.to_string()}).to_string()); return; }
                        };
                        let mut stream = res.bytes_stream(); let mut buf = String::new();
                        'stream: loop {
                            match stream.next().await {
                                Some(Ok(chunk)) => {
                                    buf.push_str(&String::from_utf8_lossy(&chunk));
                                    while let Some(pos) = buf.find('\n') {
                                        let line = buf[..pos].trim().to_string(); buf = buf[pos+1..].to_string();
                                        if line.starts_with("data: ") {
                                            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&line["data: ".len()..]) {
                                                if let Some(tok) = j["content"].as_str() { if !tok.is_empty() { let _ = tx.send(serde_json::json!({"type":"token","content":tok}).to_string()); } }
                                                if j["stop"].as_bool().unwrap_or(false) { let _ = tx.send(serde_json::json!({"type":"done"}).to_string()); break 'stream; }
                                            }
                                        }
                                    }
                                }
                                Some(Err(_)) | None => { break; }
                            }
                        }
                        let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                    });
                }
            }
            // ── PowerPoint: Write slide content (paragraphs / bullets) ──────────
            Some("ppt_write") => {
                let request      = val["request"].as_str().unwrap_or("").to_string();
                let suggested_tokens = val["suggestedTokens"].as_u64().unwrap_or(600) as u32;

                let prompt = format!(
                    "<|im_start|>system\n\
You are a professional presentation content writer integrated into Microsoft PowerPoint via CodeForge.\n\
Write exactly what the user requests — paragraph, bullet points, intro, conclusion, or list.\n\
\n\
Rules:\n\
- Write ONLY the requested content — no explanations, no \"Here is your content:\", no commentary\n\
- If the user asks for bullet points: start each with • and keep each to one clear line\n\
- If the user asks for a paragraph: write flowing, professional prose\n\
- If the user asks for a list: number each item clearly\n\
- Match the tone to the topic (professional for business, simple for general topics)\n\
- Do NOT use markdown formatting (no **, no ##, no ```)\n\
- Stop after the content is complete — no closing remarks\
<|im_end|>\n\
<|im_start|>user\n\
{request}\
<|im_end|>\n\
<|im_start|>assistant\n"
                );
                let tx_opt = { let lock = clients.lock().await; lock.get(&id).map(|c| c.tx.clone()) };
                if let Some(tx) = tx_opt {
                    let port = SERVER_PORT;
                    let n_predict = suggested_tokens.max(200).min(800);
                    tauri::async_runtime::spawn(async move {
                        use futures_util::StreamExt;
                        let client = reqwest::Client::new();
                        let body = serde_json::json!({"prompt":prompt,"n_predict":n_predict,"temperature":0.5,"stream":true,"repeat_penalty":1.1,"stop":["<|im_end|>","<|im_start|>"]});
                        let res = match client.post(format!("http://127.0.0.1:{port}/completion")).json(&body).send().await {
                            Ok(r) => r,
                            Err(e) => { let _ = tx.send(serde_json::json!({"type":"error","message":e.to_string()}).to_string()); return; }
                        };
                        let mut stream = res.bytes_stream(); let mut buf = String::new();
                        'stream: loop {
                            match stream.next().await {
                                Some(Ok(chunk)) => {
                                    buf.push_str(&String::from_utf8_lossy(&chunk));
                                    while let Some(pos) = buf.find('\n') {
                                        let line = buf[..pos].trim().to_string(); buf = buf[pos+1..].to_string();
                                        if line.starts_with("data: ") {
                                            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&line["data: ".len()..]) {
                                                if let Some(tok) = j["content"].as_str() { if !tok.is_empty() { let _ = tx.send(serde_json::json!({"type":"token","content":tok}).to_string()); } }
                                                if j["stop"].as_bool().unwrap_or(false) { let _ = tx.send(serde_json::json!({"type":"done"}).to_string()); break 'stream; }
                                            }
                                        }
                                    }
                                }
                                Some(Err(_)) | None => { break; }
                            }
                        }
                        let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                    });
                }
            }
            // ── PowerPoint: VBA macro for transition / animation / background ──
            Some("ppt_macro") => {
                let request    = val["request"].as_str().unwrap_or("").to_string();
                let macro_mode = val["macroMode"].as_str().unwrap_or("transition").to_string();
                let suggested_tokens = val["suggestedTokens"].as_u64().unwrap_or(800) as u32;

                let context_rule = match macro_mode.as_str() {
                    "transition" => "\
Generate a PowerPoint VBA macro that applies slide TRANSITIONS.\n\
\n\
TRANSITION REFERENCE:\n\
EntryEffect constants: ppEffectFade, ppEffectWipe, ppEffectDissolve, ppEffectPush,\n\
  ppEffectReveal, ppEffectZoom, ppEffectCover, ppEffectUncover, ppEffectCut, ppEffectRandom.\n\
Speed: ppTransitionSpeedSlow, ppTransitionSpeedMedium, ppTransitionSpeedFast\n\
AdvanceOnTime (auto-advance): .AdvanceOnTime = True / .AdvanceTime = 3 (seconds)\n\
\n\
APPLY TO ALL SLIDES:\n\
  Dim sld As Slide\n\
  For Each sld In ActivePresentation.Slides\n\
      sld.SlideShowTransition.EntryEffect = ppEffectFade\n\
      sld.SlideShowTransition.Speed = ppTransitionSpeedMedium\n\
  Next sld\n\
\n\
APPLY TO CURRENT SLIDE ONLY:\n\
  Dim sld As Slide\n\
  Set sld = ActivePresentation.Slides(ActiveWindow.View.Slide.SlideIndex)\n\
  sld.SlideShowTransition.EntryEffect = ppEffectFade\n\
  sld.SlideShowTransition.Speed = ppTransitionSpeedMedium",
                    "animation" => "\
Generate a PowerPoint VBA macro that applies shape ANIMATIONS using the TimeLine API.\n\
\n\
CRITICAL — CORRECT AddEffect SIGNATURE:\n\
  Dim eff As Effect\n\
  Set eff = sld.TimeLine.MainSequence.AddEffect( _\n\
      Shape:=shp, _\n\
      effectId:=msoAnimEffectFly, _\n\
      trigger:=msoAnimTriggerOnPageClick)\n\
\n\
SET DIRECTION (after AddEffect — this is required for Fly/Wipe/etc.):\n\
  eff.EffectParameters.Direction = msoAnimDirectionLeft\n\
Direction constants: msoAnimDirectionLeft, msoAnimDirectionRight, msoAnimDirectionTop,\n\
  msoAnimDirectionBottom, msoAnimDirectionTopLeft, msoAnimDirectionTopRight,\n\
  msoAnimDirectionBottomLeft, msoAnimDirectionBottomRight\n\
\n\
SET TIMING:\n\
  eff.Timing.Duration = 1.0            ' seconds\n\
  eff.Timing.TriggerType = msoAnimTriggerOnPageClick\n\
  ' or: msoAnimTriggerAfterPrevious, msoAnimTriggerWithPrevious\n\
  eff.Timing.TriggerDelayTime = 0.5    ' delay after trigger\n\
\n\
EFFECT CONSTANTS:\n\
  msoAnimEffectAppear, msoAnimEffectFade, msoAnimEffectFly, msoAnimEffectZoom,\n\
  msoAnimEffectSpin, msoAnimEffectWipe, msoAnimEffectBlinds, msoAnimEffectBox,\n\
  msoAnimEffectCheckerboard, msoAnimEffectPeek, msoAnimEffectStretch, msoAnimEffectSwivel\n\
\n\
LOOP OVER SHAPES:\n\
  Dim sld As Slide\n\
  Dim shp As Shape\n\
  Dim eff As Effect\n\
  ' Clear existing animations first:\n\
  sld.TimeLine.MainSequence.Clear\n\
  For Each shp In sld.Shapes\n\
      Set eff = sld.TimeLine.MainSequence.AddEffect( _\n\
          Shape:=shp, effectId:=msoAnimEffectFly, _\n\
          trigger:=msoAnimTriggerAfterPrevious)\n\
      eff.EffectParameters.Direction = msoAnimDirectionLeft\n\
      eff.Timing.Duration = 0.8\n\
  Next shp\n\
\n\
TARGET SPECIFIC SHAPES:\n\
  ' Title shape (type 13 = msoPlaceholder title):\n\
  If shp.PlaceholderFormat.Type = ppPlaceholderTitle Then ...\n\
  ' By name: If shp.Name = \"Title 1\" Then ...\n\
  ' By type: If shp.Type = msoTextBox Then ...\n\
\n\
APPLY TO ALL SLIDES vs CURRENT SLIDE:\n\
  ' All slides: For Each sld In ActivePresentation.Slides ... Next sld\n\
  ' Current only: Set sld = ActivePresentation.Slides(ActiveWindow.View.Slide.SlideIndex)",
                    _ => "\
Generate a PowerPoint VBA macro that changes slide BACKGROUND.\n\
\n\
SOLID COLOR BACKGROUND:\n\
  sld.Background.Fill.Solid\n\
  sld.Background.Fill.ForeColor.RGB = RGB(13, 27, 42)   ' dark navy\n\
\n\
TWO-COLOR GRADIENT:\n\
  sld.Background.Fill.TwoColorGradient msoGradientHorizontal, 1\n\
  sld.Background.Fill.ForeColor.RGB = RGB(13, 27, 42)\n\
  sld.Background.Fill.BackColor.RGB = RGB(30, 60, 90)\n\
\n\
PRESET GRADIENT:\n\
  sld.Background.Fill.PresetGradient msoGradientHorizontal, 1, msoGradientDaybreak\n\
\n\
APPLY TO ALL SLIDES:\n\
  For Each sld In ActivePresentation.Slides\n\
      sld.Background.Fill.Solid\n\
      sld.Background.Fill.ForeColor.RGB = RGB(13, 27, 42)\n\
      sld.FollowMasterBackground = msoFalse\n\
  Next sld\n\
\n\
APPLY TO CURRENT SLIDE ONLY:\n\
  Dim sld As Slide\n\
  Set sld = ActivePresentation.Slides(ActiveWindow.View.Slide.SlideIndex)\n\
  sld.Background.Fill.Solid\n\
  sld.Background.Fill.ForeColor.RGB = RGB(13, 27, 42)\n\
  sld.FollowMasterBackground = msoFalse\n\
\n\
COMMON COLORS: dark navy=RGB(13,27,42), white=RGB(255,255,255),\n\
  light gray=RGB(240,240,240), charcoal=RGB(30,30,30),\n\
  dark blue=RGB(0,32,96), forest green=RGB(0,68,27), deep red=RGB(120,0,0)",
                };

                let prompt = format!(
                    "<|im_start|>system\n\
You are a PowerPoint VBA expert. Generate ONE complete, working VBA macro.\n\
\n\
{context_rule}\n\
\n\
OUTPUT RULES — FOLLOW EXACTLY:\n\
- Output ONE Sub...End Sub block only — nothing before Sub, nothing after End Sub\n\
- No explanations, no markdown, no ``` fences — raw VBA only\n\
- Start with: Sub MacroName()\n\
- Second line: On Error GoTo ErrHandler\n\
- Add a short comment above each logical section\n\
- Second-to-last line before End Sub: MsgBox \"Done!\"\n\
- Last section before End Sub:\n\
  ErrHandler:\n\
      If Err.Number <> 0 Then MsgBox \"Error: \" & Err.Description\n\
- End with: End Sub\n\
- STOP after End Sub — do not repeat or generate another Sub\
<|im_end|>\n\
<|im_start|>user\n\
{request}\
<|im_end|>\n\
<|im_start|>assistant\n\
Sub "
                );
                let tx_opt = { let lock = clients.lock().await; lock.get(&id).map(|c| c.tx.clone()) };
                if let Some(tx) = tx_opt {
                    let port = SERVER_PORT;
                    let n_predict = suggested_tokens.max(300).min(700);
                    tauri::async_runtime::spawn(async move {
                        use futures_util::StreamExt;
                        let client = reqwest::Client::new();
                        // Pre-fill "Sub " so response starts directly with the macro name.
                        // Stop tokens: End Sub / End Function prevent repetition after the macro ends.
                        let body = serde_json::json!({
                            "prompt": prompt,
                            "n_predict": n_predict,
                            "temperature": 0.15,
                            "stream": true,
                            "repeat_penalty": 1.15,
                            "stop": ["<|im_end|>", "<|im_start|>", "\nSub ", "\nEnd Sub\n\nSub "]
                        });
                        let res = match client.post(format!("http://127.0.0.1:{port}/completion")).json(&body).send().await {
                            Ok(r) => r,
                            Err(e) => { let _ = tx.send(serde_json::json!({"type":"error","message":e.to_string()}).to_string()); return; }
                        };
                        let mut stream = res.bytes_stream(); let mut buf = String::new();
                        'stream: loop {
                            match stream.next().await {
                                Some(Ok(chunk)) => {
                                    buf.push_str(&String::from_utf8_lossy(&chunk));
                                    while let Some(pos) = buf.find('\n') {
                                        let line = buf[..pos].trim().to_string(); buf = buf[pos+1..].to_string();
                                        if line.starts_with("data: ") {
                                            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&line["data: ".len()..]) {
                                                if let Some(tok) = j["content"].as_str() { if !tok.is_empty() { let _ = tx.send(serde_json::json!({"type":"token","content":tok}).to_string()); } }
                                                if j["stop"].as_bool().unwrap_or(false) { let _ = tx.send(serde_json::json!({"type":"done"}).to_string()); break 'stream; }
                                            }
                                        }
                                    }
                                }
                                Some(Err(_)) | None => { break; }
                            }
                        }
                        let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                    });
                }
            }
            // ── VS Code: hub_chat — explain / refactor / fix / comment ───────
            Some("hub_chat") => {
                let verb             = val["verb"].as_str().unwrap_or("Explain").to_string();
                let instruction      = val["instruction"].as_str().unwrap_or("").to_string();
                let code             = val["code"].as_str().unwrap_or("").to_string();
                let language         = val["language"].as_str().unwrap_or("code").to_string();
                let suggested_tokens = val["suggestedTokens"].as_u64().unwrap_or(800) as u32;

                // ── Per-verb prompt, token budget, and temperature ────────────
                // Temperature 0.1 for all code tasks — deterministic, no hallucination.
                // Token budgets are tight to prevent rambling / over-generation.
                // Build per-verb system prompt, user message, token limit, temperature.
                // All return (String, String, u32, f32) for consistent tuple type.
                let task_line = if !instruction.is_empty() {
                    format!("Task: {instruction}")
                } else {
                    "Task: Clean up formatting and remove only byte-for-byte duplicate lines".to_string()
                };

                let (system_instructions, user_instruction, n_predict, temperature): (String, String, u32, f32) =
                if verb.to_lowercase().contains("explain") {
                    (
                        "You are a code explainer. Explain what the selected code does.\n\
Rules:\n\
- Write a 1-sentence summary first\n\
- Then list key points using plain dashes (-)\n\
- Maximum 120 words total — be concise\n\
- Plain text only. No markdown asterisks (*), pound signs (#), backticks, or bold markers\n\
- Do NOT rewrite or modify the code — only explain it".to_string(),
                        format!("Explain this {language} code:\n{code}"),
                        280u32,
                        0.1f32,
                    )
                } else if verb.to_lowercase().contains("refactor") {
                    (
                        format!("You are a code refactoring expert. Apply ONLY the task described below.\n\
{task_line}\n\
\n\
STRICT Rules:\n\
- Output ONLY the modified code — no explanation, no preamble, no closing remarks\n\
- Apply ONLY what the Task says — do not make any other changes\n\
- KEEP every line that is not directly mentioned in the Task\n\
- Vendor-prefixed properties (-webkit-, -moz-, -ms-) are NOT duplicates of standard properties — keep them unless the Task explicitly says to remove them\n\
- Never remove variables, functions, imports, or logic that the Task does not mention\n\
- No markdown fences, no backtick blocks, no asterisks\n\
- Same language, same framework, same indentation as the input"),
                        format!("Apply the task to this {language} code:\n{code}"),
                        (code.len() / 3 + 200).min(1200) as u32,
                        0.1f32,
                    )
                } else if verb.to_lowercase().contains("fix") || verb.to_lowercase().contains("bug") {
                    (
                        "You are a bug-fixing expert.\n\
Rules:\n\
- Line 1: one plain-text sentence naming the bug (no markdown, no asterisks)\n\
- Then output the COMPLETE fixed code — every original line must be present\n\
- Make ONLY the minimal change to fix the bug — do not restructure unrelated code\n\
- If no bug found, say 'No bug found.' and output the original code unchanged\n\
- No markdown fences, no ``` blocks, no asterisks, no extra explanation".to_string(),
                        format!("Find and fix bugs in this {language} code:\n{code}"),
                        (code.len() / 3 + 250).min(1200) as u32,
                        0.1f32,
                    )
                } else if verb.to_lowercase().contains("comment") {
                    (
                        "You are a code documentation expert.\n\
Rules:\n\
- Output the COMPLETE code with comments added — every original line must be present\n\
- Add a JSDoc/docstring above each function (params + return)\n\
- Add short inline comments only on non-obvious lines\n\
- NEVER remove, rename, or restructure any code — only add comment lines\n\
- Use native comment syntax only: // for JS/TS/C/Java, # for Python/Ruby, -- for SQL\n\
- No markdown fences, no ``` blocks, no asterisks, no preamble text before the code".to_string(),
                        format!("Add comments to this {language} code:\n{code}"),
                        (code.len() / 3 + 400).min(1400) as u32,
                        0.1f32,
                    )
                } else {
                    (
                        "You are a code assistant in VS Code via CodeForge. Be concise and accurate.\n\
- Plain text only. No asterisks, pound signs, or backtick fences. Max 150 words.".to_string(),
                        format!("{verb}:\n{code}"),
                        300u32,
                        0.1f32,
                    )
                };

                let prompt = format!(
                    "<|im_start|>system\n\
{system_instructions}\n\
<|im_end|>\n\
<|im_start|>user\n\
{user_instruction}\n\
<|im_end|>\n\
<|im_start|>assistant\n"
                );

                let tx_opt = { let lock = clients.lock().await; lock.get(&id).map(|c| c.tx.clone()) };
                if let Some(tx) = tx_opt {
                    let port = SERVER_PORT;
                    // n_predict is now computed per-verb above; clamp to sane range
                    let n_predict = n_predict.max(150).min(1400);
                    let _ = suggested_tokens; // consumed above per-verb
                    tauri::async_runtime::spawn(async move {
                        use futures_util::StreamExt;
                        let client = reqwest::Client::new();
                        let body = serde_json::json!({
                            "prompt":         prompt,
                            "n_predict":      n_predict,
                            "temperature":    temperature,
                            "stream":         true,
                            "repeat_penalty": 1.15,
                            "stop":           ["<|im_end|>"]
                        });
                        let res = match client.post(format!("http://127.0.0.1:{port}/completion")).json(&body).send().await {
                            Ok(r) => r,
                            Err(e) => { let _ = tx.send(serde_json::json!({"type":"error","message":e.to_string()}).to_string()); return; }
                        };
                        let mut stream = res.bytes_stream(); let mut buf = String::new();
                        'stream: loop {
                            match stream.next().await {
                                Some(Ok(chunk)) => {
                                    buf.push_str(&String::from_utf8_lossy(&chunk));
                                    while let Some(pos) = buf.find('\n') {
                                        let line = buf[..pos].trim().to_string(); buf = buf[pos+1..].to_string();
                                        if line.starts_with("data: ") {
                                            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&line["data: ".len()..]) {
                                                if let Some(tok) = j["content"].as_str() { if !tok.is_empty() { let _ = tx.send(serde_json::json!({"type":"token","content":tok}).to_string()); } }
                                                if j["stop"].as_bool().unwrap_or(false) { let _ = tx.send(serde_json::json!({"type":"done"}).to_string()); break 'stream; }
                                            }
                                        }
                                    }
                                }
                                Some(Err(_)) | None => { break; }
                            }
                        }
                        let _ = tx.send(serde_json::json!({"type":"done"}).to_string());
                    });
                }
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

// ── Security Shield commands ──────────────────────────────────────────────────

#[tauri::command]
fn shield_protect(
    _app: AppHandle,
    state: tauri::State<'_, ShieldState>,
    path: String,
    file_type: String,
) -> Result<serde_json::Value, String> {
    use std::time::UNIX_EPOCH;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let mtime = meta.modified().ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs()).unwrap_or(0);
    let atime = meta.accessed().ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs()).unwrap_or(0);
    let size = meta.len();
    let file_name = std::path::Path::new(&path)
        .file_name().unwrap_or_default().to_string_lossy().to_string();

    // Generate decoy
    let decoy_path = generate_decoy_file(&path, &file_type).ok();

    let entry = ShieldEntry {
        path: path.clone(),
        file_name,
        file_type,
        decoy_path: decoy_path.clone(),
        baseline_mtime: mtime,
        baseline_size: size,
        baseline_atime: atime,
    };
    state.entries.lock().unwrap().insert(path.clone(), entry);
    Ok(serde_json::json!({ "protected": true, "decoyPath": decoy_path }))
}

#[tauri::command]
fn shield_unprotect(state: tauri::State<'_, ShieldState>, path: String) -> Result<(), String> {
    state.entries.lock().unwrap().remove(&path);
    Ok(())
}

#[tauri::command]
fn shield_get_log(state: tauri::State<'_, ShieldState>) -> Vec<ShieldLogEntry> {
    state.log.lock().unwrap().clone()
}

#[tauri::command]
fn shield_get_protected(state: tauri::State<'_, ShieldState>) -> Vec<ShieldEntry> {
    state.entries.lock().unwrap().values().cloned().collect()
}

// ── shield_check_files: called every 3 s from JS to detect tampering ─────────
// Compares current mtime / atime / size against the baseline captured at
// protect-time.  Emits "shield-alert" for every changed file and updates the
// baseline so we don't repeat the same alert.
#[tauri::command]
fn shield_check_files(
    app: AppHandle,
    state: tauri::State<'_, ShieldState>,
) -> Vec<ShieldLogEntry> {
    let mut fired: Vec<ShieldLogEntry> = Vec::new();

    // Collect snapshot so we hold the lock as briefly as possible
    let paths: Vec<String> = {
        state.entries.lock().unwrap().keys().cloned().collect()
    };

    for path in paths {
        let (baseline_mtime, baseline_size, baseline_atime, file_name) = {
            let lock = state.entries.lock().unwrap();
            let e = match lock.get(&path) { Some(v) => v, None => continue };
            (e.baseline_mtime, e.baseline_size, e.baseline_atime, e.file_name.clone())
        };

        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => {
                // File gone — alert
                let entry = make_log_entry(&state, &path, &file_name, "deleted");
                let _ = app.emit("shield-alert", &entry);
                push_log(&state, entry.clone());
                fired.push(entry);
                // Remove so we don't keep alerting
                state.entries.lock().unwrap().remove(&path);
                continue;
            }
        };

        let cur_mtime = meta.modified().ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs()).unwrap_or(0);
        let cur_size  = meta.len();
        let cur_atime = meta.accessed().ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs()).unwrap_or(0);

        let modified = cur_mtime != baseline_mtime || cur_size != baseline_size;
        let accessed = !modified && cur_atime > baseline_atime + 2; // >2 s grace

        if modified || accessed {
            let event = if modified { "modified" } else { "accessed" };
            let entry = make_log_entry(&state, &path, &file_name, event);
            let _ = app.emit("shield-alert", &entry);
            push_log(&state, entry.clone());
            fired.push(entry);

            // Update baseline so we don't re-fire for the same change
            let mut lock = state.entries.lock().unwrap();
            if let Some(e) = lock.get_mut(&path) {
                e.baseline_mtime  = cur_mtime;
                e.baseline_size   = cur_size;
                e.baseline_atime  = cur_atime;
            }
        }
    }

    fired
}

fn make_log_entry(state: &tauri::State<'_, ShieldState>, path: &str, file_name: &str, event: &str) -> ShieldLogEntry {
    let id = state.counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // Simple UTC HH:MM:SS (good enough for alerts)
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default().as_secs();
    let h = (secs % 86400) / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    ShieldLogEntry {
        id,
        timestamp: format!("{:02}:{:02}:{:02}", h, m, s),
        path: path.to_string(),
        file_name: file_name.to_string(),
        event: event.to_string(),
    }
}

fn push_log(state: &tauri::State<'_, ShieldState>, entry: ShieldLogEntry) {
    let mut log = state.log.lock().unwrap();
    log.insert(0, entry);
    if log.len() > 100 { log.pop(); }
}

fn generate_decoy_file(path: &str, file_type: &str) -> Result<String, String> {
    use rand::Rng;
    let stem = std::path::Path::new(path)
        .file_stem().unwrap_or_default().to_string_lossy().to_string();
    let parent = std::path::Path::new(path)
        .parent().unwrap_or(std::path::Path::new("."));

    if file_type == "excel" {
        use calamine::{open_workbook_auto, Reader, Data};
        use rust_xlsxwriter::Workbook;
        let mut rng = rand::thread_rng();
        let mut wb: calamine::Sheets<_> = open_workbook_auto(path).map_err(|e| e.to_string())?;
        let sheet_names: Vec<String> = wb.sheet_names().to_vec();
        let mut workbook = Workbook::new();
        for sheet_name in &sheet_names {
            if let Ok(range) = wb.worksheet_range(sheet_name) {
                let ws = workbook.add_worksheet();
                let _ = ws.set_name(sheet_name);
                for (row_idx, row) in range.rows().enumerate() {
                    for (col_idx, cell) in row.iter().enumerate() {
                        match cell {
                            Data::Float(f) => {
                                let factor: f64 = rng.gen_range(0.6..1.4);
                                let _ = ws.write(row_idx as u32, col_idx as u16, f * factor);
                            }
                            Data::Int(i) => {
                                let factor: f64 = rng.gen_range(0.6..1.4);
                                let _ = ws.write(row_idx as u32, col_idx as u16, (*i as f64 * factor) as i64);
                            }
                            Data::String(s) => {
                                let fake = if s.len() > 16 && s.chars().any(|c| c.is_alphanumeric()) && !s.contains(' ') {
                                    fake_credential(s)
                                } else {
                                    s.clone()
                                };
                                let _ = ws.write(row_idx as u32, col_idx as u16, fake.as_str());
                            }
                            Data::Bool(b) => { let _ = ws.write(row_idx as u32, col_idx as u16, *b); }
                            Data::Empty => {}
                            _ => {}
                        }
                    }
                }
            }
        }
        let decoy_path = parent.join(format!("{}_decoy.xlsx", stem));
        workbook.save(&decoy_path).map_err(|e| e.to_string())?;
        Ok(decoy_path.to_string_lossy().to_string())
    } else {
        let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        let decoy_text = obfuscate_code(&text, file_type);
        let ext = std::path::Path::new(path)
            .extension().unwrap_or_default().to_string_lossy().to_string();
        let decoy_path = parent.join(format!("{}_decoy.{}", stem, ext));
        std::fs::write(&decoy_path, decoy_text).map_err(|e| e.to_string())?;
        Ok(decoy_path.to_string_lossy().to_string())
    }
}

fn fake_credential(original: &str) -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let len = original.len().min(32);
    let chars: Vec<char> = "abcdefghijklmnopqrstuvwxyz0123456789".chars().collect();
    let prefix = if original.contains('-') {
        original.split('-').next().unwrap_or("").to_string() + "-fake-"
    } else {
        "decoy-".to_string()
    };
    let suffix: String = (0..len).map(|_| chars[rng.gen_range(0..chars.len())]).collect();
    format!("{}{}", prefix, &suffix[..suffix.len().min(24)])
}

fn obfuscate_code(text: &str, _file_type: &str) -> String {
    let patterns: &[(&str, &str)] = &[
        (r#"(api[_-]?key\s*[=:]\s*['"])[^'"]+(['"])"#, "${1}decoy-00000000-fake-key${2}"),
        (r#"(secret[_-]?key\s*[=:]\s*['"])[^'"]+(['"])"#, "${1}decoy-secret-00000000${2}"),
        (r#"(password\s*[=:]\s*['"])[^'"]+(['"])"#, "${1}decoy-password-123${2}"),
        (r#"(token\s*[=:]\s*['"])[^'"]+(['"])"#, "${1}decoy-token-00000000${2}"),
        (r"(sk-[A-Za-z0-9]{20,})", "sk-decoy00000000000000000000000000"),
        (r"(pk-[A-Za-z0-9]{20,})", "pk-decoy00000000000000000000000000"),
        (r#"(mongodb://)[^\s'"]+"#, "${1}localhost:27017/decoy_db"),
        (r#"(postgres://)[^\s'"]+"#, "${1}decoy:decoy@localhost/decoy_db"),
        (r#"(mysql://)[^\s'"]+"#, "${1}decoy:decoy@localhost/decoy_db"),
        (r"(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})", "192.168.0.1"),
    ];
    let mut result = text.to_string();
    for (pattern, replacement) in patterns {
        if let Ok(re) = regex::Regex::new(pattern) {
            result = re.replace_all(&result, *replacement).to_string();
        }
    }
    result = format!("# [DECOY FILE - Generated by Codeforge AI Security Shield]\n# Monitor ID: shield-{:x}\n\n{}",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(),
        result);
    result
}

// ── Entry point ───────────────────────────────────────────────────────────────

/// Fetch the latest version JSON from a URL (GitHub raw or any host).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(ServerState::new())
        .manage(HubState::new())
        .manage(ShieldState::default())
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
            // Start Excel add-in HTTP server on port 8089
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            tauri::async_runtime::spawn(async move {
                let listener = match tokio::net::TcpListener::bind("0.0.0.0:8089").await {
                    Ok(l) => l,
                    Err(e) => { eprintln!("[addin] Failed to bind port 8089: {e}"); return; }
                };
                eprintln!("[addin] Serving Excel add-in on http://0.0.0.0:8089");
                loop {
                    if let Ok((stream, _)) = listener.accept().await {
                        tokio::spawn(handle_addin_http(stream));
                    }
                }
            });
            // Start Word add-in HTTP server on port 8090
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            tauri::async_runtime::spawn(async move {
                let listener = match tokio::net::TcpListener::bind("0.0.0.0:8090").await {
                    Ok(l) => l,
                    Err(e) => { eprintln!("[word-addin] Failed to bind port 8090: {e}"); return; }
                };
                eprintln!("[word-addin] Serving Word add-in on http://0.0.0.0:8090");
                loop {
                    if let Ok((stream, _)) = listener.accept().await {
                        tokio::spawn(handle_word_addin_http(stream));
                    }
                }
            });
            // Start PowerPoint add-in HTTP server on port 8091
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            tauri::async_runtime::spawn(async move {
                let listener = match tokio::net::TcpListener::bind("0.0.0.0:8091").await {
                    Ok(l) => l,
                    Err(e) => { eprintln!("[ppt-addin] Failed to bind port 8091: {e}"); return; }
                };
                eprintln!("[ppt-addin] Serving PowerPoint add-in on http://0.0.0.0:8091");
                loop {
                    if let Ok((stream, _)) = listener.accept().await {
                        tokio::spawn(handle_ppt_addin_http(stream));
                    }
                }
            });

            // Spawn background security shield monitor
            {
                let shield_state = app.state::<ShieldState>();
                // We need to hold an Arc-like reference — use app handle to access state in the async task
                let app_clone = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                        let shield = app_clone.state::<ShieldState>();
                        let entries: Vec<ShieldEntry> = shield.entries.lock().unwrap().values().cloned().collect();
                        for entry in entries {
                            if let Ok(meta) = std::fs::metadata(&entry.path) {
                                use std::time::UNIX_EPOCH;
                                let mtime = meta.modified().ok()
                                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                                    .map(|d| d.as_secs()).unwrap_or(0);
                                let size = meta.len();
                                if mtime != entry.baseline_mtime || size != entry.baseline_size {
                                    {
                                        let mut entries_lock = shield.entries.lock().unwrap();
                                        if let Some(e) = entries_lock.get_mut(&entry.path) {
                                            e.baseline_mtime = mtime;
                                            e.baseline_size = size;
                                        }
                                    }
                                    let id = shield.counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                                    let ts = {
                                        let secs = std::time::SystemTime::now()
                                            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
                                        let h = (secs % 86400) / 3600;
                                        let m = (secs % 3600) / 60;
                                        let s = secs % 60;
                                        format!("{:02}:{:02}:{:02}", h, m, s)
                                    };
                                    let log_entry = ShieldLogEntry {
                                        id,
                                        timestamp: ts,
                                        path: entry.path.clone(),
                                        file_name: entry.file_name.clone(),
                                        event: "modified".to_string(),
                                    };
                                    shield.log.lock().unwrap().push(log_entry.clone());
                                    let _ = app_clone.emit("shield-alert", &log_entry);
                                }
                            } else {
                                let id = shield.counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                                let ts = {
                                    let secs = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
                                    format!("{:02}:{:02}:{:02}", (secs % 86400) / 3600, (secs % 3600) / 60, secs % 60)
                                };
                                let log_entry = ShieldLogEntry {
                                    id, timestamp: ts,
                                    path: entry.path.clone(),
                                    file_name: entry.file_name.clone(),
                                    event: "deleted".to_string(),
                                };
                                shield.log.lock().unwrap().push(log_entry.clone());
                                let _ = app_clone.emit("shield-alert", &log_entry);
                            }
                        }
                    }
                });
                drop(shield_state); // avoid unused variable warning
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_system_ram,
            get_free_disk_space,
            get_models_dir_path,
            list_model_files,
            download_file,
            cancel_download,
            delete_model,
            is_server_ready,
            setup_llama_server,
            reset_server,
            stop_generate,
            read_excel_sheets,
            list_directory,
            read_file_text,
            run_shell_command,
            take_screenshot,
            ocr_screen,
            get_screenshot_path,
            list_windows,
            capture_region,
            get_local_ip,
            db_save_conversation,
            db_get_conversations,
            db_delete_conversation,
            db_get_stats,
            load_model,
            unload_model,
            generate,
            hub_send,
            hub_get_clients,
            read_pdf,
            read_docx,
            pubmed_search,
            shield_protect,
            shield_unprotect,
            shield_get_log,
            shield_get_protected,
            shield_check_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
