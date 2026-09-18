# boss-sdd

plan-sdd 技能的本机看板：一个常驻菜单栏的 macOS app，加一个 Go 写的 MCP server 供 agent 调用。
取代原来的 `~/.claude/skills/plan-sdd/scripts/board.py`（CLI 写入 + 只读 HTTP + 浏览器页面）。

仅支持 Apple 芯片的 Mac。

## 组成

| 目录 | 内容 |
| --- | --- |
| `Sources/BoardKit` | 数据模型、DAG 投影、SQLite 存储、HTTP 接口。无第三方依赖。 |
| `Sources/BossSDD` | SwiftUI app：菜单栏常驻 + 看板窗口。 |
| `mcp` | Go MCP server，stdio 传输，转发到 app 的本地 HTTP。 |
| `design` | 界面设计稿（HTML），用真实运行数据做的原型。 |
| `Tests/BoardKitTests` | 图算法与 Python 旧实现的逐字段平价测试、存储门禁、接口测试。 |

数据在 `~/.claude/plan-sdd/board.sqlite3`。首次启动会把旧的 `~/.claude/plan-sdd/runs/*.json`
导进来，**不删原文件**。

## 构建与安装

```bash
./Scripts/bundle.sh --install
```

编译 Swift app 与 Go MCP 二进制，组装 `BossSDD.app`（ad-hoc 签名），装到 `/Applications`。
MCP 二进制放在 `BossSDD.app/Contents/Resources/plan-sdd-mcp`，所以装 app 就等于装好了 agent 接口。

注册给 Claude Code：

```bash
claude mcp add --scope user plan-sdd /Applications/BossSDD.app/Contents/Resources/plan-sdd-mcp
```

## agent 怎么用

调 MCP 工具，参数是结构化 JSON，不经过 shell，标题和 detail 里的引号、`$`、换行都不用转义。

| 工具 | 用途 |
| --- | --- |
| `plan_board_status` | app 状态 + 本机已有运行；app 没跑会自动拉起 |
| `plan_create_run` | 新建运行 |
| `plan_update_run` | 改计划状态 / 摘要 |
| `plan_set_tasks` | 一次写入整张 DAG |
| `plan_set_task` | 单个任务增改 |
| `plan_graph` | 只读图投影 |
| `plan_get_run` | 全量任务 + 投影 |

每次写入都连带返回最新图投影（`valid` / `ready_task_ids` / `active` / `blocked`），
所以写完不需要再单独校验一次。

## 两条写入门禁

app 会拒绝这两种写入并回一个明确的错误，MCP 层不重复实现，也绕不过去：

1. 依赖未完成就把任务转 `running`。
2. 与 `running` / `review` 中的任务抢同一个 `exclusive_resource`。

`write_scope` 重叠和项目并发限制不由 app 管，仍由调度的主 agent 自己避开。

## 端口

app 在 `127.0.0.1:18888` 上监听，只服务 MCP server，agent 不直接调。
`BOSS_SDD_PORT` 可覆盖。端口被占用时窗口工具栏会直接显示原因，app 不会去抢。

接口只接受 `Content-Type: application/json` 的写请求，且拒绝任何带 `Origin` 头的请求，
所以浏览器里的网页碰不到它。

## 测试

```bash
swift test          # 图算法平价、存储门禁、HTTP 接口
cd mcp && go test ./...
```

图算法平价测试需要旧运行数据做对照，设 `BOARD_PARITY_DIR` 指向一个同时放着
旧 run JSON 和 `py_graphs.json`（Python `derive_graph` 的输出）的目录；不设则跳过。
