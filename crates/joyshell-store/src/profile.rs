use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use parking_lot::{Mutex, RwLock};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fmt::Debug;
use std::fs;
use std::io;
use std::path::Path;
use std::sync::Arc;
use uuid::Uuid;

use joyshell_core::{AuthMethod, HostKeyPolicy, SessionId, SessionProfile};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionFolder {
    pub id: Uuid,
    pub name: String,
    pub parent_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommandSnippet {
    pub id: Uuid,
    pub title: String,
    pub command: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LayoutSettings {
    pub restore_last_layout: bool,
    pub default_left_sidebar_open: bool,
    pub default_right_sidebar_open: bool,
    pub default_bottom_panel_open: bool,
    pub last_left_sidebar_open: bool,
    pub last_right_sidebar_open: bool,
    pub last_bottom_panel_open: bool,
    pub use_icmp_latency_probe: bool,
    pub skip_delete_confirmations: bool,
    pub splash_center_image_data_url: Option<String>,
    pub terminal_background_image_data_url: Option<String>,
    pub terminal_background_opacity: u8,
    pub terminal_background_apply_workspace: bool,
    pub terminal_background_apply_home: bool,
}

impl Default for LayoutSettings {
    fn default() -> Self {
        Self {
            restore_last_layout: false,
            default_left_sidebar_open: true,
            default_right_sidebar_open: true,
            default_bottom_panel_open: true,
            last_left_sidebar_open: true,
            last_right_sidebar_open: true,
            last_bottom_panel_open: true,
            use_icmp_latency_probe: false,
            skip_delete_confirmations: false,
            splash_center_image_data_url: None,
            terminal_background_image_data_url: None,
            terminal_background_opacity: 28,
            terminal_background_apply_workspace: true,
            terminal_background_apply_home: false,
        }
    }
}

#[derive(Clone)]
enum ProfileStorage {
    Memory {
        profiles: Arc<RwLock<Vec<SessionProfile>>>,
        folders: Arc<RwLock<Vec<SessionFolder>>>,
        commands: Arc<RwLock<Vec<CommandSnippet>>>,
        secrets: Arc<RwLock<Vec<(String, String)>>>,
        layout: Arc<RwLock<LayoutSettings>>,
    },
    Sqlite {
        connection: Arc<Mutex<Connection>>,
    },
}

#[derive(Clone)]
pub struct ProfileRepository {
    storage: ProfileStorage,
}

impl Default for ProfileRepository {
    fn default() -> Self {
        Self::memory()
    }
}

impl ProfileRepository {
    pub fn memory() -> Self {
        Self {
            storage: ProfileStorage::Memory {
                profiles: Arc::new(RwLock::new(Vec::new())),
                folders: Arc::new(RwLock::new(Vec::new())),
                commands: Arc::new(RwLock::new(Vec::new())),
                secrets: Arc::new(RwLock::new(Vec::new())),
                layout: Arc::new(RwLock::new(LayoutSettings::default())),
            },
        }
    }

    pub fn sqlite(database_path: impl AsRef<Path>) -> rusqlite::Result<Self> {
        if let Some(parent) = database_path.as_ref().parent() {
            fs::create_dir_all(parent)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        }
        let connection = Connection::open(database_path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&connection)?;
        Ok(Self {
            storage: ProfileStorage::Sqlite {
                connection: Arc::new(Mutex::new(connection)),
            },
        })
    }

    pub fn upsert_profile(&self, profile: SessionProfile) -> rusqlite::Result<()> {
        match &self.storage {
            ProfileStorage::Memory { profiles, .. } => {
                let mut profiles = profiles.write();
                if let Some(existing) = profiles.iter_mut().find(|item| item.id == profile.id) {
                    *existing = profile;
                } else {
                    profiles.push(profile);
                }
                Ok(())
            }
            ProfileStorage::Sqlite { connection } => {
                let connection = connection.lock();
                connection.execute(
                    "
                    insert into session_profiles (
                        id, name, group_name, host, port, latency_probe_host, latency_probe_port, use_terminal_latency_probe, username, auth_method_json,
                        host_key_policy, tags_json, favorite, sort_order, jump_host_id, updated_at
                    )
                    values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, datetime('now'))
                    on conflict(id) do update set
                        name = excluded.name,
                        group_name = excluded.group_name,
                        host = excluded.host,
                        port = excluded.port,
                        latency_probe_host = excluded.latency_probe_host,
                        latency_probe_port = excluded.latency_probe_port,
                        use_terminal_latency_probe = excluded.use_terminal_latency_probe,
                        username = excluded.username,
                        auth_method_json = excluded.auth_method_json,
                        host_key_policy = excluded.host_key_policy,
                        tags_json = excluded.tags_json,
                        favorite = excluded.favorite,
                        sort_order = excluded.sort_order,
                        jump_host_id = excluded.jump_host_id,
                        updated_at = datetime('now')
                    ",
                    params![
                        profile.id.to_string(),
                        profile.name,
                        profile.group,
                        profile.host,
                        profile.port,
                        profile.latency_probe_host,
                        profile.latency_probe_port,
                        profile.use_terminal_latency_probe,
                        profile.username,
                        serde_json::to_string(&profile.auth_method).map_err(json_to_sql_error)?,
                        serde_json::to_string(&profile.host_key_policy)
                            .map_err(json_to_sql_error)?,
                        serde_json::to_string(&profile.tags).map_err(json_to_sql_error)?,
                        profile.favorite,
                        profile.sort_order,
                        profile.jump_host_id.map(|id| id.to_string()),
                    ],
                )?;
                Ok(())
            }
        }
    }

    pub fn list_profiles(&self) -> rusqlite::Result<Vec<SessionProfile>> {
        match &self.storage {
            ProfileStorage::Memory { profiles, .. } => Ok(profiles.read().clone()),
            ProfileStorage::Sqlite { connection } => {
                let connection = connection.lock();
                let mut statement = connection.prepare(
                    "
                    select id, name, group_name, host, port, username, auth_method_json,
                           host_key_policy, tags_json, favorite, sort_order, jump_host_id,
                           latency_probe_host, latency_probe_port, use_terminal_latency_probe
                    from session_profiles
                    order by favorite desc, coalesce(group_name, ''), sort_order asc, name asc
                    ",
                )?;
                let rows = statement.query_map([], read_profile_row)?;
                rows.collect()
            }
        }
    }

    pub fn get_profile(&self, id: SessionId) -> rusqlite::Result<Option<SessionProfile>> {
        match &self.storage {
            ProfileStorage::Memory { profiles, .. } => Ok(profiles
                .read()
                .iter()
                .find(|profile| profile.id == id)
                .cloned()),
            ProfileStorage::Sqlite { connection } => {
                let connection = connection.lock();
                connection
                    .query_row(
                        "
                        select id, name, group_name, host, port, username, auth_method_json,
                               host_key_policy, tags_json, favorite, sort_order, jump_host_id,
                               latency_probe_host, latency_probe_port, use_terminal_latency_probe
                        from session_profiles
                        where id = ?1
                        ",
                        params![id.to_string()],
                        read_profile_row,
                    )
                    .optional()
            }
        }
    }

    pub fn delete_profile(&self, id: SessionId) -> rusqlite::Result<bool> {
        match &self.storage {
            ProfileStorage::Memory {
                profiles, secrets, ..
            } => {
                let mut profiles = profiles.write();
                let before = profiles.len();
                profiles.retain(|profile| profile.id != id);
                secrets
                    .write()
                    .retain(|(secret_ref, _)| !secret_ref.starts_with(&format!("secret://{id}/")));
                Ok(profiles.len() != before)
            }
            ProfileStorage::Sqlite { connection } => {
                let connection = connection.lock();
                connection.execute(
                    "delete from secret_values where secret_ref like ?1",
                    params![format!("secret://{id}/%")],
                )?;
                let deleted = connection.execute(
                    "delete from session_profiles where id = ?1",
                    params![id.to_string()],
                )?;
                Ok(deleted > 0)
            }
        }
    }

    pub fn list_folders(&self) -> rusqlite::Result<Vec<SessionFolder>> {
        match &self.storage {
            ProfileStorage::Memory { folders, .. } => Ok(folders.read().clone()),
            ProfileStorage::Sqlite { connection } => {
                let connection = connection.lock();
                let mut statement = connection
                    .prepare("select id, name, parent_id from session_folders order by name asc")?;
                let rows = statement.query_map([], |row| {
                    let parent_id: Option<String> = row.get(2)?;
                    Ok(SessionFolder {
                        id: parse_uuid(row.get::<_, String>(0)?)?,
                        name: row.get(1)?,
                        parent_id: parent_id.map(parse_uuid).transpose()?,
                    })
                })?;
                rows.collect()
            }
        }
    }

    pub fn upsert_folder(&self, folder: SessionFolder) -> rusqlite::Result<()> {
        match &self.storage {
            ProfileStorage::Memory { folders, .. } => {
                let mut folders = folders.write();
                if let Some(existing) = folders.iter_mut().find(|item| item.id == folder.id) {
                    *existing = folder;
                } else {
                    folders.push(folder);
                }
                Ok(())
            }
            ProfileStorage::Sqlite { connection } => {
                let connection = connection.lock();
                connection.execute(
                    "
                    insert into session_folders (id, name, parent_id, updated_at)
                    values (?1, ?2, ?3, datetime('now'))
                    on conflict(id) do update set
                        name = excluded.name,
                        parent_id = excluded.parent_id,
                        updated_at = datetime('now')
                    ",
                    params![
                        folder.id.to_string(),
                        folder.name,
                        folder.parent_id.map(|id| id.to_string()),
                    ],
                )?;
                Ok(())
            }
        }
    }

    pub fn delete_folder(&self, folder_id: Uuid) -> rusqlite::Result<Option<String>> {
        match &self.storage {
            ProfileStorage::Memory {
                folders, profiles, ..
            } => {
                let mut folders = folders.write();
                let Some(index) = folders.iter().position(|item| item.id == folder_id) else {
                    return Ok(None);
                };
                let folder = folders.remove(index);
                for profile in profiles.write().iter_mut() {
                    if profile.group.as_deref() == Some(folder.name.as_str()) {
                        profile.group = None;
                    }
                }
                Ok(Some(folder.name))
            }
            ProfileStorage::Sqlite { connection } => {
                let mut connection = connection.lock();
                let transaction = connection.transaction()?;
                let folder_name = transaction
                    .query_row(
                        "select name from session_folders where id = ?1",
                        params![folder_id.to_string()],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?;

                let Some(folder_name) = folder_name else {
                    return Ok(None);
                };

                transaction.execute(
                    "update session_profiles set group_name = null, updated_at = datetime('now') where group_name = ?1",
                    params![folder_name],
                )?;
                transaction.execute(
                    "delete from session_folders where id = ?1",
                    params![folder_id.to_string()],
                )?;
                transaction.commit()?;
                Ok(Some(folder_name))
            }
        }
    }

    pub fn upsert_secret(
        &self,
        secret_ref: &str,
        plaintext: &str,
        key: &[u8; 32],
    ) -> rusqlite::Result<()> {
        match &self.storage {
            ProfileStorage::Memory { secrets, .. } => {
                let mut secrets = secrets.write();
                if let Some(existing) = secrets.iter_mut().find(|item| item.0 == secret_ref) {
                    existing.1 = plaintext.to_string();
                } else {
                    secrets.push((secret_ref.to_string(), plaintext.to_string()));
                }
                Ok(())
            }
            ProfileStorage::Sqlite { connection } => {
                let encrypted = encrypt_secret(secret_ref, plaintext, key)?;
                let connection = connection.lock();
                connection.execute(
                    "
                    insert into secret_values (secret_ref, nonce, ciphertext, updated_at)
                    values (?1, ?2, ?3, datetime('now'))
                    on conflict(secret_ref) do update set
                        nonce = excluded.nonce,
                        ciphertext = excluded.ciphertext,
                        updated_at = datetime('now')
                    ",
                    params![secret_ref, encrypted.nonce, encrypted.ciphertext],
                )?;
                Ok(())
            }
        }
    }

    pub fn get_secret(&self, secret_ref: &str, key: &[u8; 32]) -> rusqlite::Result<Option<String>> {
        match &self.storage {
            ProfileStorage::Memory { secrets, .. } => Ok(secrets
                .read()
                .iter()
                .find(|item| item.0 == secret_ref)
                .map(|item| item.1.clone())),
            ProfileStorage::Sqlite { connection } => {
                let connection = connection.lock();
                let encrypted = connection
                    .query_row(
                        "select nonce, ciphertext from secret_values where secret_ref = ?1",
                        params![secret_ref],
                        |row| {
                            Ok(EncryptedSecret {
                                nonce: row.get(0)?,
                                ciphertext: row.get(1)?,
                            })
                        },
                    )
                    .optional()?;
                encrypted
                    .map(|value| decrypt_secret(secret_ref, value, key))
                    .transpose()
            }
        }
    }

    pub fn list_command_snippets(&self) -> rusqlite::Result<Vec<CommandSnippet>> {
        match &self.storage {
            ProfileStorage::Memory { commands, .. } => Ok(commands.read().clone()),
            ProfileStorage::Sqlite { connection } => {
                let connection = connection.lock();
                let mut statement = connection.prepare(
                    "select id, title, command, tags_json from command_snippets order by updated_at desc, title asc",
                )?;
                let rows = statement.query_map([], |row| {
                    let tags_json: String = row.get(3)?;
                    Ok(CommandSnippet {
                        id: parse_uuid(row.get::<_, String>(0)?)?,
                        title: row.get(1)?,
                        command: row.get(2)?,
                        tags: serde_json::from_str::<Vec<String>>(&tags_json)
                            .map_err(json_from_sql_error)?,
                    })
                })?;
                rows.collect()
            }
        }
    }

    pub fn upsert_command_snippet(
        &self,
        snippet: CommandSnippet,
    ) -> rusqlite::Result<CommandSnippet> {
        match &self.storage {
            ProfileStorage::Memory { commands, .. } => {
                let mut commands = commands.write();
                if let Some(existing) = commands.iter_mut().find(|item| item.id == snippet.id) {
                    *existing = snippet.clone();
                } else {
                    commands.push(snippet.clone());
                }
                Ok(snippet)
            }
            ProfileStorage::Sqlite { connection } => {
                let connection = connection.lock();
                connection.execute(
                    "
                    insert into command_snippets (id, title, command, tags_json, updated_at)
                    values (?1, ?2, ?3, ?4, datetime('now'))
                    on conflict(id) do update set
                        title = excluded.title,
                        command = excluded.command,
                        tags_json = excluded.tags_json,
                        updated_at = datetime('now')
                    ",
                    params![
                        snippet.id.to_string(),
                        snippet.title,
                        snippet.command,
                        serde_json::to_string(&snippet.tags).map_err(json_to_sql_error)?,
                    ],
                )?;
                Ok(snippet)
            }
        }
    }

    pub fn delete_command_snippet(&self, id: Uuid) -> rusqlite::Result<()> {
        match &self.storage {
            ProfileStorage::Memory { commands, .. } => {
                commands.write().retain(|item| item.id != id);
                Ok(())
            }
            ProfileStorage::Sqlite { connection } => {
                connection.lock().execute(
                    "delete from command_snippets where id = ?1",
                    params![id.to_string()],
                )?;
                Ok(())
            }
        }
    }

    pub fn get_layout_settings(&self) -> rusqlite::Result<LayoutSettings> {
        match &self.storage {
            ProfileStorage::Memory { layout, .. } => Ok(layout.read().clone()),
            ProfileStorage::Sqlite { connection } => {
                let connection = connection.lock();
                let value = connection
                    .query_row(
                        "
                        select restore_last_layout,
                               default_left_sidebar_open,
                               default_right_sidebar_open,
                               default_bottom_panel_open,
                               last_left_sidebar_open,
                               last_right_sidebar_open,
                               last_bottom_panel_open,
                               use_icmp_latency_probe,
                               skip_delete_confirmations,
                               splash_center_image_data_url,
                               terminal_background_image_data_url,
                               terminal_background_opacity,
                               terminal_background_apply_workspace,
                               terminal_background_apply_home
                        from layout_settings
                        where id = 'default'
                        ",
                        [],
                        |row| {
                            Ok(LayoutSettings {
                                restore_last_layout: row.get(0)?,
                                default_left_sidebar_open: row.get(1)?,
                                default_right_sidebar_open: row.get(2)?,
                                default_bottom_panel_open: row.get(3)?,
                                last_left_sidebar_open: row.get(4)?,
                                last_right_sidebar_open: row.get(5)?,
                                last_bottom_panel_open: row.get(6)?,
                                use_icmp_latency_probe: row.get(7)?,
                                skip_delete_confirmations: row.get(8)?,
                                splash_center_image_data_url: row.get(9)?,
                                terminal_background_image_data_url: row.get(10)?,
                                terminal_background_opacity: row.get(11)?,
                                terminal_background_apply_workspace: row.get(12)?,
                                terminal_background_apply_home: row.get(13)?,
                            })
                        },
                    )
                    .optional()?;
                Ok(value.unwrap_or_default())
            }
        }
    }

    pub fn save_layout_settings(
        &self,
        settings: LayoutSettings,
    ) -> rusqlite::Result<LayoutSettings> {
        match &self.storage {
            ProfileStorage::Memory { layout, .. } => {
                *layout.write() = settings.clone();
                Ok(settings)
            }
            ProfileStorage::Sqlite { connection } => {
                connection.lock().execute(
                    "
                    insert into layout_settings (
                        id,
                        restore_last_layout,
                        default_left_sidebar_open,
                        default_right_sidebar_open,
                        default_bottom_panel_open,
                        last_left_sidebar_open,
                        last_right_sidebar_open,
                        last_bottom_panel_open,
                        use_icmp_latency_probe,
                        skip_delete_confirmations,
                        splash_center_image_data_url,
                        terminal_background_image_data_url,
                        terminal_background_opacity,
                        terminal_background_apply_workspace,
                        terminal_background_apply_home,
                        updated_at
                    )
                    values ('default', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, datetime('now'))
                    on conflict(id) do update set
                        restore_last_layout = excluded.restore_last_layout,
                        default_left_sidebar_open = excluded.default_left_sidebar_open,
                        default_right_sidebar_open = excluded.default_right_sidebar_open,
                        default_bottom_panel_open = excluded.default_bottom_panel_open,
                        last_left_sidebar_open = excluded.last_left_sidebar_open,
                        last_right_sidebar_open = excluded.last_right_sidebar_open,
                        last_bottom_panel_open = excluded.last_bottom_panel_open,
                        use_icmp_latency_probe = excluded.use_icmp_latency_probe,
                        skip_delete_confirmations = excluded.skip_delete_confirmations,
                        splash_center_image_data_url = excluded.splash_center_image_data_url,
                        terminal_background_image_data_url = excluded.terminal_background_image_data_url,
                        terminal_background_opacity = excluded.terminal_background_opacity,
                        terminal_background_apply_workspace = excluded.terminal_background_apply_workspace,
                        terminal_background_apply_home = excluded.terminal_background_apply_home,
                        updated_at = datetime('now')
                    ",
                    params![
                        settings.restore_last_layout,
                        settings.default_left_sidebar_open,
                        settings.default_right_sidebar_open,
                        settings.default_bottom_panel_open,
                        settings.last_left_sidebar_open,
                        settings.last_right_sidebar_open,
                        settings.last_bottom_panel_open,
                        settings.use_icmp_latency_probe,
                        settings.skip_delete_confirmations,
                        settings.splash_center_image_data_url,
                        settings.terminal_background_image_data_url,
                        settings.terminal_background_opacity,
                        settings.terminal_background_apply_workspace,
                        settings.terminal_background_apply_home,
                    ],
                )?;
                Ok(settings)
            }
        }
    }
}

fn migrate(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "
        create table if not exists session_folders (
            id text primary key,
            name text not null,
            parent_id text null references session_folders(id) on delete set null,
            created_at text not null default (datetime('now')),
            updated_at text not null default (datetime('now'))
        );

        create table if not exists session_profiles (
            id text primary key,
            name text not null,
            group_name text null,
            host text not null,
            port integer not null,
            latency_probe_host text null,
            latency_probe_port integer null,
            use_terminal_latency_probe integer not null default 0,
            username text not null,
            auth_method_json text not null,
            host_key_policy text not null,
            tags_json text not null default '[]',
            favorite integer not null default 0,
            sort_order integer not null default 0,
            jump_host_id text null,
            created_at text not null default (datetime('now')),
            updated_at text not null default (datetime('now'))
        );

        create index if not exists idx_session_profiles_group_name
            on session_profiles(group_name);

        create table if not exists secret_values (
            secret_ref text primary key,
            nonce blob not null,
            ciphertext blob not null,
            created_at text not null default (datetime('now')),
            updated_at text not null default (datetime('now'))
        );

        create table if not exists command_snippets (
            id text primary key,
            title text not null,
            command text not null,
            tags_json text not null default '[]',
            created_at text not null default (datetime('now')),
            updated_at text not null default (datetime('now'))
        );

        create table if not exists layout_settings (
            id text primary key,
            restore_last_layout integer not null default 0,
            default_left_sidebar_open integer not null default 1,
            default_right_sidebar_open integer not null default 1,
            default_bottom_panel_open integer not null default 1,
            last_left_sidebar_open integer not null default 1,
            last_right_sidebar_open integer not null default 1,
            last_bottom_panel_open integer not null default 1,
            use_icmp_latency_probe integer not null default 0,
            skip_delete_confirmations integer not null default 0,
            splash_center_image_data_url text null,
            terminal_background_image_data_url text null,
            terminal_background_opacity integer not null default 28,
            terminal_background_apply_workspace integer not null default 1,
            terminal_background_apply_home integer not null default 0,
            updated_at text not null default (datetime('now'))
        );
        ",
    )?;

    ensure_layout_column(
        connection,
        "restore_last_layout",
        "integer not null default 0",
    )?;
    ensure_layout_column(
        connection,
        "default_left_sidebar_open",
        "integer not null default 1",
    )?;
    ensure_layout_column(
        connection,
        "default_right_sidebar_open",
        "integer not null default 1",
    )?;
    ensure_layout_column(
        connection,
        "default_bottom_panel_open",
        "integer not null default 1",
    )?;
    ensure_layout_column(
        connection,
        "last_left_sidebar_open",
        "integer not null default 1",
    )?;
    ensure_layout_column(
        connection,
        "last_right_sidebar_open",
        "integer not null default 1",
    )?;
    ensure_layout_column(
        connection,
        "last_bottom_panel_open",
        "integer not null default 1",
    )?;
    ensure_layout_column(
        connection,
        "use_icmp_latency_probe",
        "integer not null default 0",
    )?;
    ensure_layout_column(
        connection,
        "skip_delete_confirmations",
        "integer not null default 0",
    )?;
    ensure_layout_column(
        connection,
        "splash_center_image_data_url",
        "text null",
    )?;
    ensure_layout_column(
        connection,
        "terminal_background_image_data_url",
        "text null",
    )?;
    ensure_layout_column(
        connection,
        "terminal_background_opacity",
        "integer not null default 28",
    )?;
    ensure_layout_column(
        connection,
        "terminal_background_apply_workspace",
        "integer not null default 1",
    )?;
    ensure_layout_column(
        connection,
        "terminal_background_apply_home",
        "integer not null default 0",
    )?;
    ensure_table_column(
        connection,
        "session_profiles",
        "sort_order",
        "integer not null default 0",
    )?;
    ensure_table_column(
        connection,
        "session_profiles",
        "latency_probe_host",
        "text null",
    )?;
    ensure_table_column(
        connection,
        "session_profiles",
        "latency_probe_port",
        "integer null",
    )?;
    ensure_table_column(
        connection,
        "session_profiles",
        "use_terminal_latency_probe",
        "integer not null default 0",
    )?;

    Ok(())
}

fn read_profile_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionProfile> {
    let id: String = row.get(0)?;
    let auth_method_json: String = row.get(6)?;
    let host_key_policy_json: String = row.get(7)?;
    let tags_json: String = row.get(8)?;
    let jump_host_id: Option<String> = row.get(11)?;

    Ok(SessionProfile {
        id: parse_uuid(id)?,
        name: row.get(1)?,
        group: row.get(2)?,
        host: row.get(3)?,
        port: row.get::<_, u16>(4)?,
        latency_probe_host: row.get(12)?,
        latency_probe_port: row.get(13)?,
        use_terminal_latency_probe: row.get(14)?,
        username: row.get(5)?,
        auth_method: serde_json::from_str::<AuthMethod>(&auth_method_json)
            .map_err(json_from_sql_error)?,
        host_key_policy: serde_json::from_str::<HostKeyPolicy>(&host_key_policy_json)
            .map_err(json_from_sql_error)?,
        tags: serde_json::from_str::<Vec<String>>(&tags_json).map_err(json_from_sql_error)?,
        favorite: row.get(9)?,
        sort_order: row.get(10)?,
        jump_host_id: jump_host_id.map(parse_uuid).transpose()?,
    })
}

fn ensure_layout_column(
    connection: &Connection,
    name: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    ensure_table_column(connection, "layout_settings", name, definition)
}

fn ensure_table_column(
    connection: &Connection,
    table: &str,
    name: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    let mut statement = connection.prepare(&format!("pragma table_info({table})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for column in columns {
        if column? == name {
            return Ok(());
        }
    }
    connection.execute(
        &format!("alter table {table} add column {name} {definition}"),
        [],
    )?;
    Ok(())
}

fn parse_uuid(value: String) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

fn json_to_sql_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

fn json_from_sql_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

struct EncryptedSecret {
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

fn encrypt_secret(
    secret_ref: &str,
    plaintext: &str,
    key: &[u8; 32],
) -> rusqlite::Result<EncryptedSecret> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext.as_bytes(),
                aad: secret_ref.as_bytes(),
            },
        )
        .map_err(crypto_to_sql_error)?;
    Ok(EncryptedSecret {
        nonce: nonce.to_vec(),
        ciphertext,
    })
}

fn decrypt_secret(
    secret_ref: &str,
    encrypted: EncryptedSecret,
    key: &[u8; 32],
) -> rusqlite::Result<String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&encrypted.nonce),
            Payload {
                msg: encrypted.ciphertext.as_ref(),
                aad: secret_ref.as_bytes(),
            },
        )
        .map_err(crypto_to_sql_error)?;
    String::from_utf8(plaintext).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Blob, Box::new(error))
    })
}

fn crypto_to_sql_error(error: impl Debug) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(io::Error::new(
        io::ErrorKind::InvalidData,
        format!("secret encryption failed: {error:?}"),
    )))
}
