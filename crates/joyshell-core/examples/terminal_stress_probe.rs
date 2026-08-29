use joyshell_core::{AuthMethod, ConnectionState, HostKeyPolicy, SessionManager, SessionProfile};
use std::path::PathBuf;
use std::time::{Duration, Instant};
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
        name: "terminal-stress-probe".to_string(),
        group: Some("probe".to_string()),
        host,
        port,
        latency_probe_host: None,
        latency_probe_port: None,
        use_terminal_latency_probe: true,
        operating_system: None,
        username,
        auth_method: AuthMethod::PrivateKey {
            key_ref: "env://JOYSHELL_SSH_KEY_PATH".to_string(),
            passphrase_ref: passphrase
                .as_ref()
                .map(|_| "env://JOYSHELL_SSH_KEY_PASSPHRASE".to_string()),
        },
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
        .write_terminal(
            "for batch in $(seq 0 4); do awk -v base=\"$((batch * 1000))\" 'BEGIN { for (i = 1; i <= 1000; i++) printf \"download-output-test-%06d\\n\", base + i }'; sleep 1; done; printf '__JOYSHELL_%s__\\n' 'STRESS_DONE'\r"
                .to_string(),
        )
        .await?;

    tokio::time::sleep(Duration::from_secs(2)).await;
    anyhow::ensure!(
        manager
            .measure_terminal_latency(session_id)
            .await?
            .is_some(),
        "health probe did not complete while terminal output was active"
    );

    if let Err(error) =
        wait_for_output(&handle, "__JOYSHELL_STRESS_DONE__", Duration::from_secs(30)).await
    {
        anyhow::bail!(
            "{error}; {}; tail_suffix={:?}",
            manager.session_diagnostics(session_id)?,
            output_suffix(&handle, 800)?
        );
    }
    tokio::time::sleep(Duration::from_secs(7)).await;
    handle
        .write_terminal("printf '__JOYSHELL_%s__\\n' 'AFTER_IDLE'\r".to_string())
        .await?;
    if let Err(error) =
        wait_for_output(&handle, "__JOYSHELL_AFTER_IDLE__", Duration::from_secs(10)).await
    {
        anyhow::bail!(
            "{error}; {}; tail_suffix={:?}",
            manager.session_diagnostics(session_id)?,
            output_suffix(&handle, 800)?
        );
    }

    let session = manager
        .get_session(session_id)
        .ok_or_else(|| anyhow::anyhow!("stress session disappeared"))?;
    anyhow::ensure!(
        session.state == ConnectionState::Connected,
        "stress session ended in state {:?}",
        session.state
    );
    handle.write_terminal("exit\r".to_string()).await?;
    wait_for_disconnect(&manager, session_id, Duration::from_secs(10)).await?;
    println!("joyshell-terminal-stress-ok session={session_id}");
    Ok(())
}

async fn wait_for_disconnect(
    manager: &SessionManager,
    session_id: Uuid,
    timeout: Duration,
) -> anyhow::Result<()> {
    let started_at = Instant::now();
    while started_at.elapsed() < timeout {
        let state = manager
            .get_session(session_id)
            .ok_or_else(|| anyhow::anyhow!("stress session disappeared"))?
            .state;
        if state != ConnectionState::Connected {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    anyhow::bail!("SSH shell exited but the session still reports Connected")
}

fn output_suffix(
    handle: &joyshell_core::SshSessionHandle,
    max_chars: usize,
) -> anyhow::Result<String> {
    let output = handle.output_tail(200)?.join("");
    let mut suffix = output.chars().rev().take(max_chars).collect::<Vec<_>>();
    suffix.reverse();
    Ok(suffix.into_iter().collect())
}

async fn wait_for_output(
    handle: &joyshell_core::SshSessionHandle,
    marker: &str,
    timeout: Duration,
) -> anyhow::Result<()> {
    let started_at = Instant::now();
    while started_at.elapsed() < timeout {
        if handle.output_tail(200)?.join("").contains(marker) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    anyhow::bail!("terminal output marker was not received: {marker}")
}
