use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use uuid::Uuid;

use crate::SessionId;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ForwardingKind {
    Local,
    Remote,
    Socks,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ForwardingState {
    Stopped,
    Starting,
    Running,
    Reconnecting,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ForwardingRule {
    pub id: Uuid,
    pub session_id: SessionId,
    pub kind: ForwardingKind,
    pub listen_host: String,
    pub listen_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    pub state: ForwardingState,
    pub last_error: Option<String>,
    pub active_connections: u32,
    pub auto_resume: bool,
}

impl ForwardingRule {
    pub fn validate(&self) -> Result<(), String> {
        if self.listen_port == 0 && !matches!(self.kind, ForwardingKind::Remote) {
            return Err("forwarding listen port must be greater than zero".to_string());
        }
        if matches!(self.kind, ForwardingKind::Local | ForwardingKind::Socks) {
            let listen_address = self.listen_host.parse::<IpAddr>().map_err(|_| {
                "forwarding listen address must be a loopback IP address".to_string()
            })?;
            if !listen_address.is_loopback() {
                return Err(
                    "forwarding must listen on loopback by default; explicit exposure requires a separate opt-in"
                        .to_string(),
                );
            }
        }
        match self.kind {
            ForwardingKind::Socks => {
                if self.target_host.is_some() || self.target_port.is_some() {
                    return Err("SOCKS forwarding cannot define a fixed target".to_string());
                }
            }
            ForwardingKind::Local | ForwardingKind::Remote => {
                let host = self
                    .target_host
                    .as_deref()
                    .filter(|host| !host.trim().is_empty())
                    .ok_or_else(|| "forwarding target host is required".to_string())?;
                if self.target_port.unwrap_or(0) == 0 {
                    return Err("forwarding target port must be greater than zero".to_string());
                }
                if host.contains('\n') || host.contains('\r') {
                    return Err("forwarding target host contains invalid characters".to_string());
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(kind: ForwardingKind) -> ForwardingRule {
        ForwardingRule {
            id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            kind,
            listen_host: "127.0.0.1".to_string(),
            listen_port: 18080,
            target_host: Some("10.0.0.5".to_string()),
            target_port: Some(8080),
            state: ForwardingState::Stopped,
            last_error: None,
            active_connections: 0,
            auto_resume: true,
        }
    }

    #[test]
    fn validates_local_and_remote_rules() {
        assert!(rule(ForwardingKind::Local).validate().is_ok());
        assert!(rule(ForwardingKind::Remote).validate().is_ok());
    }

    #[test]
    fn validates_socks_without_fixed_target() {
        let mut socks = rule(ForwardingKind::Socks);
        socks.target_host = None;
        socks.target_port = None;
        assert!(socks.validate().is_ok());
    }

    #[test]
    fn rejects_non_loopback_listener_and_invalid_socks_target() {
        let mut exposed = rule(ForwardingKind::Local);
        exposed.listen_host = "0.0.0.0".to_string();
        assert!(exposed.validate().is_err());

        let mut socks = rule(ForwardingKind::Socks);
        socks.target_host = Some("fixed-target".to_string());
        assert!(socks.validate().is_err());
    }

    #[test]
    fn rejects_hostname_listener_that_could_resolve_outside_loopback() {
        let mut local = rule(ForwardingKind::Local);
        local.listen_host = "localhost".to_string();
        assert_eq!(
            local.validate().unwrap_err(),
            "forwarding listen address must be a loopback IP address"
        );

        local.listen_host = "::1".to_string();
        assert!(local.validate().is_ok());
    }
}
