# boss-sdd 收口加固

## 背景

看板 app、Go MCP server 和技能改写已在上一轮做完并实跑验证（9 个 Swift 测试 + 4 个 Go 测试通过，
MCP stdio 全链路跑通，两条写入门禁实测拒绝）。本轮处理三件上一轮留下的实缺口，不扩大范围。

`~/.claude/plans/witty-napping-diffie.md` 是上一轮已批准的计划，本文件只接它的尾巴。

## 目标

- MCP 在端口被非看板进程占用时，给 agent 一条能照着做的错误，而不是透传 HTTP 码。
- 补上已批准计划里承诺过但没写的 `StoreTests`，以及旧 JSON 导入的测试。
- 决定 `plan_set_tasks` 的原子性并落实。

## 非目标

- 不做应用图标、窗口状态持久化、开机自启验证——都列进「待用户拍板」。
- 不动 `~/.claude/skills/plan-sdd/scripts/board.py`，按上一轮计划它还要留一周。
- 不推送、不开 PR、不部署。

## 已定的设计决策

- 看板 app 是唯一写入方，MCP 层不重复实现任何调度不变量。
- 存储仍是 `~/.claude/plan-sdd/board.sqlite3`，旧 JSON 只读不删。
- 仅支持 Apple 芯片 Mac。

## Tasks

### T0 基线提交与 .gitignore

- `depends_on`: []
- `write_scope`: `.gitignore`
- `exclusive_resources`: `["git-index"]`
- role: 主 agent 亲自做（需用户授权动 git）
- 验收: `git log --oneline` 有一条基线提交；`git status --porcelain` 不再列出 `.build/`
- 风险: 这是后面所有 `git diff` 自审和 `branch-review.js` 的 `baseRef` 起点，必须先落。

### T1 MCP 端口占用诊断

- `depends_on`: `["T0"]`
- `write_scope`: `mcp/client.go`, `mcp/client_test.go`
- `exclusive_resources`: `["gate:go-test"]`
- role: engineer
- 现象（实测）：18866 被旧 `board.py` 占着时，`plan_board_status` 回 `看板返回 HTTP 404`。
- 要求: 请求打到端口但对方不是看板时（`/api/health` 非 2xx，或 2xx 但 body 不含 `ok`/`version`），
  错误要指明「端口 N 上是别的服务，不是看板」并给出可执行的下一步。连接被拒仍走现有的拉起重试。
- 验收: `cd mcp && go test ./...`；并在 18866 仍被占用的真实状态下复跑 `plan_board_status`，
  贴出 agent 看到的新错误原文。

### T2 Store 与旧数据导入的直接单测

- `depends_on`: `["T0"]`
- `write_scope`: `Tests/BoardKitTests/StoreTests.swift`, `Tests/BoardKitTests/LegacyImportTests.swift`
- `exclusive_resources`: `["gate:swift-test"]`
- role: engineer
- 要覆盖: 事件截断到 `eventHistoryLimit`（200）；两条写入门禁在 Store 层直测（现在只经 HTTP 测过）；
  列表字段 keep/replace/clear 在 Store 层直测；`LegacyImport.parseRun` 对缺字段、坏状态、
  非对象 task 的容忍；`importAll` 对坏文件跳过而不中断。
- 验收: `swift test`
- 风险: 测试要用临时目录建 Store，不得碰 `~/.claude/plan-sdd/board.sqlite3`。

### T3 plan_set_tasks 原子化

- `depends_on`: `["T0"]`
- `write_scope`: `Sources/BoardKit/Store.swift`, `Sources/BoardKit/API.swift`,
  `Tests/BoardKitTests/APITests.swift`, `mcp/main.go`
- `exclusive_resources`: `["gate:swift-test", "gate:go-test"]`
- role: engineer `[complexity: high]`
- 现状: MCP 逐条 PUT，某条被拒时前面的已经落库，留下一张半截 DAG（表现为 unknown_dependency，
  图判定 invalid）。可见、可恢复，但不该发生。
- 要求: Swift 侧加一个批量写入端点，在单个事务里写完全部 task，任一条不合法则整批回滚；
  MCP 的 `plan_set_tasks` 改调它，返回值形状不变（`written` / `failed` / `graph`）。
- 验收: `swift test`；`cd mcp && go test ./...`；新增一条接口测试证明「批中一条非法时整批不落库」。

注：T1 与 T2 无写入范围重叠、无共享资源，可同批并行。T3 与两者都共享门禁资源，
因此虽无依赖边，也只能等它们释放——这由看板的资源投影自动拦，不用画成边。

## 风险与未决项

- 本轮无法用看板追踪：18866 被占 + MCP 工具本会话未加载。状态落在本文件里，
  端口收掉并重启 Claude Code 后再补录。
- `branch-review.js` 的 `baseRef` 用 T0 那条基线提交。

## 待用户拍板

1. 旧 `board.py serve`（PID 88040）什么时候收掉——收掉前看板写入接口一直是停的。
2. 应用图标：现在是系统默认图标。
3. 开机自启：`SMAppService.mainApp.register()` 在 ad-hoc 签名下能否真注册，没验证过。
4. 选中的运行不持久化，重启 app 回到列表第一个。
5. `scripts/board.py` 的最终删除时机（上一轮计划定的是跑顺一周后）。

## 门禁

- `swift test`（在仓库根）
- `cd mcp && go test ./...`
- `./Scripts/bundle.sh` 能出包
