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
        name: "system-probe".to_string(),
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
    let handle = manager.connect_ssh_password(profile, password).await?;
    tokio::time::sleep(std::time::Duration::from_millis(900)).await;
    let snapshot = manager.collect_system_snapshot(handle.id()).await?;
    println!(
        "host={} os={} kernel={} arch={} ip={}",
        snapshot.host.hostname,
        snapshot.host.os_name,
        snapshot.host.kernel_release,
        snapshot.host.architecture,
        snapshot.host.primary_ip.as_deref().unwrap_or("-")
    );
    println!(
        "device={}",
        snapshot.host.device_model.as_deref().unwrap_or("-")
    );
    println!(
        "load={:.2},{:.2},{:.2} procs={}/{} uptime={:.0}s",
        snapshot.load.one,
        snapshot.load.five,
        snapshot.load.fifteen,
        snapshot.load.runnable_processes,
        snapshot.load.total_processes,
        snapshot.uptime_seconds
    );
    println!(
        "cpu cores={} model={} part={} user={} system={} idle={}",
        snapshot.cpu_info.logical_cores,
        snapshot.cpu_info.model_name,
        snapshot.cpu_info.raw_part.as_deref().unwrap_or("-"),
        snapshot.cpu.user,
        snapshot.cpu.system,
        snapshot.cpu.idle
    );
    println!(
        "memory used={} total={} swap_total={}",
        snapshot.memory.used_bytes, snapshot.memory.total_bytes, snapshot.swap.total_bytes
    );
    println!(
        "processes total={} running={} threads={} network_ifaces={} filesystems={}",
        snapshot.processes.total,
        snapshot.processes.running,
        snapshot.processes.threads,
        snapshot.network.len(),
        snapshot.filesystems.len()
    );
    for iface in snapshot
        .network
        .iter()
        .filter(|iface| iface.name != "lo")
        .take(4)
    {
        println!(
            "net {} ip={} rx={} tx={} errors={}/{}",
            iface.name,
            iface.ipv4_addresses.join(","),
            iface.rx_bytes,
            iface.tx_bytes,
            iface.rx_errors,
            iface.tx_errors
        );
    }
    for fs in snapshot.filesystems.iter().take(8) {
        println!(
            "fs {} {} type={} used={:.0}% inode={:?}% available={}",
            fs.mount_point,
            fs.filesystem,
            fs.fs_type,
            fs.used_percent,
            fs.inode_used_percent,
            fs.available_bytes
        );
    }

    Ok(())
}
