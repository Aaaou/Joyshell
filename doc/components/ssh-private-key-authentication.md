# SSH Private Key Authentication

## Component Scope

This component adds local private-key authentication to the existing SSH session path:

- the profile stores a local private-key file reference, not private-key material
- an optional private-key passphrase is encrypted through the existing secret store
- the interactive terminal and side SSH connections use the same authentication credential
- system monitoring and SFTP therefore keep working for private-key sessions

SSH Agent and `known_hosts` enforcement remain separate follow-up work.

## Mature References Read

The implementation follows existing clients and the SSH library already used by Joyshell:

- Tabby commit `14e2d60b9b6dee84a53c37f05eefeb803787de04`
  - `tabby-ssh/src/api/interfaces.ts` stores private-key file references in the profile.
  - `tabby-ssh/src/components/sshProfileSettings.component.ts` selects and stores a private-key file reference.
  - `tabby-ssh/src/session/ssh.ts` loads configured keys, rejects a mistakenly selected public key, parses encrypted keys, and keeps passphrases in the password store.
  - `tabby-ssh/src/services/passwordStorage.service.ts` separates connection passwords from key passphrases.
- electerm commit `73592ba43b2334d7dc8cc85498a6385ddcb0d1c2`
  - `src/app/server/session-ssh.js` reads the selected key, adds `publickey` to the authentication order, passes the optional passphrase, and retries after a passphrase prompt.
  - `test/unit-ci/session-ssh.spec.js` verifies RSA and Ed25519 keys protected by passphrases.
- ssh2-rs commit `ef9b07b81659b88c39682d4463bbe1e2cd2cf59c`
  - `src/session.rs::userauth_pubkey_file()` wraps `libssh2_userauth_publickey_fromfile_ex()` and accepts an optional public-key path and passphrase.
- libssh2 commit `234835876eb2b25f4e04d3ba4c8294d5dc878024`
  - official `example/ssh2.c`, `example/ssh2_exec.c`, and SFTP examples authenticate with `libssh2_userauth_publickey_fromfile()` before opening channels.

Reference links:

- <https://github.com/Eugeny/tabby/tree/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-ssh/src>
- <https://github.com/electerm/electerm/tree/73592ba43b2334d7dc8cc85498a6385ddcb0d1c2>
- <https://github.com/alexcrichton/ssh2-rs/blob/ef9b07b81659b88c39682d4463bbe1e2cd2cf59c/src/session.rs>
- <https://github.com/libssh2/libssh2/tree/234835876eb2b25f4e04d3ba4c8294d5dc878024/example>

## Adopted Flow

1. The settings dialog selects a private-key file and optionally accepts a passphrase.
2. `SessionProfile.auth_method` stores `PrivateKey.key_ref` as the local file path.
3. Only the optional passphrase enters `secret_values`, encrypted by the existing AES-256-GCM store.
4. The Tauri command resolves the passphrase in memory and calls the private-key session entry point.
5. `joyshell-core` calls `ssh2::Session::userauth_pubkey_file(username, None, key_path, passphrase)` after the SSH handshake.
6. The runtime retains the same credential for monitoring and SFTP side connections.

The public key does not need to be selected locally. libssh2 derives it from the private key when the public-key path argument is `None`; the matching public key must already be authorized by the server.

## Verification

Unit and build checks:

```powershell
cargo test --workspace
pnpm --filter @joyshell/desktop test
pnpm build
```

Environment-driven real SSH probe:

```powershell
$env:JOYSHELL_SSH_HOST='ssh.example.internal'
$env:JOYSHELL_SSH_USER='test-user'
$env:JOYSHELL_SSH_KEY_PATH='C:\path\to\private-key'
$env:JOYSHELL_SSH_PORT='22'
cargo run -p joyshell-core --example private_key_probe
```

Set `JOYSHELL_SSH_KEY_PASSPHRASE` only for an encrypted private key. The probe verifies the interactive channel, the side connection used by system monitoring, and SFTP listings for the authenticated user's home directory and the remote root directory.

The desktop requests `.` when a session first opens its file browser. The backend resolves that path through SFTP `realpath` before listing it, so non-root accounts start in their own server-defined home directory instead of the previously hard-coded `/root` path.

## Remaining Risks

- `HostKeyPolicy` is persisted but host-key verification is not enforced yet.
- SSH Agent authentication is still explicitly rejected.
- Key-file permission validation currently relies on the operating system and libssh2.
- A moved or deleted key file requires the user to select its new location.
