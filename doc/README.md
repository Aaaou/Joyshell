# Joyshell 开发文档

本目录按组件记录实现边界、开发难点、成熟参考、采用方案、验证方法和剩余风险。内容以仓库实际代码和 Git 提交为准。

## 总览

- [开发历程与问题记录](development-history.md)
- [SSH 技术选型调研](../docs/research-ssh-client-tech-selection.md)
- [总体实现状态](../docs/implementation-notes.md)

## SSH 与终端

- [Terminal SSH Interaction](components/terminal-ssh-interaction.md)
- [SSH Health And System Sync](components/ssh-health-and-sync.md)
- [SSH Private Key Authentication](components/ssh-private-key-authentication.md)
- [Remote System Monitoring](components/remote-system-monitoring.md)

## SFTP 与传输

- [SFTP File Browser](components/sftp-file-browser.md)
- [SFTP Resume And Retry](components/sftp-resume-retry.md)
- [SFTP And Terminal Concurrency](components/sftp-terminal-concurrency.md)

## 桌面前端

- [Frontend Conservative Decoupling](components/frontend-decoupling.md)
- [Desktop Chrome And Unified Gradient](components/desktop-chrome-and-gradient.md)
- [Startup Splash](components/startup-splash.md)

## 数据与资源

- [Local SQLite Profile Store](components/local-sqlite-profile-store.md)
- [Windows Installer Upgrade And Data](components/windows-installer-upgrade-and-data.md)
- [Icon Assets Attribution](components/icon-assets-attribution.md)
- [Font Assets Attribution](components/font-assets-attribution.md)

## 文档维护规则

1. “已实现”和“规划”必须分开描述。
2. 引用源码时使用当前仓库相对路径。
3. 记录参考项目的名称和链接，但不声称复制其代码。
4. 测试命令只使用占位主机和占位凭据。
5. 每次修复重大兼容性/并发/数据安全问题后更新对应组件文档。
6. 发布前检查素材许可证、已知限制和最新安装包版本。
