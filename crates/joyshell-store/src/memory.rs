use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

use joyshell_core::SessionId;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum MemoryScope {
    ShortTerm,
    Session,
    User,
    Project,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryEntry {
    pub id: Uuid,
    pub scope: MemoryScope,
    pub session_id: Option<SessionId>,
    pub key: String,
    pub value: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Default)]
pub struct MemoryStore {
    entries: Arc<RwLock<Vec<MemoryEntry>>>,
}

impl MemoryStore {
    pub fn write(
        &self,
        scope: MemoryScope,
        session_id: Option<SessionId>,
        key: impl Into<String>,
        value: impl Into<String>,
    ) -> Result<MemoryEntry, String> {
        let key = key.into();
        let value = sanitize_memory(value.into())?;
        let now = Utc::now();
        let entry = MemoryEntry {
            id: Uuid::new_v4(),
            scope,
            session_id,
            key,
            value,
            created_at: now,
            updated_at: now,
        };
        self.entries.write().push(entry.clone());
        Ok(entry)
    }

    pub fn search(&self, query: &str, limit: usize) -> Vec<MemoryEntry> {
        let query = query.to_lowercase();
        self.entries
            .read()
            .iter()
            .filter(|entry| {
                entry.key.to_lowercase().contains(&query)
                    || entry.value.to_lowercase().contains(&query)
            })
            .take(limit)
            .cloned()
            .collect()
    }

    pub fn delete(&self, id: Uuid) -> bool {
        let mut entries = self.entries.write();
        let before = entries.len();
        entries.retain(|entry| entry.id != id);
        before != entries.len()
    }
}

fn sanitize_memory(value: String) -> Result<String, String> {
    let lowered = value.to_lowercase();
    let sensitive_markers = [
        "-----begin openssh private key-----",
        "-----begin rsa private key-----",
        "password=",
        "api_key=",
        "token=",
        "secret=",
        "otp=",
    ];
    if sensitive_markers
        .iter()
        .any(|marker| lowered.contains(*marker))
    {
        return Err("memory value appears to contain a secret".to_string());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_secret_like_memory() {
        let store = MemoryStore::default();
        let result = store.write(MemoryScope::User, None, "bad", "token=abc");
        assert!(result.is_err());
    }
}
