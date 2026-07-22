use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

use joyshell_core::SessionId;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AuditAction {
    TerminalCommand,
    SftpWrite,
    PortForward,
    SecretAccess,
    AgentToolCall,
    PermissionDecision,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuditEntry {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub actor: String,
    pub session_id: Option<SessionId>,
    pub action: AuditAction,
    pub target: String,
    pub decision: Option<String>,
    pub summary: String,
}

#[derive(Clone, Default)]
pub struct AuditLog {
    entries: Arc<RwLock<Vec<AuditEntry>>>,
}

impl AuditLog {
    pub fn append(&self, entry: AuditEntry) {
        self.entries.write().push(entry);
    }

    pub fn record(
        &self,
        actor: impl Into<String>,
        session_id: Option<SessionId>,
        action: AuditAction,
        target: impl Into<String>,
        decision: Option<String>,
        summary: impl Into<String>,
    ) -> AuditEntry {
        let entry = AuditEntry {
            id: Uuid::new_v4(),
            created_at: Utc::now(),
            actor: actor.into(),
            session_id,
            action,
            target: target.into(),
            decision,
            summary: summary.into(),
        };
        self.append(entry.clone());
        entry
    }

    pub fn recent(&self, limit: usize) -> Vec<AuditEntry> {
        self.entries
            .read()
            .iter()
            .rev()
            .take(limit)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    }
}
