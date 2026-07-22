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
- `SessionProfile.auth_method`, `tags`, and host key policy are serialized as structured JSON fields where needed.
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

- `pnpm --filter @joyshell/desktop typecheck`
- `pnpm --filter @joyshell/desktop build`
- `cargo check`
- Chrome headless preview screenshot:
  - `target/joyshell-sqlite-home-preview-final.png`

## Follow-up

- Upgrade encrypted SQLite password storage to OS keychain storage:
  - Windows Credential Manager
  - macOS Keychain
  - Linux Secret Service
- Add folder rename/delete and profile move actions.
- Add a migration version table before the schema grows further.
- Persist UI state such as last selected profile only after the basic profile model stabilizes.
