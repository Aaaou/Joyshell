use serde::{Deserialize, Serialize};

use crate::assistant::AssistantDefinition;
use crate::tool::{AgentToolCall, AgentToolEffect, AgentToolRegistry};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum PermissionBehavior {
    Allow,
    Deny,
    Ask,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum PermissionMode {
    Guarded,
    Manual,
    AllowList,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum PermissionScope {
    Session,
    LocalProfile,
    GlobalUser,
    Policy,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum RiskLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PermissionRule {
    pub scope: PermissionScope,
    pub behavior: PermissionBehavior,
    pub assistant: Option<String>,
    pub tool_name: String,
    pub target_pattern: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PermissionDecision {
    pub behavior: PermissionBehavior,
    pub risk: RiskLevel,
    pub reason: String,
    pub suggestions: Vec<PermissionRule>,
}

#[derive(Debug, Clone)]
pub struct PermissionEngine {
    mode: PermissionMode,
    rules: Vec<PermissionRule>,
}

impl Default for PermissionEngine {
    fn default() -> Self {
        Self {
            mode: PermissionMode::Guarded,
            rules: safe_allowlist(),
        }
    }
}

impl PermissionEngine {
    pub fn new(mode: PermissionMode, rules: Vec<PermissionRule>) -> Self {
        Self { mode, rules }
    }

    pub fn decide(
        &self,
        assistant: &AssistantDefinition,
        registry: &AgentToolRegistry,
        call: &AgentToolCall,
    ) -> PermissionDecision {
        if assistant
            .disallowed_tools
            .iter()
            .any(|tool| tool == &call.tool_name)
        {
            return decision(
                PermissionBehavior::Deny,
                RiskLevel::High,
                "tool is disallowed for this assistant",
            );
        }

        let allowed_by_assistant = assistant.allowed_tools.iter().any(|tool| tool == "*")
            || assistant
                .allowed_tools
                .iter()
                .any(|tool| tool == &call.tool_name);
        if !allowed_by_assistant {
            return decision(
                PermissionBehavior::Deny,
                RiskLevel::High,
                "tool is outside this assistant's allowlist",
            );
        }

        if let Some(rule) = self.matching_rule(call) {
            return PermissionDecision {
                behavior: rule.behavior,
                risk: registry
                    .get(&call.tool_name)
                    .map(|tool| tool.default_risk)
                    .unwrap_or(RiskLevel::High),
                reason: format!("matched {:?} permission rule", rule.scope),
                suggestions: vec![],
            };
        }

        let Some(tool) = registry.get(&call.tool_name) else {
            return decision(
                PermissionBehavior::Deny,
                RiskLevel::High,
                "unknown tool cannot be executed",
            );
        };

        match self.mode {
            PermissionMode::Manual => decision(
                PermissionBehavior::Ask,
                tool.default_risk,
                "manual mode requires user confirmation",
            ),
            PermissionMode::AllowList => match tool.effect {
                AgentToolEffect::Read => decision(
                    PermissionBehavior::Allow,
                    tool.default_risk,
                    "read-only tool is allowed",
                ),
                _ => decision(
                    PermissionBehavior::Ask,
                    tool.default_risk,
                    "tool is not in the allowlist",
                ),
            },
            PermissionMode::Guarded => match tool.effect {
                AgentToolEffect::Read => decision(
                    PermissionBehavior::Allow,
                    tool.default_risk,
                    "read-only tool is allowed by guarded mode",
                ),
                AgentToolEffect::Execute
                | AgentToolEffect::Write
                | AgentToolEffect::SecretRead
                | AgentToolEffect::NetworkExpose => decision(
                    PermissionBehavior::Ask,
                    tool.default_risk,
                    "guarded mode requires approval for execution, writes, secrets, or exposed network access",
                ),
            },
        }
    }

    fn matching_rule(&self, call: &AgentToolCall) -> Option<&PermissionRule> {
        self.rules.iter().find(|rule| {
            rule.tool_name == call.tool_name
                && rule
                    .assistant
                    .as_ref()
                    .map(|assistant| assistant == &call.assistant)
                    .unwrap_or(true)
                && rule
                    .target_pattern
                    .as_ref()
                    .map(|pattern| call.target.contains(pattern))
                    .unwrap_or(true)
        })
    }
}

fn decision(
    behavior: PermissionBehavior,
    risk: RiskLevel,
    reason: impl Into<String>,
) -> PermissionDecision {
    PermissionDecision {
        behavior,
        risk,
        reason: reason.into(),
        suggestions: vec![],
    }
}

fn safe_allowlist() -> Vec<PermissionRule> {
    ["ls", "pwd", "df -h", "free -m", "uname -a"]
        .iter()
        .map(|command| PermissionRule {
            scope: PermissionScope::GlobalUser,
            behavior: PermissionBehavior::Allow,
            assistant: None,
            tool_name: "terminal.run_command".to_string(),
            target_pattern: Some((*command).to_string()),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use uuid::Uuid;

    use crate::{AssistantKind, AssistantRegistry};

    use super::*;

    #[test]
    fn explore_assistant_cannot_run_commands() {
        let assistants = AssistantRegistry::built_in();
        let assistant = assistants.get(&AssistantKind::ExploreAssistant).unwrap();
        let registry = AgentToolRegistry::built_in();
        let engine = PermissionEngine::default();
        let call = AgentToolCall {
            id: Uuid::new_v4(),
            assistant: assistant.display_name.clone(),
            tool_name: "terminal.run_command".to_string(),
            target: "demo".to_string(),
            input: json!({ "command": "uptime" }),
        };

        let decision = engine.decide(assistant, &registry, &call);
        assert_eq!(decision.behavior, PermissionBehavior::Deny);
    }

    #[test]
    fn guarded_mode_asks_for_dangerous_commands() {
        let assistants = AssistantRegistry::built_in();
        let assistant = assistants.get(&AssistantKind::GeneralAssistant).unwrap();
        let registry = AgentToolRegistry::built_in();
        let engine = PermissionEngine::default();
        let call = AgentToolCall {
            id: Uuid::new_v4(),
            assistant: assistant.display_name.clone(),
            tool_name: "terminal.run_command".to_string(),
            target: "rm -rf /".to_string(),
            input: json!({ "command": "rm -rf /" }),
        };

        let decision = engine.decide(assistant, &registry, &call);
        assert_eq!(decision.behavior, PermissionBehavior::Ask);
    }
}
