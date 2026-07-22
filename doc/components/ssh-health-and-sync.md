# SSH Health And System Sync

## Problem

The system monitor could show occasional sync failures while the interactive terminal still stayed alive. This made the UI ambiguous:

- if the real SSH shell is disconnected, the terminal should visibly close and the session state should become disconnected or failed;
- if only the side-band system monitor command fails, the terminal should stay connected and the monitor should retry without clearing the whole session.

## Reference Behavior

Mature SSH clients separate connection health from auxiliary jobs:

- OpenSSH `ServerAliveInterval` / `ServerAliveCountMax` style behavior treats connection death as a result of repeated failed probes, not one transient command failure.
- WinSCP exposes keepalive and reconnect behavior for long-running sessions/transfers.
- FileZilla keeps transfers as queue items and retries or resumes them independently of individual operation failures.

The useful UX rule is: terminal channel failure is session failure; monitor/SFTP side operation failure is an operation failure first.

## Joyshell Implementation

Backend changes in `crates/joyshell-core/src/session.rs`:

- SSH keepalive is enabled through libssh2 with a `20s` interval.
- The worker periodically calls `keepalive_send`; libssh2 decides when a packet is actually needed.
- Keepalive is enabled only after handshake, authentication, PTY allocation, and shell startup are complete.
- System sync uses a dedicated timeout:
  - command timeout: `8s`
  - reply wait timeout: `18s`
  - attempts: `2`
- System sync retry does not mark the SSH session failed.
- Terminal EOF now emits `Disconnected` and writes `[remote shell closed]` to the terminal.
- Fatal terminal read/write/flush failure sets session state to `Failed` and drops the runtime SSH handle.
- Fatal side-channel errors such as `Unable to startup channel`, `Session(-21)`, channel open failure, or socket disconnect now mark the whole SSH session as `Failed`, append a short terminal notice, and stop the SSH worker.

Frontend changes in `apps/desktop/src/ui/App.tsx`:

- System sync has an in-flight guard so a slow sync cannot stack multiple monitor commands.
- Consecutive monitor failures are counted.
- The UI shows `同步重试中 1/3` for transient monitor failures while keeping the last known snapshot visible.
- Successful sync resets the failure count and returns to `已同步`.
- SSH/SFTP/monitor controls treat only `Connected` as an active interactive session. `Failed` and `Disconnected` immediately disable side operations.

## Current Limits

This does not yet implement full automatic SSH reconnection for an already dead terminal session. The next stage should add:

- profile-bound reconnect worker,
- terminal reconnection banner,
- optional auto-reconnect policy per session,
- SFTP queue resume after reconnect,
- audit entries for reconnect attempts and results.
