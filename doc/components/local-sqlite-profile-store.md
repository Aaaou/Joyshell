# Local SQLite Profile Store

## Responsibility

The local store persists SSH session profiles and session folders for the desktop app. The UI calls Tauri commands, and the Rust backend owns the SQLite connection and schema migrations.

## Difficulty

- The app must start with no built-in test account.
- Server profiles must survive restarts without turning the frontend into the source of truth.
- Folder management needs to stay simple now, while leaving room for nested project/company organization later.
- Passwords and private key material must not be written to SQLite as plaintext.

## References

- SQLite WAL mode for a lightweight local desktop database.
- `rusqlite` with the `bundled` feature, so Windows/macOS/Linux packages do not depend on a system SQLite installation.
- Tauri app data directory, so the database follows each platform's standard application storage location.

## Adopted Solution

- `crates/joyshell-store` now exposes `ProfileRepository::sqlite(path)`.
- Desktop startup creates `joyshell.db` under Tauri's app data directory.
- The schema currently includes:
  - `session_profiles`
  - `session_folders`
  - `secret_values`
  - `command_snippets`
  - `layout_settings`
- `SessionProfile.auth_method`, `tags`, and host key policy are serialized as structured JSON fields where needed.
- `SessionProfile.operating_system` stores the OS name returned by the remote system probe. It is nullable for profiles that have never completed a probe, and existing databases receive the column through `ensure_table_column` without being cleared.
- The old default test server injection was removed from `AppState`.
- SSH passwords are encrypted before being stored in SQLite:
  - encryption: AES-256-GCM
  - storage: `secret_values.secret_ref`, `nonce`, `ciphertext`
  - local key derivation: app-specific salt + local user/machine identity + database path
  - associated data: `secret_ref`
- Decrypted passwords are cached only in the current desktop process after first use.
- This improves restart usability and avoids plaintext-at-rest. It is still weaker than OS keychain-backed storage, so Windows Credential Manager/macOS Keychain/Linux Secret Service remains the preferred long-term hardening path.
- If the database file is copied to another machine or another user path, stored passwords are not expected to decrypt.

## Command Snippets

- `command_snippets` stores common commands.
- The bottom panel command page can send snippets to:
  - current connected session
  - all connected sessions
  - selected connected sessions
- Sending reuses the existing terminal input channel and writes the command plus carriage return.

## Layout Settings

- `layout_settings.restore_last_layout` controls whether Joyshell restores the last runtime panel state on startup.
- When restore-last-layout is enabled, fixed default controls are disabled in the appearance settings.
- When restore-last-layout is disabled, the three default panel settings only affect the next startup and are not directly bound to the current runtime panel state.

## Large Database Evaluation

Large embedded or client/server databases are not adopted for the early desktop release.

- PostgreSQL/MySQL-compatible local deployments would add service management, port conflicts, installers, migrations, credentials, and higher idle memory.
- RocksDB/LevelDB can be attractive for high-throughput key-value workloads, but this project needs relational querying for sessions, folders, audit, commands, settings, and memories.
- DuckDB is excellent for analytics, but not the best primary mutable app database for many small UI writes.
- SQLite remains the right early choice because it is single-file, cross-platform, low-memory, transactional, supported well by Rust, and can ship with the app through `rusqlite`'s bundled feature.

The schema should stay portable so the project can later add an optional sync/index layer without replacing the local source of truth.

## UI Behavior

- If there are no local servers, the main workspace shows an add-server entry screen.
- If there are saved servers but no active selection, the main workspace shows a borderless horizontal server launcher.
- Server launcher badges infer a rough OS label from name, host, group, and tags.
- The left sidebar new button opens a creation menu for either a server or a folder.
- SSH settings can assign a profile to a folder/group.

## Verification

- `pnpm build`
- `cargo test --workspace`
- Desktop smoke test: create folders/profiles, restart the app, reconnect with the encrypted saved password, then verify layout and command snippets are restored.

## Uninstall Retention

- NSIS upgrades default to an in-place overwrite and retain the SQLite database and all application data.
- A normal uninstall shows a `清除用户数据` checkbox on the confirmation page.
- The checkbox is off by default. Uninstalling without selecting it keeps profiles, encrypted passwords, commands, and layout settings for a later reinstall.
- Update-mode uninstall stages never remove user data, even if the uninstaller is called internally by the installer.

## Follow-up

- Upgrade encrypted password storage to Windows Credential Manager, macOS Keychain and Linux Secret Service while keeping references in SQLite.
- Add an explicit schema version/migration table; current migrations use idempotent `CREATE TABLE` and `ensure_*_column` helpers.
- Extend the same explicit data-retention choice to MSI, macOS and Linux packages.
