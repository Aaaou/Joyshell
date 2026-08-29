use joyshell_core::{AuthMethod, HostKeyPolicy, SessionManager, SessionProfile};
use uuid::Uuid;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let host = std::env::var("JOYSHELL_SSH_HOST")?;
    let username = std::env::var("JOYSHELL_SSH_USER")?;
    let password = std::env::var("JOYSHELL_SSH_PASSWORD")?;
    let port = std::env::var("JOYSHELL_SSH_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(22);
    let profile_id = Uuid::new_v4();
    let profile = SessionProfile {
        id: profile_id,
        name: "multi-session-probe".to_string(),
        group: Some("probe".to_string()),
        host,
        port,
        latency_probe_host: None,
        latency_probe_port: None,
        use_terminal_latency_probe: false,
        operating_system: None,
        username,
        auth_method: AuthMethod::Password {
            secret_ref: "env://JOYSHELL_SSH_PASSWORD".to_string(),
        },
        agent_identity_fingerprint: None,
        host_key_policy: HostKeyPolicy::AcceptNew,
        tags: Vec::new(),
        favorite: false,
        sort_order: 0,
        jump_host_id: None,
    };

    let manager = SessionManager::new();
    let first_id = Uuid::new_v4();
    let second_id = Uuid::new_v4();
    let first = manager
        .connect_ssh_password_for_session(profile.clone(), password.clone(), first_id)
        .await?;
    let second = manager
        .connect_ssh_password_for_session(profile, password, second_id)
        .await?;

    first
        .write_terminal("printf 'joyshell-shell-one\\n'\r".to_string())
        .await?;
    second
        .write_terminal("printf 'joyshell-shell-two\\n'\r".to_string())
        .await?;
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    let first_output = first.output_tail(80)?.join("");
    let second_output = second.output_tail(80)?.join("");
    anyhow::ensure!(first.id() == first_id && second.id() == second_id);
    anyhow::ensure!(first_output.contains("joyshell-shell-one"));
    anyhow::ensure!(second_output.contains("joyshell-shell-two"));
    anyhow::ensure!(!first_output.contains("joyshell-shell-two"));
    anyhow::ensure!(!second_output.contains("joyshell-shell-one"));

    let sessions = manager.list_sessions();
    anyhow::ensure!(sessions.len() == 2);
    anyhow::ensure!(sessions
        .iter()
        .all(|session| session.profile_id == profile_id));
    println!("two independent SSH sessions verified for one profile");
    Ok(())
}
