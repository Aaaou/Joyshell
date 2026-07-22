# Joyshell

Joyshell is a cross-platform SSH workspace prototype built with Tauri 2, React, xterm.js, and Rust. The first slice focuses on desktop SSH fundamentals while reserving the assistant, permission, memory, CLI, and MCP architecture.

## Current Status

- Desktop workspace UI is implemented for session navigation, terminal surface, SFTP queue, assistant preview, and audit display.
- Rust crates define SSH/session events, SFTP operations, profile storage, audit logging, memory storage, assistants, tool registry, and guarded permissions.
- SSH is currently a mock adapter behind `SessionManager`; the next milestone is replacing it with a real `russh` or `ssh2-rs/libssh2` implementation.
- Model provider and MCP integrations are typed extension points, not live network integrations yet.

## Run

The Codex desktop bundled Node runtime was used on this machine because Node is not installed on the system PATH.

```powershell
$env:PATH='C:\Users\EDY\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
& 'C:\Users\EDY\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' install
& 'C:\Users\EDY\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' dev
```

Open `http://127.0.0.1:5173`.

## Verify

```powershell
$env:PATH='C:\Users\EDY\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
& 'C:\Users\EDY\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' -r typecheck
& 'C:\Users\EDY\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' --filter @joyshell/desktop test
& 'C:\Users\EDY\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' --filter @joyshell/desktop build
```

Rust/Tauri verification requires installing Rust and Cargo on PATH:

```powershell
cargo check --workspace
```
