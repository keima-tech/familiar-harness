// Familiar Harness desktop shell (Tauri).
//
// The shell bundles the Node.js runtime and the familiar server as resources,
// spawns `node familiar/packages/cli/dist/familiar.js serve` locally and renders the
// Web UI (served over 127.0.0.1) in the system webview. This is the Tauri
// counterpart of the Electron shell in packages/desktop: same "talk to a live
// familiar serve, or spawn one" strategy, but without bundling Chromium.
//
// A small `window.familiarDesktop` bridge is injected into every page (the same
// shape the Web UI expects from the Electron preload): open-with-OS,
// native folder picker, clipboard and notifications.
//
// See docs/spec/06-roadmap.md for the rationale and the current scope.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

mod e2e;

/// Ports the shell probes for an already-running `familiar serve` (mirrors the
/// Electron shell). `FAMILIAR_PORTS` overrides the list; `FAMILIAR_SPAWN_PORT`
/// overrides the port a fresh server is spawned on.
const DEFAULT_PORTS: [u16; 3] = [46210, 46211, 46212];

/// Injected into the webview on every load (including the navigation to the
/// local server). Defines the same `window.familiarDesktop` surface the Electron
/// preload exposes, so the Web UI keeps its native affordances. Only the
/// functions it can honour here are defined; anything else stays undefined and
/// the UI falls back to browser APIs / server RPCs.
const BRIDGE: &str = r#"(function () {
  function api() { return window.__TAURI__ || null; }
  function invoke(cmd, args) {
    var a = api();
    if (!a || !a.core || typeof a.core.invoke !== "function") {
      return Promise.reject(new Error("familiar: tauri IPC unavailable"));
    }
    return a.core.invoke(cmd, args);
  }
  window.familiarDesktop = {
    writeClipboard: function (text) { return invoke("write_clipboard", { text: String(text == null ? "" : text) }); },
    openPath: function (target) { return invoke("open_path", { path: String(target == null ? "" : target) }); },
    notify: function (payload) { return invoke("notify", { payload: payload || {} }); },
    pickDirectory: function () {
      var a = api();
      if (!a || !a.dialog || typeof a.dialog.open !== "function") return Promise.resolve("");
      return a.dialog.open({ directory: true, multiple: false }).then(function (res) {
        return typeof res === "string" ? res : "";
      });
    }
  };
  // Tauri's own global may be injected after this script runs — poll for it
  // before reporting readiness (which also proves IPC across the origin).
  var tries = 0;
  (function ping() {
    var a = api();
    if (a && a.core && typeof a.core.invoke === "function") {
      invoke("bridge_ready", { origin: location.origin }).catch(function () {});
      return;
    }
    if (++tries < 100) setTimeout(ping, 100);
  })();
})();"#;

/// Holds the child `familiar serve` process (if this shell spawned one) so it can
/// be terminated when the last window closes.
struct ServeState(Mutex<Option<Child>>);

fn env_ports() -> Vec<u16> {
    let raw = std::env::var("FAMILIAR_PORTS").unwrap_or_default();
    let list: Vec<u16> = raw
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    if list.is_empty() {
        DEFAULT_PORTS.to_vec()
    } else {
        list
    }
}

fn spawn_port(ports: &[u16]) -> u16 {
    std::env::var("FAMILIAR_SPAWN_PORT")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or_else(|| ports[0])
}

/// Ask `/healthz` for liveness + the path of the bearer-token file (the token
/// value itself is never exposed by the endpoint).
fn probe(port: u16) -> Option<String> {
    let url = format!("http://127.0.0.1:{port}/healthz");
    let resp = ureq::get(&url).timeout(Duration::from_millis(600)).call().ok()?;
    let v: serde_json::Value = resp.into_json().ok()?;
    if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
        return None;
    }
    Some(v.get("tokenFile").and_then(|x| x.as_str()).unwrap_or("").to_string())
}

fn read_token(token_file: &str) -> String {
    if token_file.is_empty() {
        return String::new();
    }
    std::fs::read_to_string(token_file)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// Locate (node binary, familiar.js). Bundled resources first, then a dev
/// fallback (a repo checkout) or explicit env overrides.
fn resolve_cli(app: &tauri::AppHandle) -> Option<(PathBuf, PathBuf)> {
    let env_node = std::env::var("FAMILIAR_SHELL_NODE").ok();
    let env_cli = std::env::var("FAMILIAR_SHELL_CLI").ok();
    if let (Some(n), Some(c)) = (&env_node, &env_cli) {
        return Some((PathBuf::from(n), PathBuf::from(c)));
    }
    if let Ok(dir) = app.path().resource_dir() {
        let node = if cfg!(windows) {
            dir.join("node").join("node.exe")
        } else {
            dir.join("node").join("node")
        };
        let cli = dir
            .join("familiar")
            .join("packages")
            .join("cli")
            .join("dist")
            .join("familiar.js");
        if node.exists() && cli.exists() {
            return Some((node, cli));
        }
    }
    // dev fallback: <repo>/packages/cli/dist/familiar.js (CARGO_MANIFEST_DIR is
    // <repo>/packages/desktop-tauri/src-tauri)
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    let cli = repo.join("packages").join("cli").join("dist").join("familiar.js");
    let node = env_node.map(PathBuf::from).unwrap_or_else(|| PathBuf::from("node"));
    Some((node, cli))
}

/// Probe the known ports, then spawn `familiar serve` on the spawn port. Returns
/// the base URL + port. Records the child for cleanup.
fn start_serve(app: &tauri::AppHandle) -> Option<(String, u16)> {
    let ports = env_ports();
    for port in &ports {
        if probe(*port).is_some() {
            return Some((format!("http://127.0.0.1:{port}"), *port));
        }
    }
    let (node, cli) = resolve_cli(app)?;
    // resources may lose the executable bit (Linux bundles) — restore it
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&node) {
            let mut perm = meta.permissions();
            perm.set_mode(0o755);
            let _ = std::fs::set_permissions(&node, perm);
        }
    }
    let port = spawn_port(&ports);
    let mut cmd = Command::new(&node);
    cmd.arg(&cli)
        .arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Linux: make the sidecar die with the shell (no orphan holding the port).
    #[cfg(target_os = "linux")]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[familiar] spawn failed ({node:?}): {e}");
            return None;
        }
    };
    eprintln!("[familiar] spawned familiar serve on port {port}");
    if let Some(state) = app.try_state::<ServeState>() {
        *state.0.lock().unwrap() = Some(child);
    }
    Some((format!("http://127.0.0.1:{port}"), port))
}

/// Wait for the freshly spawned server to answer /healthz, then return the
/// bearer token (empty when the server does not require one).
fn wait_token(port: u16) -> String {
    for _ in 0..150 {
        if let Some(token_file) = probe(port) {
            return read_token(&token_file);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    String::new()
}

// ---------------------------------------------------------------------------
// window.familiarDesktop bridge commands
// ---------------------------------------------------------------------------

/// Clipboard for the code-block copy button (navigator.clipboard is also
/// available on the 127.0.0.1 secure origin, but this always works).
#[tauri::command]
fn write_clipboard(text: String) -> Result<bool, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Open a file/folder with the OS default application (file viewer's
/// "open with the OS default app" and the tree's "open folder").
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    opener::open(&path).map_err(|e| e.to_string())
}

#[derive(serde::Deserialize, Default)]
struct NotifyPayload {
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
}

/// Turn-complete / approval notifications.
#[tauri::command]
fn notify(app: tauri::AppHandle, payload: NotifyPayload) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let title = if payload.title.is_empty() {
        "Familiar Harness".to_string()
    } else {
        payload.title
    };
    app.notification()
        .builder()
        .title(title)
        .body(payload.body)
        .show()
        .map_err(|e| e.to_string())
}

/// Emitted by the injected bridge once it is wired. Logs the origin (never the
/// token-bearing URL) and doubles as an end-to-end check that IPC works on the
/// remote page.
#[tauri::command]
fn bridge_ready(origin: String) {
    eprintln!("[familiar] bridge ready: {origin}");
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(ServeState(Mutex::new(None)))
        .manage(e2e::E2eState::new())
        .invoke_handler(tauri::generate_handler![
            write_clipboard,
            open_path,
            notify,
            bridge_ready,
            e2e::e2e_result
        ])
        .setup(|app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Familiar Harness")
                .inner_size(1280.0, 840.0)
                .min_inner_size(900.0, 600.0)
                .initialization_script(BRIDGE)
                .build()?;
            // Debug-only test control channel (see src/e2e.rs). Never started
            // by a release build, so a shipped binary has no eval endpoint.
            #[cfg(debug_assertions)]
            if let Ok(port) = std::env::var("FAMILIAR_SHELL_E2E_PORT") {
                if let Ok(port) = port.trim().parse::<u16>() {
                    e2e::start(app.handle().clone(), port);
                }
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let (base, port) = match start_serve(&handle) {
                    Some(v) => v,
                    None => {
                        eprintln!("[familiar] could not start familiar serve");
                        return;
                    }
                };
                let token = wait_token(port);
                let url = if token.is_empty() {
                    format!("{base}/")
                } else {
                    format!("{base}/?token={token}")
                };
                if let Ok(parsed) = tauri::Url::parse(&url) {
                    let w = window.clone();
                    let _ = handle.run_on_main_thread(move || {
                        let _ = w.navigate(parsed);
                    });
                }
                // Keep this thread alive for the process lifetime:
                // PR_SET_PDEATHSIG binds to the *creating thread*, so returning
                // here would signal the sidecar immediately (nothing is lost —
                // the process exits and the thread dies with it).
                loop {
                    std::thread::park();
                }
            });
            Ok(())
        });
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building the Familiar shell");
    app.run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<ServeState>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
