# Joyshell Implementation Notes

This repository now contains the first implementation slice of the Joyshell plan.

## What Is Implemented

- Tauri 2 desktop shell scaffold for Windows, macOS, and Linux packaging.
- React/Vite workspace UI with session navigation, xterm.js terminal surface, SFTP queue placeholder, assistant panel, and audit panel.
- Rust workspace crates for SSH/session core, local store, and guarded assistant runtime.
- Agent model with one general assistant and constrained Explore/SFTP/Ops assistants.
- Permission engine with `Allow`, `Deny`, and `Ask` decisions, safe-command allowlist, assistant tool allowlists, and audit hooks.
- Memory store with short/session/user/project scopes and basic secret-like content rejection.

## Important Boundaries

- SSH/SFTP is currently represented by a mock adapter behind `SessionManager`.
- Real SSH should be added behind the existing session interface using either `russh` or `ssh2-rs/libssh2`.
- The model provider abstraction is typed but does not call a model yet.
- MCP is represented as a reserved tool name and must use the same permission path when implemented.

## Next Implementation Step

Replace `SessionManager::connect_mock` and `write_terminal` internals with a real SSH adapter while keeping the existing Tauri commands and front-end event contract stable.
