# SFTP Resume And Retry

## Problem

Large SFTP transfers can fail when the SSH socket has no readable/writable progress before the session timeout. The observed case was a 36 MB wheel download failing with:

```text
Failed: ssh connection failed: Timed out waiting on socket
```

The previous implementation streamed a file once from offset `0`. If any `read` or `write` call failed, the whole transfer failed and the UI could show `0B/...` again.

## Reference Behavior

Mature file transfer clients generally split connection timeout from transfer progress timeout and support resuming interrupted transfers:

- WinSCP documents resume/transfer continuation for SFTP and FTP workflows.
- FileZilla keeps transfers in a queue and can resume interrupted transfers when the target protocol/server supports it.
- lftp exposes retry/no-progress timeout controls and explicit resume commands such as `reget`/`reput`.

The common pattern is:

1. Keep a transfer queue item with a stable id.
2. Track current transferred bytes.
3. On transient socket failure, reopen the file handle.
4. Seek local and remote handles to the already completed offset.
5. Retry with bounded attempts/backoff.
6. Preserve cancellation as a user-controlled hard stop.

## Joyshell Initial Implementation

Implemented in `crates/joyshell-core/src/session.rs`:

- SSH connect timeout remains `15s`.
- Normal SSH operation timeout remains `15s`.
- SFTP transfer timeout is separated as `60s`.
- SFTP transfer retry limit is `4` attempts.
- Retry backoff is `900ms * (attempt - 1)`.
- Transfer chunk size remains `64 KiB`.

Download resume:

- Uses the current local file length as `resume_offset`.
- Reopens the remote file through SFTP.
- Seeks both local and remote handles to `resume_offset`.
- Continues writing to the existing local file.
- If the local file is larger than the remote file, truncates and restarts from `0`.

Upload resume:

- Uses the current remote file length as `resume_offset`.
- Opens the local file and seeks to `resume_offset`.
- Opens the remote file in write/create mode and seeks to `resume_offset`.
- Continues writing without truncating the already uploaded prefix.
- If the remote file is larger than the local file, restarts from `0`.

UI state:

- `TransferStatus::Retrying { attempt, max_attempts, reason }` is emitted before retrying.
- The frontend treats `Retrying` as active, so cancel still works.
- Failed state preserves the latest known byte count instead of resetting to `0B`.

## Current Limits

This is resume-within-current-session. If the underlying SSH session becomes unusable, retries may still fail. A later queue worker should support full reconnect-and-resume:

- store transfer descriptors durably,
- reconnect SSH/SFTP with the saved profile,
- verify remote/local size and optional checksum,
- continue from offset after reconnection,
- expose pause/resume controls in the UI.

Also, offset resume assumes the partial local/remote file belongs to the same source file. Mature clients often prompt before overwrite/resume when metadata does not match; Joyshell should add that confirmation before public release.
