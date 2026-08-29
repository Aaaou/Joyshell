# Joyshell v0.1.56 发布更新清单

发布日期：2026-08-29
发布类型：Windows x64 开发预览版（Standard）

## 本次更新

- 增加网络工具文件夹与“内网设备扫描”子功能，默认不展示设备结果。
- 内网设备扫描支持本机网段主动探测、ARP/邻居表合并和后台并发执行。
- 过滤组播、广播、回环和链路本地地址，并保留本机 IP，标注为“本机”。
- 设备结果按 IP 数值排序，保留历史设备并显示在线/离线状态。
- 增加 MAC OUI 厂商和设备类型线索识别，覆盖树莓派、瑞芯微、中兴、乐鑫、Imilab、Apple、Samsung、Intel、Dell、Lenovo、Huawei、TP-Link、VMware、Google、ASUS 等常见标识。
- 设备条目支持详情聚焦视图，完整展示设备名称、IP、MAC、厂商/类型、在线状态和网卡接口。
- SFTP 上传/下载速度刷新间隔调整为 2.5 秒，降低数字滚动频率和视觉晃动。
- 终端事件批量同步、序列游标和 SSH 健康失败计数逻辑完成收敛，降低高频输出下的丢事件风险。

## 验证记录

- `pnpm test`：通过。
- `pnpm build`：通过。
- `cargo check --workspace`：通过。
- `pnpm --filter @joyshell/desktop typecheck`：通过。
- `pnpm --filter @joyshell/desktop tauri build`：通过。
- Windows x64 NSIS/MSI 安装包：已生成并完成安装验证。

## 产物

- `target/release/bundle/nsis/Joyshell_0.1.56_x64-setup.exe`
- `target/release/bundle/msi/Joyshell_0.1.56_x64_en-US.msi`

## 已知限制

- 设备类型属于基于 MAC OUI、主机名和网络线索的“大致推测”，不等同于精确芯片型号。
- 未开放 SSH、SNMP、HTTP 等管理接口的设备无法读取操作系统和芯片详情。
- 主动扫描当前按本机 IPv4 `/24` 网段执行，复杂 VLAN、非 IPv4 网段和跨路由网段不在本次范围内。
- P0 发布门槛中的 known_hosts 严格校验、SSH Agent、系统密钥链、持久化传输队列和三平台回归尚未完成。
- 因此本版本定位为开发预览版，不宣称生产就绪。
