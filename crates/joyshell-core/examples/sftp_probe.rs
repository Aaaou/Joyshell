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
        name: "sftp-probe".to_string(),
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

    let listing = manager
        .list_sftp_directory(handle.id(), "/root".to_string())
        .await?;
    println!(
        "list path={} entries={}",
        listing.path,
        listing.entries.len()
    );
    for entry in listing.entries.iter().take(8) {
        println!(
            "{} {} size={} perm={}",
            if entry.is_dir { "dir " } else { "file" },
            entry.path,
            entry.size,
            entry.permissions
        );
    }

    let probe_id = Uuid::new_v4();
    let remote_dir = format!("/tmp/joyshell-sftp-probe-{probe_id}");
    let remote_file = format!("{remote_dir}/hello.txt");
    let renamed_file = format!("{remote_dir}/renamed.txt");
    let local_upload = std::env::temp_dir().join(format!("joyshell-upload-{probe_id}.txt"));
    let local_download = std::env::temp_dir().join(format!("joyshell-download-{probe_id}.txt"));
    std::fs::write(&local_upload, b"hello from joyshell sftp probe\n")?;

    manager
        .create_sftp_dir(handle.id(), remote_dir.clone())
        .await?;
    manager
        .upload_sftp_file(
            handle.id(),
            Uuid::new_v4(),
            local_upload.to_string_lossy().to_string(),
            remote_file.clone(),
        )
        .await?;
    manager
        .rename_sftp_path(handle.id(), remote_file.clone(), renamed_file.clone())
        .await?;
    manager
        .download_sftp_file(
            handle.id(),
            Uuid::new_v4(),
            renamed_file.clone(),
            local_download.to_string_lossy().to_string(),
        )
        .await?;
    let downloaded = std::fs::read_to_string(&local_download)?;
    println!("downloaded={}", downloaded.trim());
    manager
        .delete_sftp_path(handle.id(), renamed_file.clone(), false)
        .await?;
    manager
        .delete_sftp_path(handle.id(), remote_dir.clone(), true)
        .await?;
    let _ = std::fs::remove_file(local_upload);
    let _ = std::fs::remove_file(local_download);
    println!("sftp probe completed");

    Ok(())
}
