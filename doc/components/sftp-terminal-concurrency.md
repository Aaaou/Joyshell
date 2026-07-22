# SFTP And Terminal Concurrency

## Problem

SFTP upload/download could block the interactive SSH terminal until the transfer finished.

The root cause was backend scheduling, not xterm.js. `run_ssh_session_loop` handled terminal input/output, system sync, SFTP listing, and file transfer on the same worker and the same `ssh2::Session`. When a large upload entered the blocking SFTP loop, the worker could not drain terminal output or process keyboard input.

## Reference Behavior

Mature SSH/SFTP clients treat interactive shell work and file transfer work as separate jobs:

- WinSCP keeps SSH/SFTP implementation in a non-visual core layer and documents resume/reconnect behavior for interrupted SFTP transfers.
- FileZilla exposes source code and is built around queued transfer jobs rather than treating each file transfer as a UI-thread action.
- OpenSSH ships `ssh` and `sftp` as separate client flows; SFTP is not implemented as a blocking side command inside an already-running interactive shell.
- libssh2 examples open an SFTP handle as a separate protocol channel on an authenticated SSH session.

References:

- https://github.com/winscp/winscp
- https://winscp.net/eng/docs/resume
- https://filezilla-project.org/sourcecode.php
- https://raw.githubusercontent.com/openssh/openssh-portable/master/sftp.c
- https://github.com/libssh2/libssh2/blob/master/example/sftp.c

## Joyshell Implementation

Backend changes in `crates/joyshell-core/src/session.rs`:

- `SshControl` was reduced to terminal input only.
- The terminal worker now owns only:
  - interactive shell output draining,
  - terminal input writes,
  - terminal keepalive,
  - terminal channel EOF/failure detection.
- SFTP operations now open an independent side SSH session through `establish_ssh_side_session`.
- SFTP list/mkdir/delete/rename/upload/download all run in `tokio::task::spawn_blocking`.
- System information sync also uses a side SSH session, so monitor refresh cannot block terminal typing.
- Transfer retry/resume logic remains unchanged, but it now runs outside the terminal loop.
- Side operation failure is reported as an operation failure first. It no longer marks the terminal session failed unless the terminal channel itself later reports EOF/read/write/flush failure.

## Credential Handling

For the MVP, `SessionRuntime` keeps a clone of `SessionProfile` and the password in memory so side sessions can authenticate without prompting for every SFTP operation.

This is not persisted to SQLite and should be replaced later by a credential-provider abstraction:

- Windows Credential Manager,
- macOS Keychain,
- Linux Secret Service,
- in-memory session token cache.

## UX Result

Expected behavior after this change:

- Uploading or downloading a large file should not freeze terminal input.
- SFTP directory refresh should not pause terminal input.
- Hardware/status sync should not pause terminal input.
- If an SFTP side connection times out, the transfer item fails/retries while the terminal remains usable.
- If the actual shell channel dies, the terminal still changes to disconnected/failed and prints a concise notice.

## Current Limits

This is a per-operation side session model. It is simple and isolates terminal responsiveness well, but it has overhead because each SFTP operation authenticates a new SSH connection.

Later optimization should add a dedicated SFTP worker per connected profile:

- one persistent SFTP side session,
- internal operation queue,
- configurable max parallel transfers,
- pause/resume/cancel backed by queue state,
- reconnect-and-resume after side session loss,
- credential-provider based re-authentication.

## Transfer Speed Notes

Observed SFTP speed can drop for three different reasons:

- protocol throughput: a sequential SFTP loop waits for each read/write path to progress instead of keeping many requests in flight;
- UI pressure: emitting a progress event for every small chunk can make the frontend and Tauri event bridge busy;
- connection churn: opening a fresh side SSH session for every operation adds handshake/auth overhead and prevents reuse of an already warm SFTP subsystem.

Reference behavior:

- OpenSSH `sftp` exposes `-B buffer_size` and `-R num_requests`; its manual states that larger buffers reduce round trips and that the default is `64` outstanding requests for concurrent SFTP operations.
- WinSCP exposes endurance settings for automatic resume/reconnect and distinguishes foreground sessions from background transfers.
- FileZilla uses a transfer queue model rather than tying file transfer progress to a single interactive shell loop.

Current Joyshell mitigation:

- SFTP transfer buffer increased from `64 KiB` to `128 KiB`.
- Frontend progress events are throttled to at most every `120ms` or every `1 MiB` of transferred data.
- Terminal and SFTP are still isolated through side SSH sessions.
- Transfer speed display uses a smoothed instantaneous rate when enough sample time has elapsed.
- If progress events arrive too quickly to form a stable sample window, the UI falls back to average rate from `bytes_done / elapsed_time` so high-speed transfers do not show `0 B/s` and unknown ETA.
- The rate sample baseline is not advanced until the sample window is large enough, preventing fast devices from repeatedly discarding useful byte deltas.

Next-stage speed work:

- persistent per-profile SFTP worker,
- global and per-host transfer concurrency limits,
- pipelined read/write requests where the SSH/SFTP library supports it,
- optional bandwidth limiter,
- adaptive progress refresh rate based on file size and measured throughput.
