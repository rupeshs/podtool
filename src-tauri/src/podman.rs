use serde::Serialize;
use serde_json::Value;
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Structured error returned to the frontend so it can render the right
/// empty-state (e.g. "start the Podman machine" vs. a raw error dump).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodmanError {
    pub kind: ErrorKind,
    pub message: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    NotInstalled,
    NotConnected,
    Generic,
}

impl PodmanError {
    /// Only a genuine "binary not found" should be reported as not-installed.
    /// Other spawn failures (e.g. a transient sharing violation from several
    /// `podman.exe` launches racing at startup) are real but not that.
    fn from_spawn_error(err: &std::io::Error) -> Self {
        if err.kind() == std::io::ErrorKind::NotFound {
            Self {
                kind: ErrorKind::NotInstalled,
                message: "The `podman` command wasn't found. Install Podman and make sure it's on your PATH.".into(),
            }
        } else {
            Self {
                kind: ErrorKind::Generic,
                message: format!("Couldn't run podman: {err}"),
            }
        }
    }

    fn from_stderr(stderr: &str) -> Self {
        let lower = stderr.to_lowercase();
        let looks_unreachable = lower.contains("cannot connect")
            || lower.contains("unable to connect")
            || (lower.contains("no such file or directory") && lower.contains("podman.sock"))
            || (lower.contains("machine") && (lower.contains("start") || lower.contains("not running")));

        if looks_unreachable {
            Self {
                kind: ErrorKind::NotConnected,
                message: "The Podman machine isn't running.".into(),
            }
        } else {
            Self {
                kind: ErrorKind::Generic,
                message: stderr.trim().to_string(),
            }
        }
    }
}

fn base_command(bin: &str) -> Command {
    let mut cmd = Command::new(bin);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdin(Stdio::null());
    cmd
}

/// Runs `podman <args>` and returns captured stdout as a String.
fn run(args: &[&str]) -> Result<String, PodmanError> {
    let output = base_command("podman")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| PodmanError::from_spawn_error(&e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(PodmanError::from_stderr(&stderr))
    }
}

/// Same as `run` but combines stdout+stderr (used for `logs`, where output
/// legitimately goes to both streams).
fn run_combined(args: &[&str]) -> Result<String, PodmanError> {
    let output = base_command("podman")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| PodmanError::from_spawn_error(&e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Ok(format!("{stdout}{stderr}"))
    } else {
        Err(PodmanError::from_stderr(&output_err_text(&output.stderr, &stdout)))
    }
}

fn output_err_text(stderr: &[u8], stdout_fallback: &str) -> String {
    let text = String::from_utf8_lossy(stderr).into_owned();
    if text.trim().is_empty() {
        stdout_fallback.to_string()
    } else {
        text
    }
}

fn get_str(v: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(s) = v.get(key).and_then(Value::as_str) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

fn get_str_array_joined(v: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(arr) = v.get(key).and_then(Value::as_array) {
            let joined: Vec<String> = arr
                .iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect();
            if !joined.is_empty() {
                return Some(joined.join(", "));
            }
        }
    }
    None
}

fn get_num(v: &Value, keys: &[&str]) -> Option<i64> {
    for key in keys {
        if let Some(n) = v.get(key).and_then(Value::as_i64) {
            return Some(n);
        }
    }
    None
}

/// `podman ps --format json`'s "Ports" field is an array of objects
/// (`host_ip`/`host_port`/`container_port`/`protocol`/`range`), not an array
/// of strings, so it needs its own formatter rather than
/// `get_str_array_joined`. Mirrors `podman ps`'s own table rendering, e.g.
/// `0.0.0.0:8080->8080/tcp`.
fn format_ports(v: &Value) -> Option<String> {
    let arr = v.get("Ports").and_then(Value::as_array)?;
    let entries: Vec<String> = arr
        .iter()
        .filter_map(|p| {
            let host_ip = p.get("host_ip").and_then(Value::as_str).unwrap_or("");
            let host_ip = if host_ip.is_empty() { "0.0.0.0" } else { host_ip };
            let host_port = p.get("host_port").and_then(Value::as_i64)?;
            let container_port = p.get("container_port").and_then(Value::as_i64)?;
            let protocol = p.get("protocol").and_then(Value::as_str).unwrap_or("tcp");
            let range = p.get("range").and_then(Value::as_i64).unwrap_or(1).max(1);

            Some(if range > 1 {
                format!(
                    "{host_ip}:{host_port}-{}->{container_port}-{}/{protocol}",
                    host_port + range - 1,
                    container_port + range - 1
                )
            } else {
                format!("{host_ip}:{host_port}->{container_port}/{protocol}")
            })
        })
        .collect();

    if entries.is_empty() {
        None
    } else {
        Some(entries.join(", "))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerSummary {
    pub id: String,
    pub short_id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub state: String,
    pub created_at: String,
    pub ports: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSummary {
    pub id: String,
    pub short_id: String,
    pub repo_tags: String,
    pub size_bytes: i64,
    pub created_at: String,
    pub containers: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeSummary {
    pub name: String,
    pub driver: String,
    pub scope: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSummary {
    pub id: String,
    pub short_id: String,
    pub name: String,
    pub driver: String,
    pub created_at: String,
    pub internal: bool,
    pub subnets: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub category: String,
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusInfo {
    pub connected: bool,
    pub version: Option<String>,
    pub message: Option<String>,
    pub kind: Option<ErrorKind>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineInfo {
    pub name: String,
    pub running: bool,
    pub default: bool,
}

fn parse_json_array(raw: &str) -> Vec<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    // `podman ... --format json` normally emits one JSON array; older/edge
    // builds sometimes emit newline-delimited JSON objects instead.
    if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(trimmed) {
        return items;
    }
    trimmed
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

pub fn list_containers() -> Result<Vec<ContainerSummary>, PodmanError> {
    let raw = run(&["ps", "-a", "--format", "json"])?;
    let items = parse_json_array(&raw);

    Ok(items
        .iter()
        .map(|v| {
            let id = get_str(v, &["Id", "ID"]).unwrap_or_default();
            let short_id = id.chars().take(12).collect::<String>();
            let name = get_str_array_joined(v, &["Names"])
                .or_else(|| get_str(v, &["Names"]))
                .unwrap_or_else(|| short_id.clone());
            let image = get_str(v, &["Image"]).unwrap_or_default();
            let status = get_str(v, &["Status"]).unwrap_or_default();
            let state = get_str(v, &["State"])
                .unwrap_or_else(|| infer_state_from_status(&status));
            let created_at = get_str(v, &["CreatedAt", "Created"]).unwrap_or_default();
            let ports = format_ports(v).unwrap_or_default();

            ContainerSummary {
                id,
                short_id,
                name,
                image,
                status,
                state,
                created_at,
                ports,
            }
        })
        .collect())
}

fn infer_state_from_status(status: &str) -> String {
    let lower = status.to_lowercase();
    if lower.starts_with("up") {
        "running".into()
    } else if lower.starts_with("exited") {
        "exited".into()
    } else if lower.starts_with("created") {
        "created".into()
    } else if lower.starts_with("paused") {
        "paused".into()
    } else {
        "unknown".into()
    }
}

pub fn list_images() -> Result<Vec<ImageSummary>, PodmanError> {
    let raw = run(&["images", "--format", "json"])?;
    let items = parse_json_array(&raw);

    Ok(items
        .iter()
        .map(|v| {
            let id = get_str(v, &["Id", "ID"]).unwrap_or_default();
            let short_id = id.chars().take(12).collect::<String>();
            let repo_tags = get_str_array_joined(v, &["RepoTags", "Names"])
                .unwrap_or_else(|| "<none>:<none>".to_string());
            let size_bytes = get_num(v, &["Size"]).unwrap_or(0);
            let created_at = get_str(v, &["CreatedAt"])
                .or_else(|| get_num(v, &["Created"]).map(|t| t.to_string()))
                .unwrap_or_default();
            let containers = get_num(v, &["Containers"]).unwrap_or(-1);

            ImageSummary {
                id,
                short_id,
                repo_tags,
                size_bytes,
                created_at,
                containers,
            }
        })
        .collect())
}

pub fn container_action(id: &str, action: &str) -> Result<(), PodmanError> {
    let allowed = ["start", "stop", "restart", "pause", "unpause", "kill"];
    if !allowed.contains(&action) {
        return Err(PodmanError {
            kind: ErrorKind::Generic,
            message: format!("Unsupported action: {action}"),
        });
    }
    run(&[action, id]).map(|_| ())
}

pub fn remove_container(id: &str, force: bool) -> Result<(), PodmanError> {
    if force {
        run(&["rm", "-f", id]).map(|_| ())
    } else {
        run(&["rm", id]).map(|_| ())
    }
}

pub fn remove_image(id: &str, force: bool) -> Result<(), PodmanError> {
    if force {
        run(&["rmi", "-f", id]).map(|_| ())
    } else {
        run(&["rmi", id]).map(|_| ())
    }
}

pub fn list_volumes() -> Result<Vec<VolumeSummary>, PodmanError> {
    let raw = run(&["volume", "ls", "--format", "json"])?;
    let items = parse_json_array(&raw);

    Ok(items
        .iter()
        .map(|v| VolumeSummary {
            name: get_str(v, &["Name", "name"]).unwrap_or_default(),
            driver: get_str(v, &["Driver", "driver"]).unwrap_or_default(),
            scope: get_str(v, &["Scope", "scope"]).unwrap_or_default(),
            created_at: get_str(v, &["CreatedAt", "createdAt", "Created", "created"])
                .unwrap_or_default(),
        })
        .collect())
}

pub fn remove_volume(name: &str, force: bool) -> Result<(), PodmanError> {
    if force {
        run(&["volume", "rm", "-f", name]).map(|_| ())
    } else {
        run(&["volume", "rm", name]).map(|_| ())
    }
}

pub fn list_networks() -> Result<Vec<NetworkSummary>, PodmanError> {
    let raw = run(&["network", "ls", "--format", "json"])?;
    let items = parse_json_array(&raw);

    Ok(items
        .iter()
        .map(|v| {
            let id = get_str(v, &["Id", "id"]).unwrap_or_default();
            let short_id = id.chars().take(12).collect::<String>();
            let internal = v
                .get("Internal")
                .or_else(|| v.get("internal"))
                .and_then(Value::as_bool)
                .unwrap_or(false);

            NetworkSummary {
                id,
                short_id,
                name: get_str(v, &["Name", "name"]).unwrap_or_default(),
                driver: get_str(v, &["Driver", "driver"]).unwrap_or_default(),
                created_at: get_str(v, &["Created", "created", "CreatedAt", "createdAt"])
                    .unwrap_or_default(),
                internal,
                subnets: get_subnets(v),
            }
        })
        .collect())
}

fn get_subnets(v: &Value) -> String {
    let entries = v
        .get("subnets")
        .or_else(|| v.get("Subnets"))
        .and_then(Value::as_array);

    match entries {
        Some(items) => items
            .iter()
            .filter_map(|s| {
                s.get("subnet")
                    .or_else(|| s.get("Subnet"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect::<Vec<_>>()
            .join(", "),
        None => String::new(),
    }
}

pub fn remove_network(name: &str, force: bool) -> Result<(), PodmanError> {
    if force {
        run(&["network", "rm", "-f", name]).map(|_| ())
    } else {
        run(&["network", "rm", name]).map(|_| ())
    }
}

pub fn cleanup(containers: bool, images: bool, volumes: bool, networks: bool) -> Vec<CleanupResult> {
    let mut results = Vec::new();

    // Containers first: freeing them up is what lets otherwise-in-use
    // images/volumes/networks become prunable too.
    if containers {
        results.push(run_prune("containers", &["container", "prune", "-f"]));
    }
    if images {
        results.push(run_prune("images", &["image", "prune", "-a", "-f"]));
    }
    if volumes {
        // -a: by default `volume prune` only removes anonymous volumes,
        // leaving named ones (what users actually create) untouched.
        results.push(run_prune("volumes", &["volume", "prune", "-a", "-f"]));
    }
    if networks {
        results.push(run_prune("networks", &["network", "prune", "-f"]));
    }

    results
}

fn run_prune(category: &str, args: &[&str]) -> CleanupResult {
    match run(args) {
        Ok(out) => CleanupResult {
            category: category.to_string(),
            ok: true,
            message: summarize_prune_output(&out),
        },
        Err(e) => CleanupResult {
            category: category.to_string(),
            ok: false,
            message: e.message,
        },
    }
}

fn summarize_prune_output(out: &str) -> String {
    let lines: Vec<&str> = out.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let reclaimed = lines
        .iter()
        .find(|l| l.to_lowercase().starts_with("total reclaimed space"));
    let removed_count = lines
        .iter()
        .filter(|l| !l.to_lowercase().starts_with("total reclaimed space"))
        .count();

    match reclaimed {
        Some(r) => format!("Removed {removed_count} item(s) · {r}"),
        None if removed_count == 0 => "Nothing to remove".to_string(),
        None => format!("Removed {removed_count} item(s)"),
    }
}

pub fn container_logs(id: &str, tail: u32) -> Result<String, PodmanError> {
    let tail_str = tail.to_string();
    run_combined(&["logs", "--tail", &tail_str, "--timestamps", id])
}

/// A single-shot resource usage snapshot (`--no-stream`, rather than a
/// long-lived streaming subprocess the frontend would have to manage the
/// lifecycle of); the frontend polls this on an interval while its stats
/// modal is open instead.
pub fn container_stats(id: &str) -> Result<String, PodmanError> {
    run(&["stats", "--no-stream", "--format", "json", id])
}

/// Runs `podman <kind> inspect <ref>` and returns the pretty-printed JSON
/// text as-is; the frontend parses it (it already needs the raw text for a
/// "raw JSON" fallback view alongside a summarized one).
fn inspect(kind: &str, reference: &str) -> Result<String, PodmanError> {
    run(&[kind, "inspect", reference])
}

pub fn inspect_container(id: &str) -> Result<String, PodmanError> {
    inspect("container", id)
}

pub fn inspect_image(id: &str) -> Result<String, PodmanError> {
    inspect("image", id)
}

pub fn inspect_volume(name: &str) -> Result<String, PodmanError> {
    inspect("volume", name)
}

pub fn inspect_network(name: &str) -> Result<String, PodmanError> {
    inspect("network", name)
}

pub fn status() -> StatusInfo {
    let version = match run(&["version", "--format", "{{.Client.Version}}"]) {
        Ok(v) => v.trim().to_string(),
        Err(e) => {
            return StatusInfo {
                connected: false,
                version: None,
                message: Some(e.message),
                kind: Some(e.kind),
            };
        }
    };

    match run(&["ps", "--format", "json"]) {
        Ok(_) => StatusInfo {
            connected: true,
            version: Some(version),
            message: None,
            kind: None,
        },
        Err(e) => StatusInfo {
            connected: false,
            version: Some(version),
            message: Some(e.message),
            kind: Some(e.kind),
        },
    }
}

pub fn list_machines() -> Vec<MachineInfo> {
    let raw = match run(&["machine", "list", "--format", "json"]) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    parse_json_array(&raw)
        .iter()
        .map(|v| {
            let name = get_str(v, &["Name"]).unwrap_or_default();
            let running = v
                .get("Running")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let default = v
                .get("Default")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            MachineInfo {
                name,
                running,
                default,
            }
        })
        .collect()
}

pub fn start_machine(name: Option<&str>) -> Result<(), PodmanError> {
    match name {
        Some(n) => run(&["machine", "start", n]).map(|_| ()),
        None => run(&["machine", "start"]).map(|_| ()),
    }
}
