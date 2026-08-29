use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KnownHostEntry {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub key_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyCheck {
    Unknown,
    Match,
    Changed { previous: KnownHostEntry },
}

#[derive(Debug, Default, Clone)]
pub struct KnownHostsStore {
    entries: Vec<KnownHostEntry>,
}

impl KnownHostsStore {
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let text = std::fs::read_to_string(path)?;
        let mut store = Self::default();
        for (line_number, line) in text.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 3 || fields[0].contains(',') || fields[0].starts_with('|') {
                continue;
            }
            let (host, port) = parse_host_port(fields[0])
                .map_err(|error| anyhow!("known_hosts line {}: {}", line_number + 1, error))?;
            store.entries.push(KnownHostEntry {
                host,
                port,
                key_type: canonical_key_type(fields[1]).to_string(),
                key_base64: fields[2].to_string(),
            });
        }
        Ok(store)
    }

    pub fn check(&self, host: &str, port: u16, key_type: &str, key_base64: &str) -> HostKeyCheck {
        let key_type = canonical_key_type(key_type);
        let matches: Vec<&KnownHostEntry> = self
            .entries
            .iter()
            .filter(|entry| entry.host == host && entry.port == port)
            .collect();
        if matches.iter().any(|entry| {
            canonical_key_type(&entry.key_type) == key_type && entry.key_base64 == key_base64
        }) {
            HostKeyCheck::Match
        } else if let Some(previous) = matches.first() {
            HostKeyCheck::Changed {
                previous: (*previous).clone(),
            }
        } else {
            HostKeyCheck::Unknown
        }
    }

    pub fn accept(&mut self, host: &str, port: u16, key_type: &str, key_base64: &str) {
        self.entries
            .retain(|entry| !(entry.host == host && entry.port == port));
        self.entries.push(KnownHostEntry {
            host: host.to_string(),
            port,
            key_type: canonical_key_type(key_type).to_string(),
            key_base64: key_base64.to_string(),
        });
    }

    pub fn remove(&mut self, host: &str, port: u16) -> bool {
        let before = self.entries.len();
        self.entries
            .retain(|entry| !(entry.host == host && entry.port == port));
        self.entries.len() != before
    }

    pub fn entries(&self) -> &[KnownHostEntry] {
        &self.entries
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut text = String::new();
        for entry in &self.entries {
            let host = if entry.port == 22 {
                entry.host.clone()
            } else {
                format!("[{}]:{}", entry.host, entry.port)
            };
            text.push_str(&format!(
                "{} {} {}\n",
                host, entry.key_type, entry.key_base64
            ));
        }
        let suffix = uuid::Uuid::new_v4();
        let temp_path = path.with_extension(format!("tmp-{suffix}"));
        let backup_path = path.with_extension(format!("bak-{suffix}"));
        let mut file = std::fs::File::create(&temp_path)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        if path.exists() {
            std::fs::rename(path, &backup_path)?;
        }
        if let Err(error) = std::fs::rename(&temp_path, path) {
            if backup_path.exists() {
                let _ = std::fs::rename(&backup_path, path);
            }
            let _ = std::fs::remove_file(&temp_path);
            return Err(error.into());
        }
        if backup_path.exists() {
            std::fs::remove_file(backup_path)?;
        }
        Ok(())
    }
}

fn canonical_key_type(value: &str) -> &str {
    match value {
        "rsa" => "ssh-rsa",
        "dss" => "ssh-dss",
        "ecdsa256" => "ecdsa-sha2-nistp256",
        "ecdsa384" => "ecdsa-sha2-nistp384",
        "ecdsa521" => "ecdsa-sha2-nistp521",
        "ed25519" => "ssh-ed25519",
        value => value,
    }
}

pub fn sha256_fingerprint(key_base64: &str) -> Result<String> {
    let key = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, key_base64)?;
    let digest = Sha256::digest(key);
    Ok(format!(
        "SHA256:{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD_NO_PAD, digest)
    ))
}

fn parse_host_port(value: &str) -> Result<(String, u16)> {
    if let Some(rest) = value.strip_prefix('[') {
        let (host, port) = rest
            .split_once("]:")
            .ok_or_else(|| anyhow!("invalid bracketed host"))?;
        return Ok((host.to_string(), port.parse()?));
    }
    Ok((value.to_string(), 22))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn known_hosts_checks_unknown_match_and_changed() {
        let mut store = KnownHostsStore::default();
        assert_eq!(
            store.check("example", 22, "ssh-ed25519", "AQ=="),
            HostKeyCheck::Unknown
        );
        store.accept("example", 22, "ssh-ed25519", "AQ==");
        assert_eq!(
            store.check("example", 22, "ssh-ed25519", "AQ=="),
            HostKeyCheck::Match
        );
        assert!(matches!(
            store.check("example", 22, "ssh-ed25519", "Ag=="),
            HostKeyCheck::Changed { .. }
        ));
    }

    #[test]
    fn known_hosts_round_trips_non_default_port() {
        let path = std::env::temp_dir().join(format!(
            "joyshell-known-hosts-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut store = KnownHostsStore::default();
        store.accept("192.0.2.10", 2222, "ssh-rsa", "AQ==");
        store.save(&path).unwrap();
        let loaded = KnownHostsStore::load(&path).unwrap();
        assert_eq!(loaded.entries(), store.entries());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn load_ignores_comments_hashed_hosts_and_host_lists() {
        let path = std::env::temp_dir().join(format!(
            "joyshell-known-hosts-ignore-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            "# comment\n\n|1|salt|hash ssh-ed25519 AQ==\na,b ssh-rsa Ag==\n[2001:db8::1]:2222 ssh-ed25519 Aw==\n",
        )
        .unwrap();
        let store = KnownHostsStore::load(&path).unwrap();
        assert_eq!(store.entries().len(), 1);
        assert_eq!(store.entries()[0].host, "2001:db8::1");
        assert_eq!(store.entries()[0].port, 2222);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sha256_fingerprint_uses_openssh_format() {
        let fingerprint = sha256_fingerprint("AQ==").unwrap();
        assert!(fingerprint.starts_with("SHA256:"));
        assert!(!fingerprint.ends_with('='));
    }

    #[test]
    fn legacy_debug_key_types_are_normalized_to_openssh_names() {
        let path = std::env::temp_dir().join(format!(
            "joyshell-known-hosts-legacy-key-type-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, "example ed25519 AQ==\n").unwrap();
        let store = KnownHostsStore::load(&path).unwrap();
        assert_eq!(store.entries()[0].key_type, "ssh-ed25519");
        assert_eq!(
            store.check("example", 22, "ssh-ed25519", "AQ=="),
            HostKeyCheck::Match
        );
        let _ = std::fs::remove_file(path);
    }
}
