use anyhow::{anyhow, bail, Context, Result};
use clap::{Args, Parser, Subcommand};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const EXTENSION_ID: &str = "hehggadaopoacecdllhhajmbjkdcmajg";
const HOST_NAME: &str = "com.openai.codexextension";
const SOCKET_DIR: &str = "/tmp/codex-browser-use";
const SOCKET_NAME: &str = "com.openai.codexextension.sock";

#[derive(Parser)]
#[command(author, version, about)]
struct Cli {
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Verify manifest, socket, extension install, and optional bridge reachability.
    Doctor(DoctorArgs),
    /// Install the Chrome Native Messaging Host manifest for this binary.
    InstallManifest(InstallManifestArgs),
    /// Run as the Chrome-launched Native Messaging Host.
    NativeHost(SocketArgs),
    /// Send a raw JSON-RPC request to the running native host bridge.
    Request(RequestArgs),
    /// Ping the extension through the bridge.
    Ping(SessionArgs),
    /// Read extension backend info.
    Info(SessionArgs),
    /// List all user Chrome tabs visible to the extension.
    Tabs(SessionArgs),
    /// Search Chrome history.
    History(HistoryArgs),
    /// Create a tab in the Codex session group.
    CreateTab(SessionArgs),
    /// Claim an existing Chrome tab into the Codex session group.
    ClaimTab(ClaimTabArgs),
    /// Attach Chrome debugger to a session tab.
    Attach(TabArgs),
    /// Detach Chrome debugger from a session tab.
    Detach(TabArgs),
    /// Execute a Chrome DevTools Protocol command for a session tab.
    Cdp(CdpArgs),
    /// Navigate a session tab, creating one when --tab-id is omitted.
    Navigate(NavigateArgs),
    /// Tell the extension that a turn ended and release active controls.
    TurnEnded(SessionArgs),
}

#[derive(Args, Clone)]
struct SocketArgs {
    #[arg(long)]
    socket_path: Option<PathBuf>,
}

#[derive(Args)]
struct DoctorArgs {
    #[command(flatten)]
    socket: SocketArgs,
    #[arg(long)]
    manifest_path: Option<PathBuf>,
}

#[derive(Args)]
struct InstallManifestArgs {
    #[arg(long)]
    host_path: Option<PathBuf>,
    #[arg(long)]
    manifest_path: Option<PathBuf>,
    #[arg(long)]
    dry_run: bool,
}

#[derive(Args, Clone)]
struct SessionArgs {
    #[command(flatten)]
    socket: SocketArgs,
    #[arg(long)]
    session: Option<String>,
    #[arg(long)]
    turn: Option<String>,
    #[arg(long, default_value_t = 10_000)]
    timeout_ms: u64,
}

#[derive(Args)]
struct RequestArgs {
    #[command(flatten)]
    session: SessionArgs,
    /// JSON-RPC method name.
    method: String,
    /// JSON object params. Use '-' to read JSON params from stdin.
    #[arg(long)]
    params: Option<String>,
    /// Do not inject session_id and turn_id into params.
    #[arg(long)]
    no_session: bool,
}

#[derive(Args)]
struct HistoryArgs {
    #[command(flatten)]
    session: SessionArgs,
    #[arg(long)]
    query: Option<String>,
    #[arg(long)]
    from: Option<String>,
    #[arg(long)]
    to: Option<String>,
    #[arg(long)]
    limit: Option<u64>,
}

#[derive(Args)]
struct ClaimTabArgs {
    #[command(flatten)]
    session: SessionArgs,
    #[arg(long)]
    tab_id: u64,
}

#[derive(Args)]
struct TabArgs {
    #[command(flatten)]
    session: SessionArgs,
    #[arg(long)]
    tab_id: u64,
}

#[derive(Args)]
struct CdpArgs {
    #[command(flatten)]
    session: SessionArgs,
    #[arg(long)]
    tab_id: u64,
    /// CDP method, for example Page.navigate or Runtime.evaluate.
    method: String,
    /// CDP command params as JSON object. Use '-' to read from stdin.
    #[arg(long)]
    params: Option<String>,
    #[arg(long)]
    timeout_ms: Option<u64>,
}

#[derive(Args)]
struct NavigateArgs {
    #[command(flatten)]
    session: SessionArgs,
    url: String,
    #[arg(long)]
    tab_id: Option<u64>,
    #[arg(long)]
    timeout_ms: Option<u64>,
}

fn main() {
    let cli = Cli::parse();
    if let Err(err) = run(cli.json, cli.command) {
        if cli_json_requested() {
            let _ = writeln!(
                io::stderr(),
                "{}",
                serde_json::to_string(&json!({ "ok": false, "error": err.to_string() }))
                    .unwrap_or_else(|_| "{\"ok\":false}".to_string())
            );
        } else {
            let _ = writeln!(io::stderr(), "error: {err:#}");
        }
        std::process::exit(1);
    }
}

fn cli_json_requested() -> bool {
    env::args().any(|arg| arg == "--json")
}

fn run(json_output: bool, command: Option<Commands>) -> Result<()> {
    let command = command.unwrap_or(Commands::NativeHost(SocketArgs { socket_path: None }));
    match command {
        Commands::Doctor(args) => print_value(json_output, doctor(args)?),
        Commands::InstallManifest(args) => print_value(json_output, install_manifest(args)?),
        Commands::NativeHost(args) => native_host(socket_path(args.socket_path)),
        Commands::Request(args) => {
            let mut params = read_params(args.params)?;
            if !args.no_session {
                inject_session(&mut params, &args.session);
            }
            let response = rpc_call(
                &args.session.socket,
                &args.method,
                params,
                args.session.timeout_ms,
            )?;
            print_value(json_output, response)
        }
        Commands::Ping(args) => print_value(
            json_output,
            rpc_call(&args.socket, "ping", json!({}), args.timeout_ms)?,
        ),
        Commands::Info(args) => print_value(
            json_output,
            rpc_call(
                &args.socket,
                "getInfo",
                session_params(&args),
                args.timeout_ms,
            )?,
        ),
        Commands::Tabs(args) => print_value(
            json_output,
            rpc_call(
                &args.socket,
                "getUserTabs",
                session_params(&args),
                args.timeout_ms,
            )?,
        ),
        Commands::History(args) => {
            let mut params = session_params(&args.session);
            insert_opt(&mut params, "query", args.query);
            insert_opt(&mut params, "from", args.from);
            insert_opt(&mut params, "to", args.to);
            if let Some(limit) = args.limit {
                params["limit"] = json!(limit);
            }
            print_value(
                json_output,
                rpc_call(
                    &args.session.socket,
                    "getUserHistory",
                    params,
                    args.session.timeout_ms,
                )?,
            )
        }
        Commands::CreateTab(args) => print_value(
            json_output,
            rpc_call(
                &args.socket,
                "createTab",
                session_params(&args),
                args.timeout_ms,
            )?,
        ),
        Commands::ClaimTab(args) => {
            let mut params = session_params(&args.session);
            params["tabId"] = json!(args.tab_id);
            print_value(
                json_output,
                rpc_call(
                    &args.session.socket,
                    "claimUserTab",
                    params,
                    args.session.timeout_ms,
                )?,
            )
        }
        Commands::Attach(args) => {
            let mut params = session_params(&args.session);
            params["tabId"] = json!(args.tab_id);
            print_value(
                json_output,
                rpc_call(
                    &args.session.socket,
                    "attach",
                    params,
                    args.session.timeout_ms,
                )?,
            )
        }
        Commands::Detach(args) => {
            let mut params = session_params(&args.session);
            params["tabId"] = json!(args.tab_id);
            print_value(
                json_output,
                rpc_call(
                    &args.session.socket,
                    "detach",
                    params,
                    args.session.timeout_ms,
                )?,
            )
        }
        Commands::Cdp(args) => {
            let mut params = session_params(&args.session);
            params["target"] = json!({ "tabId": args.tab_id });
            params["method"] = json!(args.method);
            params["commandParams"] = read_params(args.params)?;
            if let Some(timeout_ms) = args.timeout_ms {
                params["timeoutMs"] = json!(timeout_ms);
            }
            print_value(
                json_output,
                rpc_call(
                    &args.session.socket,
                    "executeCdp",
                    params,
                    args.session.timeout_ms,
                )?,
            )
        }
        Commands::Navigate(args) => {
            let session = args.session;
            let tab_id = match args.tab_id {
                Some(tab_id) => tab_id,
                None => {
                    let created = rpc_call(
                        &session.socket,
                        "createTab",
                        session_params(&session),
                        session.timeout_ms,
                    )?;
                    created
                        .get("id")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| anyhow!("createTab response did not include numeric id"))?
                }
            };
            let mut attach_params = session_params(&session);
            attach_params["tabId"] = json!(tab_id);
            let _ = rpc_call(&session.socket, "attach", attach_params, session.timeout_ms)?;

            let mut cdp_params = session_params(&session);
            cdp_params["target"] = json!({ "tabId": tab_id });
            cdp_params["method"] = json!("Page.navigate");
            cdp_params["commandParams"] = json!({ "url": args.url });
            if let Some(timeout_ms) = args.timeout_ms {
                cdp_params["timeoutMs"] = json!(timeout_ms);
            }
            let result = rpc_call(
                &session.socket,
                "executeCdp",
                cdp_params,
                session.timeout_ms,
            )?;
            print_value(json_output, json!({ "tabId": tab_id, "result": result }))
        }
        Commands::TurnEnded(args) => print_value(
            json_output,
            rpc_call(
                &args.socket,
                "turnEnded",
                session_params(&args),
                args.timeout_ms,
            )?,
        ),
    }
}

fn print_value(json_output: bool, value: Value) -> Result<()> {
    if json_output {
        println!("{}", serde_json::to_string(&value)?);
    } else if value.is_string() {
        println!("{}", value.as_str().unwrap_or_default());
    } else {
        println!("{}", serde_json::to_string_pretty(&value)?);
    }
    Ok(())
}

fn insert_opt(params: &mut Value, key: &str, value: Option<String>) {
    if let Some(value) = value {
        params[key] = json!(value);
    }
}

fn session_params(args: &SessionArgs) -> Value {
    let mut params = json!({});
    inject_session(&mut params, args);
    params
}

fn inject_session(params: &mut Value, args: &SessionArgs) {
    ensure_object(params);
    params["session_id"] = json!(args.session.clone().unwrap_or_else(default_session_id));
    params["turn_id"] = json!(args.turn.clone().unwrap_or_else(default_turn_id));
}

fn default_session_id() -> String {
    env::var("CODEX_CHROME_SESSION_ID").unwrap_or_else(|_| "codex-linux-extension-host".to_string())
}

fn default_turn_id() -> String {
    env::var("CODEX_CHROME_TURN_ID").unwrap_or_else(|_| "manual".to_string())
}

fn read_params(params: Option<String>) -> Result<Value> {
    match params {
        None => Ok(json!({})),
        Some(raw) if raw == "-" => {
            let mut input = String::new();
            io::stdin().read_to_string(&mut input)?;
            parse_params(&input)
        }
        Some(raw) => parse_params(&raw),
    }
}

fn parse_params(raw: &str) -> Result<Value> {
    let value: Value = serde_json::from_str(raw).context("params must be valid JSON")?;
    if !value.is_object() {
        bail!("params must be a JSON object");
    }
    Ok(value)
}

fn ensure_object(value: &mut Value) {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
}

fn manifest_path(override_path: Option<PathBuf>) -> PathBuf {
    override_path.unwrap_or_else(|| {
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        home.join(".config")
            .join("google-chrome")
            .join("NativeMessagingHosts")
            .join(format!("{HOST_NAME}.json"))
    })
}

fn socket_path(override_path: Option<PathBuf>) -> PathBuf {
    override_path.unwrap_or_else(|| Path::new(SOCKET_DIR).join(SOCKET_NAME))
}

#[derive(Serialize)]
struct Check {
    name: &'static str,
    ok: bool,
    detail: String,
}

fn doctor(args: DoctorArgs) -> Result<Value> {
    let manifest = manifest_path(args.manifest_path);
    let socket = socket_path(args.socket.socket_path);
    let mut checks = Vec::new();

    checks.push(Check {
        name: "platform",
        ok: cfg!(target_os = "linux"),
        detail: env::consts::OS.to_string(),
    });

    let manifest_value = match fs::read_to_string(&manifest) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(value) => {
                checks.push(Check {
                    name: "manifest-json",
                    ok: true,
                    detail: manifest.display().to_string(),
                });
                Some(value)
            }
            Err(err) => {
                checks.push(Check {
                    name: "manifest-json",
                    ok: false,
                    detail: err.to_string(),
                });
                None
            }
        },
        Err(err) => {
            checks.push(Check {
                name: "manifest-json",
                ok: false,
                detail: format!("{}: {err}", manifest.display()),
            });
            None
        }
    };

    if let Some(value) = manifest_value {
        let allowed = value
            .get("allowed_origins")
            .and_then(Value::as_array)
            .map(|items| {
                items.iter().any(|item| {
                    item.as_str() == Some(&format!("chrome-extension://{EXTENSION_ID}/"))
                })
            })
            .unwrap_or(false);
        checks.push(Check {
            name: "manifest-origin",
            ok: allowed,
            detail: format!("chrome-extension://{EXTENSION_ID}/"),
        });

        let path = value.get("path").and_then(Value::as_str).map(PathBuf::from);
        let ok = path.as_ref().is_some_and(|p| is_executable(p));
        checks.push(Check {
            name: "manifest-host-path",
            ok,
            detail: path
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "missing path".to_string()),
        });
    }

    let extension_dirs = find_extension_dirs();
    checks.push(Check {
        name: "chrome-extension-installed",
        ok: !extension_dirs.is_empty(),
        detail: if extension_dirs.is_empty() {
            "no profile extension directory found".to_string()
        } else {
            extension_dirs
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        },
    });

    let socket_check = match rpc_call_raw(&socket, "host.ping", json!({}), 1_000) {
        Ok(value) => Check {
            name: "bridge-socket-ping",
            ok: value == json!("pong"),
            detail: value.to_string(),
        },
        Err(err) => Check {
            name: "bridge-socket-ping",
            ok: false,
            detail: err.to_string(),
        },
    };
    checks.push(socket_check);

    let extension_check = match rpc_call_raw(&socket, "ping", json!({}), 1_000) {
        Ok(value) => Check {
            name: "extension-ping",
            ok: value == json!("pong"),
            detail: value.to_string(),
        },
        Err(err) => Check {
            name: "extension-ping",
            ok: false,
            detail: err.to_string(),
        },
    };
    checks.push(extension_check);

    let ok = checks.iter().all(|check| check.ok);
    Ok(json!({
        "ok": ok,
        "paths": {
            "manifest": manifest,
            "socket": socket,
        },
        "checks": checks,
    }))
}

fn find_extension_dirs() -> Vec<PathBuf> {
    let Some(home) = env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    let chrome_root = home.join(".config").join("google-chrome");
    let Ok(entries) = fs::read_dir(chrome_root) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("Extensions").join(EXTENSION_ID))
        .filter(|path| path.is_dir())
        .collect()
}

fn install_manifest(args: InstallManifestArgs) -> Result<Value> {
    let host_path = match args.host_path {
        Some(path) => absolutize(path)?,
        None => env::current_exe().context("failed to resolve current executable")?,
    };
    if !is_executable(&host_path) {
        bail!("host path is not executable: {}", host_path.display());
    }

    let manifest = manifest_path(args.manifest_path);
    let value = json!({
        "name": HOST_NAME,
        "description": "Codex chrome native messaging host",
        "type": "stdio",
        "path": host_path,
        "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")],
    });

    if !args.dry_run {
        let parent = manifest
            .parent()
            .ok_or_else(|| anyhow!("manifest path has no parent: {}", manifest.display()))?;
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
        fs::write(&manifest, serde_json::to_vec_pretty(&value)?)
            .with_context(|| format!("failed to write {}", manifest.display()))?;
    }

    Ok(json!({
        "ok": true,
        "dryRun": args.dry_run,
        "manifestPath": manifest,
        "manifest": value,
    }))
}

fn absolutize(path: PathBuf) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(env::current_dir()?.join(path))
    }
}

fn is_executable(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

struct BridgeState {
    to_chrome: mpsc::Sender<Value>,
    clients: Mutex<HashMap<u64, Arc<Mutex<UnixStream>>>>,
    routes: Mutex<HashMap<u64, Route>>,
    next_client_id: AtomicU64,
    next_bridge_id: AtomicU64,
}

struct Route {
    client_id: u64,
    original_id: Value,
}

fn native_host(path: PathBuf) -> Result<()> {
    let listener = bind_socket(&path)?;
    let (to_chrome, from_clients) = mpsc::channel::<Value>();
    let state = Arc::new(BridgeState {
        to_chrome,
        clients: Mutex::new(HashMap::new()),
        routes: Mutex::new(HashMap::new()),
        next_client_id: AtomicU64::new(1),
        next_bridge_id: AtomicU64::new(1),
    });

    let writer = thread::spawn(move || chrome_writer_loop(from_clients));

    {
        let state = Arc::clone(&state);
        thread::spawn(move || {
            if let Err(err) = chrome_reader_loop(state) {
                eprintln!("chrome reader stopped: {err:#}");
            }
        });
    }

    eprintln!("codex linux extension host listening on {}", path.display());
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let state = Arc::clone(&state);
                thread::spawn(move || {
                    if let Err(err) = client_loop(state, stream) {
                        eprintln!("client connection stopped: {err:#}");
                    }
                });
            }
            Err(err) => eprintln!("failed to accept client: {err}"),
        }
    }

    let _ = writer.join();
    Ok(())
}

fn bind_socket(path: &Path) -> Result<UnixListener> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("socket path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)?;
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    if path.exists() {
        match UnixStream::connect(path) {
            Ok(_) => bail!("socket already has a listener: {}", path.display()),
            Err(_) => {
                fs::remove_file(path)
                    .with_context(|| format!("failed to remove stale socket {}", path.display()))?;
            }
        }
    }
    let listener = UnixListener::bind(path)
        .with_context(|| format!("failed to bind socket {}", path.display()))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

fn chrome_writer_loop(rx: mpsc::Receiver<Value>) {
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    for message in rx {
        if let Err(err) = write_frame(&mut stdout, &message) {
            eprintln!("failed to write to chrome: {err:#}");
            break;
        }
        let _ = stdout.flush();
    }
}

fn chrome_reader_loop(state: Arc<BridgeState>) -> Result<()> {
    let stdin = io::stdin();
    let mut stdin = stdin.lock();
    while let Some(message) = read_frame(&mut stdin)? {
        handle_chrome_message(&state, message)?;
    }
    Ok(())
}

fn handle_chrome_message(state: &Arc<BridgeState>, message: Value) -> Result<()> {
    if message.get("method").is_some() && message.get("id").is_some() {
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let response = if method == "ping" {
            json!({ "jsonrpc": "2.0", "id": id, "result": "pong" })
        } else {
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("host does not handle extension request {method}") }
            })
        };
        state.to_chrome.send(response)?;
        return Ok(());
    }

    if message.get("id").is_some() && message.get("method").is_none() {
        let Some(bridge_id) = message.get("id").and_then(Value::as_u64) else {
            return Ok(());
        };
        let Some(route) = state.routes.lock().unwrap().remove(&bridge_id) else {
            return Ok(());
        };
        let mut routed = message;
        routed["id"] = route.original_id;
        send_to_client(state, route.client_id, &routed)?;
        return Ok(());
    }

    broadcast_to_clients(state, &message)
}

fn client_loop(state: Arc<BridgeState>, mut stream: UnixStream) -> Result<()> {
    let client_id = state.next_client_id.fetch_add(1, Ordering::SeqCst);
    let writer = Arc::new(Mutex::new(stream.try_clone()?));
    state.clients.lock().unwrap().insert(client_id, writer);

    let result = loop {
        match read_frame(&mut stream) {
            Ok(Some(message)) => handle_client_message(&state, client_id, message),
            Ok(None) => break Ok(()),
            Err(err) => break Err(err),
        }?;
    };

    state.clients.lock().unwrap().remove(&client_id);
    state
        .routes
        .lock()
        .unwrap()
        .retain(|_, route| route.client_id != client_id);
    result
}

fn handle_client_message(
    state: &Arc<BridgeState>,
    client_id: u64,
    mut message: Value,
) -> Result<()> {
    if message.get("method").and_then(Value::as_str) == Some("host.ping") {
        let response = json!({
            "jsonrpc": "2.0",
            "id": message.get("id").cloned().unwrap_or(Value::Null),
            "result": "pong"
        });
        send_to_client(state, client_id, &response)?;
        return Ok(());
    }

    if message.get("method").is_some() && message.get("id").is_some() {
        let bridge_id = state.next_bridge_id.fetch_add(1, Ordering::SeqCst);
        let original_id = message.get("id").cloned().unwrap_or(Value::Null);
        state.routes.lock().unwrap().insert(
            bridge_id,
            Route {
                client_id,
                original_id,
            },
        );
        message["id"] = json!(bridge_id);
        state.to_chrome.send(message)?;
        return Ok(());
    }

    state.to_chrome.send(message)?;
    Ok(())
}

fn send_to_client(state: &Arc<BridgeState>, client_id: u64, message: &Value) -> Result<()> {
    let writer = {
        let clients = state.clients.lock().unwrap();
        clients.get(&client_id).cloned()
    };
    if let Some(writer) = writer {
        write_frame(&mut *writer.lock().unwrap(), message)?;
    }
    Ok(())
}

fn broadcast_to_clients(state: &Arc<BridgeState>, message: &Value) -> Result<()> {
    let clients = state
        .clients
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for writer in clients {
        let _ = write_frame(&mut *writer.lock().unwrap(), message);
    }
    Ok(())
}

fn rpc_call(
    socket_args: &SocketArgs,
    method: &str,
    params: Value,
    timeout_ms: u64,
) -> Result<Value> {
    rpc_call_raw(
        &socket_path(socket_args.socket_path.clone()),
        method,
        params,
        timeout_ms,
    )
}

fn rpc_call_raw(socket: &Path, method: &str, params: Value, timeout_ms: u64) -> Result<Value> {
    let mut stream = UnixStream::connect(socket)
        .with_context(|| format!("failed to connect to bridge socket {}", socket.display()))?;
    stream.set_read_timeout(Some(Duration::from_millis(timeout_ms)))?;
    stream.set_write_timeout(Some(Duration::from_millis(timeout_ms)))?;

    let id = 1_u64;
    write_frame(
        &mut stream,
        &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
    )?;

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if Instant::now() > deadline {
            bail!("timed out waiting for response to {method}");
        }
        match read_frame(&mut stream)? {
            Some(message) if message.get("id").and_then(Value::as_u64) == Some(id) => {
                if let Some(error) = message.get("error") {
                    let text = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("remote JSON-RPC error");
                    bail!("{text}");
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
            Some(_) => continue,
            None => bail!("bridge closed before response to {method}"),
        }
    }
}

fn write_frame<W: Write>(writer: &mut W, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > u32::MAX as usize {
        bail!("message too large for native messaging frame");
    }
    writer.write_all(&(bytes.len() as u32).to_le_bytes())?;
    writer.write_all(&bytes)?;
    Ok(())
}

fn read_frame<R: Read>(reader: &mut R) -> Result<Option<Value>> {
    let mut len = [0_u8; 4];
    match reader.read_exact(&mut len) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(err)
            if matches!(
                err.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
            ) =>
        {
            return Err(anyhow!("timed out reading frame"));
        }
        Err(err) => return Err(err.into()),
    }
    let len = u32::from_le_bytes(len) as usize;
    let mut bytes = vec![0_u8; len];
    reader.read_exact(&mut bytes)?;
    Ok(Some(serde_json::from_slice(&bytes)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trip() {
        let value = json!({"jsonrpc":"2.0","id":1,"method":"ping","params":{}});
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &value).unwrap();
        let decoded = read_frame(&mut bytes.as_slice()).unwrap().unwrap();
        assert_eq!(decoded, value);
    }

    #[test]
    fn params_must_be_object() {
        assert!(parse_params("[]").is_err());
        assert_eq!(parse_params(r#"{"a":1}"#).unwrap(), json!({"a":1}));
    }

    #[test]
    fn injects_session_defaults() {
        let args = SessionArgs {
            socket: SocketArgs { socket_path: None },
            session: Some("s".to_string()),
            turn: Some("t".to_string()),
            timeout_ms: 1,
        };
        assert_eq!(
            session_params(&args),
            json!({"session_id":"s","turn_id":"t"})
        );
    }
}
