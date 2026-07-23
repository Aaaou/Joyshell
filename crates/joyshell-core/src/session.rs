use chrono::{DateTime, Utc};
use mio::net::TcpStream as MioTcpStream;
use mio::{Events, Interest, Poll, Token};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::{
    FileTransferDirection, RemoteDirectoryListing, RemoteFileEntry, SftpProgress, TransferStatus,
};

pub type SessionId = Uuid;

const SSH_CONNECT_TIMEOUT_SECS: u64 = 15;
const SSH_OPERATION_TIMEOUT_MS: u32 = 15_000;
const SSH_KEEPALIVE_INTERVAL_SECS: u32 = 20;
const SYSTEM_SYNC_TIMEOUT_MS: u32 = 8_000;
const SYSTEM_SYNC_MAX_ATTEMPTS: u32 = 2;
const SFTP_TRANSFER_TIMEOUT_MS: u32 = 60_000;
const SFTP_TRANSFER_MAX_ATTEMPTS: u32 = 4;
const SFTP_TRANSFER_BACKOFF_MS: u64 = 900;
const SFTP_TRANSFER_BUFFER_SIZE: usize = 128 * 1024;
const SFTP_PROGRESS_MIN_INTERVAL_MS: u64 = 120;
const SFTP_PROGRESS_MIN_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum HostKeyPolicy {
    Strict,
    AcceptNew,
    InsecureAcceptAny,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AuthMethod {
    Password {
        secret_ref: String,
    },
    PrivateKey {
        key_ref: String,
        passphrase_ref: Option<String>,
    },
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionProfile {
    pub id: SessionId,
    pub name: String,
    pub group: Option<String>,
    pub host: String,
    pub port: u16,
    pub latency_probe_host: Option<String>,
    pub latency_probe_port: Option<u16>,
    pub username: String,
    pub auth_method: AuthMethod,
    pub host_key_policy: HostKeyPolicy,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub sort_order: i64,
    pub jump_host_id: Option<SessionId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Failed { reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: SessionId,
    pub profile_name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub state: ConnectionState,
    pub connected_at: Option<DateTime<Utc>>,
    pub last_seen_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadAverage {
    pub one: f64,
    pub five: f64,
    pub fifteen: f64,
    pub runnable_processes: u64,
    pub total_processes: u64,
    pub last_pid: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpuTimes {
    pub user: u64,
    pub nice: u64,
    pub system: u64,
    pub idle: u64,
    pub iowait: u64,
    pub irq: u64,
    pub softirq: u64,
    pub steal: u64,
    pub guest: u64,
    pub guest_nice: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpuCoreSample {
    pub name: String,
    pub times: CpuTimes,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpuInfoSample {
    pub model_name: String,
    pub raw_part: Option<String>,
    pub logical_cores: u64,
    pub physical_cores: Option<u64>,
    pub mhz: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemorySample {
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub free_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryInfoSample {
    pub frequency_mhz: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkInterfaceSample {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub rx_packets: u64,
    pub tx_packets: u64,
    pub rx_errors: u64,
    pub tx_errors: u64,
    pub ipv4_addresses: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSystemSample {
    pub filesystem: String,
    pub fs_type: String,
    pub mount_point: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
    pub used_percent: f64,
    pub inode_total: Option<u64>,
    pub inode_used: Option<u64>,
    pub inode_available: Option<u64>,
    pub inode_used_percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostInfoSample {
    pub hostname: String,
    pub os_name: String,
    pub kernel_name: String,
    pub kernel_release: String,
    pub architecture: String,
    pub primary_ip: Option<String>,
    pub device_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessSample {
    pub total: u64,
    pub running: u64,
    pub sleeping: u64,
    pub stopped: u64,
    pub zombie: u64,
    pub threads: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemSnapshot {
    pub captured_at: DateTime<Utc>,
    pub host: HostInfoSample,
    pub uptime_seconds: f64,
    pub load: LoadAverage,
    pub cpu: CpuTimes,
    pub cpu_cores: Vec<CpuCoreSample>,
    pub cpu_info: CpuInfoSample,
    pub memory: MemorySample,
    pub memory_info: MemoryInfoSample,
    pub swap: MemorySample,
    pub processes: ProcessSample,
    pub network: Vec<NetworkInterfaceSample>,
    pub filesystems: Vec<FileSystemSample>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SessionEvent {
    StateChanged {
        session_id: SessionId,
        state: ConnectionState,
    },
    TerminalOutput {
        session_id: SessionId,
        data: String,
    },
    SftpProgress(super::sftp::SftpProgress),
}

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("session was not found: {0}")]
    NotFound(SessionId),
    #[error("session is not connected: {0}")]
    NotConnected(SessionId),
    #[error("ssh connection failed: {0}")]
    ConnectionFailed(String),
}

struct SessionRuntime {
    info: SessionInfo,
    profile: SessionProfile,
    password: String,
    output_tail: VecDeque<String>,
    ssh: Option<SshRuntime>,
    runtime_token: Uuid,
    last_transient_io: Option<String>,
}

struct SshRuntime {
    control: Sender<SshControl>,
    _thread: JoinHandle<()>,
}

enum SshControl {
    Terminal(Vec<u8>),
}

enum SideTransferError {
    Connect(String),
    Transfer(String),
}

#[derive(Clone)]
pub struct SshSessionHandle {
    id: SessionId,
    manager: SessionManager,
}

impl SshSessionHandle {
    pub fn id(&self) -> SessionId {
        self.id
    }

    pub async fn write_terminal(&self, data: String) -> Result<(), SessionError> {
        self.manager.write_terminal(self.id, data).await
    }

    pub fn output_tail(&self, max_chunks: usize) -> Result<Vec<String>, SessionError> {
        self.manager.output_tail(self.id, max_chunks)
    }
}

#[derive(Clone)]
pub struct SessionManager {
    sessions: Arc<RwLock<HashMap<SessionId, SessionRuntime>>>,
    events: broadcast::Sender<SessionEvent>,
    cancelled_transfers: Arc<RwLock<HashSet<Uuid>>>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionManager {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(4096);
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            events,
            cancelled_transfers: Arc::new(RwLock::new(HashSet::new())),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.events.subscribe()
    }

    pub async fn connect_ssh_password(
        &self,
        profile: SessionProfile,
        password: String,
    ) -> Result<SshSessionHandle, SessionError> {
        let now = Utc::now();
        let connecting_info = SessionInfo {
            id: profile.id,
            profile_name: profile.name.clone(),
            host: profile.host.clone(),
            port: profile.port,
            username: profile.username.clone(),
            state: ConnectionState::Connecting,
            connected_at: None,
            last_seen_at: now,
        };

        self.sessions.write().insert(
            profile.id,
            SessionRuntime {
                info: connecting_info,
                profile: profile.clone(),
                password: password.clone(),
                output_tail: VecDeque::new(),
                ssh: None,
                runtime_token: Uuid::new_v4(),
                last_transient_io: None,
            },
        );
        let _ = self.events.send(SessionEvent::StateChanged {
            session_id: profile.id,
            state: ConnectionState::Connecting,
        });
        self.push_output(
            profile.id,
            format!(
                "Connecting to {}@{}:{}...\r\n",
                profile.username, profile.host, profile.port
            ),
        );

        let session_id = profile.id;
        let profile_for_connect = profile.clone();
        let password_for_connect = password.clone();
        let connect_result = tokio::task::spawn_blocking(move || {
            establish_ssh_session(&profile_for_connect, &password_for_connect)
        })
        .await
        .map_err(|error| SessionError::ConnectionFailed(error.to_string()))?;

        match connect_result {
            Ok((session, channel, wait_socket)) => {
                let (control, control_rx) = mpsc::channel();
                let runtime_token = Uuid::new_v4();
                let manager = self.clone();
                let thread = std::thread::spawn(move || {
                    run_ssh_session_loop(
                        session_id,
                        runtime_token,
                        session,
                        channel,
                        wait_socket,
                        control_rx,
                        manager,
                    );
                });

                let info = {
                    let mut sessions = self.sessions.write();
                    let runtime = sessions
                        .get_mut(&session_id)
                        .ok_or(SessionError::NotFound(session_id))?;
                    runtime.info.state = ConnectionState::Connected;
                    runtime.info.connected_at = Some(Utc::now());
                    runtime.info.last_seen_at = Utc::now();
                    runtime.ssh = Some(SshRuntime {
                        control,
                        _thread: thread,
                    });
                    runtime.runtime_token = runtime_token;
                    runtime.info.clone()
                };

                let _ = self.events.send(SessionEvent::StateChanged {
                    session_id,
                    state: ConnectionState::Connected,
                });
                self.push_output(session_id, "Connected. Shell ready.\r\n".to_string());
                tokio::time::sleep(Duration::from_millis(700)).await;
                Ok(SshSessionHandle {
                    id: info.id,
                    manager: self.clone(),
                })
            }
            Err(error) => {
                let reason = error.to_string();
                if let Some(runtime) = self.sessions.write().get_mut(&session_id) {
                    runtime.info.state = ConnectionState::Failed {
                        reason: reason.clone(),
                    };
                    runtime.info.last_seen_at = Utc::now();
                }
                let _ = self.events.send(SessionEvent::StateChanged {
                    session_id,
                    state: ConnectionState::Failed {
                        reason: reason.clone(),
                    },
                });
                self.push_output(session_id, format!("SSH connection failed: {reason}\r\n"));
                Err(SessionError::ConnectionFailed(reason))
            }
        }
    }

    pub async fn disconnect(&self, session_id: SessionId) -> Result<(), SessionError> {
        let mut sessions = self.sessions.write();
        let runtime = sessions
            .get_mut(&session_id)
            .ok_or(SessionError::NotFound(session_id))?;
        runtime.info.state = ConnectionState::Disconnected;
        runtime.info.last_seen_at = Utc::now();
        let _ = self.events.send(SessionEvent::StateChanged {
            session_id,
            state: ConnectionState::Disconnected,
        });
        Ok(())
    }

    pub async fn write_terminal(
        &self,
        session_id: SessionId,
        data: String,
    ) -> Result<(), SessionError> {
        let mut sessions = self.sessions.write();
        let runtime = sessions
            .get_mut(&session_id)
            .ok_or(SessionError::NotFound(session_id))?;

        runtime.info.last_seen_at = Utc::now();

        if let Some(ssh) = runtime.ssh.as_mut() {
            ssh.control
                .send(SshControl::Terminal(data.into_bytes()))
                .map_err(|_| {
                    SessionError::ConnectionFailed("terminal channel is closed".to_string())
                })?;
            if runtime.info.state != ConnectionState::Connected {
                runtime.info.state = ConnectionState::Connected;
                let _ = self.events.send(SessionEvent::StateChanged {
                    session_id,
                    state: ConnectionState::Connected,
                });
            }
            return Ok(());
        }

        if runtime.info.state != ConnectionState::Connected {
            return Err(SessionError::NotConnected(session_id));
        }

        Err(SessionError::ConnectionFailed(
            "terminal channel is not available".to_string(),
        ))
    }

    pub async fn collect_system_snapshot(
        &self,
        session_id: SessionId,
    ) -> Result<SystemSnapshot, SessionError> {
        let (profile, password) = self.side_connection_credentials(session_id)?;
        tokio::task::spawn_blocking(move || {
            let (session, wait_socket) = establish_ssh_side_session(&profile, &password)?;
            let mut socket_waiter = SocketWaiter::new(wait_socket);
            collect_system_snapshot_with_retry(&session, &mut socket_waiter)
        })
        .await
        .map_err(|error| SessionError::ConnectionFailed(error.to_string()))?
        .map_err(|error| SessionError::ConnectionFailed(error.to_string()))
    }

    pub async fn list_sftp_directory(
        &self,
        session_id: SessionId,
        path: String,
    ) -> Result<RemoteDirectoryListing, SessionError> {
        let (profile, password) = self.side_connection_credentials(session_id)?;
        tokio::task::spawn_blocking(move || {
            let (session, _wait_socket) = establish_ssh_side_session(&profile, &password)?;
            list_sftp_directory_from_ssh(&session, &path)
        })
        .await
        .map_err(|error| SessionError::ConnectionFailed(error.to_string()))?
        .map_err(|error| SessionError::ConnectionFailed(error.to_string()))
    }

    pub async fn create_sftp_dir(
        &self,
        session_id: SessionId,
        path: String,
    ) -> Result<(), SessionError> {
        let (profile, password) = self.side_connection_credentials(session_id)?;
        tokio::task::spawn_blocking(move || {
            let (session, _wait_socket) = establish_ssh_side_session(&profile, &password)?;
            create_sftp_dir_from_ssh(&session, &path)
        })
        .await
        .map_err(|error| SessionError::ConnectionFailed(error.to_string()))?
        .map_err(|error| SessionError::ConnectionFailed(error.to_string()))
    }

    pub async fn delete_sftp_path(
        &self,
        session_id: SessionId,
        path: String,
        is_dir: bool,
    ) -> Result<(), SessionError> {
        let (profile, password) = self.side_connection_credentials(session_id)?;
        tokio::task::spawn_blocking(move || {
            let (session, _wait_socket) = establish_ssh_side_session(&profile, &password)?;
            delete_sftp_path_from_ssh(&session, &path, is_dir)
        })
        .await
        .map_err(|error| SessionError::ConnectionFailed(error.to_string()))?
        .map_err(|error| SessionError::ConnectionFailed(error.to_string()))
    }

    pub async fn rename_sftp_path(
        &self,
        session_id: SessionId,
        from: String,
        to: String,
    ) -> Result<(), SessionError> {
        let (profile, password) = self.side_connection_credentials(session_id)?;
        tokio::task::spawn_blocking(move || {
            let (session, _wait_socket) = establish_ssh_side_session(&profile, &password)?;
            rename_sftp_path_from_ssh(&session, &from, &to)
        })
        .await
        .map_err(|error| SessionError::ConnectionFailed(error.to_string()))?
        .map_err(|error| SessionError::ConnectionFailed(error.to_string()))
    }

    pub async fn download_sftp_file(
        &self,
        session_id: SessionId,
        transfer_id: Uuid,
        remote_path: String,
        local_path: String,
    ) -> Result<SftpProgress, SessionError> {
        let (profile, password) = self.side_connection_credentials(session_id)?;
        self.clear_cancelled_transfer(transfer_id);
        let manager = self.clone();
        let progress_remote_path = remote_path.clone();
        let progress_local_path = local_path.clone();
        let transfer_result = tokio::task::spawn_blocking(move || {
            let (session, _wait_socket) = establish_ssh_side_session(&profile, &password)
                .map_err(|error| SideTransferError::Connect(error.to_string()))?;
            download_sftp_file_from_ssh(
                &session,
                session_id,
                transfer_id,
                &remote_path,
                &local_path,
                &manager,
            )
            .map_err(|error| SideTransferError::Transfer(error.to_string()))
        })
        .await
        .map_err(|error| SessionError::ConnectionFailed(error.to_string()))?;

        match transfer_result {
            Ok(progress) => Ok(progress),
            Err(SideTransferError::Connect(reason)) => {
                self.clear_cancelled_transfer(transfer_id);
                emit_failed_sftp_progress(
                    self,
                    session_id,
                    transfer_id,
                    FileTransferDirection::Download,
                    &progress_local_path,
                    &progress_remote_path,
                    std::fs::metadata(&progress_local_path)
                        .ok()
                        .map(|metadata| metadata.len())
                        .unwrap_or(0),
                    None,
                    reason.clone(),
                );
                Err(SessionError::ConnectionFailed(reason))
            }
            Err(SideTransferError::Transfer(reason)) => Err(SessionError::ConnectionFailed(reason)),
        }
    }

    pub async fn upload_sftp_file(
        &self,
        session_id: SessionId,
        transfer_id: Uuid,
        local_path: String,
        remote_path: String,
    ) -> Result<SftpProgress, SessionError> {
        let (profile, password) = self.side_connection_credentials(session_id)?;
        self.clear_cancelled_transfer(transfer_id);
        let manager = self.clone();
        let progress_remote_path = remote_path.clone();
        let progress_local_path = local_path.clone();
        let upload_total = std::fs::metadata(&progress_local_path)
            .ok()
            .map(|metadata| metadata.len());
        let transfer_result = tokio::task::spawn_blocking(move || {
            let (session, _wait_socket) = establish_ssh_side_session(&profile, &password)
                .map_err(|error| SideTransferError::Connect(error.to_string()))?;
            upload_sftp_file_from_ssh(
                &session,
                session_id,
                transfer_id,
                &local_path,
                &remote_path,
                &manager,
            )
            .map_err(|error| SideTransferError::Transfer(error.to_string()))
        })
        .await
        .map_err(|error| SessionError::ConnectionFailed(error.to_string()))?;

        match transfer_result {
            Ok(progress) => Ok(progress),
            Err(SideTransferError::Connect(reason)) => {
                self.clear_cancelled_transfer(transfer_id);
                emit_failed_sftp_progress(
                    self,
                    session_id,
                    transfer_id,
                    FileTransferDirection::Upload,
                    &progress_local_path,
                    &progress_remote_path,
                    0,
                    upload_total,
                    reason.clone(),
                );
                Err(SessionError::ConnectionFailed(reason))
            }
            Err(SideTransferError::Transfer(reason)) => Err(SessionError::ConnectionFailed(reason)),
        }
    }

    pub fn cancel_sftp_transfer(&self, transfer_id: Uuid) {
        self.cancelled_transfers.write().insert(transfer_id);
    }

    fn clear_cancelled_transfer(&self, transfer_id: Uuid) {
        self.cancelled_transfers.write().remove(&transfer_id);
    }

    fn is_transfer_cancelled(&self, transfer_id: Uuid) -> bool {
        self.cancelled_transfers.read().contains(&transfer_id)
    }

    fn side_connection_credentials(
        &self,
        session_id: SessionId,
    ) -> Result<(SessionProfile, String), SessionError> {
        let sessions = self.sessions.read();
        let runtime = sessions
            .get(&session_id)
            .ok_or(SessionError::NotFound(session_id))?;
        if runtime.info.state != ConnectionState::Connected || runtime.ssh.is_none() {
            return Err(SessionError::NotConnected(session_id));
        }
        Ok((runtime.profile.clone(), runtime.password.clone()))
    }

    pub fn session_diagnostics(&self, session_id: SessionId) -> Result<String, SessionError> {
        let sessions = self.sessions.read();
        let runtime = sessions
            .get(&session_id)
            .ok_or(SessionError::NotFound(session_id))?;
        Ok(format!(
            "session={session_id} state={:?} has_ssh={} tail_chunks={} last_transient_io={}",
            runtime.info.state,
            runtime.ssh.is_some(),
            runtime.output_tail.len(),
            runtime.last_transient_io.as_deref().unwrap_or("none")
        ))
    }

    pub fn list_sessions(&self) -> Vec<SessionInfo> {
        self.sessions
            .read()
            .values()
            .map(|runtime| runtime.info.clone())
            .collect()
    }

    pub fn get_session(&self, session_id: SessionId) -> Option<SessionInfo> {
        self.sessions
            .read()
            .get(&session_id)
            .map(|runtime| runtime.info.clone())
    }

    pub fn output_tail(
        &self,
        session_id: SessionId,
        max_chunks: usize,
    ) -> Result<Vec<String>, SessionError> {
        let sessions = self.sessions.read();
        let runtime = sessions
            .get(&session_id)
            .ok_or(SessionError::NotFound(session_id))?;
        Ok(runtime
            .output_tail
            .iter()
            .rev()
            .take(max_chunks)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect())
    }

    fn push_output(&self, session_id: SessionId, data: String) {
        if let Some(runtime) = self.sessions.write().get_mut(&session_id) {
            runtime.info.last_seen_at = Utc::now();
            runtime.output_tail.push_back(data.clone());
            while runtime.output_tail.len() > 200 {
                runtime.output_tail.pop_front();
            }
        }
        let _ = self
            .events
            .send(SessionEvent::TerminalOutput { session_id, data });
    }

    fn push_output_for_runtime(&self, session_id: SessionId, runtime_token: Uuid, data: String) {
        let should_emit = if let Some(runtime) = self.sessions.write().get_mut(&session_id) {
            if runtime.runtime_token != runtime_token {
                false
            } else {
                runtime.info.last_seen_at = Utc::now();
                runtime.output_tail.push_back(data.clone());
                while runtime.output_tail.len() > 200 {
                    runtime.output_tail.pop_front();
                }
                true
            }
        } else {
            false
        };

        if should_emit {
            let _ = self
                .events
                .send(SessionEvent::TerminalOutput { session_id, data });
        }
    }

    fn fail_session_for_runtime(&self, session_id: SessionId, runtime_token: Uuid, reason: String) {
        let should_emit = if let Some(runtime) = self.sessions.write().get_mut(&session_id) {
            if runtime.runtime_token != runtime_token {
                false
            } else {
                runtime.info.state = ConnectionState::Failed {
                    reason: reason.clone(),
                };
                runtime.info.last_seen_at = Utc::now();
                runtime.ssh = None;
                true
            }
        } else {
            false
        };

        if should_emit {
            let _ = self.events.send(SessionEvent::StateChanged {
                session_id,
                state: ConnectionState::Failed {
                    reason: reason.clone(),
                },
            });
            self.push_output_for_runtime(session_id, runtime_token, format!("\r\n[{reason}]\r\n"));
        }
    }

    fn disconnect_session_for_runtime(
        &self,
        session_id: SessionId,
        runtime_token: Uuid,
        reason: String,
    ) {
        let should_emit = if let Some(runtime) = self.sessions.write().get_mut(&session_id) {
            if runtime.runtime_token != runtime_token {
                false
            } else {
                runtime.info.state = ConnectionState::Disconnected;
                runtime.info.last_seen_at = Utc::now();
                runtime.ssh = None;
                true
            }
        } else {
            false
        };

        if should_emit {
            let _ = self.events.send(SessionEvent::StateChanged {
                session_id,
                state: ConnectionState::Disconnected,
            });
            self.push_output_for_runtime(session_id, runtime_token, format!("\r\n[{reason}]\r\n"));
        }
    }

    fn record_transient_io_for_runtime(
        &self,
        session_id: SessionId,
        runtime_token: Uuid,
        phase: &str,
        error: &std::io::Error,
        block_directions: ssh2::BlockDirections,
    ) {
        if let Some(runtime) = self.sessions.write().get_mut(&session_id) {
            if runtime.runtime_token == runtime_token {
                runtime.last_transient_io = Some(format!(
                    "{phase}: {error}; block_directions={block_directions:?}"
                ));
            }
        }
    }
}

fn run_ssh_session_loop(
    session_id: SessionId,
    runtime_token: Uuid,
    session: ssh2::Session,
    mut channel: ssh2::Channel,
    wait_socket: TcpStream,
    control: Receiver<SshControl>,
    manager: SessionManager,
) {
    let mut buffer = [0_u8; 8192];
    let mut pending_write = Vec::new();
    let mut pending_offset = 0;
    let mut socket_waiter = SocketWaiter::new(wait_socket);

    loop {
        loop {
            match control.try_recv() {
                Ok(SshControl::Terminal(data)) => {
                    pending_write.extend_from_slice(&data);
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }

        if !drain_channel_output(
            &session,
            &mut channel,
            &mut buffer,
            session_id,
            runtime_token,
            &manager,
        ) {
            return;
        }

        while pending_offset < pending_write.len() {
            match channel.write(&pending_write[pending_offset..]) {
                Ok(0) => break,
                Ok(written) => pending_offset += written,
                Err(error) if is_transient_ssh_io_error(&error) => {
                    manager.record_transient_io_for_runtime(
                        session_id,
                        runtime_token,
                        "write",
                        &error,
                        session.block_directions(),
                    );
                    socket_waiter.wait(&session, Duration::from_millis(20));
                    break;
                }
                Err(error) => {
                    manager.fail_session_for_runtime(
                        session_id,
                        runtime_token,
                        format!("terminal write failed: {error}"),
                    );
                    return;
                }
            }
        }

        if pending_offset == pending_write.len() {
            pending_write.clear();
            pending_offset = 0;
            if let Err(error) = channel.flush() {
                if !is_transient_ssh_io_error(&error) {
                    manager.fail_session_for_runtime(
                        session_id,
                        runtime_token,
                        format!("terminal flush failed: {error}"),
                    );
                    return;
                }
                manager.record_transient_io_for_runtime(
                    session_id,
                    runtime_token,
                    "flush",
                    &error,
                    session.block_directions(),
                );
                socket_waiter.wait(&session, Duration::from_millis(20));
            }
        } else if pending_offset > 0 {
            pending_write.drain(..pending_offset);
            pending_offset = 0;
        }

        if !drain_channel_output(
            &session,
            &mut channel,
            &mut buffer,
            session_id,
            runtime_token,
            &manager,
        ) {
            return;
        }

        socket_waiter.wait(&session, Duration::from_millis(10));
        let _ = session.keepalive_send();
    }
}

fn drain_channel_output(
    session: &ssh2::Session,
    channel: &mut ssh2::Channel,
    buffer: &mut [u8],
    session_id: SessionId,
    runtime_token: Uuid,
    manager: &SessionManager,
) -> bool {
    for _ in 0..64 {
        match channel.read(buffer) {
            Ok(0) => {
                if channel.eof() {
                    manager.disconnect_session_for_runtime(
                        session_id,
                        runtime_token,
                        "remote shell closed".to_string(),
                    );
                    return false;
                }
                return true;
            }
            Ok(read) => {
                let data = String::from_utf8_lossy(&buffer[..read]).to_string();
                manager.push_output_for_runtime(session_id, runtime_token, data);
            }
            Err(error) if is_transient_ssh_io_error(&error) => {
                manager.record_transient_io_for_runtime(
                    session_id,
                    runtime_token,
                    "read",
                    &error,
                    session.block_directions(),
                );
                return true;
            }
            Err(error) => {
                manager.fail_session_for_runtime(
                    session_id,
                    runtime_token,
                    format!("terminal read failed: {error}"),
                );
                return false;
            }
        }
    }

    true
}

fn collect_system_snapshot_from_ssh(
    session: &ssh2::Session,
    socket_waiter: &mut SocketWaiter,
) -> anyhow::Result<SystemSnapshot> {
    let script = [
        "LC_ALL=C",
        "printf '__JOYSHELL_HOST__\\n'",
        "hostname 2>/dev/null || uname -n",
        "uname -s 2>/dev/null || true",
        "uname -r 2>/dev/null || true",
        "uname -m 2>/dev/null || true",
        r#"if [ -r /etc/os-release ]; then . /etc/os-release; printf '%s\n' "${PRETTY_NAME:-${NAME:-}}"; else uname -s; fi"#,
        r#"ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true"#,
        r#"if [ -r /sys/firmware/devicetree/base/model ]; then tr -d '\000' < /sys/firmware/devicetree/base/model; printf '\n'; elif [ -r /proc/device-tree/model ]; then tr -d '\000' < /proc/device-tree/model; printf '\n'; else true; fi"#,
        "printf '__JOYSHELL_STAT__\\n'",
        "cat /proc/stat",
        "printf '__JOYSHELL_CPUINFO__\\n'",
        "cat /proc/cpuinfo 2>/dev/null || true",
        r#"for f in /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq; do if [ -r "$f" ]; then awk '{printf "cpu MHz\t: %.3f\n", $1/1000}' "$f"; break; fi; done"#,
        "printf '__JOYSHELL_MEMINFO__\\n'",
        "cat /proc/meminfo",
        "printf '__JOYSHELL_MEM_DMI__\\n'",
        r#"if command -v dmidecode >/dev/null 2>&1; then dmidecode -t memory 2>/dev/null | awk -F: '/^[[:space:]]*Configured Memory Speed:/ {gsub(/^[ \t]+|[ \t]+$/, "", $2); if($2 !~ /Unknown|Not Installed/ && $2 != "") print $2} /^[[:space:]]*Speed:/ {gsub(/^[ \t]+|[ \t]+$/, "", $2); if($2 !~ /Unknown|Not Installed/ && $2 != "") print $2}' | head -n 8; fi"#,
        "printf '__JOYSHELL_LOADAVG__\\n'",
        "cat /proc/loadavg",
        "printf '__JOYSHELL_UPTIME__\\n'",
        "cat /proc/uptime",
        "printf '__JOYSHELL_PROCESSES__\\n'",
        r#"ps -eo stat= 2>/dev/null | awk 'BEGIN{total=0;running=0;sleeping=0;stopped=0;zombie=0} {total++; s=substr($1,1,1); if(s=="R")running++; else if(s=="S" || s=="D" || s=="I")sleeping++; else if(s=="T" || s=="t")stopped++; else if(s=="Z")zombie++} END{printf "total=%d running=%d sleeping=%d stopped=%d zombie=%d\n",total,running,sleeping,stopped,zombie}' || true"#,
        r#"printf 'threads='; ps -eLo pid= 2>/dev/null | wc -l || printf '0\n'"#,
        "printf '__JOYSHELL_NETDEV__\\n'",
        "cat /proc/net/dev",
        "printf '__JOYSHELL_IPADDR__\\n'",
        "ip -o -4 addr show 2>/dev/null || true",
        "printf '__JOYSHELL_DF__\\n'",
        "df -kPT 2>/dev/null || df -kP",
        "printf '__JOYSHELL_DF_INODE__\\n'",
        "df -iP 2>/dev/null || true",
    ]
    .join("; ");

    let output = exec_ssh_command_blocking_with_timeout(
        session,
        socket_waiter,
        &script,
        SYSTEM_SYNC_TIMEOUT_MS,
    )?;
    parse_system_snapshot(&output)
}

fn collect_system_snapshot_with_retry(
    session: &ssh2::Session,
    socket_waiter: &mut SocketWaiter,
) -> anyhow::Result<SystemSnapshot> {
    let mut last_error = None;
    for attempt in 1..=SYSTEM_SYNC_MAX_ATTEMPTS {
        match collect_system_snapshot_from_ssh(session, socket_waiter) {
            Ok(snapshot) => return Ok(snapshot),
            Err(error) => {
                last_error = Some(error.to_string());
                if attempt < SYSTEM_SYNC_MAX_ATTEMPTS {
                    let _ = session.keepalive_send();
                    socket_waiter.wait(session, Duration::from_millis(250 * u64::from(attempt)));
                }
            }
        }
    }

    anyhow::bail!(
        "system sync failed after {} attempts: {}",
        SYSTEM_SYNC_MAX_ATTEMPTS,
        last_error.unwrap_or_else(|| "unknown sync error".to_string())
    )
}

fn exec_ssh_command_blocking_with_timeout(
    session: &ssh2::Session,
    socket_waiter: &mut SocketWaiter,
    command: &str,
    timeout_ms: u32,
) -> anyhow::Result<String> {
    let previous_timeout = SSH_OPERATION_TIMEOUT_MS;
    session.set_timeout(timeout_ms);
    let result = exec_ssh_command_blocking(session, socket_waiter, command);
    session.set_timeout(previous_timeout);
    result
}

fn exec_ssh_command_blocking(
    session: &ssh2::Session,
    socket_waiter: &mut SocketWaiter,
    command: &str,
) -> anyhow::Result<String> {
    session.set_blocking(true);
    let result: anyhow::Result<String> = (|| {
        let mut channel = session.channel_session()?;
        channel.exec(command)?;
        let mut output = String::new();
        channel.read_to_string(&mut output)?;
        channel.wait_close()?;
        Ok(output)
    })();
    session.set_blocking(false);
    socket_waiter.wait(session, Duration::from_millis(1));
    result
}

fn list_sftp_directory_from_ssh(
    session: &ssh2::Session,
    remote_path: &str,
) -> anyhow::Result<RemoteDirectoryListing> {
    let path = normalize_remote_path(remote_path);
    session.set_blocking(true);
    let result: anyhow::Result<RemoteDirectoryListing> = (|| {
        let sftp = session.sftp()?;
        let mut entries = sftp
            .readdir(Path::new(&path))?
            .into_iter()
            .filter_map(|(entry_path, stat)| remote_entry_from_stat(&path, entry_path, stat))
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| {
            right
                .is_dir
                .cmp(&left.is_dir)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(RemoteDirectoryListing {
            parent: parent_remote_path(&path),
            path,
            entries,
        })
    })();
    session.set_blocking(false);
    result
}

fn create_sftp_dir_from_ssh(session: &ssh2::Session, remote_path: &str) -> anyhow::Result<()> {
    session.set_blocking(true);
    let result: anyhow::Result<()> = (|| {
        let sftp = session.sftp()?;
        sftp.mkdir(Path::new(&normalize_remote_path(remote_path)), 0o755)?;
        Ok(())
    })();
    session.set_blocking(false);
    result
}

fn delete_sftp_path_from_ssh(
    session: &ssh2::Session,
    remote_path: &str,
    is_dir: bool,
) -> anyhow::Result<()> {
    session.set_blocking(true);
    let result: anyhow::Result<()> = (|| {
        let sftp = session.sftp()?;
        let path = normalize_remote_path(remote_path);
        if is_dir {
            sftp.rmdir(Path::new(&path))?;
        } else {
            sftp.unlink(Path::new(&path))?;
        }
        Ok(())
    })();
    session.set_blocking(false);
    result
}

fn rename_sftp_path_from_ssh(session: &ssh2::Session, from: &str, to: &str) -> anyhow::Result<()> {
    session.set_blocking(true);
    let result = (|| {
        let sftp = session.sftp()?;
        sftp.rename(
            Path::new(&normalize_remote_path(from)),
            Path::new(&normalize_remote_path(to)),
            None,
        )?;
        Ok(())
    })();
    session.set_blocking(false);
    result
}

fn download_sftp_file_from_ssh(
    session: &ssh2::Session,
    session_id: SessionId,
    transfer_id: Uuid,
    remote_path: &str,
    local_path: &str,
    manager: &SessionManager,
) -> anyhow::Result<SftpProgress> {
    session.set_blocking(true);
    session.set_timeout(SFTP_TRANSFER_TIMEOUT_MS);
    let result: anyhow::Result<SftpProgress> = (|| {
        let remote_path = normalize_remote_path(remote_path);
        let mut progress = SftpProgress {
            id: transfer_id,
            session_id,
            direction: FileTransferDirection::Download,
            local_path: local_path.to_string(),
            remote_path: remote_path.clone(),
            bytes_done: 0,
            bytes_total: None,
            status: TransferStatus::Running,
        };
        emit_sftp_progress(manager, &progress);

        let mut last_error = None;
        for attempt in 1..=SFTP_TRANSFER_MAX_ATTEMPTS {
            if attempt > 1 {
                progress.status = TransferStatus::Retrying {
                    attempt,
                    max_attempts: SFTP_TRANSFER_MAX_ATTEMPTS,
                    reason: last_error
                        .clone()
                        .unwrap_or_else(|| "transfer stalled".to_string()),
                };
                emit_sftp_progress(manager, &progress);
                std::thread::sleep(Duration::from_millis(
                    SFTP_TRANSFER_BACKOFF_MS * u64::from(attempt - 1),
                ));
            }

            let attempt_result: anyhow::Result<SftpProgress> = (|| {
                let sftp = session.sftp()?;
                progress.bytes_total = sftp
                    .stat(Path::new(&remote_path))
                    .ok()
                    .and_then(|stat| stat.size);

                let local_path_buf = PathBuf::from(local_path);
                let mut resume_offset = std::fs::metadata(&local_path_buf)
                    .ok()
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                if let Some(total) = progress.bytes_total {
                    if resume_offset > total {
                        resume_offset = 0;
                    }
                }

                let mut local = OpenOptions::new()
                    .create(true)
                    .read(true)
                    .write(true)
                    .open(&local_path_buf)?;
                if resume_offset == 0 {
                    local.set_len(0)?;
                }
                local.seek(SeekFrom::Start(resume_offset))?;

                let mut remote = sftp.open(Path::new(&remote_path))?;
                if resume_offset > 0 {
                    remote.seek(SeekFrom::Start(resume_offset))?;
                }

                progress.bytes_done = resume_offset;
                progress.status = TransferStatus::Running;
                emit_sftp_progress(manager, &progress);

                if progress
                    .bytes_total
                    .is_some_and(|total| resume_offset >= total)
                {
                    progress.status = TransferStatus::Completed;
                    emit_sftp_progress(manager, &progress);
                    return Ok(progress.clone());
                }

                let mut buffer = [0_u8; SFTP_TRANSFER_BUFFER_SIZE];
                let mut last_progress_emit_at = Instant::now();
                let mut last_progress_emit_bytes = progress.bytes_done;
                loop {
                    if manager.is_transfer_cancelled(transfer_id) {
                        progress.status = TransferStatus::Cancelled;
                        emit_sftp_progress(manager, &progress);
                        return Ok(progress.clone());
                    }
                    let read = remote.read(&mut buffer)?;
                    if read == 0 {
                        break;
                    }
                    local.write_all(&buffer[..read])?;
                    progress.bytes_done += read as u64;
                    maybe_emit_sftp_progress(
                        manager,
                        &progress,
                        &mut last_progress_emit_at,
                        &mut last_progress_emit_bytes,
                    );
                }
                progress.status = TransferStatus::Completed;
                emit_sftp_progress(manager, &progress);
                Ok(progress.clone())
            })();

            match attempt_result {
                Ok(progress) => return Ok(progress),
                Err(error) => {
                    if manager.is_transfer_cancelled(transfer_id) {
                        progress.status = TransferStatus::Cancelled;
                        emit_sftp_progress(manager, &progress);
                        return Ok(progress);
                    }
                    last_error = Some(error.to_string());
                }
            }
        }

        anyhow::bail!(
            "transfer failed after {} attempts; last error: {}",
            SFTP_TRANSFER_MAX_ATTEMPTS,
            last_error.unwrap_or_else(|| "unknown transfer error".to_string())
        )
    })();
    session.set_timeout(SSH_OPERATION_TIMEOUT_MS);
    session.set_blocking(false);
    manager.clear_cancelled_transfer(transfer_id);
    if let Err(error) = &result {
        let failed_bytes_done = std::fs::metadata(local_path)
            .ok()
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let failed_bytes_total = progress_total_for_remote_path(session, remote_path);
        emit_failed_sftp_progress(
            manager,
            session_id,
            transfer_id,
            FileTransferDirection::Download,
            local_path,
            remote_path,
            failed_bytes_done,
            failed_bytes_total,
            error.to_string(),
        );
    }
    result
}

fn upload_sftp_file_from_ssh(
    session: &ssh2::Session,
    session_id: SessionId,
    transfer_id: Uuid,
    local_path: &str,
    remote_path: &str,
    manager: &SessionManager,
) -> anyhow::Result<SftpProgress> {
    session.set_blocking(true);
    session.set_timeout(SFTP_TRANSFER_TIMEOUT_MS);
    let upload_total = std::fs::metadata(local_path)
        .ok()
        .map(|metadata| metadata.len());
    let result: anyhow::Result<SftpProgress> = (|| {
        let remote_path = normalize_remote_path(remote_path);
        let mut progress = SftpProgress {
            id: transfer_id,
            session_id,
            direction: FileTransferDirection::Upload,
            local_path: local_path.to_string(),
            remote_path: remote_path.clone(),
            bytes_done: 0,
            bytes_total: upload_total,
            status: TransferStatus::Running,
        };
        emit_sftp_progress(manager, &progress);

        let mut last_error = None;
        for attempt in 1..=SFTP_TRANSFER_MAX_ATTEMPTS {
            if attempt > 1 {
                progress.status = TransferStatus::Retrying {
                    attempt,
                    max_attempts: SFTP_TRANSFER_MAX_ATTEMPTS,
                    reason: last_error
                        .clone()
                        .unwrap_or_else(|| "transfer stalled".to_string()),
                };
                emit_sftp_progress(manager, &progress);
                std::thread::sleep(Duration::from_millis(
                    SFTP_TRANSFER_BACKOFF_MS * u64::from(attempt - 1),
                ));
            }

            let attempt_result: anyhow::Result<SftpProgress> = (|| {
                let mut local = File::open(PathBuf::from(local_path))?;
                let sftp = session.sftp()?;
                let mut resume_offset = sftp
                    .stat(Path::new(&remote_path))
                    .ok()
                    .and_then(|stat| stat.size)
                    .unwrap_or(0);
                if let Some(total) = upload_total {
                    if resume_offset > total {
                        resume_offset = 0;
                    }
                }

                let mut remote = if resume_offset == 0 {
                    sftp.create(Path::new(&remote_path))?
                } else {
                    sftp.open_mode(
                        Path::new(&remote_path),
                        ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE,
                        0o644,
                        ssh2::OpenType::File,
                    )?
                };

                if resume_offset > 0 {
                    local.seek(SeekFrom::Start(resume_offset))?;
                    remote.seek(SeekFrom::Start(resume_offset))?;
                }

                progress.bytes_done = resume_offset;
                progress.status = TransferStatus::Running;
                emit_sftp_progress(manager, &progress);

                if upload_total.is_some_and(|total| resume_offset >= total) {
                    progress.status = TransferStatus::Completed;
                    emit_sftp_progress(manager, &progress);
                    return Ok(progress.clone());
                }

                let mut buffer = [0_u8; SFTP_TRANSFER_BUFFER_SIZE];
                let mut last_progress_emit_at = Instant::now();
                let mut last_progress_emit_bytes = progress.bytes_done;
                loop {
                    if manager.is_transfer_cancelled(transfer_id) {
                        progress.status = TransferStatus::Cancelled;
                        emit_sftp_progress(manager, &progress);
                        return Ok(progress.clone());
                    }
                    let read = local.read(&mut buffer)?;
                    if read == 0 {
                        break;
                    }
                    remote.write_all(&buffer[..read])?;
                    progress.bytes_done += read as u64;
                    maybe_emit_sftp_progress(
                        manager,
                        &progress,
                        &mut last_progress_emit_at,
                        &mut last_progress_emit_bytes,
                    );
                }
                progress.status = TransferStatus::Completed;
                emit_sftp_progress(manager, &progress);
                Ok(progress.clone())
            })();

            match attempt_result {
                Ok(progress) => return Ok(progress),
                Err(error) => {
                    if manager.is_transfer_cancelled(transfer_id) {
                        progress.status = TransferStatus::Cancelled;
                        emit_sftp_progress(manager, &progress);
                        return Ok(progress);
                    }
                    last_error = Some(error.to_string());
                }
            }
        }

        anyhow::bail!(
            "transfer failed after {} attempts; last error: {}",
            SFTP_TRANSFER_MAX_ATTEMPTS,
            last_error.unwrap_or_else(|| "unknown transfer error".to_string())
        )
    })();
    session.set_timeout(SSH_OPERATION_TIMEOUT_MS);
    session.set_blocking(false);
    manager.clear_cancelled_transfer(transfer_id);
    if let Err(error) = &result {
        let failed_bytes_done = progress_total_for_remote_path(session, remote_path).unwrap_or(0);
        emit_failed_sftp_progress(
            manager,
            session_id,
            transfer_id,
            FileTransferDirection::Upload,
            local_path,
            remote_path,
            failed_bytes_done,
            upload_total,
            error.to_string(),
        );
    }
    result
}

fn emit_sftp_progress(manager: &SessionManager, progress: &SftpProgress) {
    let _ = manager
        .events
        .send(SessionEvent::SftpProgress(progress.clone()));
}

fn maybe_emit_sftp_progress(
    manager: &SessionManager,
    progress: &SftpProgress,
    last_emit_at: &mut Instant,
    last_emit_bytes: &mut u64,
) {
    let now = Instant::now();
    let bytes_delta = progress.bytes_done.saturating_sub(*last_emit_bytes);
    if bytes_delta < SFTP_PROGRESS_MIN_BYTES
        && now.duration_since(*last_emit_at) < Duration::from_millis(SFTP_PROGRESS_MIN_INTERVAL_MS)
    {
        return;
    }

    emit_sftp_progress(manager, progress);
    *last_emit_at = now;
    *last_emit_bytes = progress.bytes_done;
}

fn progress_total_for_remote_path(session: &ssh2::Session, remote_path: &str) -> Option<u64> {
    let sftp = session.sftp().ok()?;
    sftp.stat(Path::new(&normalize_remote_path(remote_path)))
        .ok()
        .and_then(|stat| stat.size)
}

fn emit_failed_sftp_progress(
    manager: &SessionManager,
    session_id: SessionId,
    transfer_id: Uuid,
    direction: FileTransferDirection,
    local_path: &str,
    remote_path: &str,
    bytes_done: u64,
    bytes_total: Option<u64>,
    reason: String,
) {
    emit_sftp_progress(
        manager,
        &SftpProgress {
            id: transfer_id,
            session_id,
            direction,
            local_path: local_path.to_string(),
            remote_path: remote_path.to_string(),
            bytes_done,
            bytes_total,
            status: TransferStatus::Failed { reason },
        },
    );
}

fn remote_entry_from_stat(
    directory: &str,
    entry_path: PathBuf,
    stat: ssh2::FileStat,
) -> Option<RemoteFileEntry> {
    let raw_path = entry_path.to_string_lossy().replace('\\', "/");
    let name = raw_path.rsplit('/').next().unwrap_or_default().to_string();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    let path = if raw_path.starts_with('/') {
        raw_path
    } else {
        join_remote_path(directory, &name)
    };
    let permissions = stat.perm.unwrap_or(0);
    Some(RemoteFileEntry {
        name,
        path,
        is_dir: is_directory_mode(permissions),
        size: stat.size.unwrap_or(0),
        permissions: format_permissions(permissions),
        modified_at: stat
            .mtime
            .and_then(|seconds| DateTime::<Utc>::from_timestamp(seconds as i64, 0))
            .map(|datetime| datetime.to_rfc3339()),
    })
}

fn is_directory_mode(mode: u32) -> bool {
    mode & 0o170000 == 0o040000
}

fn format_permissions(mode: u32) -> String {
    if mode == 0 {
        return "---------".to_string();
    }
    let file_type = if is_directory_mode(mode) { 'd' } else { '-' };
    let mut value = String::with_capacity(10);
    value.push(file_type);
    for bit in [
        0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001,
    ] {
        value.push(match (mode & bit != 0, bit) {
            (true, 0o400 | 0o040 | 0o004) => 'r',
            (true, 0o200 | 0o020 | 0o002) => 'w',
            (true, _) => 'x',
            (false, _) => '-',
        });
    }
    value
}

fn normalize_remote_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return ".".to_string();
    }
    let mut normalized = trimmed.replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
}

fn join_remote_path(directory: &str, name: &str) -> String {
    let directory = normalize_remote_path(directory);
    if directory == "/" {
        format!("/{name}")
    } else if directory == "." {
        name.to_string()
    } else {
        format!("{directory}/{}", name.trim_start_matches('/'))
    }
}

fn parent_remote_path(path: &str) -> Option<String> {
    let path = normalize_remote_path(path);
    if path == "/" || path == "." {
        return None;
    }
    let trimmed = path.trim_end_matches('/');
    let Some(index) = trimmed.rfind('/') else {
        return Some(".".to_string());
    };
    if index == 0 {
        Some("/".to_string())
    } else {
        Some(trimmed[..index].to_string())
    }
}

fn parse_system_snapshot(output: &str) -> anyhow::Result<SystemSnapshot> {
    let host = section_after(output, "__JOYSHELL_HOST__", "__JOYSHELL_STAT__")?;
    let stat = section_after(output, "__JOYSHELL_STAT__", "__JOYSHELL_CPUINFO__")?;
    let cpuinfo = section_after(output, "__JOYSHELL_CPUINFO__", "__JOYSHELL_MEMINFO__")?;
    let meminfo = section_after(output, "__JOYSHELL_MEMINFO__", "__JOYSHELL_MEM_DMI__")?;
    let mem_dmi = section_after(output, "__JOYSHELL_MEM_DMI__", "__JOYSHELL_LOADAVG__")?;
    let loadavg = section_after(output, "__JOYSHELL_LOADAVG__", "__JOYSHELL_UPTIME__")?;
    let uptime = section_after(output, "__JOYSHELL_UPTIME__", "__JOYSHELL_PROCESSES__")?;
    let processes = section_after(output, "__JOYSHELL_PROCESSES__", "__JOYSHELL_NETDEV__")?;
    let netdev = section_after(output, "__JOYSHELL_NETDEV__", "__JOYSHELL_IPADDR__")?;
    let ipaddr = section_after(output, "__JOYSHELL_IPADDR__", "__JOYSHELL_DF__")?;
    let df = section_after(output, "__JOYSHELL_DF__", "__JOYSHELL_DF_INODE__")?;
    let df_inode = output
        .split("__JOYSHELL_DF_INODE__")
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("df inode section missing"))?;

    Ok(SystemSnapshot {
        captured_at: Utc::now(),
        host: parse_host_info(host),
        uptime_seconds: parse_uptime(uptime)?,
        load: parse_loadavg(loadavg)?,
        cpu: parse_cpu_times(stat)?,
        cpu_cores: parse_cpu_core_times(stat),
        cpu_info: parse_cpuinfo(cpuinfo, stat),
        memory: parse_memory(meminfo),
        memory_info: parse_memory_info(mem_dmi),
        swap: parse_swap(meminfo),
        processes: parse_processes(processes),
        network: parse_netdev(netdev, ipaddr),
        filesystems: parse_df(df, df_inode),
    })
}

fn section_after<'a>(output: &'a str, start: &str, end: &str) -> anyhow::Result<&'a str> {
    let after_start = output
        .split(start)
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("{start} section missing"))?;
    after_start
        .split(end)
        .next()
        .ok_or_else(|| anyhow::anyhow!("{end} section missing"))
}

fn parse_host_info(host: &str) -> HostInfoSample {
    let mut lines = host.lines().map(str::trim).filter(|line| !line.is_empty());
    let hostname = lines.next().unwrap_or_default().to_string();
    let kernel_name = lines.next().unwrap_or_default().to_string();
    let kernel_release = lines.next().unwrap_or_default().to_string();
    let architecture = lines.next().unwrap_or_default().to_string();
    let os_name = lines.next().unwrap_or_default().to_string();
    let primary_ip = lines
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let device_model = lines
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    HostInfoSample {
        hostname,
        os_name,
        kernel_name,
        kernel_release,
        architecture,
        primary_ip,
        device_model,
    }
}

fn parse_cpu_times(stat: &str) -> anyhow::Result<CpuTimes> {
    let line = stat
        .lines()
        .find(|line| line.starts_with("cpu "))
        .ok_or_else(|| anyhow::anyhow!("cpu line missing"))?;
    Ok(parse_cpu_times_line(line))
}

fn parse_cpu_times_line(line: &str) -> CpuTimes {
    let mut values = line
        .split_whitespace()
        .skip(1)
        .map(|value| value.parse::<u64>().unwrap_or(0));
    CpuTimes {
        user: values.next().unwrap_or(0),
        nice: values.next().unwrap_or(0),
        system: values.next().unwrap_or(0),
        idle: values.next().unwrap_or(0),
        iowait: values.next().unwrap_or(0),
        irq: values.next().unwrap_or(0),
        softirq: values.next().unwrap_or(0),
        steal: values.next().unwrap_or(0),
        guest: values.next().unwrap_or(0),
        guest_nice: values.next().unwrap_or(0),
    }
}

fn parse_cpu_core_times(stat: &str) -> Vec<CpuCoreSample> {
    stat.lines()
        .filter(|line| {
            line.starts_with("cpu")
                && line
                    .as_bytes()
                    .get(3)
                    .map(|byte| byte.is_ascii_digit())
                    .unwrap_or(false)
        })
        .filter_map(|line| {
            let name = line.split_whitespace().next()?.to_string();
            Some(CpuCoreSample {
                name,
                times: parse_cpu_times_line(line),
            })
        })
        .collect()
}

fn parse_cpuinfo(cpuinfo: &str, stat: &str) -> CpuInfoSample {
    let mut model_name = String::new();
    let mut raw_part = None;
    let mut logical_cores = 0_u64;
    let mut physical_cores = None;
    let mut mhz = None;

    for line in cpuinfo.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim();
        match key.as_str() {
            "processor" => logical_cores += 1,
            "model name" | "hardware" | "model" if model_name.is_empty() => {
                model_name = value.to_string();
            }
            "cpu part" if model_name.is_empty() => {
                raw_part = Some(value.to_string());
                model_name = arm_cpu_part_name(value)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("ARM CPU part {value}"));
            }
            "cpu part" if raw_part.is_none() => {
                raw_part = Some(value.to_string());
            }
            "cpu cores" if physical_cores.is_none() => {
                physical_cores = value.parse::<u64>().ok();
            }
            "cpu mhz" if mhz.is_none() => {
                mhz = value.parse::<f64>().ok();
            }
            _ => {}
        }
    }

    if logical_cores == 0 {
        logical_cores = parse_cpu_core_times(stat).len() as u64;
    }
    if model_name.is_empty() {
        model_name = "Unknown CPU".to_string();
    }

    CpuInfoSample {
        model_name,
        raw_part,
        logical_cores,
        physical_cores,
        mhz,
    }
}

fn arm_cpu_part_name(part: &str) -> Option<&'static str> {
    let normalized = part.trim().trim_start_matches("0x").to_ascii_lowercase();
    match normalized.as_str() {
        "920" => Some("ARM920"),
        "926" => Some("ARM926"),
        "b02" => Some("Cortex-A5"),
        "b36" => Some("Cortex-A5"),
        "b76" => Some("Cortex-A7"),
        "c05" => Some("Cortex-A5"),
        "c07" => Some("Cortex-A7"),
        "c08" => Some("Cortex-A8"),
        "c09" => Some("Cortex-A9"),
        "c0d" => Some("Cortex-A17"),
        "c0e" => Some("Cortex-A17"),
        "d01" => Some("Cortex-A32"),
        "d03" => Some("Cortex-A53"),
        "d04" => Some("Cortex-A35"),
        "d05" => Some("Cortex-A55"),
        "d06" => Some("Cortex-A65"),
        "d07" => Some("Cortex-A57"),
        "d08" => Some("Cortex-A72"),
        "d09" => Some("Cortex-A73"),
        "d0a" => Some("Cortex-A75"),
        "d0b" => Some("Cortex-A76"),
        "d0c" => Some("Neoverse N1"),
        "d0d" => Some("Cortex-A77"),
        "d0e" => Some("Cortex-A76AE"),
        "d13" => Some("Cortex-R52"),
        "d20" => Some("Cortex-M23"),
        "d21" => Some("Cortex-M33"),
        "d40" => Some("Neoverse V1"),
        "d41" => Some("Cortex-A78"),
        "d42" => Some("Cortex-A78AE"),
        "d44" => Some("Cortex-X1"),
        "d46" => Some("Cortex-A510"),
        "d47" => Some("Cortex-A710"),
        "d48" => Some("Cortex-X2"),
        "d49" => Some("Neoverse N2"),
        "d4a" => Some("Neoverse E1"),
        "d4b" => Some("Cortex-A78C"),
        "d4c" => Some("Cortex-X1C"),
        "d4d" => Some("Cortex-A715"),
        "d4e" => Some("Cortex-X3"),
        "d4f" => Some("Neoverse V2"),
        "d80" => Some("Cortex-A520"),
        "d81" => Some("Cortex-A720"),
        "d82" => Some("Cortex-X4"),
        _ => None,
    }
}

fn parse_loadavg(loadavg: &str) -> anyhow::Result<LoadAverage> {
    let mut parts = loadavg.split_whitespace();
    let one = parts.next().unwrap_or("0").parse()?;
    let five = parts.next().unwrap_or("0").parse()?;
    let fifteen = parts.next().unwrap_or("0").parse()?;
    let process_counts = parts.next().unwrap_or("0/0");
    let (runnable_processes, total_processes) = process_counts
        .split_once('/')
        .map(|(running, total)| {
            (
                running.parse::<u64>().unwrap_or(0),
                total.parse::<u64>().unwrap_or(0),
            )
        })
        .unwrap_or((0, 0));
    Ok(LoadAverage {
        one,
        five,
        fifteen,
        runnable_processes,
        total_processes,
        last_pid: parts.next().unwrap_or("0").parse().unwrap_or(0),
    })
}

fn parse_uptime(uptime: &str) -> anyhow::Result<f64> {
    uptime
        .split_whitespace()
        .next()
        .unwrap_or("0")
        .parse()
        .map_err(Into::into)
}

fn parse_meminfo_value(meminfo: &str, key: &str) -> u64 {
    meminfo
        .lines()
        .find_map(|line| {
            let (line_key, rest) = line.split_once(':')?;
            if line_key != key {
                return None;
            }
            rest.split_whitespace()
                .next()
                .and_then(|value| value.parse::<u64>().ok())
        })
        .unwrap_or(0)
        * 1024
}

fn parse_memory(meminfo: &str) -> MemorySample {
    let total = parse_meminfo_value(meminfo, "MemTotal");
    let free = parse_meminfo_value(meminfo, "MemFree");
    let available = parse_meminfo_value(meminfo, "MemAvailable");
    let available = if available == 0 { free } else { available };
    MemorySample {
        total_bytes: total,
        used_bytes: total.saturating_sub(available),
        free_bytes: free,
        available_bytes: available,
    }
}

fn parse_memory_info(mem_dmi: &str) -> MemoryInfoSample {
    let mut speeds = mem_dmi
        .lines()
        .filter_map(parse_memory_speed_mhz)
        .filter(|value| *value > 0.0)
        .collect::<Vec<_>>();
    speeds.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    speeds.dedup_by(|left, right| (*left - *right).abs() < 0.5);
    let frequency_mhz = speeds.first().copied();
    MemoryInfoSample { frequency_mhz }
}

fn parse_memory_speed_mhz(line: &str) -> Option<f64> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let lower = line.to_ascii_lowercase();
    if lower.contains("unknown") || lower.contains("not installed") {
        return None;
    }
    let value = line
        .split_whitespace()
        .next()
        .and_then(|value| value.parse::<f64>().ok())?;
    if value > 0.0 {
        Some(value)
    } else {
        None
    }
}

fn parse_swap(meminfo: &str) -> MemorySample {
    let total = parse_meminfo_value(meminfo, "SwapTotal");
    let free = parse_meminfo_value(meminfo, "SwapFree");
    MemorySample {
        total_bytes: total,
        used_bytes: total.saturating_sub(free),
        free_bytes: free,
        available_bytes: free,
    }
}

fn parse_processes(processes: &str) -> ProcessSample {
    let mut sample = ProcessSample {
        total: 0,
        running: 0,
        sleeping: 0,
        stopped: 0,
        zombie: 0,
        threads: 0,
    };

    for token in processes.split_whitespace() {
        let Some((key, value)) = token.split_once('=') else {
            continue;
        };
        let value = value.trim().parse::<u64>().unwrap_or(0);
        match key.trim() {
            "total" => sample.total = value,
            "running" => sample.running = value,
            "sleeping" => sample.sleeping = value,
            "stopped" => sample.stopped = value,
            "zombie" => sample.zombie = value,
            "threads" => sample.threads = value,
            _ => {}
        }
    }

    sample
}

fn parse_ip_addresses(ipaddr: &str) -> HashMap<String, Vec<String>> {
    let mut addresses: HashMap<String, Vec<String>> = HashMap::new();

    for line in ipaddr.lines() {
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() < 4 || parts.get(2) != Some(&"inet") {
            continue;
        }
        let name = parts
            .get(1)
            .copied()
            .unwrap_or_default()
            .split('@')
            .next()
            .unwrap_or_default()
            .trim_end_matches(':')
            .to_string();
        let address = parts
            .get(3)
            .copied()
            .unwrap_or_default()
            .split('/')
            .next()
            .unwrap_or_default()
            .to_string();

        if !name.is_empty() && !address.is_empty() {
            addresses.entry(name).or_default().push(address);
        }
    }

    addresses
}

fn parse_netdev(netdev: &str, ipaddr: &str) -> Vec<NetworkInterfaceSample> {
    let addresses = parse_ip_addresses(ipaddr);

    netdev
        .lines()
        .filter_map(|line| {
            let (name, rest) = line.split_once(':')?;
            let values = rest
                .split_whitespace()
                .map(|value| value.parse::<u64>().unwrap_or(0))
                .collect::<Vec<_>>();
            let name = name.trim().to_string();
            Some(NetworkInterfaceSample {
                ipv4_addresses: addresses.get(&name).cloned().unwrap_or_default(),
                name,
                rx_bytes: *values.first()?,
                tx_bytes: *values.get(8)?,
                rx_packets: *values.get(1).unwrap_or(&0),
                tx_packets: *values.get(9).unwrap_or(&0),
                rx_errors: *values.get(2).unwrap_or(&0),
                tx_errors: *values.get(10).unwrap_or(&0),
            })
        })
        .collect()
}

fn parse_df_inode(df_inode: &str) -> HashMap<String, (u64, u64, u64, f64)> {
    let mut inodes = HashMap::new();
    for line in df_inode.lines().skip(1) {
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() < 6 {
            continue;
        }
        let Some(mount_point) = parts.get(5) else {
            continue;
        };
        let total = parts
            .get(1)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let used = parts
            .get(2)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let available = parts
            .get(3)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let used_percent = parts
            .get(4)
            .and_then(|value| value.trim_end_matches('%').parse::<f64>().ok())
            .unwrap_or(0.0);
        inodes.insert(
            (*mount_point).to_string(),
            (total, used, available, used_percent),
        );
    }
    inodes
}

fn parse_df(df: &str, df_inode: &str) -> Vec<FileSystemSample> {
    let inodes = parse_df_inode(df_inode);

    df.lines()
        .skip(1)
        .filter_map(|line| {
            let parts = line.split_whitespace().collect::<Vec<_>>();
            if parts.len() < 6 {
                return None;
            }
            let typed = parts.len() >= 7 && parts.get(1)?.parse::<u64>().is_err();
            let filesystem = parts.first()?.to_string();
            let fs_type = if typed {
                parts.get(1)?.to_string()
            } else {
                "unknown".to_string()
            };
            let total_index = if typed { 2 } else { 1 };
            let used_index = if typed { 3 } else { 2 };
            let available_index = if typed { 4 } else { 3 };
            let percent_index = if typed { 5 } else { 4 };
            let mount_index = if typed { 6 } else { 5 };
            let total = parts
                .get(total_index)?
                .parse::<u64>()
                .ok()?
                .saturating_mul(1024);
            let used = parts
                .get(used_index)?
                .parse::<u64>()
                .ok()?
                .saturating_mul(1024);
            let available = parts
                .get(available_index)?
                .parse::<u64>()
                .ok()?
                .saturating_mul(1024);
            let used_percent = parts
                .get(percent_index)?
                .trim_end_matches('%')
                .parse::<f64>()
                .unwrap_or(0.0);
            let mount_point = parts.get(mount_index)?.to_string();
            let inode = inodes.get(&mount_point).copied();
            Some(FileSystemSample {
                filesystem,
                fs_type,
                mount_point,
                total_bytes: total,
                used_bytes: used,
                available_bytes: available,
                used_percent,
                inode_total: inode.map(|value| value.0),
                inode_used: inode.map(|value| value.1),
                inode_available: inode.map(|value| value.2),
                inode_used_percent: inode.map(|value| value.3),
            })
        })
        .collect()
}

struct SocketWaiter {
    poll: Option<Poll>,
    events: Events,
    _stream: Option<MioTcpStream>,
}

impl SocketWaiter {
    fn new(wait_socket: TcpStream) -> Self {
        let mut stream = MioTcpStream::from_std(wait_socket);
        let poll = Poll::new().ok();
        let mut registered_poll = None;

        if let Some(poll) = poll {
            if poll
                .registry()
                .register(
                    &mut stream,
                    Token(0),
                    Interest::READABLE.add(Interest::WRITABLE),
                )
                .is_ok()
            {
                registered_poll = Some(poll);
            }
        }

        Self {
            poll: registered_poll,
            events: Events::with_capacity(8),
            _stream: Some(stream),
        }
    }

    fn wait(&mut self, session: &ssh2::Session, timeout: Duration) {
        match session.block_directions() {
            ssh2::BlockDirections::None => {
                std::thread::sleep(timeout);
            }
            ssh2::BlockDirections::Inbound
            | ssh2::BlockDirections::Outbound
            | ssh2::BlockDirections::Both => {
                if let Some(poll) = self.poll.as_mut() {
                    let _ = poll.poll(&mut self.events, Some(timeout));
                } else {
                    std::thread::sleep(timeout);
                }
            }
        }
    }
}

fn establish_ssh_session(
    profile: &SessionProfile,
    password: &str,
) -> Result<(ssh2::Session, ssh2::Channel, TcpStream), anyhow::Error> {
    let (session, wait_socket) = establish_authenticated_ssh_session(profile, password)?;
    let mut channel = session.channel_session().map_err(|error| {
        anyhow::anyhow!(
            "SSH channel open failed for {}@{}:{}: {}",
            profile.username,
            profile.host,
            profile.port,
            error
        )
    })?;
    channel
        .request_pty("xterm-256color", None, Some((120, 32, 0, 0)))
        .map_err(|error| {
            anyhow::anyhow!(
                "SSH PTY request failed for {}@{}:{}: {}",
                profile.username,
                profile.host,
                profile.port,
                error
            )
        })?;
    channel.shell().map_err(|error| {
        anyhow::anyhow!(
            "SSH shell startup failed for {}@{}:{}: {}",
            profile.username,
            profile.host,
            profile.port,
            error
        )
    })?;
    session.set_keepalive(true, SSH_KEEPALIVE_INTERVAL_SECS);
    wait_socket.set_nonblocking(true)?;
    session.set_blocking(false);
    Ok((session, channel, wait_socket))
}

fn establish_ssh_side_session(
    profile: &SessionProfile,
    password: &str,
) -> Result<(ssh2::Session, TcpStream), anyhow::Error> {
    let (session, wait_socket) = establish_authenticated_ssh_session(profile, password)?;
    wait_socket.set_nonblocking(true)?;
    session.set_blocking(true);
    Ok((session, wait_socket))
}

fn establish_authenticated_ssh_session(
    profile: &SessionProfile,
    password: &str,
) -> Result<(ssh2::Session, TcpStream), anyhow::Error> {
    let address = format!("{}:{}", profile.host, profile.port);
    let socket_addr = address
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| anyhow::anyhow!("host did not resolve"))?;
    let tcp =
        TcpStream::connect_timeout(&socket_addr, Duration::from_secs(SSH_CONNECT_TIMEOUT_SECS))
            .map_err(|error| {
                anyhow::anyhow!(
                    "TCP connect to {}@{}:{} failed after {}s: {}",
                    profile.username,
                    profile.host,
                    profile.port,
                    SSH_CONNECT_TIMEOUT_SECS,
                    error
                )
            })?;
    let wait_socket = tcp.try_clone().map_err(|error| {
        anyhow::anyhow!(
            "TCP socket clone failed for {}:{}: {}",
            profile.host,
            profile.port,
            error
        )
    })?;

    let mut session = ssh2::Session::new()?;
    session.set_tcp_stream(tcp);
    session.set_timeout(SSH_OPERATION_TIMEOUT_MS);
    session
        .handshake()
        .map_err(|error| describe_handshake_error_clean(&profile, &error))?;
    session
        .userauth_password(&profile.username, &password)
        .map_err(|error| {
            anyhow::anyhow!(
                "SSH password authentication failed for {}@{}:{}: {}",
                profile.username,
                profile.host,
                profile.port,
                error
            )
        })?;
    if !session.authenticated() {
        anyhow::bail!("authentication failed");
    }

    session.set_keepalive(true, SSH_KEEPALIVE_INTERVAL_SECS);
    Ok((session, wait_socket))
}

fn describe_handshake_error_clean(profile: &SessionProfile, error: &ssh2::Error) -> anyhow::Error {
    let raw = error.to_string();
    let normalized = raw.to_ascii_lowercase();
    if normalized.contains("unable to exchange encryption keys")
        || normalized.contains("session(-5)")
        || normalized.contains("session(-8)")
    {
        return anyhow::anyhow!(
            "SSH key exchange failed for {}@{}:{}: {}. Common causes: the port is not an SSH service, the port-forward target is wrong, or the server only supports legacy/incompatible KEX or cipher algorithms. Verify with: ssh -vvv -p {} {}@{}.",
            profile.username,
            profile.host,
            profile.port,
            raw,
            profile.port,
            profile.username,
            profile.host
        );
    }

    anyhow::anyhow!(
        "SSH handshake failed for {}@{}:{}: {}",
        profile.username,
        profile.host,
        profile.port,
        raw
    )
}
fn is_transient_ssh_io_error(error: &std::io::Error) -> bool {
    if matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
    ) {
        return true;
    }

    let message = error.to_string().to_ascii_lowercase();
    message.contains("would block")
        || message.contains("operation would block")
        || message.contains("resource temporarily unavailable")
        || message.contains("transport read")
        || message.contains("transport write")
        || message.contains("draining incoming flow")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_arm_cpu_part_to_readable_core_name() {
        let cpuinfo = "\
processor   : 0
CPU implementer : 0x41
CPU architecture: 8
CPU part    : 0xd03
CPU revision    : 4
processor   : 1
CPU part    : 0xd03
";
        let stat = "cpu  100 0 50 1000 0 0 0 0 0 0\ncpu0 50 0 25 500 0 0 0 0 0 0\ncpu1 50 0 25 500 0 0 0 0 0 0";

        let parsed = parse_cpuinfo(cpuinfo, stat);

        assert_eq!(parsed.model_name, "Cortex-A53");
        assert_eq!(parsed.raw_part.as_deref(), Some("0xd03"));
        assert_eq!(parsed.logical_cores, 2);
    }
}
