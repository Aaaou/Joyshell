# SSH Health And System Sync

## Problem

The system monitor can fail while the interactive SSH terminal remains alive. These cases must stay separate:

- terminal or transport failure closes the session, clears latency, and prints a disconnect notice;
- monitor or SFTP side-operation failure retries that operation without destroying a healthy shell.

The former PTY-resize RTT probe was incorrect. SSH `window-change` requests explicitly do not require a reply, so the measured `1ms` was usually local packet submission rather than a server round trip.

## Source References

The implementation was checked against concrete upstream source:

- OpenSSH portable commit `7e446d3f5917c2f2770981a89d0e54d5d064bf0c`: `clientloop.c::server_alive_check()` sends `keepalive@openssh.com` with `want reply = 1`, counts missed replies, and exits after `ServerAliveCountMax`.
- libssh2 commit `a7d05f958f4c3414b534107076e8b0f88b233461`: `keepalive.c::libssh2_keepalive_send()` schedules and sends `keepalive@libssh2.org`, but does not expose OpenSSH-style missed-reply tracking to its caller.
- The same libssh2 commit: `channel.c::channel_setenv()` sends `SSH_MSG_CHANNEL_REQUEST` with `want_reply = 1` and waits for `CHANNEL_SUCCESS` or `CHANNEL_FAILURE`. Either response proves that the SSH peer replied.
- The same libssh2 file marks `window-change` with `Do not reply`; it cannot be used as an RTT probe.
- Tabby commit `14e2d60b9b6dee84a53c37f05eefeb803787de04`: `tabby-ssh/src/profiles.ts` defaults keepalive to `5000ms`; `tabby-ssh/src/session/ssh.ts` passes interval/count into the SSH runtime and destroys the session on `disconnect$`; `tabby-ssh/src/components/sshTab.component.ts` prints a concise `session closed` message.

Upstream links:

- <https://github.com/openssh/openssh-portable/blob/7e446d3f5917c2f2770981a89d0e54d5d064bf0c/clientloop.c>
- <https://github.com/libssh2/libssh2/blob/a7d05f958f4c3414b534107076e8b0f88b233461/src/keepalive.c>
- <https://github.com/libssh2/libssh2/blob/a7d05f958f4c3414b534107076e8b0f88b233461/src/channel.c>
- <https://github.com/Eugeny/tabby/tree/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-ssh/src>

## Joyshell Implementation

Backend behavior in `crates/joyshell-core/src/session.rs`:

- The interactive SSH worker starts one response-required health request every `5s`.
- ssh2/libssh2 does not expose an arbitrary OpenSSH global-request API, so Joyshell uses a harmless `channel.setenv("JOYSHELL_HEALTH_CHECK", "1")` request. Success and explicit denial both prove liveness; `EAGAIN` remains pending.
- The request is polled non-blockingly after terminal reads and writes. It does not execute a shell command and does not occupy an SFTP worker.
- A pending request has a `3s` deadline. Timeout or a fatal transport/channel error changes the session to `Failed`.
- Terminal EOF changes the session to `Disconnected`.
- The old PTY resize probe and the untracked `keepalive_send()` loop were removed.
- System sync keeps its independent `8s` command timeout and two attempts. A sync failure alone does not close SSH.
- SFTP and monitor sessions remain independent from the interactive terminal session.

Frontend behavior in `apps/desktop/src/app/JoyshellApp.tsx` and `features/terminal/use-terminal-runtime.ts`:

- `Failed` or `Disconnected` immediately sets latency to `--` and disables SSH-dependent controls.
- The terminal writes one deduplicated `[disconnected] ...` notice from the state event.
- System sync has an in-flight guard and shows `同步重试中 1/3` for transient failures.
- Successful sync resets the failure count and returns to `已同步`.

## Validation

- Unit test confirms libssh2 `CHANNEL_REQUEST_DENIED` is treated as a valid peer reply.
- A real SSH probe through `127.0.0.1:2222` remained interactive across more than two `5s` health intervals and executed a second command successfully.
- A stopped-server/tunnel test is still required before release to confirm the complete `5-8s` failure path in the packaged WebView.

## Reconnection Policy

Joyshell does not silently reconnect a dead interactive shell. A new SSH channel cannot restore the remote process, working directory, foreground application, or unsaved terminal state. A future opt-in mode should use:

- explicit `Reconnecting` state and terminal banner;
- bounded exponential backoff;
- a user-visible retry/cancel action;
- SFTP queue resume only for resumable items;
- audit entries for every reconnect attempt and result.
