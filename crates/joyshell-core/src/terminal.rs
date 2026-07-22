use serde::{Deserialize, Serialize};

use crate::SessionId;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalInput {
    pub session_id: SessionId,
    pub data: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalOutput {
    pub session_id: SessionId,
    pub data: String,
    pub sequence: u64,
}
