use joyshell_agent::{
    AgentToolCall, AgentToolRegistry, AssistantRegistry, ContextBuilder, PermissionEngine,
};
use joyshell_core::{
    AuthMethod, RemoteDirectoryListing, SessionInfo, SessionManager, SessionProfile, SftpProgress,
    SystemSnapshot,
};
use joyshell_store::{
    AuditAction, AuditEntry, AuditLog, CommandSnippet, LayoutSettings, MemoryStore,
    ProfileRepository, SessionFolder,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::process::{Command, Output};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};
use uuid::Uuid;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Clone)]
struct AppState {
    profiles: ProfileRepository,
    sessions: SessionManager,
    assistants: AssistantRegistry,
    tools: AgentToolRegistry,
    permissions: PermissionEngine,
    memories: MemoryStore,
    audit: AuditLog,
    secrets: Arc<RwLock<HashMap<String, String>>>,
    secret_key: [u8; 32],
}

impl AppState {
    fn new(database_path: impl AsRef<Path>) -> anyhow::Result<Self> {
        let database_path = database_path.as_ref();
        Ok(Self {
            profiles: ProfileRepository::sqlite(database_path)?,
            sessions: SessionManager::new(),
            assistants: AssistantRegistry::built_in(),
            tools: AgentToolRegistry::built_in(),
            permissions: PermissionEngine::default(),
            memories: MemoryStore::default(),
            audit: AuditLog::default(),
            secrets: Arc::new(RwLock::new(HashMap::new())),
            secret_key: derive_local_secret_key(database_path),
        })
    }
}

fn derive_local_secret_key(database_path: &Path) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"joyshell.local.sqlite.secret.v1");
    hasher.update(env::var("USERNAME").unwrap_or_default().as_bytes());
    hasher.update(env::var("USER").unwrap_or_default().as_bytes());
    hasher.update(env::var("COMPUTERNAME").unwrap_or_default().as_bytes());
    hasher.update(env::var("HOSTNAME").unwrap_or_default().as_bytes());
    hasher.update(database_path.to_string_lossy().as_bytes());
    hasher.finalize().into()
}

#[derive(Debug, Clone, Deserialize)]
struct SaveProfilePayload {
    profile: SessionProfile,
    password: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct AgentToolCallPreview {
    id: Uuid,
    assistant: String,
    tool_name: String,
    target: String,
    decision: joyshell_agent::PermissionDecision,
}

#[tauri::command]
fn list_profiles(state: State<'_, AppState>) -> Result<Vec<SessionProfile>, String> {
    state
        .profiles
        .list_profiles()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_folders(state: State<'_, AppState>) -> Result<Vec<SessionFolder>, String> {
    state
        .profiles
        .list_folders()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_folder(state: State<'_, AppState>, folder: SessionFolder) -> Result<SessionFolder, String> {
    state
        .profiles
        .upsert_folder(folder.clone())
        .map_err(|error| error.to_string())?;
    Ok(folder)
}

#[tauri::command]
fn delete_folder(state: State<'_, AppState>, folder_id: Uuid) -> Result<Option<String>, String> {
    state
        .profiles
        .delete_folder(folder_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_profile(state: State<'_, AppState>, profile_id: Uuid) -> Result<bool, String> {
    state
        .profiles
        .delete_profile(profile_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_profile(
    state: State<'_, AppState>,
    payload: SaveProfilePayload,
) -> Result<SessionProfile, String> {
    let profile = payload.profile;
    if let AuthMethod::Password { secret_ref } = &profile.auth_method {
        if let Some(password) = payload.password.filter(|value| !value.is_empty()) {
            if let Ok(mut secrets) = state.secrets.write() {
                secrets.insert(secret_ref.clone(), password.clone());
            }
            state
                .profiles
                .upsert_secret(secret_ref, &password, &state.secret_key)
                .map_err(|error| error.to_string())?;
        }
    }
    state
        .profiles
        .upsert_profile(profile.clone())
        .map_err(|error| error.to_string())?;
    state.audit.record(
        "user",
        Some(profile.id),
        AuditAction::AgentToolCall,
        format!("{}@{}:{}", profile.username, profile.host, profile.port),
        Some("allow".to_string()),
        "saved SSH profile",
    );
    Ok(profile)
}

#[tauri::command]
async fn connect_profile(
    state: State<'_, AppState>,
    profile_id: Uuid,
    session_id: Option<Uuid>,
) -> Result<SessionInfo, String> {
    let profile = state
        .profiles
        .get_profile(profile_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "profile was not found".to_string())?;
    let password = match &profile.auth_method {
        AuthMethod::Password { secret_ref } => {
            let cached = state
                .secrets
                .read()
                .map_err(|_| "secret store is unavailable".to_string())?
                .get(secret_ref)
                .cloned();
            match cached {
                Some(password) => password,
                None => {
                    let password = state
                        .profiles
                        .get_secret(secret_ref, &state.secret_key)
                        .map_err(|error| error.to_string())?
                        .ok_or_else(|| {
                            "password is missing; open SSH settings and save it again".to_string()
                        })?;
                    if let Ok(mut secrets) = state.secrets.write() {
                        secrets.insert(secret_ref.clone(), password.clone());
                    }
                    password
                }
            }
        }
        AuthMethod::PrivateKey { .. } => {
            return Err("private key authentication is not implemented yet".to_string())
        }
        AuthMethod::Agent => {
            return Err("SSH agent authentication is not implemented yet".to_string())
        }
    };
    let handle = state
        .sessions
        .connect_ssh_password_for_session(
            profile.clone(),
            password,
            session_id.unwrap_or_else(Uuid::new_v4),
        )
        .await
        .map_err(|error| error.to_string())?;
    state.audit.record(
        "user",
        Some(handle.id()),
        AuditAction::TerminalCommand,
        format!("{}@{}:{}", profile.username, profile.host, profile.port),
        Some("allow".to_string()),
        "connected SSH session",
    );
    state
        .sessions
        .get_session(handle.id())
        .ok_or_else(|| "session did not start".to_string())
}

#[tauri::command]
async fn disconnect_profile(state: State<'_, AppState>, session_id: Uuid) -> Result<(), String> {
    state
        .sessions
        .disconnect(session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_command_snippets(state: State<'_, AppState>) -> Result<Vec<CommandSnippet>, String> {
    state
        .profiles
        .list_command_snippets()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_command_snippet(
    state: State<'_, AppState>,
    snippet: CommandSnippet,
) -> Result<CommandSnippet, String> {
    state
        .profiles
        .upsert_command_snippet(snippet)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_command_snippet(state: State<'_, AppState>, id: Uuid) -> Result<(), String> {
    state
        .profiles
        .delete_command_snippet(id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_layout_settings(state: State<'_, AppState>) -> Result<LayoutSettings, String> {
    state
        .profiles
        .get_layout_settings()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_layout_settings(
    state: State<'_, AppState>,
    settings: LayoutSettings,
) -> Result<LayoutSettings, String> {
    state
        .profiles
        .save_layout_settings(settings)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn write_terminal(
    state: State<'_, AppState>,
    session_id: Uuid,
    data: String,
) -> Result<(), String> {
    let before = state
        .sessions
        .session_diagnostics(session_id)
        .unwrap_or_else(|error| error.to_string());
    state
        .sessions
        .write_terminal(session_id, data.clone())
        .await
        .map_err(|error| error.to_string())?;
    let after = state
        .sessions
        .session_diagnostics(session_id)
        .unwrap_or_else(|error| error.to_string());
    state.audit.record(
        "user",
        Some(session_id),
        AuditAction::TerminalCommand,
        "terminal input",
        Some("allow".to_string()),
        format!(
            "wrote {} bytes to terminal; before: {before}; after: {after}",
            data.len()
        ),
    );
    Ok(())
}

#[tauri::command]
fn session_diagnostics(state: State<'_, AppState>, session_id: Uuid) -> Result<String, String> {
    state
        .sessions
        .session_diagnostics(session_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn terminal_output_tail(
    state: State<'_, AppState>,
    session_id: Uuid,
    max_chunks: Option<usize>,
) -> Result<String, String> {
    state
        .sessions
        .output_tail(session_id, max_chunks.unwrap_or(200))
        .map(|chunks| chunks.concat())
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn collect_system_snapshot(
    state: State<'_, AppState>,
    session_id: Uuid,
) -> Result<SystemSnapshot, String> {
    let snapshot = state
        .sessions
        .collect_system_snapshot(session_id)
        .await
        .map_err(|error| error.to_string())?;

    let detected_os = snapshot.host.os_name.trim();
    if !detected_os.is_empty() {
        if let Some(mut profile) = state
            .profiles
            .get_profile(session_id)
            .map_err(|error| error.to_string())?
        {
            if profile.operating_system.as_deref() != Some(detected_os) {
                profile.operating_system = Some(detected_os.to_string());
                state
                    .profiles
                    .upsert_profile(profile)
                    .map_err(|error| error.to_string())?;
            }
        }
    }

    Ok(snapshot)
}

#[tauri::command]
async fn measure_latency(host: String, port: u16, use_icmp: bool) -> Result<Option<f64>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if use_icmp {
            Ok(measure_icmp_latency_ms(&host).or_else(|| measure_tcp_latency_ms(&host, port)))
        } else {
            Ok(measure_tcp_latency_ms(&host, port))
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn measure_session_latency(
    state: State<'_, AppState>,
    session_id: Uuid,
) -> Result<Option<f64>, String> {
    state
        .sessions
        .measure_terminal_latency(session_id)
        .await
        .map_err(|error| error.to_string())
}

fn measure_tcp_latency_ms(host: &str, port: u16) -> Option<f64> {
    let address = (host, port).to_socket_addrs().ok()?.next()?;
    let started = Instant::now();
    TcpStream::connect_timeout(&address, Duration::from_millis(1500)).ok()?;
    Some(started.elapsed().as_secs_f64() * 1000.0)
}

fn measure_icmp_latency_ms(host: &str) -> Option<f64> {
    let started = Instant::now();
    let output = if cfg!(target_os = "windows") {
        run_probe_command("ping", &["-n", "1", "-w", "1500", host])?
    } else if cfg!(target_os = "macos") {
        run_probe_command("ping", &["-c", "1", "-W", "1500", host])?
    } else {
        run_probe_command("ping", &["-c", "1", "-W", "2", host])?
    };
    if !output.status.success() {
        return None;
    }
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    parse_ping_latency_ms(&text).or_else(|| Some(started.elapsed().as_secs_f64() * 1000.0))
}

fn run_probe_command(program: &str, args: &[&str]) -> Option<Output> {
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command.output().ok()
}

fn parse_ping_latency_ms(output: &str) -> Option<f64> {
    for marker in ["time=", "time<", "时间=", "时间<", "時間=", "時間<"] {
        if let Some(index) = output.find(marker) {
            let rest = &output[index + marker.len()..];
            let number = rest
                .chars()
                .skip_while(|char| char.is_whitespace())
                .take_while(|char| char.is_ascii_digit() || *char == '.')
                .collect::<String>();
            if let Ok(value) = number.parse::<f64>() {
                return Some(value.max(0.1));
            }
        }
    }
    None
}

#[tauri::command]
async fn sftp_list_directory(
    state: State<'_, AppState>,
    session_id: Uuid,
    path: String,
) -> Result<RemoteDirectoryListing, String> {
    state
        .sessions
        .list_sftp_directory(session_id, path)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn sftp_create_dir(
    state: State<'_, AppState>,
    session_id: Uuid,
    path: String,
) -> Result<(), String> {
    state
        .sessions
        .create_sftp_dir(session_id, path.clone())
        .await
        .map_err(|error| error.to_string())?;
    state.audit.record(
        "user",
        Some(session_id),
        AuditAction::SftpWrite,
        path,
        Some("allow".to_string()),
        "created remote directory",
    );
    Ok(())
}

#[tauri::command]
async fn sftp_delete_path(
    state: State<'_, AppState>,
    session_id: Uuid,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    state
        .sessions
        .delete_sftp_path(session_id, path.clone(), is_dir)
        .await
        .map_err(|error| error.to_string())?;
    state.audit.record(
        "user",
        Some(session_id),
        AuditAction::SftpWrite,
        path,
        Some("allow".to_string()),
        if is_dir {
            "deleted remote directory"
        } else {
            "deleted remote file"
        },
    );
    Ok(())
}

#[tauri::command]
async fn sftp_rename_path(
    state: State<'_, AppState>,
    session_id: Uuid,
    from: String,
    to: String,
) -> Result<(), String> {
    state
        .sessions
        .rename_sftp_path(session_id, from.clone(), to.clone())
        .await
        .map_err(|error| error.to_string())?;
    state.audit.record(
        "user",
        Some(session_id),
        AuditAction::SftpWrite,
        to,
        Some("allow".to_string()),
        format!("renamed remote path from {from}"),
    );
    Ok(())
}

#[tauri::command]
async fn sftp_download_file(
    state: State<'_, AppState>,
    session_id: Uuid,
    transfer_id: Uuid,
    remote_path: String,
    local_path: String,
) -> Result<SftpProgress, String> {
    let progress = state
        .sessions
        .download_sftp_file(
            session_id,
            transfer_id,
            remote_path.clone(),
            local_path.clone(),
        )
        .await
        .map_err(|error| error.to_string())?;
    state.audit.record(
        "user",
        Some(session_id),
        AuditAction::SftpWrite,
        remote_path,
        Some("allow".to_string()),
        format!("downloaded remote file to {local_path}"),
    );
    Ok(progress)
}

#[tauri::command]
async fn sftp_upload_file(
    state: State<'_, AppState>,
    session_id: Uuid,
    transfer_id: Uuid,
    local_path: String,
    remote_path: String,
) -> Result<SftpProgress, String> {
    let progress = state
        .sessions
        .upload_sftp_file(
            session_id,
            transfer_id,
            local_path.clone(),
            remote_path.clone(),
        )
        .await
        .map_err(|error| error.to_string())?;
    state.audit.record(
        "user",
        Some(session_id),
        AuditAction::SftpWrite,
        remote_path,
        Some("allow".to_string()),
        format!("uploaded local file from {local_path}"),
    );
    Ok(progress)
}

#[tauri::command]
fn cancel_sftp_transfer(state: State<'_, AppState>, transfer_id: Uuid) -> Result<(), String> {
    state.sessions.cancel_sftp_transfer(transfer_id);
    Ok(())
}

#[tauri::command]
fn reveal_local_path(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    let existing_target = if target.exists() {
        target
    } else {
        target
            .parent()
            .ok_or_else(|| "local path does not exist".to_string())?
    };

    #[cfg(target_os = "windows")]
    {
        let argument = if target.exists() && target.is_file() {
            format!("/select,{}", existing_target.display())
        } else {
            existing_target.display().to_string()
        };
        Command::new("explorer")
            .arg(argument)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if target.exists() && target.is_file() {
            command.arg("-R").arg(existing_target);
        } else {
            command.arg(existing_target);
        }
        command.spawn().map_err(|error| error.to_string())?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let directory = if existing_target.is_file() {
            existing_target
                .parent()
                .ok_or_else(|| "local path parent does not exist".to_string())?
        } else {
            existing_target
        };
        Command::new("xdg-open")
            .arg(directory)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn delete_local_file(path: String) -> Result<(), String> {
    let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("local path is not a file".to_string());
    }
    std::fs::remove_file(&path).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_assistants(state: State<'_, AppState>) -> Vec<joyshell_agent::AssistantDefinition> {
    state.assistants.list().to_vec()
}

#[tauri::command]
fn preview_agent_tool_call(
    state: State<'_, AppState>,
    assistant: String,
    tool_name: String,
    target: String,
    input: Value,
) -> Result<AgentToolCallPreview, String> {
    let assistant_definition = state
        .assistants
        .list()
        .iter()
        .find(|definition| definition.display_name == assistant)
        .ok_or_else(|| "assistant was not found".to_string())?;
    let call = AgentToolCall {
        id: Uuid::new_v4(),
        assistant,
        tool_name,
        target,
        input,
    };
    let decision = state
        .permissions
        .decide(assistant_definition, &state.tools, &call);
    state.audit.record(
        &call.assistant,
        None,
        AuditAction::PermissionDecision,
        &call.target,
        Some(format!("{:?}", decision.behavior)),
        format!("previewed {}", call.tool_name),
    );
    Ok(AgentToolCallPreview {
        id: call.id,
        assistant: call.assistant,
        tool_name: call.tool_name,
        target: call.target,
        decision,
    })
}

#[tauri::command]
fn build_agent_context(
    state: State<'_, AppState>,
    assistant: String,
    session_id: Option<Uuid>,
    query: String,
) -> Result<joyshell_agent::AgentContext, String> {
    let assistant_definition = state
        .assistants
        .list()
        .iter()
        .find(|definition| definition.display_name == assistant)
        .ok_or_else(|| "assistant was not found".to_string())?;
    let builder = ContextBuilder::new(
        state.sessions.clone(),
        state.memories.clone(),
        state.tools.clone(),
    );
    Ok(builder.build(assistant_definition, session_id, &query))
}

#[tauri::command]
fn recent_audit(state: State<'_, AppState>) -> Vec<AuditEntry> {
    state.audit.recent(20)
}

#[tauri::command]
fn write_clipboard_text(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    clipboard.set_text(text).map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let database_path = app.path().app_data_dir()?.join("joyshell.db");
            let app_state = AppState::new(database_path)?;
            let sessions = app_state.sessions.clone();
            app.manage(app_state);
            let app_handle = app.handle().clone();
            let mut events = sessions.subscribe();
            tauri::async_runtime::spawn(async move {
                while let Ok(event) = events.recv().await {
                    let _ = app_handle.emit("session:event", event);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            list_folders,
            save_folder,
            delete_folder,
            delete_profile,
            save_profile,
            list_command_snippets,
            save_command_snippet,
            delete_command_snippet,
            get_layout_settings,
            save_layout_settings,
            connect_profile,
            disconnect_profile,
            write_terminal,
            session_diagnostics,
            terminal_output_tail,
            collect_system_snapshot,
            measure_latency,
            measure_session_latency,
            sftp_list_directory,
            sftp_create_dir,
            sftp_delete_path,
            sftp_rename_path,
            sftp_download_file,
            sftp_upload_file,
            cancel_sftp_transfer,
            reveal_local_path,
            delete_local_file,
            list_assistants,
            preview_agent_tool_call,
            build_agent_context,
            recent_audit,
            write_clipboard_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running Joyshell");
}
