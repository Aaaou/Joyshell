# Remote System Monitoring

## Component Scope

This component provides FinalShell/MobaXterm-like remote hardware and system information for an active SSH session.

It currently displays:

- host name, OS, kernel, architecture, primary IP
- CPU model and logical core count
- CPU usage
- memory usage
- swap usage
- load average
- uptime
- process and thread summary
- network receive/transmit rate
- network interface packets, errors, and IPv4 addresses
- filesystem capacity and usage
- filesystem type and inode usage

Main files:

- `crates/joyshell-core/src/session.rs`
- `crates/joyshell-core/examples/system_probe.rs`
- `apps/desktop/src-tauri/src/lib.rs`
- `apps/desktop/src/bridge.ts`
- `apps/desktop/src/types.ts`
- `apps/desktop/src/ui/App.tsx`
- `apps/desktop/src/styles.css`

## Mature References

The collection model follows common Linux monitoring tools:

- Glances / psutil: CPU, memory, swap, network, disk, load, uptime
- Netdata Linux collectors: `/proc` and filesystem based sampling
- Linux `free`, `top`, `uptime`, `df`: stable user-facing metric semantics

Reference interfaces:

- `/proc/stat`: CPU jiffies
- `/proc/meminfo`: memory and swap
- `/proc/loadavg`: load averages
- `/proc/uptime`: uptime
- `/proc/net/dev`: network interface bytes
- `/proc/cpuinfo`: CPU model and core metadata
- `ip -o -4 addr show`: interface IPv4 addresses
- `ps`: process and thread state summary
- `df -kPT`: filesystem capacity and filesystem type
- `df -iP`: inode capacity

External references checked:

- psutil Linux backend: https://github.com/giampaolo/psutil/blob/master/psutil/_pslinux.py
- Glances CPU plugin: https://github.com/nicolargo/glances/blob/develop/glances/plugins/cpu/__init__.py
- Netdata proc collector: https://github.com/netdata/netdata/blob/master/src/collectors/proc.plugin/plugin_proc.c
- Linux `/proc/stat` manual: https://man7.org/linux/man-pages/man5/proc_stat.5.html
- Linux `/proc/meminfo` manual: https://man7.org/linux/man-pages/man5/proc_meminfo.5.html
- Linux `/proc/loadavg` manual: https://man7.org/linux/man-pages/man5/proc_loadavg.5.html

## Design

The frontend does not inject monitoring commands into the visible terminal.

Instead:

1. The active SSH worker receives a `CollectSystem` control message.
2. The worker opens a separate SSH exec channel.
3. The exec channel reads `/proc` and `df` data.
4. Rust parses the raw output into a structured `SystemSnapshot`.
5. Tauri exposes `collect_system_snapshot`.
6. React polls the active connected session every 2 seconds.
7. React derives CPU percentage and network throughput from snapshot deltas.

This keeps monitoring independent from the user terminal channel.

## Snapshot Fields

`SystemSnapshot` includes:

- `captured_at`
- `host.hostname/os_name/kernel_name/kernel_release/architecture/primary_ip`
- `uptime_seconds`
- `load.one/five/fifteen/runnable_processes/total_processes/last_pid`
- raw `cpu` jiffies
- `cpu_cores[]` raw per-core jiffies
- `cpu_info.model_name/logical_cores/physical_cores/mhz`
- `memory.total/used/free/available`
- `swap.total/used/free/available`
- `processes.total/running/sleeping/stopped/zombie/threads`
- network interface `rx_bytes/tx_bytes/rx_packets/tx_packets/rx_errors/tx_errors/ipv4_addresses`
- filesystem `fs_type/total/used/available/used_percent/inode_*`

## Derived Frontend Metrics

CPU percentage:

```text
cpu% = (total_delta - idle_delta) / total_delta * 100
```

Memory percentage:

```text
used = MemTotal - MemAvailable
```

Network speed:

```text
rate = (current_bytes - previous_bytes) / elapsed_seconds
```

Loopback interface `lo` is excluded from aggregate network rates.

The UI now includes:

- a compact left status card for quick CPU/memory/disk/network state
- a lower system monitor band inspired by FinalShell/MobaXterm resource panels
- a filesystem table that shows mount point, available/total, usage, filesystem type, inode usage, and device

## Implementation Notes

- The monitor command uses explicit section markers such as `__JOYSHELL_STAT__` and `__JOYSHELL_DF__`; this avoids fragile positional parsing across mixed command output.
- Host information parsing must ignore the blank line immediately after each section marker, otherwise hostname/OS/kernel fields shift by one line.
- CPU percentage is not read directly from Linux. It is derived from two `/proc/stat` samples, matching mature monitor behavior.
- Memory usage follows the `free`/psutil style: `used = MemTotal - MemAvailable`, not `MemTotal - MemFree`.
- Filesystem capacity uses `df -kPT` when available so filesystem type is included; it falls back to `df -kP`.
- inode usage is collected separately with `df -iP` and joined by mount point.
- Monitoring currently opens a blocking exec channel inside the SSH worker. If sampling ever causes terminal latency, move monitoring to a dedicated SSH connection or non-blocking exec loop.

## Verification

Run against the Cloudflare tunnel endpoint:

```powershell
$env:OPENSSL_DIR='D:\miniconda3\Library'
$env:JOYSHELL_SSH_HOST='127.0.0.1'
$env:JOYSHELL_SSH_USER='root'
$env:JOYSHELL_SSH_PASSWORD='yujiarong520'
$env:JOYSHELL_SSH_PORT='2222'
C:\Users\EDY\.cargo\bin\cargo.exe run -p joyshell-core --example system_probe
```

Run against the LAN test host:

```powershell
$env:OPENSSL_DIR='D:\miniconda3\Library'
$env:JOYSHELL_SSH_HOST='192.168.110.24'
$env:JOYSHELL_SSH_USER='root'
$env:JOYSHELL_SSH_PASSWORD='yujiarong520'
$env:JOYSHELL_SSH_PORT='22'
C:\Users\EDY\.cargo\bin\cargo.exe run -p joyshell-core --example system_probe
```

Expected output includes:

- `host=... os=... kernel=... arch=... ip=...`
- `load=...`
- `cpu cores=... model=...`
- `uptime=...`
- `memory used=... total=...`
- `processes total=... running=... threads=...`
- `net ... rx=... tx=... errors=...`
- `network_ifaces=...`
- `filesystems=...`
- filesystem rows such as `/`, `/boot/efi`, `/tmp`, `/run` with `type` and `inode`

## Follow-up Work

1. Move monitor exec to a non-blocking channel loop if sampling ever causes visible terminal latency.
2. Add per-interface chart history and selectable NIC.
3. Add per-core CPU bars using `cpu_cores[]` deltas.
4. Add process list and top processes.
5. Add disk I/O throughput from `/proc/diskstats`.
6. Add platform adapters for macOS/BSD remote hosts.
7. Add user-configurable sampling interval.
8. Add explicit monitoring permission/audit integration for the agent system.
