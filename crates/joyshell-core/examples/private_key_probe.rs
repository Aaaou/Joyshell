use joyshell_core::{AuthMethod, HostKeyPolicy, SessionManager, SessionProfile};
use std::path::PathBuf;
use uuid::Uuid;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let host = std::env::var("JOYSHELL_SSH_HOST")?;
    let username = std::env::var("JOYSHELL_SSH_USER")?;
    let key_path = PathBuf::from(std::env::var("JOYSHELL_SSH_KEY_PATH")?);
    let passphrase = std::env::var("JOYSHELL_SSH_KEY_PASSPHRASE")
        .ok()
        .filter(|value| !value.is_empty());
    let port = std::env::var("JOYSHELL_SSH_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(22);
    let session_id = Uuid::new_v4();

    let profile = SessionProfile {
        id: Uuid::new_v4(),
        name: "private-key-probe".to_string(),
        group: Some("probe".to_string()),
        host,
        port,
        latency_probe_host: None,
        latency_probe_port: None,
        use_terminal_latency_probe: false,
        operating_system: None,
        username,
        auth_method: AuthMethod::PrivateKey {
            key_ref: "env://JOYSHELL_SSH_KEY_PATH".to_string(),
            passphrase_ref: passphrase
                .as_ref()
                .map(|_| "env://JOYSHELL_SSH_KEY_PASSPHRASE".to_string()),
        },
        agent_identity_fingerprint: None,
        host_key_policy: HostKeyPolicy::AcceptNew,
        tags: Vec::new(),
        favorite: false,
        sort_order: 0,
        jump_host_id: None,
    };

    let manager = SessionManager::new();
    let handle = manager
        .connect_ssh_private_key_for_session(profile, key_path, passphrase, session_id)
        .await?;
    handle
        .write_terminal("printf 'joyshell-key-probe:'; whoami; pwd\r".to_string())
        .await?;
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    let terminal_output = handle.output_tail(80)?.join("");
    anyhow::ensure!(terminal_output.contains("joyshell-key-probe:"));

    print!("{terminal_output}");
    if std::env::var("JOYSHELL_SSH_SKIP_SYSTEM_PROBE").as_deref() == Ok("1") {
        println!("joyshell-private-key-backend-ok session={session_id}");
    } else {
        let snapshot = manager.collect_system_snapshot(session_id).await?;
        anyhow::ensure!(!snapshot.host.hostname.is_empty());

        let home_listing = manager
            .list_sftp_directory(session_id, ".".to_string())
            .await?;
        anyhow::ensure!(home_listing.path.starts_with('/'));
        let root_listing = manager
            .list_sftp_directory(session_id, "/".to_string())
            .await?;
        anyhow::ensure!(!root_listing.entries.is_empty());
        println!(
            "joyshell-private-key-backend-ok host={} home={} home_entries={} root_entries={} session={session_id}",
            snapshot.host.hostname,
            home_listing.path,
            home_listing.entries.len(),
            root_listing.entries.len()
        );
    }
    Ok(())
}
