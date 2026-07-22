use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

use joyshell_core::{SessionId, SessionProfile};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionFolder {
    pub id: Uuid,
    pub name: String,
    pub parent_id: Option<Uuid>,
}

#[derive(Clone, Default)]
pub struct ProfileRepository {
    profiles: Arc<RwLock<Vec<SessionProfile>>>,
    folders: Arc<RwLock<Vec<SessionFolder>>>,
}

impl ProfileRepository {
    pub fn with_demo_data() -> Self {
        Self::default()
    }

    pub fn upsert_profile(&self, profile: SessionProfile) {
        let mut profiles = self.profiles.write();
        if let Some(existing) = profiles.iter_mut().find(|item| item.id == profile.id) {
            *existing = profile;
        } else {
            profiles.push(profile);
        }
    }

    pub fn list_profiles(&self) -> Vec<SessionProfile> {
        self.profiles.read().clone()
    }

    pub fn get_profile(&self, id: SessionId) -> Option<SessionProfile> {
        self.profiles
            .read()
            .iter()
            .find(|profile| profile.id == id)
            .cloned()
    }

    pub fn list_folders(&self) -> Vec<SessionFolder> {
        self.folders.read().clone()
    }
}
