use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AssistantKind {
    GeneralAssistant,
    ExploreAssistant,
    SftpAssistant,
    OpsAssistant,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AssistantDefinition {
    pub kind: AssistantKind,
    pub display_name: String,
    pub description: String,
    pub allowed_tools: Vec<String>,
    pub disallowed_tools: Vec<String>,
    pub can_spawn_children: bool,
    pub system_prompt: String,
}

#[derive(Debug, Clone, Default)]
pub struct AssistantRegistry {
    assistants: Vec<AssistantDefinition>,
}

impl AssistantRegistry {
    pub fn built_in() -> Self {
        Self {
            assistants: vec![
                AssistantDefinition {
                    kind: AssistantKind::GeneralAssistant,
                    display_name: "General Assistant".to_string(),
                    description: "Primary assistant for explaining output, proposing commands, delegating constrained subtasks, and summarizing results.".to_string(),
                    allowed_tools: vec!["*".to_string()],
                    disallowed_tools: vec![],
                    can_spawn_children: true,
                    system_prompt: "You are Joyshell's main SSH assistant. Prefer safe explanations and command drafts. Ask for approval before execution or file mutation.".to_string(),
                },
                AssistantDefinition {
                    kind: AssistantKind::ExploreAssistant,
                    display_name: "Explore Assistant".to_string(),
                    description: "Read-only assistant for session and terminal-output analysis.".to_string(),
                    allowed_tools: vec![
                        "terminal.read_output".to_string(),
                        "session.get_info".to_string(),
                        "memory.search".to_string(),
                    ],
                    disallowed_tools: vec![
                        "terminal.run_command".to_string(),
                        "sftp.upload".to_string(),
                        "sftp.delete".to_string(),
                        "sftp.rename".to_string(),
                        "mcp.call".to_string(),
                    ],
                    can_spawn_children: false,
                    system_prompt: "You are a read-only exploration assistant. Never execute remote commands or mutate files.".to_string(),
                },
                AssistantDefinition {
                    kind: AssistantKind::SftpAssistant,
                    display_name: "SFTP Assistant".to_string(),
                    description: "File transfer assistant for planning and explaining SFTP operations.".to_string(),
                    allowed_tools: vec![
                        "sftp.list".to_string(),
                        "sftp.read".to_string(),
                        "sftp.download".to_string(),
                        "sftp.upload".to_string(),
                        "sftp.delete".to_string(),
                        "sftp.rename".to_string(),
                        "session.get_info".to_string(),
                    ],
                    disallowed_tools: vec!["terminal.run_command".to_string(), "mcp.call".to_string()],
                    can_spawn_children: false,
                    system_prompt: "You are a file transfer assistant. Read operations are fine; write, overwrite, delete, and rename operations require approval.".to_string(),
                },
                AssistantDefinition {
                    kind: AssistantKind::OpsAssistant,
                    display_name: "Ops Assistant".to_string(),
                    description: "Operations assistant for diagnostics and command proposals.".to_string(),
                    allowed_tools: vec![
                        "terminal.read_output".to_string(),
                        "terminal.propose_command".to_string(),
                        "terminal.run_command".to_string(),
                        "session.get_info".to_string(),
                        "memory.search".to_string(),
                    ],
                    disallowed_tools: vec!["sftp.delete".to_string(), "sftp.rename".to_string(), "mcp.call".to_string()],
                    can_spawn_children: false,
                    system_prompt: "You are an operations assistant. Prefer diagnostics and safe commands; execution requires approval unless a rule explicitly allows it.".to_string(),
                },
            ],
        }
    }

    pub fn list(&self) -> &[AssistantDefinition] {
        &self.assistants
    }

    pub fn get(&self, kind: &AssistantKind) -> Option<&AssistantDefinition> {
        self.assistants
            .iter()
            .find(|assistant| &assistant.kind == kind)
    }
}
