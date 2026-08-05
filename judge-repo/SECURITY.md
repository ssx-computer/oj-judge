# 评测安全模型（Sandbox & Security Model）

本仓库是 OJ 系统的评测执行端（由 `backend` 通过 GitHub API 推送提交触发）。
用户提交的代码属于**完全不可信输入**，必须在受控沙箱中编译和运行。

## 威胁模型

用户反馈过的真实攻击场景，全部被本方案覆盖：

| 攻击 | 之前的风险 | 现在的防线 |
|------|-----------|-----------|
| 代码访问网络（外传/挖矿/外连） | runner 宿主有完整外网，`curl`/`socket` 可直接用 | `--network none` 容器零网络 + 静态检测拦截 socket/http/requests/urllib 等 |
| 直接读取测试点 | `judge_data.json`（含全部输入+期望输出）明文在工作目录 | 判题数据移到 `$HOME/judge_meta/`（容器不挂载）；只读挂载测试**输入**；**期望输出永不出宿主机**，比对在容器退出后进行 |
| 杀死评测进程 / fork 炸弹 | 用户代码与评测脚本同宿主，`kill -9 $PPID` 即可 | 容器 PID namespace 隔离——容器内只能杀容器内进程；`--pids-limit 64` 限进程数 |
| 读取 GitHub token / secrets | 环境变量对用户代码可见 | 容器不继承 runner 环境变量（`--env` 未传任何 secret） |
| 写宿主文件系统 / 提权 | 用户代码以 runner 用户运行 | `--read-only` 根文件系统 + `--user 65534` + `--cap-drop ALL` + `--no-new-privileges` + 默认 seccomp |
| 内存/CPU 滥用 | `ulimit` 是软限制可绕过 | cgroup 硬限制 `--memory/--cpus`，超限 OOM kill（退出码 137 → `memory_limit_exceeded`） |

## 三层防线

1. **静态检测**（`scripts/check_security.py`）——**默认开启**（`SECURITY_SCAN=1`）：
   命中危险调用（`os.system`/`subprocess`/`socket`/`eval`/`fork`/敏感路径读取等）的
   提交不进入评测，直接以 `security_blocked` 状态回调，前端显示"危险指令"。
   关键字黑名单可被 `#define`、字符串拼接等方式绕过，因此它只是前置标记层，
   **不是安全边界**——容器沙箱才是真正的安全边界（fail-closed：扫描器异常则拒绝评测）。
   覆盖语言与规则见脚本头注释。

2. **Docker 硬隔离**（`scripts/judge.sh` + `scripts/run_inner.sh`）——编译与运行都在容器内：
   ```
   --network none --memory <mem>m --memory-swap <mem>m --cpus 1 --pids-limit 64
   --cap-drop ALL --security-opt no-new-privileges --security-opt seccomp=default
   --user 65534:65534 --read-only --tmpfs /tmp:rw,size=128m
   ```
   镜像按语言选择官方镜像：`python:3.12-slim` / `gcc:13` / `eclipse-temurin:21-jdk` / `node:22-bookworm-slim` / `golang:1.24-bookworm` / `rust:1-bookworm`。
   单用例墙钟超时用容器内 `timeout -s KILL`，整体超时用外层 `timeout` 兜底。

3. **数据隔离**：
   - `judge.yml` 把 `judge_data.json` 下载到 `$HOME/judge_meta/`（workspace 之外，容器不挂载）。
   - `judge.sh` 在宿主机解析判题数据；只把测试**输入**以只读卷挂进容器。
   - 期望输出只在宿主机内存/文件中，容器退出后才比对。
   - SPJ 代码（管理员编写）也在独立沙箱容器中运行，同样禁网限资源。

## 失败安全策略

- Docker 不可用 / 镜像拉取失败 → 返回 `system_error`，**绝不降级为裸机运行**不可信代码。
- 任何异常（无元数据、扫描器异常、SPJ 失败）都以明确状态回调 `backend`，不吞错误。

## 编译与运行资源上限

| 阶段 | 限制 |
|------|------|
| 编译 | `COMPILE_TIMEOUT`（默认 60s），容器内 `timeout -s KILL`，超时判 `compile_error`；SPJ 编译同样受控 |
| 运行（单用例） | 容器内 `timeout -s KILL`（题目时间限制 +1s 余量） |
| 运行（整体） | 外层 `timeout` 兜底：`TL×N + 300s`，超时判 `time_limit_exceeded` |
| 内存 | cgroup `--memory` 硬限制（题目限制 +512MB 编译余量），OOM kill → `memory_limit_exceeded` |
| 进程数 | `--pids-limit 64`（防 fork 炸弹） |
| CPU | `--cpus 1` |

## 滥用防护（backend 侧）

| 环节 | 防护 |
|------|------|
| 提交 | `rateLimitMiddleware`：60s/10 次/用户，fail-closed；提交需过验证码 |
| 注册 | 验证码 + 5min/10 次/IP 限流 + 注册开关 + 邮箱后缀限制 |
| 登录 | 验证码 + 5min/10 次/IP 限流 |
| 邮箱验证码 | IP 限流（2min/3 次）+ **邮箱维度 60s 冷却**（防换 IP 轰炸同一邮箱） |
| 密码重置 | 3~5 次/5min/IP 限流 |
| 源码大小 | `validateSourceCode` 上限 65535 字符 |

## 说明与限制

- 沙箱共享宿主内核，极端情况下内核漏洞可越界——如需更强隔离（VM 级），长期可将评测引擎切换为独立部署的 [Judge0 CE](https://github.com/judge0/judge0)（基于 IOI 官方 isolate + Docker + seccomp），通过 REST API + webhook 接入，本 OJ 的提交/回调契约保持不变。
- Docker Hub 匿名拉取有限流风险，评测量大时建议在 workflow 中加入 `docker/login-action` 认证。
