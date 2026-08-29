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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalOutputBatch {
    pub session_id: SessionId,
    pub first_sequence: Option<u64>,
    pub latest_sequence: u64,
    pub truncated: bool,
    pub outputs: Vec<TerminalOutput>,
}
