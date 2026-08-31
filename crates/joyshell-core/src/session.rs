use base64::Engine;
use chrono::{DateTime, Utc};
use mio::net::TcpStream as MioTcpStream;
use mio::{Events, Interest, Poll, Token};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, RwLock as StdRwLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::{broadcast, oneshot};
use uuid::Uuid;

use crate::{
    sha256_fingerprint, FileTransferDirection, ForwardingKind, ForwardingRule, HostKeyCheck,
    KnownHostsStore, RemoteDirectoryListing, RemoteFileEntry, SftpProgress, TerminalOutput,
    TerminalOutputBatch, TransferConflictDecision, TransferStatus,
};

pub type SessionId = Uuid;

const SSH_CONNECT_TIMEOUT_SECS: u64 = 15;
const SSH_OPERATION_TIMEOUT_MS: u32 = 15_000;
const SSH_HEALTH_INTERVAL_SECS: u64 = 5;
const SSH_KEEPALIVE_INTERVAL_SECS: u32 = 2;
const SSH_HEALTH_TIMEOUT_MS: u64 = 3_000;
const SSH_HEALTH_CACHE_MS: u64 = 2_000;
const SSH_HEALTH_FAILURE_LIMIT: u32 = 3;
const SYSTEM_SYNC_TIMEOUT_MS: u32 = 8_000;
const SYSTEM_SYNC_MAX_ATTEMPTS: u32 = 2;
const SFTP_TRANSFER_TIMEOUT_MS: u32 = 60_000;
const SFTP_TRANSFER_MAX_ATTEMPTS: u32 = 5;
const SFTP_TRANSFER_BACKOFF_MS: u64 = 900;
const SFTP_TRANSFER_BUFFER_SIZE: usize = 128 * 1024;
const SFTP_PROGRESS_MIN_INTERVAL_MS: u64 = 120;
const SFTP_PROGRESS_MIN_BYTES: u64 = 1024 * 1024;
const TERMINAL_OUTPUT_TAIL_CHUNKS: usize = 200;

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

#[derive(Clone)]
pub enum SshCredential {
    Password(String),
    PrivateKey {
        key_path: PathBuf,
        passphrase: Option<String>,
    },
    Agent {
        identity_fingerprint: Option<String>,
    },
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
    #[serde(default)]
    pub use_terminal_latency_probe: bool,
    #[serde(default)]
    pub operating_system: Option<String>,
    pub username: String,
    pub auth_method: AuthMethod,
    #[serde(default)]
    pub agent_identity_fingerprint: Option<String>,
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
    HostKeyPending,
    Connected,
    Reconnecting,
    Failed { reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HostKeyPromptReason {
    Unknown,
    Changed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HostKeyDecision {
    Accept,
    Update,
    Reject,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostKeyPrompt {
    pub token: Uuid,
    pub session_id: SessionId,
    pub profile_id: SessionId,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub key_base64: String,
    pub fingerprint: String,
    pub previous_fingerprint: Option<String>,
    pub reason: HostKeyPromptReason,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: SessionId,
    pub profile_id: SessionId,
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
    TerminalOutput(TerminalOutput),
    SftpProgress(super::sftp::SftpProgress),
    HostKeyPrompt(HostKeyPrompt),
    HostKeyAccepted {
        session_id: SessionId,
        host: String,
        port: u16,
        fingerprint: String,
    },
    HostKeyChanged {
        session_id: SessionId,
        host: String,
        port: u16,
        previous_fingerprint: String,
        fingerprint: String,
    },
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
    credential: SshCredential,
    jump: Option<(SessionProfile, SshCredential)>,
    output_tail: VecDeque<TerminalOutput>,
    next_output_sequence: u64,
    ssh: Option<SshRuntime>,
    runtime_token: Uuid,
    last_transient_io: Option<String>,
    last_health_rtt_ms: Option<f64>,
    last_health_at: Option<Instant>,
}

struct SshRuntime {
    control: Sender<SshControl>,
    _thread: JoinHandle<()>,
}

struct ActiveForward {
    listener: TcpListener,
    stop: Arc<AtomicBool>,
    rule: ForwardingRule,
}

struct ActiveRemoteForward {
    listener: ssh2::Listener,
    stop: Arc<AtomicBool>,
    rule: ForwardingRule,
}

struct PendingHostKeyPrompt {
    session_id: SessionId,
    response: mpsc::Sender<HostKeyDecision>,
}

enum SshControl {
    Terminal(Vec<u8>),
    MeasureLatency(oneshot::Sender<Result<Option<f64>, String>>),
    StartLocalForward(
        ForwardingRule,
        oneshot::Sender<Result<ForwardingRule, String>>,
    ),
    StartRemoteForward(
        ForwardingRule,
        oneshot::Sender<Result<ForwardingRule, String>>,
    ),
    StopForward(Uuid),
}

struct PendingHealthProbe {
    started_at: Instant,
    responses: Vec<oneshot::Sender<Result<Option<f64>, String>>>,
}

enum HealthProbePoll {
    Pending,
    Alive(f64),
    Failed(String),
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
    paused_transfers: Arc<RwLock<HashSet<Uuid>>>,
    known_hosts: Option<Arc<StdRwLock<KnownHostsStore>>>,
    known_hosts_path: Option<Arc<PathBuf>>,
    pending_host_keys: Arc<RwLock<HashMap<Uuid, PendingHostKeyPrompt>>>,
    transfer_conflict_decisions: Arc<RwLock<HashMap<Uuid, TransferConflictDecision>>>,
    forwarding_stops: Arc<RwLock<HashMap<Uuid, Arc<AtomicBool>>>>,
    forwarding_rules: Arc<RwLock<HashMap<Uuid, ForwardingRule>>>,
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
            paused_transfers: Arc::new(RwLock::new(HashSet::new())),
            known_hosts: None,
            known_hosts_path: None,
            pending_host_keys: Arc::new(RwLock::new(HashMap::new())),
            transfer_conflict_decisions: Arc::new(RwLock::new(HashMap::new())),
            forwarding_stops: Arc::new(RwLock::new(HashMap::new())),
            forwarding_rules: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn with_known_hosts(
        known_hosts: Arc<StdRwLock<KnownHostsStore>>,
        known_hosts_path: PathBuf,
    ) -> Self {
        let mut manager = Self::new();
        manager.known_hosts = Some(known_hosts);
        manager.known_hosts_path = Some(Arc::new(known_hosts_path));
        manager
    }

    pub fn resolve_host_key_prompt(
        &self,
        token: Uuid,
        session_id: SessionId,
        decision: HostKeyDecision,
    ) -> Result<(), SessionError> {
        let pending = self
            .pending_host_keys
            .write()
            .remove(&token)
            .ok_or_else(|| {
                SessionError::ConnectionFailed(
                    "host key prompt expired or was already resolved".to_string(),
                )
            })?;
        if pending.session_id != session_id {
            self.pending_host_keys.write().insert(token, pending);
            return Err(SessionError::ConnectionFailed(
                "host key prompt belongs to a different session".to_string(),
            ));
        }
        pending.response.send(decision).map_err(|_| {
            SessionError::ConnectionFailed("host key prompt is no longer active".to_string())
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.events.subscribe()
    }

    pub async fn start_local_forward(
        &self,
        session_id: SessionId,
        mut rule: ForwardingRule,
    ) -> Result<ForwardingRule, SessionError> {
        rule.kind = ForwardingKind::Local;
        rule.session_id = session_id;
        rule.validate().map_err(SessionError::ConnectionFailed)?;
        let (response, receiver) = oneshot::channel();
        let control = self
            .sessions
            .read()
            .get(&session_id)
            .and_then(|runtime| runtime.ssh.as_ref().map(|ssh| ssh.control.clone()))
            .ok_or(SessionError::NotConnected(session_id))?;
        control
            .send(SshControl::StartLocalForward(rule, response))
            .map_err(|_| {
                SessionError::ConnectionFailed("SSH control channel is closed".to_string())
            })?;
        let result = receiver
            .await
            .map_err(|_| {
                SessionError::ConnectionFailed("forwarding request was cancelled".to_string())
            })?
            .map_err(SessionError::ConnectionFailed)?;
        self.forwarding_rules
            .write()
            .insert(result.id, result.clone());
        Ok(result)
    }

    pub async fn start_remote_forward(
        &self,
        session_id: SessionId,
        mut rule: ForwardingRule,
    ) -> Result<ForwardingRule, SessionError> {
        rule.kind = ForwardingKind::Remote;
        rule.session_id = session_id;
        rule.validate().map_err(SessionError::ConnectionFailed)?;
        let (response, receiver) = oneshot::channel();
        let control = self
            .sessions
            .read()
            .get(&session_id)
            .and_then(|runtime| runtime.ssh.as_ref().map(|ssh| ssh.control.clone()))
            .ok_or(SessionError::NotConnected(session_id))?;
        control
            .send(SshControl::StartRemoteForward(rule, response))
            .map_err(|_| {
                SessionError::ConnectionFailed("SSH control channel is closed".to_string())
            })?;
        let result = receiver
            .await
            .map_err(|_| {
                SessionError::ConnectionFailed("forwarding request was cancelled".to_string())
            })?
            .map_err(SessionError::ConnectionFailed)?;
        self.forwarding_rules
            .write()
            .insert(result.id, result.clone());
        Ok(result)
    }

    pub async fn start_socks_forward(
        &self,
        session_id: SessionId,
        mut rule: ForwardingRule,
    ) -> Result<ForwardingRule, SessionError> {
        rule.kind = ForwardingKind::Socks;
        rule.session_id = session_id;
        rule.validate().map_err(SessionError::ConnectionFailed)?;
        let (response, receiver) = oneshot::channel();
        let control = self
            .sessions
            .read()
            .get(&session_id)
            .and_then(|runtime| runtime.ssh.as_ref().map(|ssh| ssh.control.clone()))
            .ok_or(SessionError::NotConnected(session_id))?;
        control
            .send(SshControl::StartLocalForward(rule, response))
            .map_err(|_| {
                SessionError::ConnectionFailed("SSH control channel is closed".to_string())
            })?;
        let result = receiver
            .await
            .map_err(|_| {
                SessionError::ConnectionFailed("forwarding request was cancelled".to_string())
            })?
            .map_err(SessionError::ConnectionFailed)?;
        self.forwarding_rules
            .write()
            .insert(result.id, result.clone());
        Ok(result)
    }

    pub fn stop_forward(
        &self,
        session_id: SessionId,
        forwarding_id: Uuid,
    ) -> Result<(), SessionError> {
        {
            let mut rules = self.forwarding_rules.write();
            if let Some(rule) = rules.get_mut(&forwarding_id) {
                if rule.session_id != session_id {
                    return Err(SessionError::ConnectionFailed(
                        "forwarding rule belongs to another session".into(),
                    ));
                }
                rule.state = crate::ForwardingState::Stopped;
                rule.last_error = None;
                rule.active_connections = 0;
            }
        }
        let control = self
            .sessions
            .read()
            .get(&session_id)
            .and_then(|runtime| runtime.ssh.as_ref().map(|ssh| ssh.control.clone()))
            .ok_or(SessionError::NotConnected(session_id))?;
        control
            .send(SshControl::StopForward(forwarding_id))
            .map_err(|_| {
                SessionError::ConnectionFailed("SSH control channel is closed".to_string())
            })
    }

    pub fn list_forwarding_rules(&self, session_id: SessionId) -> Vec<ForwardingRule> {
        self.forwarding_rules
            .read()
            .values()
            .filter(|rule| rule.session_id == session_id)
            .cloned()
            .collect()
    }

    pub fn remove_forwarding_rule(
        &self,
        session_id: SessionId,
        forwarding_id: Uuid,
    ) -> Result<(), SessionError> {
        let belongs = self
            .forwarding_rules
            .read()
            .get(&forwarding_id)
            .map(|r| r.session_id == session_id)
            .unwrap_or(true);
        if !belongs {
            return Err(SessionError::ConnectionFailed(
                "forwarding rule belongs to another session".into(),
            ));
        }
        let _ = self.stop_forward(session_id, forwarding_id);
        self.forwarding_rules.write().remove(&forwarding_id);
        Ok(())
    }

    pub async fn connect_ssh_password(
        &self,
        profile: SessionProfile,
        password: String,
    ) -> Result<SshSessionHandle, SessionError> {
        let session_id = profile.id;
        self.connect_ssh_for_session(profile, SshCredential::Password(password), session_id, None)
            .await
    }

    pub async fn connect_ssh_password_for_session(
        &self,
        profile: SessionProfile,
        password: String,
        session_id: SessionId,
    ) -> Result<SshSessionHandle, SessionError> {
        self.connect_ssh_for_session(profile, SshCredential::Password(password), session_id, None)
            .await
    }

    pub async fn connect_ssh_private_key_for_session(
        &self,
        profile: SessionProfile,
        key_path: PathBuf,
        passphrase: Option<String>,
        session_id: SessionId,
    ) -> Result<SshSessionHandle, SessionError> {
        self.connect_ssh_for_session(
            profile,
            SshCredential::PrivateKey {
                key_path,
                passphrase,
            },
            session_id,
            None,
        )
        .await
    }

    pub async fn connect_ssh_agent_for_session(
        &self,
        profile: SessionProfile,
        identity_fingerprint: Option<String>,
        session_id: SessionId,
    ) -> Result<SshSessionHandle, SessionError> {
        self.connect_ssh_for_session(
            profile,
            SshCredential::Agent {
                identity_fingerprint,
            },
            session_id,
            None,
        )
        .await
    }

    pub async fn connect_ssh_password_via_jump_for_session(
        &self,
        profile: SessionProfile,
        password: String,
        jump_profile: SessionProfile,
        jump_password: String,
        session_id: SessionId,
    ) -> Result<SshSessionHandle, SessionError> {
        self.connect_ssh_for_session(
            profile,
            SshCredential::Password(password),
            session_id,
            Some((jump_profile, SshCredential::Password(jump_password))),
        )
        .await
    }

    pub async fn connect_ssh_private_key_via_jump_for_session(
        &self,
        profile: SessionProfile,
        key_path: PathBuf,
        passphrase: Option<String>,
        jump_profile: SessionProfile,
        jump_key_path: PathBuf,
        jump_passphrase: Option<String>,
        session_id: SessionId,
    ) -> Result<SshSessionHandle, SessionError> {
        self.connect_ssh_for_session(
            profile,
            SshCredential::PrivateKey {
                key_path,
                passphrase,
            },
            session_id,
            Some((
                jump_profile,
                SshCredential::PrivateKey {
                    key_path: jump_key_path,
                    passphrase: jump_passphrase,
                },
            )),
        )
        .await
    }

    pub async fn connect_ssh_agent_via_jump_for_session(
        &self,
        profile: SessionProfile,
        identity_fingerprint: Option<String>,
        jump_profile: SessionProfile,
        jump_identity_fingerprint: Option<String>,
        session_id: SessionId,
    ) -> Result<SshSessionHandle, SessionError> {
        self.connect_ssh_for_session(
            profile,
            SshCredential::Agent {
                identity_fingerprint,
            },
            session_id,
            Some((
                jump_profile,
                SshCredential::Agent {
                    identity_fingerprint: jump_identity_fingerprint,
                },
            )),
        )
        .await
    }

    pub async fn connect_ssh_with_jump_for_session(
        &self,
        profile: SessionProfile,
        credential: SshCredential,
        jump_profile: SessionProfile,
        jump_credential: SshCredential,
        session_id: SessionId,
    ) -> Result<SshSessionHandle, SessionError> {
        self.connect_ssh_for_session(
            profile,
            credential,
            session_id,
            Some((jump_profile, jump_credential)),
        )
        .await
    }

    async fn connect_ssh_for_session(
        &self,
        profile: SessionProfile,
        credential: SshCredential,
        session_id: SessionId,
        jump: Option<(SessionProfile, SshCredential)>,
    ) -> Result<SshSessionHandle, SessionError> {
        let now = Utc::now();
        let connecting_info = SessionInfo {
            id: session_id,
            profile_id: profile.id,
            profile_name: profile.name.clone(),
            host: profile.host.clone(),
            port: profile.port,
            username: profile.username.clone(),
            state: ConnectionState::Connecting,
            connected_at: None,
            last_seen_at: now,
        };

        self.sessions.write().insert(
            session_id,
            SessionRuntime {
                info: connecting_info,
                profile: profile.clone(),
                credential: credential.clone(),
                jump: jump.clone(),
                output_tail: VecDeque::new(),
                next_output_sequence: 0,
                ssh: None,
                runtime_token: Uuid::new_v4(),
                last_transient_io: None,
                last_health_rtt_ms: None,
                last_health_at: None,
            },
        );
        let _ = self.events.send(SessionEvent::StateChanged {
            session_id,
            state: ConnectionState::Connecting,
        });
        self.push_output(
            session_id,
            format!(
                "Connecting to {}@{}:{}...\r\n",
                profile.username, profile.host, profile.port
            ),
        );

        let profile_for_connect = profile.clone();
        let credential_for_connect = credential.clone();
        let manager_for_connect = self.clone();
        let connect_result = tokio::task::spawn_blocking(move || {
            establish_ssh_session(
                &manager_for_connect,
                session_id,
                &profile_for_connect,
                &credential_for_connect,
                jump,
            )
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
        let prompt_tokens = self
            .pending_host_keys
            .read()
            .iter()
            .filter_map(|(token, pending)| (pending.session_id == session_id).then_some(*token))
            .collect::<Vec<_>>();
        for token in prompt_tokens {
            if let Some(pending) = self.pending_host_keys.write().remove(&token) {
                let _ = pending.response.send(HostKeyDecision::Reject);
            }
        }
        let mut sessions = self.sessions.write();
        let runtime = sessions
            .get_mut(&session_id)
            .ok_or(SessionError::NotFound(session_id))?;
        runtime.info.state = ConnectionState::Disconnected;
        runtime.info.last_seen_at = Utc::now();
        runtime.ssh = None;
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

    pub async fn measure_terminal_latency(
        &self,
        session_id: SessionId,
    ) -> Result<Option<f64>, SessionError> {
        let receiver = {
            let sessions = self.sessions.read();
            let runtime = sessions
                .get(&session_id)
                .ok_or(SessionError::NotFound(session_id))?;
            if runtime.info.state != ConnectionState::Connected {
                return Err(SessionError::NotConnected(session_id));
            }
            if runtime.last_health_at.is_some_and(|checked_at| {
                checked_at.elapsed() <= Duration::from_millis(SSH_HEALTH_CACHE_MS)
            }) {
                return Ok(runtime.last_health_rtt_ms);
            }
            let ssh = runtime.ssh.as_ref().ok_or_else(|| {
                SessionError::ConnectionFailed("terminal channel is not available".to_string())
            })?;
            let (sender, receiver) = oneshot::channel();
            ssh.control
                .send(SshControl::MeasureLatency(sender))
                .map_err(|_| {
                    SessionError::ConnectionFailed("terminal channel is closed".to_string())
                })?;
            receiver
        };

        match tokio::time::timeout(Duration::from_millis(3000), receiver).await {
            Ok(Ok(result)) => result.map_err(SessionError::ConnectionFailed),
            Ok(Err(_)) => Err(SessionError::ConnectionFailed(
                "terminal latency probe was cancelled".to_string(),
            )),
            Err(_) => Ok(None),
        }
    }

    pub async fn collect_system_snapshot(
        &self,
        session_id: SessionId,
    ) -> Result<SystemSnapshot, SessionError> {
        let (profile, credential, jump) = self.side_connection_credentials(session_id)?;
        let manager = self.clone();
        tokio::task::spawn_blocking(move || {
            let (session, wait_socket) =
                establish_ssh_side_session(&manager, session_id, &profile, &credential, jump)?;
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
        let (profile, credential, jump) = self.side_connection_credentials(session_id)?;
        let manager = self.clone();
        tokio::task::spawn_blocking(move || {
            let (session, _wait_socket) =
                establish_ssh_side_session(&manager, session_id, &profile, &credential, jump)?;
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
        let (profile, credential, jump) = self.side_connection_credentials(session_id)?;
        let manager = self.clone();
        tokio::task::spawn_blocking(move || {
            let (session, _wait_socket) =
                establish_ssh_side_session(&manager, session_id, &profile, &credential, jump)?;
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
        let (profile, credential, jump) = self.side_connection_credentials(session_id)?;
        let manager = self.clone();
        tokio::task::spawn_blocking(move || {
            let (session, _wait_socket) =
                establish_ssh_side_session(&manager, session_id, &profile, &credential, jump)?;
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
        let (profile, credential, jump) = self.side_connection_credentials(session_id)?;
        let manager = self.clone();
        tokio::task::spawn_blocking(move || {
            let (session, _wait_socket) =
                establish_ssh_side_session(&manager, session_id, &profile, &credential, jump)?;
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
        expected: Option<SftpProgress>,
    ) -> Result<SftpProgress, SessionError> {
        let (profile, credential, jump) = self.side_connection_credentials(session_id)?;
        self.clear_cancelled_transfer(transfer_id);
        let conflict_decision = self.take_transfer_conflict_decision(transfer_id);
        let manager = self.clone();
        let progress_remote_path = remote_path.clone();
        let progress_local_path = local_path.clone();
        let transfer_result = tokio::task::spawn_blocking(move || {
            let (session, _wait_socket) =
                establish_ssh_side_session(&manager, session_id, &profile, &credential, jump)
                    .map_err(|error| SideTransferError::Connect(error.to_string()))?;
            download_sftp_file_from_ssh(
                &session,
                session_id,
                transfer_id,
                &remote_path,
                &local_path,
                &manager,
                expected.as_ref(),
                conflict_decision,
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
                    None,
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
        expected: Option<SftpProgress>,
    ) -> Result<SftpProgress, SessionError> {
        let (profile, credential, jump) = self.side_connection_credentials(session_id)?;
        self.clear_cancelled_transfer(transfer_id);
        let conflict_decision = self.take_transfer_conflict_decision(transfer_id);
        let manager = self.clone();
        let progress_remote_path = remote_path.clone();
        let progress_local_path = local_path.clone();
        let upload_total = std::fs::metadata(&progress_local_path)
            .ok()
            .map(|metadata| metadata.len());
        let transfer_result = tokio::task::spawn_blocking(move || {
            let (session, _wait_socket) =
                establish_ssh_side_session(&manager, session_id, &profile, &credential, jump)
                    .map_err(|error| SideTransferError::Connect(error.to_string()))?;
            upload_sftp_file_from_ssh(
                &session,
                session_id,
                transfer_id,
                &local_path,
                &remote_path,
                &manager,
                expected.as_ref(),
                conflict_decision,
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
                    None,
                );
                Err(SessionError::ConnectionFailed(reason))
            }
            Err(SideTransferError::Transfer(reason)) => Err(SessionError::ConnectionFailed(reason)),
        }
    }

    pub fn cancel_sftp_transfer(&self, transfer_id: Uuid) {
        self.cancelled_transfers.write().insert(transfer_id);
    }

    pub fn pause_sftp_transfer(&self, transfer_id: Uuid) {
        self.paused_transfers.write().insert(transfer_id);
    }

    pub fn resolve_transfer_conflict(&self, transfer_id: Uuid, decision: TransferConflictDecision) {
        self.transfer_conflict_decisions
            .write()
            .insert(transfer_id, decision);
    }

    fn take_transfer_conflict_decision(
        &self,
        transfer_id: Uuid,
    ) -> Option<TransferConflictDecision> {
        self.transfer_conflict_decisions
            .write()
            .remove(&transfer_id)
    }

    fn clear_cancelled_transfer(&self, transfer_id: Uuid) {
        self.cancelled_transfers.write().remove(&transfer_id);
        self.paused_transfers.write().remove(&transfer_id);
    }

    fn is_transfer_cancelled(&self, transfer_id: Uuid) -> bool {
        self.cancelled_transfers.read().contains(&transfer_id)
    }

    fn is_transfer_paused(&self, transfer_id: Uuid) -> bool {
        self.paused_transfers.read().contains(&transfer_id)
    }

    fn side_connection_credentials(
        &self,
        session_id: SessionId,
    ) -> Result<
        (
            SessionProfile,
            SshCredential,
            Option<(SessionProfile, SshCredential)>,
        ),
        SessionError,
    > {
        let sessions = self.sessions.read();
        let runtime = sessions
            .get(&session_id)
            .ok_or(SessionError::NotFound(session_id))?;
        if runtime.info.state != ConnectionState::Connected || runtime.ssh.is_none() {
            return Err(SessionError::NotConnected(session_id));
        }
        Ok((
            runtime.profile.clone(),
            runtime.credential.clone(),
            runtime.jump.clone(),
        ))
    }

    pub fn session_diagnostics(&self, session_id: SessionId) -> Result<String, SessionError> {
        let sessions = self.sessions.read();
        let runtime = sessions
            .get(&session_id)
            .ok_or(SessionError::NotFound(session_id))?;
        Ok(format!(
            "session={session_id} state={:?} has_ssh={} tail_chunks={} health_rtt_ms={} last_transient_io={}",
            runtime.info.state,
            runtime.ssh.is_some(),
            runtime.output_tail.len(),
            runtime
                .last_health_rtt_ms
                .map(|value| format!("{value:.1}"))
                .unwrap_or_else(|| "none".to_string()),
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
            .map(|output| output.data.clone())
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect())
    }

    pub fn output_batch(
        &self,
        session_id: SessionId,
        after_sequence: Option<u64>,
        max_chunks: usize,
    ) -> Result<TerminalOutputBatch, SessionError> {
        let sessions = self.sessions.read();
        let runtime = sessions
            .get(&session_id)
            .ok_or(SessionError::NotFound(session_id))?;
        Ok(build_output_batch(
            runtime,
            session_id,
            after_sequence,
            max_chunks,
        ))
    }

    fn push_output(&self, session_id: SessionId, data: String) {
        let output = if let Some(runtime) = self.sessions.write().get_mut(&session_id) {
            runtime.info.last_seen_at = Utc::now();
            Some(store_terminal_output(runtime, session_id, data))
        } else {
            None
        };
        if let Some(output) = output {
            let _ = self.events.send(SessionEvent::TerminalOutput(output));
        }
    }

    fn push_output_for_runtime(&self, session_id: SessionId, runtime_token: Uuid, data: String) {
        let output = if let Some(runtime) = self.sessions.write().get_mut(&session_id) {
            if runtime.runtime_token != runtime_token {
                None
            } else {
                runtime.info.last_seen_at = Utc::now();
                Some(store_terminal_output(runtime, session_id, data))
            }
        } else {
            None
        };

        if let Some(output) = output {
            let _ = self.events.send(SessionEvent::TerminalOutput(output));
        }
    }

    fn fail_session_for_runtime(&self, session_id: SessionId, runtime_token: Uuid, reason: String) {
        let reconnect = if let Some(runtime) = self.sessions.write().get_mut(&session_id) {
            if runtime.runtime_token != runtime_token {
                None
            } else {
                let reconnect_token = Uuid::new_v4();
                runtime.info.state = ConnectionState::Reconnecting;
                runtime.info.last_seen_at = Utc::now();
                runtime.ssh = None;
                runtime.runtime_token = reconnect_token;
                Some((
                    reconnect_token,
                    runtime.profile.clone(),
                    runtime.credential.clone(),
                ))
            }
        } else {
            None
        };

        if let Some((reconnect_token, profile, credential)) = reconnect {
            let _ = self.events.send(SessionEvent::StateChanged {
                session_id,
                state: ConnectionState::Reconnecting,
            });
            self.push_output(
                session_id,
                format!("\r\nConnection lost: {reason}\r\nReconnecting...\r\n"),
            );
            let manager = self.clone();
            std::thread::spawn(move || {
                manager.run_reconnect_loop(
                    session_id,
                    reconnect_token,
                    profile,
                    credential,
                    reason,
                );
            });
        }
    }

    fn run_reconnect_loop(
        &self,
        session_id: SessionId,
        reconnect_token: Uuid,
        profile: SessionProfile,
        credential: SshCredential,
        initial_reason: String,
    ) {
        let mut last_error = initial_reason;
        for attempt in 1_u64..=5 {
            if !self.is_reconnect_active(session_id, reconnect_token) {
                return;
            }
            let jitter_ms = (u64::from(session_id.as_bytes()[0]) + attempt * 37) % 240;
            std::thread::sleep(Duration::from_millis(
                (1_u64 << (attempt - 1)) * 1000 + jitter_ms,
            ));
            if !self.is_reconnect_active(session_id, reconnect_token) {
                return;
            }
            self.push_output(session_id, format!("Reconnect attempt {attempt}/5...\r\n"));
            match establish_ssh_session(self, session_id, &profile, &credential, None) {
                Ok((session, channel, wait_socket)) => {
                    if !self.is_reconnect_active(session_id, reconnect_token) {
                        return;
                    }
                    let (control, control_rx) = mpsc::channel();
                    let next_token = Uuid::new_v4();
                    let manager = self.clone();
                    let thread = std::thread::spawn(move || {
                        run_ssh_session_loop(
                            session_id,
                            next_token,
                            session,
                            channel,
                            wait_socket,
                            control_rx,
                            manager,
                        );
                    });
                    let connected =
                        if let Some(runtime) = self.sessions.write().get_mut(&session_id) {
                            if runtime.runtime_token != reconnect_token
                                || runtime.info.state == ConnectionState::Disconnected
                            {
                                false
                            } else {
                                runtime.runtime_token = next_token;
                                runtime.ssh = Some(SshRuntime {
                                    control,
                                    _thread: thread,
                                });
                                runtime.info.state = ConnectionState::Connected;
                                runtime.info.connected_at = Some(Utc::now());
                                runtime.info.last_seen_at = Utc::now();
                                true
                            }
                        } else {
                            false
                        };
                    if connected {
                        let _ = self.events.send(SessionEvent::StateChanged {
                            session_id,
                            state: ConnectionState::Connected,
                        });
                        self.push_output(session_id, "Reconnected. Shell ready.\r\n".to_string());
                    }
                    return;
                }
                Err(error) => {
                    last_error = error.to_string();
                    if last_error.contains("host key was rejected")
                        || last_error.contains("host key confirmation timed out")
                    {
                        break;
                    }
                    if let Some(runtime) = self.sessions.write().get_mut(&session_id) {
                        if runtime.runtime_token == reconnect_token {
                            runtime.info.state = ConnectionState::Reconnecting;
                        }
                    }
                }
            }
        }
        let failed = if let Some(runtime) = self.sessions.write().get_mut(&session_id) {
            if runtime.runtime_token == reconnect_token
                && runtime.info.state != ConnectionState::Disconnected
            {
                runtime.info.state = ConnectionState::Failed {
                    reason: last_error.clone(),
                };
                runtime.info.last_seen_at = Utc::now();
                true
            } else {
                false
            }
        } else {
            false
        };
        if failed {
            let _ = self.events.send(SessionEvent::StateChanged {
                session_id,
                state: ConnectionState::Failed {
                    reason: last_error.clone(),
                },
            });
            self.push_output(
                session_id,
                format!("Reconnect attempts exhausted: {last_error}\r\n"),
            );
        }
    }

    fn is_reconnect_active(&self, session_id: SessionId, reconnect_token: Uuid) -> bool {
        self.sessions
            .read()
            .get(&session_id)
            .is_some_and(|runtime| {
                runtime.runtime_token == reconnect_token
                    && runtime.info.state != ConnectionState::Disconnected
                    && !matches!(runtime.info.state, ConnectionState::Failed { .. })
            })
    }

    fn disconnect_session_for_runtime(
        &self,
        session_id: SessionId,
        runtime_token: Uuid,
        _reason: String,
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

    fn record_health_success_for_runtime(
        &self,
        session_id: SessionId,
        runtime_token: Uuid,
        elapsed_ms: f64,
    ) {
        if let Some(runtime) = self.sessions.write().get_mut(&session_id) {
            if runtime.runtime_token == runtime_token {
                runtime.last_health_rtt_ms = Some(elapsed_ms);
                runtime.last_health_at = Some(Instant::now());
                runtime.info.last_seen_at = Utc::now();
                runtime.last_transient_io = None;
            }
        }
    }
}

fn store_terminal_output(
    runtime: &mut SessionRuntime,
    session_id: SessionId,
    data: String,
) -> TerminalOutput {
    runtime.next_output_sequence = runtime.next_output_sequence.saturating_add(1);
    let output = TerminalOutput {
        session_id,
        data,
        sequence: runtime.next_output_sequence,
    };
    runtime.output_tail.push_back(output.clone());
    while runtime.output_tail.len() > TERMINAL_OUTPUT_TAIL_CHUNKS {
        runtime.output_tail.pop_front();
    }
    output
}

fn build_output_batch(
    runtime: &SessionRuntime,
    session_id: SessionId,
    after_sequence: Option<u64>,
    max_chunks: usize,
) -> TerminalOutputBatch {
    let first_sequence = runtime.output_tail.front().map(|output| output.sequence);
    let latest_sequence = runtime.next_output_sequence;
    let truncated = after_sequence
        .zip(first_sequence)
        .is_some_and(|(cursor, first)| cursor.saturating_add(1) < first);
    let available = runtime
        .output_tail
        .iter()
        .filter(|output| after_sequence.is_none_or(|cursor| output.sequence > cursor));
    let outputs = if after_sequence.is_some() {
        available.take(max_chunks).cloned().collect()
    } else {
        available
            .rev()
            .take(max_chunks)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    };

    TerminalOutputBatch {
        session_id,
        first_sequence,
        latest_sequence,
        truncated,
        outputs,
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
    let mut health_probe: Option<PendingHealthProbe> = None;
    let mut health_failures = 0;
    let mut next_health_probe_at = Instant::now() + Duration::from_secs(SSH_HEALTH_INTERVAL_SECS);
    let mut active_forwards: HashMap<Uuid, ActiveForward> = HashMap::new();
    let mut active_remote_forwards: HashMap<Uuid, ActiveRemoteForward> = HashMap::new();

    loop {
        loop {
            match control.try_recv() {
                Ok(SshControl::Terminal(data)) => {
                    pending_write.extend_from_slice(&data);
                }
                Ok(SshControl::MeasureLatency(response)) => {
                    if let Some(probe) = health_probe.as_mut() {
                        probe.responses.push(response);
                    } else {
                        health_probe = Some(PendingHealthProbe {
                            started_at: Instant::now(),
                            responses: vec![response],
                        });
                    }
                }
                Ok(SshControl::StartLocalForward(mut rule, response)) => {
                    if let Some(existing) = active_forwards.get(&rule.id) {
                        let _ = response.send(Ok(existing.rule.clone()));
                        continue;
                    }
                    let bind_address = format!("{}:{}", rule.listen_host, rule.listen_port);
                    match TcpListener::bind(&bind_address) {
                        Ok(listener) => {
                            if let Err(error) = listener.set_nonblocking(true) {
                                let _ = response
                                    .send(Err(format!("forward listener setup failed: {error}")));
                                continue;
                            }
                            let actual_port = listener
                                .local_addr()
                                .map(|addr| addr.port())
                                .unwrap_or(rule.listen_port);
                            rule.listen_port = actual_port;
                            rule.state = crate::ForwardingState::Running;
                            let stop = Arc::new(AtomicBool::new(false));
                            manager
                                .forwarding_stops
                                .write()
                                .insert(rule.id, stop.clone());
                            active_forwards.insert(
                                rule.id,
                                ActiveForward {
                                    listener,
                                    stop,
                                    rule: rule.clone(),
                                },
                            );
                            let _ = response.send(Ok(rule));
                        }
                        Err(error) => {
                            let _ = response.send(Err(format!(
                                "forward listener bind failed on {bind_address}: {error}"
                            )));
                        }
                    }
                }
                Ok(SshControl::StopForward(forwarding_id)) => {
                    if let Some(forward) = active_forwards.remove(&forwarding_id) {
                        forward.stop.store(true, Ordering::Relaxed);
                        manager.forwarding_stops.write().remove(&forwarding_id);
                    }
                    if let Some(forward) = active_remote_forwards.remove(&forwarding_id) {
                        forward.stop.store(true, Ordering::Relaxed);
                        manager.forwarding_stops.write().remove(&forwarding_id);
                    }
                }
                Ok(SshControl::StartRemoteForward(mut rule, response)) => {
                    if let Some(existing) = active_remote_forwards.get(&rule.id) {
                        let _ = response.send(Ok(existing.rule.clone()));
                        continue;
                    }
                    let host = rule.listen_host.clone();
                    let mut listen_result =
                        session.channel_forward_listen(rule.listen_port, Some(&host), Some(64));
                    for _ in 0..40 {
                        let Err(error) = &listen_result else {
                            break;
                        };
                        if !is_transient_ssh2_error(error) {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                        listen_result =
                            session.channel_forward_listen(rule.listen_port, Some(&host), Some(64));
                    }
                    match listen_result {
                        Ok((listener, actual_port)) => {
                            rule.listen_port = actual_port;
                            rule.state = crate::ForwardingState::Running;
                            let stop = Arc::new(AtomicBool::new(false));
                            manager
                                .forwarding_stops
                                .write()
                                .insert(rule.id, stop.clone());
                            active_remote_forwards.insert(
                                rule.id,
                                ActiveRemoteForward {
                                    listener,
                                    stop,
                                    rule: rule.clone(),
                                },
                            );
                            let _ = response.send(Ok(rule));
                        }
                        Err(error) => {
                            let _ = response
                                .send(Err(format!("remote forwarding request failed: {error}")));
                        }
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    cleanup_active_forwards(
                        &mut active_forwards,
                        &mut active_remote_forwards,
                        &manager,
                    );
                    return;
                }
            }
        }

        let forwarding_ids = active_forwards.keys().copied().collect::<Vec<_>>();
        for forwarding_id in forwarding_ids {
            let Some(forward) = active_forwards.get(&forwarding_id) else {
                continue;
            };
            if forward.stop.load(Ordering::Relaxed) {
                continue;
            }
            loop {
                let Ok((mut stream, _peer)) = forward.listener.accept() else {
                    break;
                };
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
                let (target_host, target_port) = if forward.rule.kind == ForwardingKind::Socks {
                    match socks5_handshake(&mut stream) {
                        Ok(target) => target,
                        Err(_) => {
                            let _ = stream.shutdown(std::net::Shutdown::Both);
                            continue;
                        }
                    }
                } else {
                    (
                        forward
                            .rule
                            .target_host
                            .as_deref()
                            .unwrap_or_default()
                            .to_string(),
                        forward.rule.target_port.unwrap_or_default(),
                    )
                };
                match channel_direct_tcpip_retry(&session, &target_host, target_port) {
                    Ok(mut channel) => {
                        if forward.rule.kind == ForwardingKind::Socks {
                            let _ = stream.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
                        }
                        std::thread::spawn(move || {
                            let mut stream_clone = match stream.try_clone() {
                                Ok(clone) => clone,
                                Err(_) => return,
                            };
                            let mut channel_clone = channel.clone();
                            let left = std::thread::spawn(move || {
                                copy_with_would_block_retry(&mut stream_clone, &mut channel_clone);
                            });
                            copy_with_would_block_retry(&mut channel, &mut stream);
                            let _ = left.join();
                        });
                    }
                    Err(_) => {
                        if forward.rule.kind == ForwardingKind::Socks {
                            let _ = stream.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]);
                        }
                        let _ = stream.shutdown(std::net::Shutdown::Both);
                    }
                }
            }
        }

        let remote_forwarding_ids = active_remote_forwards.keys().copied().collect::<Vec<_>>();
        for forwarding_id in remote_forwarding_ids {
            let Some(forward) = active_remote_forwards.get_mut(&forwarding_id) else {
                continue;
            };
            if forward.stop.load(Ordering::Relaxed) {
                continue;
            }
            loop {
                let Ok(mut channel) = forward.listener.accept() else {
                    break;
                };
                let target_host = forward
                    .rule
                    .target_host
                    .as_deref()
                    .unwrap_or_default()
                    .to_string();
                let target_port = forward.rule.target_port.unwrap_or_default();
                match TcpStream::connect((target_host.as_str(), target_port)) {
                    Ok(mut stream) => {
                        std::thread::spawn(move || {
                            let mut channel_clone = channel.clone();
                            let mut stream_clone = match stream.try_clone() {
                                Ok(clone) => clone,
                                Err(_) => return,
                            };
                            let left = std::thread::spawn(move || {
                                copy_with_would_block_retry(&mut channel_clone, &mut stream_clone);
                            });
                            copy_with_would_block_retry(&mut stream, &mut channel);
                            let _ = left.join();
                        });
                    }
                    Err(_) => {
                        let _ = channel.close();
                    }
                }
            }
        }

        let Some(bytes_read) = drain_channel_output(
            &session,
            &mut channel,
            &mut buffer,
            session_id,
            runtime_token,
            &manager,
        ) else {
            cleanup_active_forwards(&mut active_forwards, &mut active_remote_forwards, &manager);
            return;
        };
        if bytes_read > 0 {
            health_failures = 0;
            next_health_probe_at = Instant::now() + Duration::from_secs(SSH_HEALTH_INTERVAL_SECS);
        }

        while pending_offset < pending_write.len() {
            match channel.write(&pending_write[pending_offset..]) {
                Ok(0) => break,
                Ok(written) => {
                    pending_offset += written;
                    health_failures = 0;
                    next_health_probe_at =
                        Instant::now() + Duration::from_secs(SSH_HEALTH_INTERVAL_SECS);
                }
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
                    cleanup_active_forwards(
                        &mut active_forwards,
                        &mut active_remote_forwards,
                        &manager,
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
                    cleanup_active_forwards(
                        &mut active_forwards,
                        &mut active_remote_forwards,
                        &manager,
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

        let Some(bytes_read) = drain_channel_output(
            &session,
            &mut channel,
            &mut buffer,
            session_id,
            runtime_token,
            &manager,
        ) else {
            cleanup_active_forwards(&mut active_forwards, &mut active_remote_forwards, &manager);
            return;
        };
        if bytes_read > 0 {
            health_failures = 0;
            next_health_probe_at = Instant::now() + Duration::from_secs(SSH_HEALTH_INTERVAL_SECS);
        }

        if health_probe.is_none() && Instant::now() >= next_health_probe_at {
            health_probe = Some(PendingHealthProbe {
                started_at: Instant::now(),
                responses: Vec::new(),
            });
        }

        if let Some(probe) = health_probe.as_ref() {
            match poll_session_health(&session, probe.started_at) {
                HealthProbePoll::Pending => {}
                HealthProbePoll::Alive(elapsed_ms) => {
                    health_failures = 0;
                    let completed = health_probe.take().expect("health probe exists");
                    for response in completed.responses {
                        let _ = response.send(Ok(Some(elapsed_ms)));
                    }
                    manager.record_health_success_for_runtime(
                        session_id,
                        runtime_token,
                        elapsed_ms,
                    );
                    next_health_probe_at =
                        Instant::now() + Duration::from_secs(SSH_HEALTH_INTERVAL_SECS);
                }
                HealthProbePoll::Failed(reason) => {
                    health_failures += 1;
                    let failed = health_probe.take().expect("health probe exists");
                    for response in failed.responses {
                        let _ = response.send(Err(reason.clone()));
                    }
                    if health_failures >= SSH_HEALTH_FAILURE_LIMIT {
                        manager.fail_session_for_runtime(session_id, runtime_token, reason);
                        cleanup_active_forwards(
                            &mut active_forwards,
                            &mut active_remote_forwards,
                            &manager,
                        );
                        return;
                    }
                    next_health_probe_at =
                        Instant::now() + Duration::from_secs(SSH_HEALTH_INTERVAL_SECS);
                }
            }
        }

        socket_waiter.wait(&session, Duration::from_millis(10));
    }
}

fn cleanup_active_forwards(
    active_forwards: &mut HashMap<Uuid, ActiveForward>,
    active_remote_forwards: &mut HashMap<Uuid, ActiveRemoteForward>,
    manager: &SessionManager,
) {
    for (forwarding_id, forward) in active_forwards.drain() {
        forward.stop.store(true, Ordering::Relaxed);
        manager.forwarding_stops.write().remove(&forwarding_id);
    }
    for (forwarding_id, forward) in active_remote_forwards.drain() {
        forward.stop.store(true, Ordering::Relaxed);
        manager.forwarding_stops.write().remove(&forwarding_id);
    }
}

fn copy_with_would_block_retry<R: Read, W: Write>(reader: &mut R, writer: &mut W) {
    let mut buffer = [0_u8; 32 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => {
                let _ = writer.flush();
                return;
            }
            Ok(bytes) => {
                let mut offset = 0;
                while offset < bytes {
                    match writer.write(&buffer[offset..bytes]) {
                        Ok(0) => return,
                        Ok(written) => offset += written,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => return,
                    }
                }
                let _ = writer.flush();
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) => return,
        }
    }
}

fn channel_direct_tcpip_retry(
    session: &ssh2::Session,
    host: &str,
    port: u16,
) -> Result<ssh2::Channel, ssh2::Error> {
    let mut result = session.channel_direct_tcpip(host, port, None);
    for _ in 0..40 {
        let Err(error) = &result else {
            break;
        };
        if !is_transient_ssh2_error(error) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
        result = session.channel_direct_tcpip(host, port, None);
    }
    result
}

fn socks5_handshake(stream: &mut TcpStream) -> anyhow::Result<(String, u16)> {
    let mut header = [0_u8; 2];
    stream.read_exact(&mut header)?;
    if header[0] != 5 {
        anyhow::bail!("unsupported SOCKS version");
    }
    let mut methods = vec![0_u8; usize::from(header[1])];
    stream.read_exact(&mut methods)?;
    if !methods.contains(&0) {
        stream.write_all(&[5, 0xff])?;
        anyhow::bail!("SOCKS authentication is not supported");
    }
    stream.write_all(&[5, 0])?;
    let mut request = [0_u8; 4];
    stream.read_exact(&mut request)?;
    if request[0] != 5 || request[1] != 1 {
        stream.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0])?;
        anyhow::bail!("SOCKS supports TCP CONNECT only");
    }
    let host = match request[3] {
        1 => {
            let mut addr = [0_u8; 4];
            stream.read_exact(&mut addr)?;
            std::net::Ipv4Addr::from(addr).to_string()
        }
        3 => {
            let mut len = [0_u8; 1];
            stream.read_exact(&mut len)?;
            let mut name = vec![0_u8; usize::from(len[0])];
            stream.read_exact(&mut name)?;
            String::from_utf8(name)?
        }
        4 => {
            let mut addr = [0_u8; 16];
            stream.read_exact(&mut addr)?;
            std::net::Ipv6Addr::from(addr).to_string()
        }
        _ => {
            stream.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0])?;
            anyhow::bail!("unsupported SOCKS address type");
        }
    };
    let mut port = [0_u8; 2];
    stream.read_exact(&mut port)?;
    let port = u16::from_be_bytes(port);
    if port == 0 {
        anyhow::bail!("SOCKS target port must be greater than zero");
    }
    Ok((host, port))
}

fn drain_channel_output(
    session: &ssh2::Session,
    channel: &mut ssh2::Channel,
    buffer: &mut [u8],
    session_id: SessionId,
    runtime_token: Uuid,
    manager: &SessionManager,
) -> Option<usize> {
    let mut total_read = 0;
    for _ in 0..64 {
        match channel.read(buffer) {
            Ok(0) => {
                if channel.eof() {
                    manager.disconnect_session_for_runtime(
                        session_id,
                        runtime_token,
                        "remote shell closed".to_string(),
                    );
                    return None;
                }
                return Some(total_read);
            }
            Ok(read) => {
                total_read += read;
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
                return Some(total_read);
            }
            Err(error) => {
                manager.fail_session_for_runtime(
                    session_id,
                    runtime_token,
                    format!("terminal read failed: {error}"),
                );
                return None;
            }
        }
    }

    Some(total_read)
}

fn poll_session_health(session: &ssh2::Session, started_at: Instant) -> HealthProbePoll {
    let elapsed = started_at.elapsed();
    match session.keepalive_send() {
        Ok(_) => HealthProbePoll::Alive(elapsed.as_secs_f64() * 1000.0),
        Err(error) if is_transient_ssh2_error(&error) => {
            if elapsed >= Duration::from_millis(SSH_HEALTH_TIMEOUT_MS) {
                HealthProbePoll::Failed("SSH connection timed out.".to_string())
            } else {
                HealthProbePoll::Pending
            }
        }
        Err(error) => HealthProbePoll::Failed(format!("SSH connection lost: {error}")),
    }
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
    let requested_path = normalize_remote_path(remote_path);
    session.set_blocking(true);
    let result: anyhow::Result<RemoteDirectoryListing> = (|| {
        let sftp = session.sftp()?;
        let path = if requested_path == "." {
            sftp.realpath(Path::new("."))?
                .to_string_lossy()
                .into_owned()
        } else {
            requested_path
        };
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
    expected: Option<&SftpProgress>,
    conflict_decision: Option<TransferConflictDecision>,
) -> anyhow::Result<SftpProgress> {
    session.set_blocking(true);
    session.set_timeout(SFTP_TRANSFER_TIMEOUT_MS);
    let result: anyhow::Result<SftpProgress> = (|| {
        let remote_path = normalize_remote_path(remote_path);
        let now = Utc::now().to_rfc3339();
        let mut progress = SftpProgress {
            id: transfer_id,
            session_id,
            profile_id: None,
            direction: FileTransferDirection::Download,
            local_path: local_path.to_string(),
            remote_path: remote_path.clone(),
            bytes_done: 0,
            bytes_total: None,
            status: TransferStatus::Running,
            created_at: expected
                .and_then(|item| item.created_at.clone())
                .or_else(|| Some(now.clone())),
            updated_at: Some(now),
            retry_count: expected.map(|item| item.retry_count).unwrap_or(0),
            last_error: expected.and_then(|item| item.last_error.clone()),
            source_size: None,
            source_modified_at: None,
            target_size: std::fs::metadata(local_path)
                .ok()
                .map(|metadata| metadata.len()),
            target_modified_at: file_modified_unix(local_path),
        };
        emit_sftp_progress(manager, &progress);

        let mut last_error = None;
        let mut pending_decision = conflict_decision;
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
                let remote_stat = sftp.stat(Path::new(&remote_path))?;
                progress.bytes_total = remote_stat.size;
                progress.source_size = remote_stat.size;
                progress.source_modified_at = remote_stat.mtime;

                let local_path_buf = PathBuf::from(local_path);
                let actual_target_size = std::fs::metadata(&local_path_buf)
                    .ok()
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                progress.target_size = Some(actual_target_size);
                let decision = pending_decision.take();
                if matches!(decision.as_ref(), Some(TransferConflictDecision::Cancel)) {
                    progress.status = TransferStatus::Cancelled;
                    emit_sftp_progress(manager, &progress);
                    return Ok(progress.clone());
                }
                let source_changed = expected.is_some_and(|previous| {
                    previous
                        .source_size
                        .is_some_and(|size| remote_stat.size != Some(size))
                        || previous
                            .source_modified_at
                            .is_some_and(|mtime| remote_stat.mtime != Some(mtime))
                });
                let offset_changed = expected
                    .map(|previous| previous.bytes_done != actual_target_size)
                    .unwrap_or(actual_target_size > 0);
                let target_exceeds_source = progress
                    .bytes_total
                    .is_some_and(|total| actual_target_size > total);
                if target_exceeds_source
                    && matches!(decision.as_ref(), Some(TransferConflictDecision::Continue))
                {
                    progress.bytes_done = actual_target_size;
                    progress.status = TransferStatus::NeedsAttention {
                        reason:
                            "本地目标文件大于远端源文件，无法从现有断点继续；请重新开始或取消任务"
                                .to_string(),
                        expected_size: progress.bytes_total,
                        actual_size: Some(actual_target_size),
                    };
                    emit_sftp_progress(manager, &progress);
                    return Ok(progress.clone());
                }
                if attempt == 1
                    && !matches!(
                        decision.as_ref(),
                        Some(
                            TransferConflictDecision::Restart | TransferConflictDecision::Continue
                        )
                    )
                    && (source_changed || offset_changed || target_exceeds_source)
                {
                    progress.bytes_done = actual_target_size;
                    progress.status = TransferStatus::NeedsAttention {
                        reason: if source_changed {
                            "远端源文件已发生变化"
                        } else {
                            "本地目标文件与记录的断点不一致"
                        }
                        .to_string(),
                        expected_size: expected.map(|previous| previous.bytes_done),
                        actual_size: Some(actual_target_size),
                    };
                    emit_sftp_progress(manager, &progress);
                    return Ok(progress.clone());
                }
                let resume_offset =
                    if matches!(decision.as_ref(), Some(TransferConflictDecision::Restart)) {
                        0
                    } else {
                        actual_target_size
                    };

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
                    if manager.is_transfer_paused(transfer_id) {
                        progress.status = TransferStatus::Paused;
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
                    if manager.is_transfer_paused(transfer_id) {
                        progress.status = TransferStatus::Paused;
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
            expected,
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
    expected: Option<&SftpProgress>,
    conflict_decision: Option<TransferConflictDecision>,
) -> anyhow::Result<SftpProgress> {
    session.set_blocking(true);
    session.set_timeout(SFTP_TRANSFER_TIMEOUT_MS);
    let upload_total = std::fs::metadata(local_path)
        .ok()
        .map(|metadata| metadata.len());
    let result: anyhow::Result<SftpProgress> = (|| {
        let remote_path = normalize_remote_path(remote_path);
        let now = Utc::now().to_rfc3339();
        let mut progress = SftpProgress {
            id: transfer_id,
            session_id,
            profile_id: None,
            direction: FileTransferDirection::Upload,
            local_path: local_path.to_string(),
            remote_path: remote_path.clone(),
            bytes_done: 0,
            bytes_total: upload_total,
            status: TransferStatus::Running,
            created_at: expected
                .and_then(|item| item.created_at.clone())
                .or_else(|| Some(now.clone())),
            updated_at: Some(now),
            retry_count: expected.map(|item| item.retry_count).unwrap_or(0),
            last_error: expected.and_then(|item| item.last_error.clone()),
            source_size: upload_total,
            source_modified_at: file_modified_unix(local_path),
            target_size: None,
            target_modified_at: None,
        };
        emit_sftp_progress(manager, &progress);

        let mut last_error = None;
        let mut pending_decision = conflict_decision;
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
                let remote_stat = sftp.stat(Path::new(&remote_path)).ok();
                let actual_target_size =
                    remote_stat.as_ref().and_then(|stat| stat.size).unwrap_or(0);
                progress.target_size = Some(actual_target_size);
                progress.target_modified_at = remote_stat.as_ref().and_then(|stat| stat.mtime);
                let current_source_size = std::fs::metadata(local_path)
                    .ok()
                    .map(|metadata| metadata.len());
                let current_source_modified = file_modified_unix(local_path);
                progress.source_size = current_source_size;
                progress.source_modified_at = current_source_modified;
                let decision = pending_decision.take();
                if matches!(decision.as_ref(), Some(TransferConflictDecision::Cancel)) {
                    progress.status = TransferStatus::Cancelled;
                    emit_sftp_progress(manager, &progress);
                    return Ok(progress.clone());
                }
                let source_changed = expected.is_some_and(|previous| {
                    previous
                        .source_size
                        .is_some_and(|size| current_source_size != Some(size))
                        || previous
                            .source_modified_at
                            .is_some_and(|mtime| current_source_modified != Some(mtime))
                });
                let offset_changed = expected
                    .map(|previous| previous.bytes_done != actual_target_size)
                    .unwrap_or(actual_target_size > 0);
                let target_exceeds_source =
                    upload_total.is_some_and(|total| actual_target_size > total);
                if target_exceeds_source
                    && matches!(decision.as_ref(), Some(TransferConflictDecision::Continue))
                {
                    progress.bytes_done = actual_target_size;
                    progress.status = TransferStatus::NeedsAttention {
                        reason:
                            "远端目标文件大于本地源文件，无法从现有断点继续；请重新开始或取消任务"
                                .to_string(),
                        expected_size: upload_total,
                        actual_size: Some(actual_target_size),
                    };
                    emit_sftp_progress(manager, &progress);
                    return Ok(progress.clone());
                }
                if attempt == 1
                    && !matches!(
                        decision.as_ref(),
                        Some(
                            TransferConflictDecision::Restart | TransferConflictDecision::Continue
                        )
                    )
                    && (source_changed || offset_changed || target_exceeds_source)
                {
                    progress.bytes_done = actual_target_size;
                    progress.status = TransferStatus::NeedsAttention {
                        reason: if source_changed {
                            "本地源文件已发生变化"
                        } else {
                            "远端目标文件与记录的断点不一致"
                        }
                        .to_string(),
                        expected_size: expected.map(|previous| previous.bytes_done),
                        actual_size: Some(actual_target_size),
                    };
                    emit_sftp_progress(manager, &progress);
                    return Ok(progress.clone());
                }
                let resume_offset =
                    if matches!(decision.as_ref(), Some(TransferConflictDecision::Restart)) {
                        0
                    } else {
                        actual_target_size
                    };

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
                    if manager.is_transfer_paused(transfer_id) {
                        progress.status = TransferStatus::Paused;
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
                    if manager.is_transfer_paused(transfer_id) {
                        progress.status = TransferStatus::Paused;
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
            expected,
        );
    }
    result
}

fn emit_sftp_progress(manager: &SessionManager, progress: &SftpProgress) {
    let mut progress = progress.clone();
    if progress.profile_id.is_none() {
        progress.profile_id = manager
            .sessions
            .read()
            .get(&progress.session_id)
            .map(|runtime| runtime.profile.id);
    }
    progress.updated_at = Some(Utc::now().to_rfc3339());
    let _ = manager.events.send(SessionEvent::SftpProgress(progress));
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
    expected: Option<&SftpProgress>,
) {
    emit_sftp_progress(
        manager,
        &SftpProgress {
            id: transfer_id,
            session_id,
            profile_id: None,
            direction,
            local_path: local_path.to_string(),
            remote_path: remote_path.to_string(),
            bytes_done,
            bytes_total,
            status: TransferStatus::Failed {
                reason: reason.clone(),
            },
            created_at: expected
                .and_then(|item| item.created_at.clone())
                .or_else(|| Some(Utc::now().to_rfc3339())),
            updated_at: Some(Utc::now().to_rfc3339()),
            retry_count: expected
                .map(|item| item.retry_count.saturating_add(1))
                .unwrap_or(1),
            last_error: Some(reason.clone()),
            source_size: expected.and_then(|item| item.source_size).or(bytes_total),
            source_modified_at: expected
                .and_then(|item| item.source_modified_at)
                .or_else(|| file_modified_unix(local_path)),
            target_size: Some(bytes_done),
            target_modified_at: None,
        },
    );
}

fn file_modified_unix(path: &str) -> Option<u64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
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
    manager: &SessionManager,
    session_id: SessionId,
    profile: &SessionProfile,
    credential: &SshCredential,
    jump: Option<(SessionProfile, SshCredential)>,
) -> Result<(ssh2::Session, ssh2::Channel, TcpStream), anyhow::Error> {
    let (session, wait_socket) = establish_authenticated_ssh_session_with_jump(
        manager, session_id, profile, credential, jump,
    )?;
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
    wait_socket.set_nonblocking(true)?;
    session.set_blocking(false);
    Ok((session, channel, wait_socket))
}

fn establish_ssh_side_session(
    manager: &SessionManager,
    session_id: SessionId,
    profile: &SessionProfile,
    credential: &SshCredential,
    jump: Option<(SessionProfile, SshCredential)>,
) -> Result<(ssh2::Session, TcpStream), anyhow::Error> {
    let (session, wait_socket) = establish_authenticated_ssh_session_with_jump(
        manager, session_id, profile, credential, jump,
    )?;
    wait_socket.set_nonblocking(true)?;
    session.set_blocking(true);
    Ok((session, wait_socket))
}

fn establish_authenticated_ssh_session(
    manager: &SessionManager,
    session_id: SessionId,
    profile: &SessionProfile,
    credential: &SshCredential,
) -> Result<(ssh2::Session, TcpStream), anyhow::Error> {
    establish_authenticated_ssh_session_with_jump(manager, session_id, profile, credential, None)
}

fn establish_authenticated_ssh_session_with_jump(
    manager: &SessionManager,
    session_id: SessionId,
    profile: &SessionProfile,
    credential: &SshCredential,
    jump: Option<(SessionProfile, SshCredential)>,
) -> Result<(ssh2::Session, TcpStream), anyhow::Error> {
    if let SshCredential::PrivateKey { key_path, .. } = credential {
        if !key_path.is_file() {
            anyhow::bail!("SSH private key file was not found: {}", key_path.display());
        }
    }

    let (tcp, relay_guard): (TcpStream, Option<std::thread::JoinHandle<()>>) =
        if let Some((jump_profile, jump_credential)) = jump {
            let (jump_session, _) = establish_authenticated_ssh_session_with_jump(
                manager,
                session_id,
                &jump_profile,
                &jump_credential,
                None,
            )?;
            // The SSH forwarding request itself is a synchronous libssh2 operation.
            // Keep the jump session blocking until the direct-tcpip channel exists;
            // the target session and relay can use their own I/O scheduling after that.
            jump_session.set_blocking(true);
            let channel = jump_session
                .channel_direct_tcpip(&profile.host, profile.port, None)
                .map_err(|e| {
                    anyhow::anyhow!(
                        "ProxyJump channel to {}:{} failed: {}",
                        profile.host,
                        profile.port,
                        e
                    )
                })?;
            jump_session.set_blocking(false);
            let listener = TcpListener::bind("127.0.0.1:0")?;
            let addr = listener.local_addr()?;
            let local = TcpStream::connect(addr)?;
            let (peer, _) = listener.accept()?;
            let relay = std::thread::spawn(move || {
                let _jump_session = jump_session;
                let mut channel = channel;
                let mut peer = peer;
                let _ = peer.set_nonblocking(true);
                let mut buffer = [0_u8; 16 * 1024];
                let mut reverse = [0_u8; 16 * 1024];
                loop {
                    let mut progressed = false;
                    match channel.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(n) => {
                            if relay_write_retry(&mut peer, &buffer[..n]).is_err() {
                                break;
                            }
                            progressed = true;
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                        Err(_) => break,
                    }
                    match peer.read(&mut reverse) {
                        Ok(0) => break,
                        Ok(n) => {
                            if relay_write_retry(&mut channel, &reverse[..n]).is_err() {
                                break;
                            }
                            progressed = true;
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                        Err(_) => break,
                    }
                    if !progressed {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                }
            });
            (local, Some(relay))
        } else {
            let address = format!("{}:{}", profile.host, profile.port);
            let socket_addr = address
                .to_socket_addrs()?
                .next()
                .ok_or_else(|| anyhow::anyhow!("host did not resolve"))?;
            let tcp = TcpStream::connect_timeout(
                &socket_addr,
                Duration::from_secs(SSH_CONNECT_TIMEOUT_SECS),
            )
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
            (tcp, None)
        };
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
    manager.verify_host_key(session_id, profile, &session)?;
    match credential {
        SshCredential::Password(password) => session
            .userauth_password(&profile.username, password)
            .map_err(|error| {
                anyhow::anyhow!(
                    "SSH password authentication failed for {}@{}:{}: {}",
                    profile.username,
                    profile.host,
                    profile.port,
                    error
                )
            })?,
        SshCredential::PrivateKey {
            key_path,
            passphrase,
        } => session
            .userauth_pubkey_file(&profile.username, None, key_path, passphrase.as_deref())
            .map_err(|error| {
                anyhow::anyhow!(
                    "SSH private key authentication failed for {}@{}:{} using {}: {}",
                    profile.username,
                    profile.host,
                    profile.port,
                    key_path.display(),
                    error
                )
            })?,
        SshCredential::Agent {
            identity_fingerprint,
        } => authenticate_with_agent(&session, &profile.username, identity_fingerprint.as_deref())?,
    }
    if !session.authenticated() {
        anyhow::bail!("authentication failed");
    }
    session.set_keepalive(true, SSH_KEEPALIVE_INTERVAL_SECS);

    let _ = relay_guard;
    Ok((session, wait_socket))
}

fn relay_write_retry<W: Write>(writer: &mut W, mut data: &[u8]) -> std::io::Result<()> {
    while !data.is_empty() {
        match writer.write(data) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "relay closed",
                ))
            }
            Ok(n) => data = &data[n..],
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

impl SessionManager {
    fn verify_host_key(
        &self,
        session_id: SessionId,
        profile: &SessionProfile,
        session: &ssh2::Session,
    ) -> Result<(), anyhow::Error> {
        if matches!(profile.host_key_policy, HostKeyPolicy::InsecureAcceptAny) {
            return Ok(());
        }
        let Some(known_hosts) = &self.known_hosts else {
            return Ok(());
        };
        let Some(path) = &self.known_hosts_path else {
            return Ok(());
        };
        let (key, key_type) = session
            .host_key()
            .ok_or_else(|| anyhow::anyhow!("server did not provide a host key"))?;
        let key_base64 = base64::engine::general_purpose::STANDARD.encode(key);
        let key_type = openssh_host_key_algorithm(key_type)?;
        let fingerprint = sha256_fingerprint(&key_base64)?;
        let check = known_hosts
            .read()
            .map_err(|_| anyhow::anyhow!("known_hosts is unavailable"))?
            .check(&profile.host, profile.port, &key_type, &key_base64);
        let (reason, previous_fingerprint) = match check {
            HostKeyCheck::Match => return Ok(()),
            HostKeyCheck::Unknown => (HostKeyPromptReason::Unknown, None),
            HostKeyCheck::Changed { previous } => (
                HostKeyPromptReason::Changed,
                Some(sha256_fingerprint(&previous.key_base64)?),
            ),
        };
        let token = Uuid::new_v4();
        let created_at = Utc::now();
        let prompt = HostKeyPrompt {
            token,
            session_id,
            profile_id: profile.id,
            host: profile.host.clone(),
            port: profile.port,
            key_type: key_type.clone(),
            key_base64: key_base64.clone(),
            fingerprint: fingerprint.clone(),
            previous_fingerprint: previous_fingerprint.clone(),
            reason: reason.clone(),
            created_at,
        };
        let (response, receiver) = mpsc::channel();
        self.pending_host_keys.write().insert(
            token,
            PendingHostKeyPrompt {
                session_id,
                response,
            },
        );
        if let Some(runtime) = self.sessions.write().get_mut(&session_id) {
            runtime.info.state = ConnectionState::HostKeyPending;
            runtime.info.last_seen_at = Utc::now();
        }
        let _ = self.events.send(SessionEvent::StateChanged {
            session_id,
            state: ConnectionState::HostKeyPending,
        });
        if let Some(previous) = &previous_fingerprint {
            let _ = self.events.send(SessionEvent::HostKeyChanged {
                session_id,
                host: profile.host.clone(),
                port: profile.port,
                previous_fingerprint: previous.clone(),
                fingerprint: fingerprint.clone(),
            });
        }
        let _ = self.events.send(SessionEvent::HostKeyPrompt(prompt));
        let decision = receiver
            .recv_timeout(Duration::from_secs(120))
            .map_err(|_| {
                self.pending_host_keys.write().remove(&token);
                anyhow::anyhow!(
                    "host key confirmation timed out for {}:{} ({})",
                    profile.host,
                    profile.port,
                    fingerprint
                )
            })?;
        self.pending_host_keys.write().remove(&token);
        let allowed = matches!(
            (&reason, &decision),
            (HostKeyPromptReason::Unknown, HostKeyDecision::Accept)
                | (HostKeyPromptReason::Changed, HostKeyDecision::Update)
        );
        if !allowed {
            anyhow::bail!(
                "host key was rejected for {}:{} ({}, {})",
                profile.host,
                profile.port,
                key_type,
                fingerprint
            );
        }
        {
            let mut store = known_hosts
                .write()
                .map_err(|_| anyhow::anyhow!("known_hosts is unavailable"))?;
            store.accept(&profile.host, profile.port, &key_type, &key_base64);
            store.save(path.as_ref())?;
        }
        let _ = self.events.send(SessionEvent::HostKeyAccepted {
            session_id,
            host: profile.host.clone(),
            port: profile.port,
            fingerprint,
        });
        Ok(())
    }
}

fn openssh_host_key_algorithm(key_type: ssh2::HostKeyType) -> anyhow::Result<String> {
    let algorithm = match key_type {
        ssh2::HostKeyType::Rsa => "ssh-rsa",
        ssh2::HostKeyType::Dss => "ssh-dss",
        ssh2::HostKeyType::Ecdsa256 => "ecdsa-sha2-nistp256",
        ssh2::HostKeyType::Ecdsa384 => "ecdsa-sha2-nistp384",
        ssh2::HostKeyType::Ecdsa521 => "ecdsa-sha2-nistp521",
        ssh2::HostKeyType::Ed25519 => "ssh-ed25519",
        ssh2::HostKeyType::Unknown => {
            anyhow::bail!("server returned an unknown host key algorithm")
        }
    };
    Ok(algorithm.to_string())
}

fn authenticate_with_agent(
    session: &ssh2::Session,
    username: &str,
    identity_fingerprint: Option<&str>,
) -> Result<(), anyhow::Error> {
    let mut agent = session
        .agent()
        .map_err(|error| anyhow::anyhow!("SSH agent is unavailable: {error}"))?;
    agent
        .connect()
        .map_err(|error| anyhow::anyhow!("SSH agent connection failed: {error}"))?;
    agent
        .list_identities()
        .map_err(|error| anyhow::anyhow!("SSH agent key listing failed: {error}"))?;
    let identities = agent
        .identities()
        .map_err(|error| anyhow::anyhow!("SSH agent key listing failed: {error}"))?;
    if identities.is_empty() {
        anyhow::bail!("SSH agent has no available identities");
    }
    let selected = identities.iter().find(|identity| {
        identity_fingerprint
            .map(|expected| ssh_agent_identity_fingerprint(identity) == expected)
            .unwrap_or(true)
    });
    let identity = selected.ok_or_else(|| {
        anyhow::anyhow!(
            "SSH agent identity was not found: {}",
            identity_fingerprint.unwrap_or("")
        )
    })?;
    agent
        .userauth(username, identity)
        .map_err(|error| anyhow::anyhow!("SSH agent authentication failed: {error}"))
}

fn ssh_agent_identity_fingerprint(identity: &ssh2::PublicKey) -> String {
    let digest = sha2::Sha256::digest(identity.blob());
    format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)
    )
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentIdentity {
    pub fingerprint: String,
    pub comment: String,
    pub algorithm: String,
}

pub fn list_ssh_agent_identities() -> Result<Vec<AgentIdentity>, anyhow::Error> {
    let session = ssh2::Session::new()
        .map_err(|error| anyhow::anyhow!("SSH agent initialization failed: {error}"))?;
    let mut agent = session
        .agent()
        .map_err(|error| anyhow::anyhow!("SSH agent is unavailable: {error}"))?;
    agent
        .connect()
        .map_err(|error| anyhow::anyhow!("SSH agent connection failed: {error}"))?;
    agent
        .list_identities()
        .map_err(|error| anyhow::anyhow!("SSH agent key listing failed: {error}"))?;
    let identities = agent
        .identities()
        .map_err(|error| anyhow::anyhow!("SSH agent key listing failed: {error}"))?;
    Ok(identities
        .iter()
        .map(|identity| AgentIdentity {
            fingerprint: ssh_agent_identity_fingerprint(identity),
            comment: identity.comment().to_string(),
            algorithm: public_key_blob_algorithm(identity.blob()),
        })
        .collect())
}

fn public_key_blob_algorithm(blob: &[u8]) -> String {
    if blob.len() < 4 {
        return "unknown".to_string();
    }
    let length = u32::from_be_bytes([blob[0], blob[1], blob[2], blob[3]]) as usize;
    if length == 0 || blob.len() < 4 + length {
        return "unknown".to_string();
    }
    std::str::from_utf8(&blob[4..4 + length])
        .unwrap_or("unknown")
        .to_string()
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

fn is_transient_ssh2_error(error: &ssh2::Error) -> bool {
    if matches!(
        error.code(),
        ssh2::ErrorCode::Session(-37)
            | ssh2::ErrorCode::Session(-32)
            | ssh2::ErrorCode::Session(-9)
    ) {
        return true;
    }
    let message = error.to_string().to_ascii_lowercase();
    message.contains("would block")
        || message.contains("operation would block")
        || message.contains("timed out")
        || message.contains("timeout")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn forwarding_rule(kind: ForwardingKind, session_id: SessionId) -> ForwardingRule {
        let is_socks = kind == ForwardingKind::Socks;
        ForwardingRule {
            id: Uuid::new_v4(),
            session_id,
            kind,
            listen_host: "127.0.0.1".to_string(),
            listen_port: 28080,
            target_host: (!is_socks).then(|| "127.0.0.1".to_string()),
            target_port: (!is_socks).then_some(18080),
            state: crate::ForwardingState::Stopped,
            last_error: None,
            active_connections: 0,
            auto_resume: true,
        }
    }

    #[tokio::test]
    async fn failed_forward_starts_do_not_leave_runtime_rules() {
        let manager = SessionManager::new();
        let session_id = Uuid::new_v4();

        assert!(manager
            .start_local_forward(
                session_id,
                forwarding_rule(ForwardingKind::Local, session_id),
            )
            .await
            .is_err());
        assert!(manager
            .start_remote_forward(
                session_id,
                forwarding_rule(ForwardingKind::Remote, session_id),
            )
            .await
            .is_err());
        assert!(manager
            .start_socks_forward(
                session_id,
                forwarding_rule(ForwardingKind::Socks, session_id),
            )
            .await
            .is_err());
        assert!(manager.list_forwarding_rules(session_id).is_empty());
    }

    #[test]
    fn socks5_handshake_parses_domain_and_port() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind SOCKS test listener");
        let address = listener.local_addr().expect("read listener address");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept SOCKS test connection");
            socks5_handshake(&mut stream)
        });

        let mut client = TcpStream::connect(address).expect("connect SOCKS test client");
        client.write_all(&[5, 1, 0]).expect("send greeting");
        let mut greeting_response = [0_u8; 2];
        client
            .read_exact(&mut greeting_response)
            .expect("read greeting response");
        assert_eq!(greeting_response, [5, 0]);

        let hostname = b"example.internal";
        let mut request = vec![5, 1, 0, 3, hostname.len() as u8];
        request.extend_from_slice(hostname);
        request.extend_from_slice(&8443_u16.to_be_bytes());
        client.write_all(&request).expect("send CONNECT request");

        assert_eq!(
            server.join().expect("join SOCKS test server").unwrap(),
            ("example.internal".to_string(), 8443)
        );
    }

    fn test_session_runtime(session_id: SessionId) -> SessionRuntime {
        let profile = SessionProfile {
            id: session_id,
            name: "sequence-test".to_string(),
            group: None,
            host: "127.0.0.1".to_string(),
            port: 22,
            latency_probe_host: None,
            latency_probe_port: None,
            use_terminal_latency_probe: false,
            operating_system: None,
            username: "test-user".to_string(),
            auth_method: AuthMethod::Password {
                secret_ref: "test-secret".to_string(),
            },
            agent_identity_fingerprint: None,
            host_key_policy: HostKeyPolicy::AcceptNew,
            tags: Vec::new(),
            favorite: false,
            sort_order: 0,
            jump_host_id: None,
        };
        SessionRuntime {
            info: SessionInfo {
                id: session_id,
                profile_id: session_id,
                profile_name: profile.name.clone(),
                host: profile.host.clone(),
                port: profile.port,
                username: profile.username.clone(),
                state: ConnectionState::Connected,
                connected_at: Some(Utc::now()),
                last_seen_at: Utc::now(),
            },
            profile,
            credential: SshCredential::Password("test".to_string()),
            jump: None,
            output_tail: VecDeque::new(),
            next_output_sequence: 0,
            ssh: None,
            runtime_token: Uuid::new_v4(),
            last_transient_io: None,
            last_health_rtt_ms: None,
            last_health_at: None,
        }
    }

    #[test]
    fn terminal_output_batch_tracks_sequences_and_retention() {
        let session_id = Uuid::new_v4();
        let mut runtime = test_session_runtime(session_id);
        for sequence in 1..=205 {
            let output = store_terminal_output(&mut runtime, session_id, format!("{sequence}\n"));
            assert_eq!(output.sequence, sequence);
        }

        let initial = build_output_batch(&runtime, session_id, None, 2);
        assert_eq!(initial.first_sequence, Some(6));
        assert_eq!(initial.latest_sequence, 205);
        assert!(!initial.truncated);
        assert_eq!(
            initial
                .outputs
                .iter()
                .map(|output| output.sequence)
                .collect::<Vec<_>>(),
            vec![204, 205]
        );

        let truncated = build_output_batch(&runtime, session_id, Some(3), 200);
        assert!(truncated.truncated);
        assert_eq!(
            truncated.outputs.first().map(|output| output.sequence),
            Some(6)
        );
        assert_eq!(
            truncated.outputs.last().map(|output| output.sequence),
            Some(205)
        );

        let incremental = build_output_batch(&runtime, session_id, Some(203), 200);
        assert!(!incremental.truncated);
        assert_eq!(
            incremental
                .outputs
                .iter()
                .map(|output| output.sequence)
                .collect::<Vec<_>>(),
            vec![204, 205]
        );
    }

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

    #[test]
    fn would_block_is_a_transient_ssh_error() {
        let pending = ssh2::Error::new(ssh2::ErrorCode::Session(-37), "would block");

        assert!(is_transient_ssh2_error(&pending));
    }

    #[test]
    fn private_key_authentication_rejects_a_missing_key_before_connecting() {
        let key_path = std::env::temp_dir().join(format!("missing-ssh-key-{}", Uuid::new_v4()));
        let profile = SessionProfile {
            id: Uuid::new_v4(),
            name: "missing-key-test".to_string(),
            group: None,
            host: "127.0.0.1".to_string(),
            port: 22,
            latency_probe_host: None,
            latency_probe_port: None,
            use_terminal_latency_probe: false,
            operating_system: None,
            username: "test-user".to_string(),
            auth_method: AuthMethod::PrivateKey {
                key_ref: key_path.to_string_lossy().into_owned(),
                passphrase_ref: None,
            },
            agent_identity_fingerprint: None,
            host_key_policy: HostKeyPolicy::AcceptNew,
            tags: Vec::new(),
            favorite: false,
            sort_order: 0,
            jump_host_id: None,
        };
        let credential = SshCredential::PrivateKey {
            key_path: key_path.clone(),
            passphrase: None,
        };

        let error = match establish_authenticated_ssh_session(
            &SessionManager::new(),
            profile.id,
            &profile,
            &credential,
        ) {
            Ok(_) => panic!("a missing private key must not reach SSH authentication"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("private key file was not found"));
        assert!(error
            .to_string()
            .contains(&key_path.to_string_lossy().to_string()));
    }

    #[test]
    fn host_key_prompt_token_is_session_bound_and_single_use() {
        let manager = SessionManager::new();
        let token = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let (sender, receiver) = mpsc::channel();
        manager.pending_host_keys.write().insert(
            token,
            PendingHostKeyPrompt {
                session_id,
                response: sender,
            },
        );

        assert!(manager
            .resolve_host_key_prompt(token, Uuid::new_v4(), HostKeyDecision::Accept)
            .is_err());
        manager
            .resolve_host_key_prompt(token, session_id, HostKeyDecision::Accept)
            .expect("correct session resolves prompt");
        assert_eq!(receiver.recv().unwrap(), HostKeyDecision::Accept);
        assert!(manager
            .resolve_host_key_prompt(token, session_id, HostKeyDecision::Accept)
            .is_err());
    }

    #[test]
    fn transfer_conflict_decision_is_consumed_once() {
        let manager = SessionManager::new();
        let transfer_id = Uuid::new_v4();
        manager.resolve_transfer_conflict(transfer_id, TransferConflictDecision::Restart);
        assert_eq!(
            manager.take_transfer_conflict_decision(transfer_id),
            Some(TransferConflictDecision::Restart)
        );
        assert_eq!(manager.take_transfer_conflict_decision(transfer_id), None);
    }

    #[test]
    fn parses_agent_public_key_blob_algorithm() {
        let mut blob = vec![0, 0, 0, 11];
        blob.extend_from_slice(b"ssh-ed25519");
        assert_eq!(public_key_blob_algorithm(&blob), "ssh-ed25519");
        assert_eq!(public_key_blob_algorithm(&[0, 1]), "unknown");
    }

    #[test]
    fn maps_libssh2_host_key_types_to_openssh_algorithms() {
        assert_eq!(
            openssh_host_key_algorithm(ssh2::HostKeyType::Ed25519).unwrap(),
            "ssh-ed25519"
        );
        assert_eq!(
            openssh_host_key_algorithm(ssh2::HostKeyType::Ecdsa256).unwrap(),
            "ecdsa-sha2-nistp256"
        );
        assert!(openssh_host_key_algorithm(ssh2::HostKeyType::Unknown).is_err());
    }

    #[test]
    fn stale_runtime_generation_is_not_active_for_reconnect() {
        let manager = SessionManager::new();
        let session_id = Uuid::new_v4();
        let mut runtime = test_session_runtime(session_id);
        runtime.info.state = ConnectionState::Reconnecting;
        let current_token = runtime.runtime_token;
        manager.sessions.write().insert(session_id, runtime);
        assert!(manager.is_reconnect_active(session_id, current_token));
        manager
            .sessions
            .write()
            .get_mut(&session_id)
            .unwrap()
            .runtime_token = Uuid::new_v4();
        assert!(!manager.is_reconnect_active(session_id, current_token));
    }
}
