# Joyshell v0.1.68 发布更新清单

发布日期：2026-08-30  
发布类型：Windows x64 安全连接与可靠传输技术预览版（Pre-release）

## 本次更新

- 将 SSH 主机密钥校验合并到唯一真实握手中，在用户认证、终端、SFTP 和系统监控启动前完成信任判断，删除预检连接造成的双握手。
- 主机信任确认改为结构化事件和一次性令牌，令牌绑定 Session、两分钟自动超时，并拒绝重复、过期和跨 Session 确认。
- 首次连接显示主机、端口、算法和 SHA-256 指纹；主机密钥变化时同时显示旧指纹和新指纹，只有明确更新信任后才继续连接。
- 新增已信任主机管理界面，支持查看主机、端口、算法、指纹并删除单条记录。
- 强化应用独立 `known_hosts` 的 Windows 原子替换流程，并兼容 OpenSSH 标准主机密钥算法名称、IPv4、IPv6、默认端口和非默认端口。
- 完整开放 Windows SSH Agent，支持检测代理状态、枚举密钥算法、指纹和注释，允许 Profile 绑定指定公钥指纹。
- 终端、SFTP、系统监控及自动重连统一使用 Profile 选择的 Agent 身份；代理不可用、无密钥和认证失败均返回明确错误。
- 敏感凭据优先写入 Windows Credential Manager，旧 AES-256-GCM 凭据在启动或读取时执行写入、回读校验、删除旧密文的安全迁移。
- 凭据状态现在区分“原生服务不可用”和“旧凭据等待迁移”，修复升级后错误显示本地加密回退的问题。
- 传输记录升级为持久化描述符，兼容读取 `v0.1.67` 数据，并保存方向、路径、断点、状态、重试次数和源/目标元数据。
- 上传和下载恢复前重新检查文件状态；检测到源文件变化、目标缩短、目标超出断点或修改时间异常时停止并进入冲突处理。
- 传输冲突提供“覆盖并重新开始”“从现有断点继续”“取消任务”三个并排选项，不再静默拼接文件。
- 暂停、继续、取消、重试、完成、失败和待处理状态统一由后端与数据库驱动，避免前端显示与真实任务状态不一致。
- 自动重连采用最多五次的有界指数退避；每次重连重新校验主机密钥和认证，并使用 Session generation 丢弃旧连接事件。
- 中断的 Queued、Running 和 Retrying 任务可在对应 Profile 恢复连接后重新绑定；已暂停和已取消任务不会被旧定时器重新启动。
- 保留终端最后输出，SFTP 和系统监控 side session 单独恢复，单个附属功能失败不会误报主终端断线。

## 验证记录

- `pnpm test`：通过，桌面端 16 项测试全部通过。
- `pnpm build`：通过。
- `pnpm --filter @joyshell/desktop typecheck`：通过。
- `cargo fmt --all -- --check`：通过。
- `cargo test --workspace`：通过，Core 14 项、Store 7 项、Desktop 3 项、Agent 2 项全部通过。
- `cargo check --workspace`：通过。
- `git diff --check`：通过。
- Windows Credential Manager 真实写入、回读、旧凭据迁移和测试凭据清理：通过。
- Windows OpenSSH Agent 密钥枚举和指纹读取：通过。
- `pnpm --filter @joyshell/desktop tauri build`：通过。
- Windows x64 NSIS/MSI 覆盖安装候选包：已生成并完成用户验收。
- 主机密钥确认、Agent 登录、自动重连、重启续传、传输冲突、暂停继续及升级数据保留：已完成 Windows 实际验证。

## 安装包校验

- `Joyshell_0.1.68_x64-setup.exe`  
  SHA-256：`835885F7A4FB335CCEF6DB9B3224000176BCDECB7FD6B88FD4101A75B965C030`
- `Joyshell_0.1.68_x64_en-US.msi`  
  SHA-256：`B2C640D238DF51BAEA9BFF6AF1F9BFECA2DD67565693C46C3F4BC73109F0AD55`

## 已知限制

- 本版本是 Windows x64 技术预览版，不宣称生产 Stable。
- Windows 安装包尚未进行商业代码签名，首次运行可能显示系统信誉提示。
- 当前 SSH 底层继续使用 `ssh2/libssh2`，构建时会出现第三方 OpenSSL 静态库缺少调试 PDB 的非阻塞警告，不影响发布包运行。
- macOS 和 Linux 保持跨平台代码结构，但本版本未完成两平台实机安装与回归，不宣称三平台 P0 验收完成。
- ProxyJump、端口转发、本地 Shell、Mosh、X11、RDP/VNC、终端搜索与高级 resize、SFTP 批量递归、插件市场和云同步不在本版本范围内。
- 应用使用独立的明文 `known_hosts` 文件，不读取或覆盖用户系统的 OpenSSH `~/.ssh/known_hosts`；hashed host 和主机证书留待后续兼容迭代。
