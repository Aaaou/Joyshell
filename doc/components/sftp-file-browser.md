# SFTP File Browser

## Component Scope

This component provides the remote file browser and file transfer surface for an active SSH session.

It currently supports:

- directory listing
- parent navigation
- refresh
- create directory
- rename
- delete
- upload
- download
- transfer progress display
- in-app right-click menus for terminal and file browser
- native file picker upload/download on desktop
- drag-and-drop upload into the file browser

Main files:

- `crates/joyshell-core/src/sftp.rs`
- `crates/joyshell-core/src/session.rs`
- `crates/joyshell-core/examples/sftp_probe.rs`
- `apps/desktop/src-tauri/src/lib.rs`
- `apps/desktop/src/bridge.ts`
- `apps/desktop/src/types.ts`
- `apps/desktop/src/ui/App.tsx`
- `apps/desktop/src/styles.css`

## Mature References

The implementation follows common SFTP client behavior and the SSH2/libssh2 API surface.

Reference material:

- ssh2-rs SFTP API: https://docs.rs/ssh2/latest/ssh2/struct.Sftp.html
- libssh2 SFTP docs: https://libssh2.org/libssh2_sftp_open.html
- OpenSSH `sftp` behavior: directory navigation, file listing, rename/delete, and transfer semantics
- FileZilla / Cyberduck UX patterns: remote browser + action toolbar + transfer queue

## Design

The browser reuses the authenticated SSH session instead of opening a second login path.

Flow:

1. UI asks Tauri for `sftp_list_directory`.
2. Rust sends a control message to the SSH worker.
3. The worker opens an SFTP handle on the active session.
4. Directory entries are parsed into `RemoteDirectoryListing`.
5. File operations run through the same worker and emit `SftpProgress`.
6. The UI renders the remote listing and transfer queue.

## Supported Operations

- `list_sftp_directory`
- `create_sftp_dir`
- `delete_sftp_path`
- `rename_sftp_path`
- `download_sftp_file`
- `upload_sftp_file`

## Data Model

`RemoteFileEntry` includes:

- `name`
- `path`
- `is_dir`
- `size`
- `permissions`
- `modified_at`

`SftpProgress` includes:

- `direction`
- `local_path`
- `remote_path`
- `bytes_done`
- `bytes_total`
- `status`

## Implementation Notes

- The worker uses explicit control messages instead of injecting shell commands into the visible terminal.
- Remote paths are normalized to POSIX style before calling libssh2 SFTP APIs.
- Progress events are emitted through the existing `session:event` channel so the UI can show transfer state without polling.
- Upload and download are synchronous within the SSH worker for now. This is acceptable for the initial desktop MVP, but very large transfers may later deserve a dedicated transfer worker.
- Listing filters out `.` and `..` and sorts directories before files.
- Permissions are formatted in `ls -l` style for quick scanning.
- inode data is not part of SFTP itself; this component does not fabricate inode fields.
- Desktop uploads use the native file dialog rather than a manual path field.
- Drag-and-drop uploads are handled at the webview level and forwarded into the same upload path pipeline.
- Right-click menus are app-rendered overlays, which prevents the browser default context menu from appearing.
- Tauri dialog APIs require an explicit `dialog:default` capability in `src-tauri/capabilities/default.json`.
- Upload/download buttons insert an optimistic `Running` transfer row before the backend returns, then replace it with the real `SftpProgress`. This prevents small transfers from completing before the queue visually updates.

## Verification

Run against the Cloudflare tunnel endpoint:

```powershell
$env:OPENSSL_DIR='D:\miniconda3\Library'
$env:JOYSHELL_SSH_HOST='127.0.0.1'
$env:JOYSHELL_SSH_USER='root'
$env:JOYSHELL_SSH_PASSWORD='yujiarong520'
$env:JOYSHELL_SSH_PORT='2222'
C:\Users\EDY\.cargo\bin\cargo.exe run -p joyshell-core --example sftp_probe
```

Run against the LAN test host:

```powershell
$env:OPENSSL_DIR='D:\miniconda3\Library'
$env:JOYSHELL_SSH_HOST='192.168.110.24'
$env:JOYSHELL_SSH_USER='root'
$env:JOYSHELL_SSH_PASSWORD='yujiarong520'
$env:JOYSHELL_SSH_PORT='22'
C:\Users\EDY\.cargo\bin\cargo.exe run -p joyshell-core --example sftp_probe
```

Expected output includes:

- remote directory listing
- upload/download roundtrip
- rename success
- delete success
- `sftp probe completed`

## Follow-up Work

1. Add multi-select and batch transfer queue.
2. Add recursive directory upload/download.
3. Add file editor/viewer for text files.
4. Add resumable transfers and persistent queue state.
