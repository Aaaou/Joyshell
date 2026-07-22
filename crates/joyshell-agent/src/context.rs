use serde::{Deserialize, Serialize};

use joyshell_core::{SessionId, SessionManager};
use joyshell_store::{MemoryEntry, MemoryStore};

use crate::{AgentToolRegistry, AssistantDefinition};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentContext {
    pub assistant_name: String,
    pub system_prompt: String,
    pub session_summary: Option<String>,
    pub terminal_tail: Vec<String>,
    pub memories: Vec<MemoryEntry>,
    pub available_tools: Vec<String>,
    pub permission_summary: String,
}

#[derive(Clone)]
pub struct ContextBuilder {
    sessions: SessionManager,
    memories: MemoryStore,
    tools: AgentToolRegistry,
}

impl ContextBuilder {
    pub fn new(sessions: SessionManager, memories: MemoryStore, tools: AgentToolRegistry) -> Self {
        Self {
            sessions,
            memories,
            tools,
        }
    }

    pub fn build(
        &self,
        assistant: &AssistantDefinition,
        session_id: Option<SessionId>,
        query: &str,
    ) -> AgentContext {
        let session_summary =
            session_id
                .and_then(|id| self.sessions.get_session(id))
                .map(|session| {
                    format!(
                        "{}@{}:{} is {:?}",
                        session.username, session.host, session.port, session.state
                    )
                });
        let terminal_tail = session_id
            .and_then(|id| self.sessions.output_tail(id, 30).ok())
            .unwrap_or_default();
        let memories = self.memories.search(query, 8);
        let available_tools = self
            .tools
            .list()
            .iter()
            .filter(|tool| {
                !assistant
                    .disallowed_tools
                    .iter()
                    .any(|name| name == &tool.name)
                    && (assistant.allowed_tools.iter().any(|name| name == "*")
                        || assistant
                            .allowed_tools
                            .iter()
                            .any(|name| name == &tool.name))
            })
            .map(|tool| tool.name.clone())
            .collect();

        AgentContext {
            assistant_name: assistant.display_name.clone(),
            system_prompt: assistant.system_prompt.clone(),
            session_summary,
            terminal_tail,
            memories,
            available_tools,
            permission_summary:
                "Guarded mode: read tools auto-allow; commands, writes, secrets, MCP, and port exposure require approval."
                    .to_string(),
        }
    }
}
