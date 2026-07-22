use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::permission::RiskLevel;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AgentToolEffect {
    Read,
    Execute,
    Write,
    SecretRead,
    NetworkExpose,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentTool {
    pub name: String,
    pub description: String,
    pub effect: AgentToolEffect,
    pub default_risk: RiskLevel,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentToolCall {
    pub id: Uuid,
    pub assistant: String,
    pub tool_name: String,
    pub target: String,
    pub input: Value,
}

#[derive(Debug, Clone)]
pub struct AgentToolRegistry {
    tools: Vec<AgentTool>,
}

impl Default for AgentToolRegistry {
    fn default() -> Self {
        Self::built_in()
    }
}

impl AgentToolRegistry {
    pub fn built_in() -> Self {
        let tools = vec![
            tool(
                "terminal.read_output",
                "Read terminal output tail",
                AgentToolEffect::Read,
                RiskLevel::Low,
            ),
            tool(
                "terminal.propose_command",
                "Draft a command without executing it",
                AgentToolEffect::Read,
                RiskLevel::Low,
            ),
            tool(
                "terminal.run_command",
                "Write a command to an SSH session",
                AgentToolEffect::Execute,
                RiskLevel::High,
            ),
            tool(
                "sftp.list",
                "List a remote directory",
                AgentToolEffect::Read,
                RiskLevel::Low,
            ),
            tool(
                "sftp.read",
                "Read a remote file preview",
                AgentToolEffect::Read,
                RiskLevel::Medium,
            ),
            tool(
                "sftp.download",
                "Download a remote file",
                AgentToolEffect::Write,
                RiskLevel::Medium,
            ),
            tool(
                "sftp.upload",
                "Upload a local file",
                AgentToolEffect::Write,
                RiskLevel::High,
            ),
            tool(
                "sftp.delete",
                "Delete a remote file",
                AgentToolEffect::Write,
                RiskLevel::High,
            ),
            tool(
                "sftp.rename",
                "Rename a remote file",
                AgentToolEffect::Write,
                RiskLevel::High,
            ),
            tool(
                "session.get_info",
                "Read sanitized session metadata",
                AgentToolEffect::Read,
                RiskLevel::Low,
            ),
            tool(
                "memory.search",
                "Search saved memory",
                AgentToolEffect::Read,
                RiskLevel::Low,
            ),
            tool(
                "memory.write",
                "Write non-secret memory",
                AgentToolEffect::Write,
                RiskLevel::Medium,
            ),
            tool(
                "memory.delete",
                "Delete memory",
                AgentToolEffect::Write,
                RiskLevel::Medium,
            ),
            tool(
                "mcp.call",
                "Call a future MCP tool",
                AgentToolEffect::NetworkExpose,
                RiskLevel::High,
            ),
        ];
        Self { tools }
    }

    pub fn list(&self) -> &[AgentTool] {
        &self.tools
    }

    pub fn get(&self, name: &str) -> Option<&AgentTool> {
        self.tools.iter().find(|tool| tool.name == name)
    }
}

fn tool(
    name: &str,
    description: &str,
    effect: AgentToolEffect,
    default_risk: RiskLevel,
) -> AgentTool {
    AgentTool {
        name: name.to_string(),
        description: description.to_string(),
        effect,
        default_risk,
    }
}
