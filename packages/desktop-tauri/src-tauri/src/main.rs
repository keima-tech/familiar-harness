// Familiar Harness desktop shell (Tauri).
//
// The shell bundles the Node.js runtime and the familiar server as resources,
// spawns `node familiar/packages/cli/dist/familiar.js serve` locally and renders the
// Web UI (served over 127.0.0.1) in the system webview. This is the Tauri
// counterpart of the Electron shell in packages/desktop: same "talk to a live
// familiar serve, or spawn one" strategy, but without bundling Chromium.
//
// See docs/spec/06-roadmap.md for the rationale and the current scope.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// Ports the shell probes for an already-running `familiar serve` (mirrors the
/// Electron shell). `FAMILIAR_PORTS` overrides the list; `FAMILIAR_SPAWN_PORT`
/// overrides the port a fresh server is spawned on.
const DEFAULT_PORTS: [u16; 3] = [46210, 46211, 46212];

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

/// Holds the child `familiar serve` process (if this shell spawned one) so it can
/// be terminated when the last window closes.
struct ServeState(Mutex<Option<Child>>);

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
    let child = cmd.spawn().ok()?;
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

fn main() {
    tauri::Builder::default()
        .manage(ServeState(Mutex::new(None)))
        .setup(|app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Familiar Harness")
                .inner_size(1280.0, 840.0)
                .min_inner_size(900.0, 600.0)
                .build()?;
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
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Familiar shell")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<ServeState>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
