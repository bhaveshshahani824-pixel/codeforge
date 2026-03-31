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
        .arg("--ctx-size").arg("8192")
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

// ── Excel Add-in HTTP server ──────────────────────────────────────────────────
// Serves the taskpane.html and taskpane.js files on http://localhost:8089
// so the Office add-in manifest can load them from Excel's task pane.

const ADDIN_HTML: &str = include_str!("../assets/excel-addin/taskpane.html");
const ADDIN_JS:   &str = include_str!("../assets/excel-addin/taskpane.js");

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn handle_addin_http(mut stream: tokio::net::TcpStream) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut buf = [0u8; 2048];
    let n = match stream.read(&mut buf).await { Ok(n) => n, Err(_) => return };
    let req = String::from_utf8_lossy(&buf[..n]);
    let first_line = req.lines().next().unwrap_or("");

    let (content_type, body): (&str, &str) = if first_line.contains("taskpane.js") {
        ("application/javascript", ADDIN_JS)
    } else {
        ("text/html; charset=utf-8", ADDIN_HTML)
    };

    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes()).await;
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
                let question     = val["question"].as_str().unwrap_or("").to_string();
                let data_str     = val["dataStr"].as_str().unwrap_or("").to_string();
                let computed_str = val["computedStr"].as_str().unwrap_or("").to_string();
                let has_computed = val["hasComputed"].as_bool().unwrap_or(false);

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
                        let body = serde_json::json!({
                            "prompt": prompt,
                            "n_predict": 2048,
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
        let app2 = app.clone();
        upd.download_and_install(
            |downloaded, total| {
                let pct = total.map(|t| (downloaded as u64) * 100 / t).unwrap_or(0);
                let _ = app2.emit("update-progress", pct);
            },
            || {},
        )
        .await
        .map_err(|e| format!("Install failed: {e}"))?;
        app.restart();
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
                let listener = match tokio::net::TcpListener::bind("127.0.0.1:8089").await {
                    Ok(l) => l,
                    Err(e) => { eprintln!("[addin] Failed to bind port 8089: {e}"); return; }
                };
                eprintln!("[addin] Serving Excel add-in on http://127.0.0.1:8089");
                loop {
                    if let Ok((stream, _)) = listener.accept().await {
                        tokio::spawn(handle_addin_http(stream));
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
            check_for_update,
            install_update,
            shield_protect,
            shield_unprotect,
            shield_get_log,
            shield_get_protected,
            shield_check_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
