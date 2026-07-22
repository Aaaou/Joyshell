use joyshell_agent::{
    AgentToolCall, AgentToolRegistry, AssistantRegistry, ContextBuilder, PermissionEngine,
};
use joyshell_core::{
    AuthMethod, HostKeyPolicy, RemoteDirectoryListing, SessionInfo, SessionManager, SessionProfile,
    SftpProgress, SystemSnapshot,
};
use joyshell_store::{AuditAction, AuditEntry, AuditLog, MemoryStore, ProfileRepository};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tauri::{Emitter, State};
use uuid::Uuid;

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
}

impl Default for AppState {
    fn default() -> Self {
        let test_profile_id = Uuid::from_u128(0x019f_835c_aef6_7200_9962_e3cbe4957024);
        let test_secret_ref = "secret://test/192.168.110.24/root/password".to_string();
        let profiles = ProfileRepository::with_demo_data();
        profiles.upsert_profile(SessionProfile {
            id: test_profile_id,
            name: "测试服务器 192.168.110.24".to_string(),
            group: Some("测试".to_string()),
            host: "192.168.110.24".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_method: AuthMethod::Password {
                secret_ref: test_secret_ref.clone(),
            },
            host_key_policy: HostKeyPolicy::AcceptNew,
            tags: vec!["test".to_string(), "ubuntu".to_string()],
            favorite: true,
            jump_host_id: None,
        });

        let mut secrets = HashMap::new();
        secrets.insert(test_secret_ref, "yujiarong520".to_string());

        Self {
            profiles,
            sessions: SessionManager::new(),
            assistants: AssistantRegistry::built_in(),
            tools: AgentToolRegistry::built_in(),
            permissions: PermissionEngine::default(),
            memories: MemoryStore::default(),
            audit: AuditLog::default(),
            secrets: Arc::new(RwLock::new(secrets)),
        }
    }
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
fn list_profiles(state: State<'_, AppState>) -> Vec<SessionProfile> {
    state.profiles.list_profiles()
}

#[tauri::command]
fn save_profile(state: State<'_, AppState>, payload: SaveProfilePayload) -> SessionProfile {
    let profile = payload.profile;
    if let AuthMethod::Password { secret_ref } = &profile.auth_method {
        if let Some(password) = payload.password.filter(|value| !value.is_empty()) {
            if let Ok(mut secrets) = state.secrets.write() {
                secrets.insert(secret_ref.clone(), password);
            }
        }
    }
    state.profiles.upsert_profile(profile.clone());
    state.audit.record(
        "user",
        Some(profile.id),
        AuditAction::AgentToolCall,
        format!("{}@{}:{}", profile.username, profile.host, profile.port),
        Some("allow".to_string()),
        "saved SSH profile",
    );
    profile
}

#[tauri::command]
async fn connect_profile(
    state: State<'_, AppState>,
    profile_id: Uuid,
) -> Result<SessionInfo, String> {
    let profile = state
        .profiles
        .get_profile(profile_id)
        .ok_or_else(|| "profile was not found".to_string())?;
    let password = match &profile.auth_method {
        AuthMethod::Password { secret_ref } => state
            .secrets
            .read()
            .map_err(|_| "secret store is unavailable".to_string())?
            .get(secret_ref)
            .cloned()
            .ok_or_else(|| {
                "password is missing; open SSH settings and save it again".to_string()
            })?,
        AuthMethod::PrivateKey { .. } => {
            return Err("private key authentication is not implemented yet".to_string())
        }
        AuthMethod::Agent => {
            return Err("SSH agent authentication is not implemented yet".to_string())
        }
    };
    let handle = state
        .sessions
        .connect_ssh_password(profile.clone(), password)
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
    state
        .sessions
        .collect_system_snapshot(session_id)
        .await
        .map_err(|error| error.to_string())
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

pub fn run() {
    let app_state = AppState::default();
    let sessions = app_state.sessions.clone();

    tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
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
            save_profile,
            connect_profile,
            write_terminal,
            session_diagnostics,
            terminal_output_tail,
            collect_system_snapshot,
            sftp_list_directory,
            sftp_create_dir,
            sftp_delete_path,
            sftp_rename_path,
            sftp_download_file,
            sftp_upload_file,
            cancel_sftp_transfer,
            list_assistants,
            preview_agent_tool_call,
            build_agent_context,
            recent_audit
        ])
        .run(tauri::generate_context!())
        .expect("error while running Joyshell");
}
