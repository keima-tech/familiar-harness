//! Debug-only test control channel for the Tauri shell.
//!
//! The WebKitGTK remote inspector exposes no CDP-style HTTP/JSON endpoint, so
//! driving the Web UI for end-to-end tests needs a channel we control. When the
//! `FAMILIAR_SHELL_E2E_PORT` env var is set (only ever done by
//! `scripts/e2e.mjs`), the shell starts a tiny HTTP server on 127.0.0.1:
//!
//!   POST /eval   body = a JS expression -> {"ok":true,"value":…}
//!
//! It evaluates the expression in the "main" webview and returns the
//! JSON-stringified result, i.e. the same `evalOnce(expr)` the Electron-based
//! `packages/desktop/scripts/ssh-e2e.mjs` gets over the Chrome DevTools
//! Protocol. The server is only started for debug builds (see `main.rs`), so a
//! release binary ships no eval endpoint; `e2e_result` stays registered but has
//! no pending call to resolve and is inert.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;

/// Pending `/eval` calls, keyed by call id, resolved by `e2e_result`.
pub struct E2eState {
    pending: Mutex<HashMap<u64, Sender<String>>>,
    next_id: Mutex<u64>,
}

impl E2eState {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }
}

impl Default for E2eState {
    fn default() -> Self {
        Self::new()
    }
}

/// Called by the injected JS with the stringified result of an `/eval`.
#[tauri::command]
pub fn e2e_result(state: tauri::State<'_, E2eState>, id: u64, value: String) {
    if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(value);
    }
}

/// Start the control server (debug builds only; see `main.rs`).
pub fn start(app: tauri::AppHandle, port: u16) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[familiar] e2e control: bind 127.0.0.1:{port} failed: {e}");
                return;
            }
        };
        eprintln!("[familiar] e2e control listening on 127.0.0.1:{port}");
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            match read_body(&mut stream) {
                Some(expr) => {
                    let out = evaluate(&app, &expr);
                    let _ = respond(&mut stream, 200, &out);
                }
                None => {
                    let _ = respond(&mut stream, 400, r#"{"ok":false,"error":"bad request"}"#);
                }
            }
        }
    });
}

/// Evaluate `expr` in the main webview and return `{"ok":…,"value":…}`.
fn evaluate(app: &tauri::AppHandle, expr: &str) -> String {
    let state = app.state::<E2eState>();
    let id = {
        let mut n = state.next_id.lock().unwrap();
        let v = *n;
        *n += 1;
        v
    };
    let (tx, rx) = channel::<String>();
    state.pending.lock().unwrap().insert(id, tx);

    let Some(window) = app.get_webview_window("main") else {
        state.pending.lock().unwrap().remove(&id);
        return r#"{"ok":false,"error":"no main window"}"#.into();
    };
    // Build the JS: evaluate the expression, then hand the stringified result
    // back through the `e2e_result` command.
    let expr_json = serde_json::to_string(expr).unwrap_or_else(|_| "\"\"".into());
    let js = format!(
        "(async function(){{var __r;try{{var __v=await eval({expr_json});__r=JSON.stringify({{ok:true,value:(typeof __v==='undefined'?null:__v)}});}}\
         catch(e){{__r=JSON.stringify({{ok:false,error:String((e&&e.message)||e)}});}}\
         window.__TAURI__.core.invoke('e2e_result',{{id:{id},value:__r}});}})()",
        expr_json = expr_json,
        id = id,
    );
    let handle = app.clone();
    if handle
        .run_on_main_thread(move || {
            let _ = window.eval(&js);
        })
        .is_err()
    {
        state.pending.lock().unwrap().remove(&id);
        return r#"{"ok":false,"error":"could not reach the UI thread"}"#.into();
    }
    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(v) => v,
        Err(_) => {
            state.pending.lock().unwrap().remove(&id);
            r#"{"ok":false,"error":"timeout"}"#.into()
        }
    }
}

/// Read a minimal HTTP/1.1 request and return its body.
fn read_body(stream: &mut TcpStream) -> Option<String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        let n = stream.read(&mut tmp).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&buf[..pos]).to_string();
            let len: usize = headers
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("content-length:"))
                .and_then(|l| l.split(':').nth(1))
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(0);
            let start = pos + 4;
            while buf.len() < start + len {
                let n = stream.read(&mut tmp).ok()?;
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
            }
            let end = (start + len).min(buf.len());
            return Some(String::from_utf8_lossy(&buf[start..end]).to_string());
        }
        if buf.len() > 1_000_000 {
            return None;
        }
    }
    None
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let resp = format!(
        "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}",
        len = body.len(),
    );
    stream.write_all(resp.as_bytes())?;
    stream.flush()
}
