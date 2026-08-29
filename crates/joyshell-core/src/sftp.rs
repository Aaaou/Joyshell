use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::SessionId;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub permissions: String,
    pub modified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteDirectoryListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<RemoteFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum FileTransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum TransferStatus {
    Queued,
    Running,
    Paused,
    Retrying {
        attempt: u32,
        max_attempts: u32,
        reason: String,
    },
    Completed,
    Failed {
        reason: String,
    },
    NeedsAttention {
        reason: String,
        expected_size: Option<u64>,
        actual_size: Option<u64>,
    },
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum SftpOperation {
    List {
        remote_path: String,
    },
    Read {
        remote_path: String,
    },
    Download {
        remote_path: String,
        local_path: String,
    },
    Upload {
        local_path: String,
        remote_path: String,
    },
    Delete {
        remote_path: String,
    },
    Rename {
        from: String,
        to: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SftpProgress {
    pub id: Uuid,
    pub session_id: SessionId,
    #[serde(default)]
    pub profile_id: Option<SessionId>,
    pub direction: FileTransferDirection,
    pub local_path: String,
    pub remote_path: String,
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub status: TransferStatus,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub retry_count: u32,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub source_size: Option<u64>,
    #[serde(default)]
    pub source_modified_at: Option<u64>,
    #[serde(default)]
    pub target_size: Option<u64>,
    #[serde(default)]
    pub target_modified_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferConflictDecision {
    Restart,
    Continue,
    Cancel,
}
