# Windows Installer Upgrade And Data

## Why Two Upgrade Screens Appeared

The stock Tauri CLI 2.11.4 NSIS template treats two cases differently:

- Installing the same version selects `Add/Reinstall` first.
- Installing a newer version selects `Uninstall before installing` first.

That version comparison made normal releases look like different installer modes. The SQLite store was not responsible for the difference.

## Joyshell Behavior

Joyshell keeps a repository copy of the official Tauri CLI 2.11.4 NSIS template at `apps/desktop/src-tauri/windows/installer.nsi`. The local change swaps only the upgrade choices and their branch logic:

- `覆盖安装（保留用户数据）` is first and selected by default for upgrades.
- `卸载后安装` remains available as an explicit secondary choice.
- Same-version reinstall and downgrade safety behavior remain separate.

The template is configured through `bundle.windows.nsis.template` in `tauri.conf.json`. When upgrading the Tauri CLI, diff the local template against the matching upstream version before packaging.

## User Data Choice

Tauri already provides an uninstall-page application-data checkbox. Joyshell uses that control instead of a second message box:

- Label: `清除用户数据`
- Default: unchecked
- Unchecked: preserve SQLite, encrypted passwords, commands, themes, and layout settings
- Checked during a normal uninstall: remove current and known legacy Joyshell application-data directories
- Internal update uninstall: always preserve data

OpenSSL runtime DLL cleanup remains in `windows/openssl-dlls.nsh` and is independent from user-data retention.

## Verification

After building, inspect `target/release/nsis/x64/installer.nsi` and its generated language file:

- The upgrade branch assigns `dontUninstall` to the first radio button.
- Selecting the first upgrade option jumps to `reinst_done`.
- `un.ConfirmShow` does not set `BM_SETCHECK` on the data checkbox.
- `deleteAppData` resolves to `清除用户数据`.
- No pre-uninstall data-deletion `MessageBox` remains.
