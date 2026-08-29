use joyshell_core::list_ssh_agent_identities;

fn main() -> anyhow::Result<()> {
    let identities = list_ssh_agent_identities()?;
    if identities.is_empty() {
        anyhow::bail!("SSH agent has no available identities");
    }
    for identity in identities {
        println!(
            "{}\t{}\t{}",
            identity.algorithm, identity.fingerprint, identity.comment
        );
    }
    Ok(())
}
