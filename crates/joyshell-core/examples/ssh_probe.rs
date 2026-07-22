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

    let profile = SessionProfile {
        id: Uuid::new_v4(),
        name: "ssh-probe".to_string(),
        group: Some("probe".to_string()),
        host,
        port,
        username,
        auth_method: AuthMethod::Password {
            secret_ref: "env://JOYSHELL_SSH_PASSWORD".to_string(),
        },
        host_key_policy: HostKeyPolicy::AcceptNew,
        tags: Vec::new(),
        favorite: false,
        sort_order: 0,
        jump_host_id: None,
    };

    let manager = SessionManager::new();
    let handle = manager.connect_ssh_password(profile, password).await?;
    tokio::time::sleep(std::time::Duration::from_millis(900)).await;
    handle
        .write_terminal("printf 'joyshell-probe:'; uname -a\r".to_string())
        .await?;
    tokio::time::sleep(std::time::Duration::from_secs(12)).await;
    handle
        .write_terminal("printf 'joyshell-second:'; pwd\r".to_string())
        .await?;
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    for chunk in handle.output_tail(80)? {
        print!("{chunk}");
    }

    Ok(())
}
