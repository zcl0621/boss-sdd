# boss-sdd：加固 + 可移植技能发布

## 背景

上一轮做完了看板 app、Go MCP server 和本机技能改写，仓库已推到
https://github.com/zcl0621/boss-sdd （public）。本轮两件事：收掉上一轮留的三个实缺口，
并把 plan-sdd 做成一个能在 **Claude Code / Codex / Cursor** 三家跑的可移植技能随仓库发布。

上一轮已批准的计划在 `~/.claude/plans/witty-napping-diffie.md`。

## 目标

- MCP 在端口被非看板进程占用时给出能照做的错误。
- 补上承诺过的 Store / 旧数据导入测试。
- `plan_set_tasks` 改成单事务。
- 发布一份全英文、三平台的技能：DAG + spec + TDD + 多角色 subagent + goal 模式 +
  code review + 门禁的聚合体。
- 看板按 project 维度记忆可复用的勘察结论，让下一轮不必从零重学门禁和启动方式。
- README 说清楚三家怎么装，并提示使用者按自己的订阅调整各角色模型。

## 非目标

- 不做应用图标、窗口状态持久化、开机自启验证。
- 不动 `~/.claude/skills/plan-sdd/scripts/board.py`。
- 不把本机私有数据发到公开仓库（设计稿的真实基础设施数据已换成合成数据）。

## 已定的设计决策

- 默认端口 18866 → **18888**：18866 上长期挂着已退役的 Python 看板，换端口比抢端口干净。
- 技能三个平台共用同一份 SKILL.md 正文与 references，差异只落在：
  frontmatter 扩展字段、subagent 派发机制、模型 ID、MCP 注册方式。
- 可移植版不依赖 Claude Code 独有的 `Workflow` 工具；勘察与复核统一表达成角色化 subagent 扇出。
  Claude Code 变体可以额外说明用 `Workflow` 并行更省事，但不作为前提。
- 每个 subagent 就是一个角色，角色有自己的身份、输入契约、交付契约和模型档位。
- **阶段 3 走"原生复核器优先 + 交接门禁"**：三家都自带一个跑在本地分支上的复核器
  （`/code-review`、`/review`、`/review-bugbot`），比自己派 subagent 复核更专。但这三个
  都是**用户敲的斜杠命令，agent 启动不了**（Claude Code 这条我的运行环境写明了
  user-triggered and billed、不许绕道调用）。所以技能把它表达成交接：主 agent 备好分支 →
  提示用户敲命令 → 用户贴回结论 → 技能用 adversarial-verifier 逐条反证分诊。
  技能自带的多角色分支复核保留为不依赖人工按键的那条路，两条并存不互斥。

### 平台事实（已查证，非凭记忆）

| | Claude Code | Codex | Cursor |
|---|---|---|---|
| 技能位置 | `~/.claude/skills/<name>/` | `.agents/skills/<name>/`、`$HOME/.agents/skills/` | 项目级 `.agents/skills/`、`.cursor/skills/`；用户级 `~/.agents/skills/`、`~/.cursor/skills/`；兼容读 `.claude/skills/`、`.codex/skills/`、`~/.claude/skills/`、`~/.codex/skills/`；仓库内任意位置的 `.cursor/skills/` 也会被发现（monorepo） |
| 同名**技能**优先级 | — | — | **官方文档未规定**——早先写的「`.cursor/` 冲突时优先」是我编的，已推翻。注意：subagent 有规定，技能没有，两者别混 |
| Cursor subagent 目录 | — | — | 项目级 `.cursor/agents/`、`.claude/agents/`、`.codex/agents/`；用户级 `~/.cursor/agents/`、`~/.claude/agents/`、`~/.codex/agents/` |
| 同名 **subagent** 优先级 | — | — | **有规定**："Project subagents take precedence when names conflict. When multiple locations contain subagents with the same name, `.cursor/` takes precedence over `.claude/` or `.codex/`." |
| Cursor `readonly` 语义 | — | — | 布尔，默认 `false`。"If `true`, the subagent runs with restricted write permissions (no file edits, no state-changing shell commands)."——**限的是写和会改状态的命令，只读命令（`git log`/`git blame`/`grep`）不受限** |
| Cursor `is_background` | — | — | 布尔，默认 `false` |
| Cursor SKILL.md frontmatter | — | — | `name`（必须匹配父文件夹名）、`description`、`paths`、`disable-model-invocation`、`icon`、`color`、`metadata`；`globs` 作为旧拼法仍被接受但新技能应用 `paths` |
| Cursor 技能显式调用 | — | — | 在 Agent chat 里键入 `/` 并搜索技能名 |
| 显式调用 | `/name` | `$name` | `/name` |
| 角色定义 | `.claude/agents/<n>.md`，`Agent` 工具带 `model` | `config.toml` 的 `[agents.<n>]`，**只接受两个键**：`config_file`（"Path to a TOML config layer for that role"）、`description` | `.cursor/agents/<n>.md`，frontmatter 为 `name` / `description` / `model` / `readonly` / `is_background` |
| Codex 配置位置 | — | 用户级 `~/.codex/config.toml`；项目级 `.codex/config.toml`（需信任该项目） | — |
| Codex agents 全局键 | — | `agents.enabled`、`agents.interrupt_message`、`agents.max_concurrent_threads_per_session`、`agents.max_threads`（旧别名）、`agents.default_subagent_model`、`agents.default_subagent_reasoning_effort` —— **这六个都是全局，不是逐角色** | — |
| Codex reasoning effort 取值 | — | `minimal` / `low` / `medium` / `high` / `xhigh`（`xhigh` 依模型而定） | — |
| Codex review_model | — | "Optional model override used by `/review` (defaults to the current session model)" | — |
| 模型写法 | `opus` / `sonnet` / `haiku` / `fable` | `gpt-5.6`，另有 `default_subagent_reasoning_effort`、`default_subagent_model` | `inherit`、`composer-2`、`composer-2.5`、`gpt-5.6-sol`、`claude-opus-5`；括号参数 `fast` / `effort` / `context`，例 `claude-opus-5[effort=high,context=300k]`、`composer-2.5[]`（空括号形式文档有例） |
| frontmatter 扩展 | `allowed-tools`、`argument-hint` | 仅 name/description | `paths`（glob 限定） |
| 原生分支复核 | `/code-review`（当前分支）；`/code-review ultra <PR#>` 走云端多 agent | `/review` → Review uncommitted changes / 对 base 分支；`review_model` 单独配模型 | `/review-bugbot`（相对 base 的全部改动，含未提交）；`/review` 同义 |
| 原生 PR 复核 | `/code-review ultra <PR#>` | GitHub 集成，`@codex review`，读 `AGENTS.md` 里的 Code Review rules | PR 评论 `bugbot run` / `cursor review` |
| 复核规则文件 | — | `AGENTS.md` 里的 `## Code Review Rules` 小节 | `.cursor/BUGBOT.md`（根目录那份总是加载，再沿变更文件向上找） |
| Codex AGENTS.md 发现与合并 | — | 全局先 `~/.codex/AGENTS.override.md` 再 `~/.codex/AGENTS.md`；项目级"Starting at the project root (typically the Git root), Codex walks down to your current working directory"，逐目录先 override 后 AGENTS.md。合并："Codex concatenates files from the root down, joining them with blank lines. Files closer to your current directory override earlier guidance because they appear later in the combined prompt." 上限 `project_doc_max_bytes`，默认 32 KiB | — |
| Codex 复核规则的作用范围 | — | "Codex searches your repository for `AGENTS.md` files and follows the applicable code review rules.""Put repository-wide rules in the root `AGENTS.md` and service-specific rules in a nested file, such as `services/experiment_reporting/AGENTS.md`. Codex applies the root and more-specific guidance that covers each changed file.""For Codex code review in GitHub, add a `## Code Review Rules` section to the `AGENTS.md` closest to the code the rules govern."——**是根 + 更具体两者都生效，不是只取最近那一份** | — |
| subagent 派发字段 | `Agent` 工具取 `subagent_type`（角色名）与 `model`；本会话工具定义原文可证 | 事实表未覆盖 | 事实表未覆盖调用形式，仅确认「同一条消息里多个 Task 调用会并行」 |
| subagent 隔离 | `Agent` 工具有 `isolation: "worktree"`，无改动时自动清理 | 事实表未覆盖，不许编 | **默认共用父 agent 的检出**："Subagents share the parent agent's checkout by default. When several subagents edit files at once, they can overwrite each other's changes." 隔离靠自然语言显式要求（"each in its own environment"），**没有具名配置开关** |
| subagent 并行 | 同一条消息里多个 `Agent` 调用并发执行；本会话运行环境明文如此要求 | 事实表未覆盖 | "Agent sends multiple Task tool calls in a single message, so subagents run simultaneously." |
| subagent 续聊 | `SendMessage` 按 agent id | 事实表未覆盖 | 可以："Each subagent execution returns an agent ID. Pass this ID to resume the subagent with full context preserved." |
| 内置 subagent | — | 事实表未覆盖 | Explore、Bash、Browser |
| 原生 memory | **有**，且是逐项目的：本会话系统提示原文给出 `~/.claude/projects/<项目>/memory/`，一条事实一个文件，frontmatter 为 `name` / `description` / `metadata.type`（`user` / `feedback` / `project` / `reference`），另有一份每次会话加载的 `MEMORY.md` 索引。**没有 `source` 字段要求，没有条数上限** | **有，但是全局的，且默认关**："Codex stores memories under your Codex home directory. By default, that's `~/.codex`"、"The main memory files live under `~/.codex/memories/`"、"Local Codex memories are off by default."（Settings > Personalization，或 `config.toml` 里 `[features] memories = true`）；`/memories` 只控制当前这一轮聊天用不用、算不算素材。由 Codex 后台自己从过往聊天生成，官方明说 "don't rely on editing them by hand as your primary control surface"，**没有给 agent 的增删改接口**。整页 `project` 一词出现 **0 次**——不是按项目分的 | **当前文档里没有**：`cursor.com/docs/context/memories` 301 到 `cursor.com/docs/rules`（`curl -L` 实测 final URL），`cursor.com/docs/llms.txt`（455 行的全站文档索引）、`cursor.com/sitemap.xml`、`cursor.com/docs/sitemap.xml` 里 `memor` 命中数均为 **0**；Rules 页唯一一处 "memory" 是泛指句 "Large language models don't retain memory between completions."。搜索结果里"Memories are stored per project"那类说法来自论坛和旧缓存，不是现存文档页 |

来源：developers.openai.com/codex/skills、/codex/config-reference、developers.openai.com/codex/cli/features、
developers.openai.com/codex/integrations/github、cursor.com/docs/skills、cursor.com/docs/subagents、cursor.com/docs/bugbot。
learn.chatgpt.com/docs/agent-configuration/agents-md、learn.chatgpt.com/docs/third-party/github
（后两个是 developers.openai.com 对应页面的 308 跳转目标）。
查证日期 2026-09-18；Cursor 的模型写法、frontmatter、隔离/并行/续聊于同日复核（cursor.com/docs/subagents），
补回了首次记录时漏掉的 `composer-2`、`context` 括号参数和 `name`/`description` 两个字段——
这张表是给 subagent 当唯一可信来源用的，漏记会被当成「凭空捏造」判掉。

Codex 那一页还有一句和本项目直接相关的："Keep required team guidance in `AGENTS.md` or checked-in documentation. Treat memories as a helpful recall layer, **not as the only source for rules that must always apply**."——官方自己不把它当成硬规则的载体。

memory 一行的查证方式（2026-09-18，可复现）：Codex 取 `learn.chatgpt.com/docs/customization/memories?surface=app`（`developers.openai.com/codex/memories` 的 308 跳转目标）原始 HTML 后逐句 grep，上面每条引号内的话都是原文；Cursor 是 `curl -sS -L -w '%{url_effective}'` 看跳转落点，再对 llms.txt / 两份 sitemap 做 `grep -ic memor`。


**第三次同类事故**：给 T5b 的派发里，我把 `agents.enabled`、
`agents.max_concurrent_threads_per_session`、`~/.codex/config.toml`、`/etc/codex/skills`
和 skill 目录结构当成「已查证表的 Codex 列」列了出来，而表里一条都没有。T5b 照着转述并
归因给表，复核逐条 grep `docs/` 才发现。核准后这些大多为真，但**逐角色分档那条是反的**：
`default_subagent_model` 和 `default_subagent_reasoning_effort` 都是**全局**键，
`[agents.<n>]` 只收 `config_file` 和 `description`；逐角色分档要落在 `config_file`
指向的那一层 TOML 里。

**第六次，最难堪的一次**：三包交叉复核发现 `skills/shared/roles.md:299-302`
到现在还写着 `[agents.<name>]` 收 `config_file`、`description` **和
`default_subagent_model`**——正是「第三次同类事故」那条被判反了的事实，原样
躺在正文里，从 a6e8ee2 起就已提交。

关键在于我当时做了什么：我更正了表、更正了三个 wrapper、写了这段事故复盘——
**唯独没回头改那份最初出错的正文**。于是现在三个 wrapper 都对，而它们奉为
权威的正文是错的（`PLAYBOOK.md:204` 明确让读者以 `roles.md` 为准）。

前五次的教训都是「表要全」。这次是新形状：**修完源头和下游，漏掉中间层**。
事故复盘本身会制造一种「这条已经处理过了」的错觉，而复盘记的是认知的更正，
不是文件的更正。以后再记这类复盘，要连带列出所有需要同步改的文件，逐个打勾。

同一份 `roles.md` 还有第二处同源问题：它说 Codex 的 effort 取值「官方没公布，
你自己查配置手册填」，而表里五个取值写得明明白白，Codex wrapper 也正是照着
表里那五个建的分档表和 canary。正文在低估一条已经查证的事实。

**第五次，同样是误杀**：T5c 复核判定「Cursor 也读 `.claude/agents/`、`.codex/agents/`」
未获授权。查 cursor.com/docs/subagents（同日两次取，措辞一致）：**是真的**，六个目录都读，
而且**同名 subagent 的优先级官方有规定**（`.cursor/` 优先）——只有**技能**的优先级没规定。
我先前把「未规定」笼统写在技能那一行，等于让复核把一条真事实判成捏造。

同一页还一并settle了两个此前当作未知挂着的字段：`readonly` 是布尔、默认 `false`，
限制是 "no file edits, no state-changing shell commands"——**只读命令不受限**，
所以 adversary 的 `git log -S`、`git blame` 根本没问题，T5c 里那一整段「万一 readonly
连读命令也拦」的预案可以删掉；`is_background` 也是布尔、默认 `false`。

表缺一条，下游要么编，要么把真的判成编的。两种代价都记在这儿。

**第四次，方向反过来**：T5b 复核判定「Codex 沿变更文件向上找 `AGENTS.md`」是把
Cursor 的事实搬到了 Codex 列——**程序上判得对，内容上判错了**。我去查了官方文档
（developers.openai.com/codex/* 现 308 跳到 learn.chatgpt.com），嵌套 `AGENTS.md`
确有其事，已按原文补进表。但措辞得改：Codex 是**根 + 更具体两者都生效**，不是
「最近一份说了算」。

这正是表缺条目的第二种代价。前三次是我从旁路喂事实，这次是表缺了一条**真事实**，
于是复核只能按「未授权即捏造」判——对的内容被判掉，和错的内容被放行一样要人命。
所以补表不只是防捏造，也是防误杀。

结构性教训：**我往派发 prompt 里写的每一条平台事实，必须先进表。** 三次事故全是
「我定了唯一可信来源，然后自己从旁路喂事实」。

**第二次同类事故**：Cursor 的 worktree 和内置 subagent 两条，我直接写进派发 prompt
喂给了 T5c，而没有先进表——等于自己绕过了自己定的唯一可信来源。T5c 照做了但把
不一致报了回来。复核后发现其中一条还是**反的**：Cursor 的 subagent **默认共用
父 agent 的检出**，并发编辑会互相覆盖；隔离要显式要求，且没有具名开关。我原话
「isolated git worktrees per subagent are available」把 opt-in 说成了现成能力。

**Bugbot 是 Cursor 的产品，不是 Codex 的**——这点先前记反了，已按官方文档更正。

## Tasks

### T0 基线提交与公开仓库 ✅

已完成。基线提交 `eb614c0`，`.gitignore` 排除 `.build/` 等；设计稿中的真实基础设施标识
（内部主机名、数据库名、一条历史安全问题的描述、模拟器 UDID）已换成合成数据后才推送。

### T1 MCP 端口占用诊断 ✅ 740491d

- `depends_on`: []
- `write_scope`: `mcp/client.go`, `mcp/client_test.go`
- `exclusive_resources`: `["gate:go-test"]`
- role: implementer
- 现象（实测）：端口上蹲着别的服务时，`plan_board_status` 回 `看板返回 HTTP 404`。
- 要求：区分「连不上」（拉起 app 重试，现有行为）与「连上了但不是看板」（`/api/health`
  非 2xx，或 2xx 但 body 缺 `ok`/`version`），后者报出端口号、可能的占用者和下一步。
- 验收：`cd mcp && go test ./...`；并在端口被占的真实状态下复跑，贴出新错误原文。

### T2 Store 与旧数据导入的直接单测 ✅ 1286efe

- `depends_on`: []
- `write_scope`: `Tests/BoardKitTests/StoreTests.swift`, `Tests/BoardKitTests/LegacyImportTests.swift`
- `exclusive_resources`: `["gate:swift-test"]`
- role: implementer
- 覆盖：事件截断到 200；两条写入门禁在 Store 层直测；列表 keep/replace/clear 直测；
  `LegacyImport.parseRun` 对缺字段/坏状态/非对象 task 的容忍；`importAll` 遇坏文件跳过不中断。
- 验收：`swift test`。测试必须用临时目录，不得碰 `~/.claude/plan-sdd/board.sqlite3`。

### T3 plan_set_tasks 原子化 ✅ cf3ea64

- `depends_on`: []
- `write_scope`: `Sources/BoardKit/Store.swift`, `Sources/BoardKit/API.swift`,
  `Tests/BoardKitTests/APITests.swift`, `mcp/main.go`
- `exclusive_resources`: `["gate:swift-test", "gate:go-test"]`
- role: implementer `[complexity: high]`
- 现状：逐条 PUT，中途被拒会留下半截 DAG。
- 要求：Swift 侧加批量端点，单事务写完全部 task，任一条不合法整批回滚；MCP 改调它，
  返回形状不变。
- 验收：`swift test`；`go test ./...`；新增接口测试证明「批中一条非法则整批不落库」。

### T4 可移植技能正文（英文） ✅ e9fea27

- `depends_on`: []
- `write_scope`: `skills/shared/`
- `exclusive_resources`: `[]`
- role: skill-author `[complexity: high]`
- 内容：DAG 契约、spec 契约、TDD 循环、角色扇出、goal 模式、code review、门禁纪律、禁止事项。
- 必须先用 `prompt-engineer` skill 走一遍（Job 2：从零写 prompt），再用 `humanizer` 去 AI 味。
- 不得假设 `Workflow` 工具存在；不得出现中文；不得出现本机私有路径。
- 验收：人工读一遍结构完整；`grep` 无中文字符、无 `/Users/`、无 `Workflow` 依赖表述。

### T5 角色花名册与模型矩阵 ✅ 0003e71

- `depends_on`: `["T4"]`
- `write_scope`: `skills/shared/roles.md`
- role: skill-author
- 角色：recon-rules、recon-product、recon-code、implementer、ui-designer、qa、
  reviewer、branch-reviewer、adversary。每个角色写清身份、输入契约、交付契约、停止条件。
- 给出三平台默认模型矩阵，并注明这是起点不是定论。
- 验收：每个角色在 T4 正文里都有对应调用点，无孤儿角色。

### T5a / T5b / T5c 三平台打包 ✅ aa4228b

- `depends_on`: `["T5"]`
- `write_scope`: 分别是 `skills/claude-code/`、`skills/codex/`、`skills/cursor/`
- `exclusive_resources`: `[]`（三者互不重叠，可并行）
- role: skill-author
- 各自产出该平台的 SKILL.md（正确的 frontmatter）、角色文件、MCP 注册说明、安装步骤。
- 验收：按各平台文档核对字段名与路径；模型 ID 用该平台真实存在的写法。

### T7 多 worktree 执行模式 ✅ a6e8ee2

- `depends_on`: `["T5"]`
- `write_scope`: `skills/shared/`
- `exclusive_resources`: `[]`
- role: skill-author `[complexity: high]`

共享正文现在的前提是「所有节点共用一个工作树，并发安全只靠 `write_scope` /
`exclusive_resources` 声明」。要加一种可选的执行模式：每个派发出去的节点拿一个
自己的 git worktree、自己的分支，从 baseline 切出去。

两条与直觉相反、必须写进去的：

1. **worktree 不会削弱 `exclusive_resources`，反而让它更要紧。** 端口、设备、
   共享测试库、模拟器都是机器级的，worktree 隔离的是文件不是这些。读者的直觉
   是「隔离了就不用声明了」，正好反了。
2. **「我这棵树里是绿的」不等于「合进去还是绿的」。** 这是本模式新增的主要
   失败形态。节点必须合回集成分支、并在合并后重跑门禁才算 done，不能拿
   worktree 内的绿色收口。

其余要覆盖的：

- `write_scope` 重叠在本模式下从「禁止同批派发」变成「合并期冲突」。默认仍然
  不同批派发重叠范围——subagent 解合并冲突解不好——但要说清这个约束此时是
  为了什么，和共享树模式下不是一回事。
- 门禁在该节点的 worktree 里跑，代价是每棵树一次全量构建；把这个成本写明。
  抢机器级资源的门禁仍然要按 `exclusive_resources` 串行。
- 逐节点提交仍然限定在 `write_scope`（自己的 worktree 里照样可能越界写）。
- 阶段 3 的分支复核对象是全部合并完成后的集成分支。
- 清理：正常完成的 worktree 删掉；**被标 `blocked` 的节点，worktree 要保留**
  供事后查看，别顺手删了。
- 何时用哪种模式：worktree 模式的成本是建树、N 倍构建、合并工作量；共享树更
  简单。给出选择依据，不要暗示 worktree 总是更好。
- **必须可降级**：平台不支持 worktree 时，整份文档在共享树模式下照样走得通。

平台支持（已查证）：Claude Code 的 `Agent` 工具有 `isolation: "worktree"`，无改动时自动清理；
**Cursor 的 subagent 默认共用父 agent 的检出、并发编辑会互相覆盖**，隔离要逐次用自然语言
要求且没有具名开关（先前写的「Cursor 支持每个 subagent 独立 worktree」已推翻）；
**Codex 侧事实表没有覆盖，不许编**。

- 验收：无中文、无本机路径、无 `Workflow` 依赖；两种模式各走一遍执行路径都
  不需要临场发挥；共享树模式的行为与现状一致，不被新模式的措辞污染。

### T5a/T5b/T5c 的 worktree 增量

- `depends_on`: `["T7"]`
- 三个包装层都要补本平台的 worktree 支持说明；Codex 那份如果事实表没有依据，
  就明写「未覆盖」，不许补一段像模像样的配置。

### T8 看板侧 project memory 存储与接口 ✅ 93a9cac

- `depends_on`: []
- `write_scope`: `Sources/BoardKit/Store.swift`, `Sources/BoardKit/Models.swift`,
  `Sources/BoardKit/API.swift`, `Tests/BoardKitTests/MemoryTests.swift`,
  `Tests/BoardKitTests/APITests.swift`
- `exclusive_resources`: `["gate:swift-test"]`
- role: implementer `[complexity: high]`

memory 以 **project** 为维度（`Run` 已有 `project` 字段，复用它，不另起概念）。
新增 `memories` 表与四个接口。每条至少带：`project`、`key`、`value`、`kind`、
`source`、`created_at`、`updated_at`。

`source` 是设计的关键，不是附属字段：它记这条是从哪个文件哪一行、或哪条命令的
输出读出来的。没有它，下一轮拿到一条 `swift test` 无从判断是否还作数，memory
就退化成一个自信的错误来源——这正是本仓库存在要防的那类失败。

- 接口：list（按 project，可按 kind 过滤）、get、add（同 key 覆盖）、delete。
- **不做 UI**（用户已拍板）：memory 只有存储和接口，看板窗口里不加展示。
  后续也别顺手加——它的读者是 agent，不是人。
- **不做向量化**：一个 project 的 memory 是几十条量级，`list` 一次全取即可；
  检索键是 `kind` 精确过滤，不是语义相似度。而且向量检索返回「大致相关」，
  对一条门禁命令来说大致对就是最坏结果——宁可 miss 触发重新勘察，
  也不要拿邻近项目的门禁跑绿。
- 写路径沿用既有的 Host 白名单、`Origin` 拒绝、`application/json` 强制。
- 验收：`swift test`；测试必须用临时目录，不得碰 `~/.claude/plan-sdd/board.sqlite3`。

### T9 MCP 侧 memory 四工具 ✅ 7fb46f2

- `depends_on`: `["T8"]`
- `write_scope`: `mcp/main.go`, `mcp/summary.go`, `mcp/tools_test.go`
- `exclusive_resources`: `["gate:go-test"]`
- role: implementer
- `plan_memory_list` / `plan_memory_get` / `plan_memory_add` / `plan_memory_delete`。
- 验收：`cd mcp && go test -count=1 ./...`。

### T10 技能侧接入 memory ✅ a213efe

- `depends_on`: `["T7", "T9"]`
- `write_scope`: `skills/shared/`
- role: skill-author
- 阶段 0 改成：先 list 本 project 的 memory → 对每条按 `source` 做**廉价复验**
  （那个文件还在吗、那条命令还在配置里吗）→ **只对缺失和复验不过的派勘察泳道**。
  不许拿 memory 直接顶替勘察结论。
- 每隔若干个 task 整理一次 memory（并入 goal 模式已有的 checkpoint，不另设节奏）：
  把本轮学到的耐久事实写进去、删掉被推翻的、合并重复的。
- 必须可降级：没有看板 / 没有 memory 接口时，退回现在的全量勘察，流程不变。
- 验收：无中文、无本机路径；两种情况（有 memory、无 memory）各走一遍阶段 0
  都不需要临场发挥。

注：T10 与 T7 都写 `skills/shared/`，范围重叠，不能同批派发；T7 先落地。

### T6 README（英文） ✅ 1834982

- `depends_on`: `["T1","T2","T3","T5a","T5b","T5c"]`
- `write_scope`: `README.md`
- role: skill-author
- 涵盖：这是什么、三家怎么装、MCP 工具表、两条写入门禁、端口、**提示使用者按自己的订阅
  和预算调整各角色模型**、测试怎么跑。
- 必须过 `humanizer`。
- 验收：全英文；三段安装说明能照着做下来。

注：T1/T2/T3/T4 无写入范围重叠。T1 与 T2 资源不冲突可并行；T3 与两者都抢门禁资源，
自然排在后面，不用画依赖边。T4 纯文档，与代码任务完全并行。

### T13 DELETE 路由回显的是原始值，不是入库值 ✅ 4f26a4d

`Sources/BoardKit/API.swift:277` 的 DELETE 回 `["deleted": parts[2], "project": project]`
——路径段和查询值都是**原始**的。而 GET / POST 回的是入库那条记录，key 已小写、
project 已 trim。于是 `DELETE /api/memories/Gate?project=p` 答 `{"deleted":"Gate"}`，
实际删掉的行是 `gate`。

调用方据此打日志会打出一个库里从来不存在的 key。三条路由对同一个字段回两种口径，
这种不一致迟早要有人踩。改成回归一化后的值，并补一个测试钉住三条路由口径一致。

发现方式：核 T9 的 verifyMemoryDeleted 时反查 Swift 侧回什么，才看出它现在能过
是因为 DELETE 恰好不规范化。T9 那边已让它对两种拼法都容错，但根在这儿。

`write_scope`: `Sources/BoardKit/API.swift`、`Tests/BoardKitTests/APITests.swift`。

### T14 T7 终审剩余六条 ✅ b905bde

T7 已提交（a6e8ee2），中心问题关掉了：终审明确答「找不到任何一条路径，能让节点的活
没进集成分支而运行报绿」。剩下六条另派节点修，不再占 T7 的返修轮次。

两条 HIGH：`PLAYBOOK.md:262-269` 还列着加 worktree 之前的十一项清单（漏
`<working_directory>` 和 `<design_decisions>`），照它拼 prompt 的人会漏发工作目录，
implementer 写进主树——8b 守卫能拦住，不会报绿，但白跑一趟且弄脏用户的树；
以及 8b 冲突后的返修循环不收敛：节点工作树里看不到集成分支那一侧，改完再合
一模一样地冲突，三轮到顶判 blocked，而跨趟的 write_scope 重叠本来是文档自己
说的「合法且无人有错」。

### T15 memory 每项目 100 条上限 ✅ 350e123

用户拍板：不做 search，做上限。理由记在这儿以免以后有人「优化」掉——

search 的坏处不是贵，是**让「没找到」和「不存在」长得一样**：agent 搜 `test` 没命中，
就断定没记过门禁，而 key 其实叫 `verify.swift`。`list` 全量摊开就不会被这样骗。
这和当初否掉向量化是同一个理由，只是程度轻一点。

所以真正要定的是上限，而上限的作用是让 `list` 保持可读。一条约 300–500 字节正文，
100 条就是 30–50KB、每次勘察 10–15k token，已经到了「不再免费」的临界。200 条会
让 agent 从读变成扫，而被扫过去的 hard_rule 等于没生效。

两条硬要求：**满了就拒写，绝不淘汰最旧的**（静默消失的 hard_rule 比从没写过更糟，
因为 agent 以为它还在）；**已存在的 key 必须仍能覆盖写**——否则满额时改不掉一条过期的
门禁命令，而最该改的恰恰就是错的那条。

### T16 并行节点共用 scratchpad，脚本会互相覆盖 ✅ 7db5a26

T5a 报告：它的 `linkcheck.py` 在 21:46 被另一个节点同名脚本覆盖。**它是靠替换
版本恰好崩在缺参数上才发现的**——原话是「Had it merely behaved differently
I would have pasted its numbers as mine.」

我核了 scratchpad 根目录，确实是一个平铺目录，多个节点各写各的通用名：
`linkcheck.py` / `lc.py` / `lc2.py`、`mutate.py` / `mutate2.py`、
`edit1.py`…`edit7.py`、`SKILL.head.md` 与 `SKILL_HEAD.md`、
`cc-run1.txt` / `cx-run1.txt` / `cu-run1.txt` 三组同构文件名。

这是这轮最危险的一类故障：**一个错的验证数字，看起来和对的一模一样**。整个
流程的其他防线（变异对照、独立复核、原始输出）全都建立在「贴出来的数字是这次
真跑出来的」之上，而这条通道能在不留痕迹的情况下把它替换掉。

本技能的设计就是大量并行 subagent，所以这条得写进正文：派发契约里要求每个
节点把 scratch 文件写在自己的子目录下，脚本名带节点标识；发现该是自己的文件
不是自己写的，要报告而不是使用。

`write_scope`: `skills/shared/references/dispatch.md`（可能还有 `gates.md`）。
`depends_on`: T10（同一批文件）。

### T12 APITests 的诊断力 ✅ 0240a53

`Tests/BoardKitTests/APITests.swift` 全文用 `as!` 链取字段（84、95、114、139、157 等约 40 处）。断言一失败，紧跟的强解包就把测试进程打死：我做源码变异时拿到 `Fatal error: Unexpectedly found nil`（661 行）和 `exited with unexpected signal code 5`，后面的用例根本没跑。

这不是 T8 引入的，是整个文件既有的写法，所以不并进 T8——节点中途顺手重构是本技能明令禁止的。单独成节点做：把取字段换成不会中止进程的形式，让一次失败只损失一个用例的信息。

`write_scope`: `Tests/BoardKitTests/APITests.swift`。`depends_on`: T8 收口之后（同一文件）。

### T18 T10 二轮复核剩下的三条 ✅ 2a74d16

二轮复核（agent aaa76a92f8faabad3）九条里，HIGH 和 MEDIUM-HIGH 四条已在 a213efe 修掉。
剩下三条是同一类：`<extra_context>` 这个块承担了两种内容，而 dispatch.md 自己的规则
说不许这样。

- **MEDIUM**：`memory.md` 允许 `convention` 不经 lane 直接采用，而 convention 的去处是
  `<background>`；`dispatch.md:67-69` 把该块定义成「recon 的已确认发现，附支撑路径」。
  于是一条没人核过的 convention 以「已确认发现」的身份发到每个 implementer 手上。
  a213efe 加的那条 dispatch 警告只盖了 `<hard_rules>` 和 `<acceptance>`，漏的正是这块。
- **MEDIUM**：claims 和已确认发现共用 `<extra_context>`，靠编排者临场写的一句散文区分。
  `dispatch.md:36-39` 自己写着「每段粘贴内容各自包标签」，理由就是防止一种内容被当成
  另一种读——而「claim 被当成 finding」正是本次改动要防的那一种。该给 claims 单独的标签。
- **LOW**：`recon.md:14` 说「给每个 lane 同样的三个输入」，但 claims 按 kind 分路由之后
  `<extra_context>` 已经逐 lane 不同。照第 14 行套模板会把 gate claim 也发给 lane B/C，
  两个 lane 可能对同一条回出互相矛盾的结论，而没人规定谁说了算。

`write_scope`: `skills/shared/references/dispatch.md`、`skills/shared/references/recon.md`、
`skills/shared/references/memory.md`。
`depends_on`: T16（同写 dispatch.md）。

## 2026-09-19 这一批的调度

本会话仍然没有看板：`plan_board_status` 等工具不在工具集里（ToolSearch 查无此名），
状态继续落在本文件。

同批派发 T6 / T16 / T12，三者写入范围互不重叠：`README.md`、
`skills/shared/references/dispatch.md`、`Tests/BoardKitTests/APITests.swift`。
只有 T12 占 `gate:swift-test`。

T13 与 T12 同写 `Tests/BoardKitTests/APITests.swift`，且同抢 `gate:swift-test`，
所以排在 T12 之后单独一批。顺序选 T12 在前：T12 要改的正是全文取字段的写法，
先改完，T13 新加的那条测试就直接落在新写法里，省掉一次返工。

### T19 verifyMemoryDeleted 的两处容忍 ✅ f0a74fd

T13 把 DELETE 的回显改成入库值之后，`mcp/main.go` 里 `verifyMemoryDeleted`
的容忍有一半失去了存在理由。T13 给了建议但按范围没动：

- `got.Project != project` 这个 disjunct 是为这个缺陷加的，接受调用方未 trim 的
  原始 project。服务端现在不可能回未 trim 的值，去掉它并只比 `trimmedProject`
  不花成本，反而堵住一个真洞：今天一个没 trim 就回显的看板能通过校验，
  而这正是这个校验器要拦的那一类。
- key 那个 `EqualFold(TrimSpace(...))` **不能**收成严格相等——它比的是调用方的
  原始 key，而原始 key 本来就允许大小写混写和留白。真要收紧，应该是把调用方
  那一侧先 `ToLower(TrimSpace(...))` 再要求严格相等，这样才能抓住「服务端回了
  一个没折叠的 key」。这是行为变更，值得单独复核。

风险是版本错配：收紧后的 MCP 二进制指向旧版看板，调用方传带空格的 project 时
`plan_memory_delete` 会开始报错。两者同包发布就无所谓；能各自漂移就要先想清楚。
函数上方 598-612 那段注释把这个缺陷记成「另案处理，此处不修」，也要一并改写。

另外 T13 顺带报了两条未核实的观察：`verifyMemoryEcho` 可能有同形状的容忍；
`got.Deleted == "" || got.Project == ""` 那道守卫可能实际不可达（空 project 在
`normalizedProject` 就 400 了，空 key 根本到不了 DELETE 路由）。要核过再动。

`write_scope`: `mcp/main.go`、`mcp/tools_test.go`。
`exclusive_resources`: `["gate:go-test"]`。

### T20 本地完整验证流程 ✅ 33eb836

现在三条门禁是分开记在文档里的（`swift test` / `cd mcp && go test ./...` /
`./Scripts/bundle.sh`），谁要在本地完整过一遍，得自己知道有这三条、知道顺序、
还得自己判断「装起来之后到底能不能用」。缺的那一段恰恰是最值钱的：编译过、
单测过，不代表打包出来的 app 真能起来并正确响应 MCP 那条链路。

要的是一条命令跑完全程，并且**最后一段是真的把 app 起来、用真 HTTP 打一遍**：
建一个临时库和临时端口，建 run、写带依赖的 task、故意制造资源冲突看是否 409、
写读删一条 memory，然后收干净。退出码要能直接当 CI 用。

`write_scope`: `Scripts/`、`README.md`（只动测试那一节）。
`exclusive_resources`: `["gate:swift-test", "gate:go-test"]`（它自己要跑这两条）。
`depends_on`: []

### T21 README 补 app 界面截图（新增，未开始）

README 现在把 app 说清楚了但一张图都没有，而这个项目一半的卖点就是那个常驻
菜单栏的看板。要真机截图，不是 `design/board-mock.html` 那份原型。

`write_scope`: `README.md`、`docs/images/`。
`depends_on`: T20（同写 README.md）、**T23**（见下，这条是派发时才发现的）。

**第二个阻塞，比权限那条严重**：截图要起真 app，而真 app 打开的是真看板。
真看板现在装着的是用户另外两个项目的两条运行记录——各自带标题和本机绝对路径。
（那两行原本抄在这里，2026-09-19 推送前删掉了：这份计划本身就在公开仓库里，
把它们写在这儿犯的正是下面这段要防的错。）

这些要是进了截图，就等于把别的项目的名字和本机绝对路径贴进一个**公开**仓库。
T0 已经为同类问题清理过一次（设计稿里的内部主机名、库名、模拟器 UDID）。
截图不比文字，事后没法"改一句话"补救。

而 `BoardModel.swift:40` 是 `try Store()`，`Sources/` 里唯一的环境变量是
`BOSS_SDD_PORT`（两条都自己 grep 过）——**没有任何办法让 app 打开别的库**。
所以要拿到干净的截图，得先有 T23 的 store 路径覆盖，再灌一份合成数据。
`exclusive_resources`: `["real-board-db", "port:18888"]`——截图要起真 app，
真 app 打开的是 `~/.claude/plan-sdd/board.sqlite3` 并监听 18888，
而 T20 的验收里有一条是「跑完后真库的修改时间不变」。同批跑会让 T20 假红。

**派发前实测到的阻塞**：`screencapture` 拿不到屏幕录制权限。

    $ screencapture -x -R0,0,1,1 <scratch>/permcheck.png
    could not create image from rect
    exit=1
    （文件未生成）

所以走 shell 截图这条路直接不通，派下去只会白烧一轮。可行的替代是
computer-use 那套的 `request_access` + `app_screenshot`，它走的是另一条授权
链路，会向用户弹一次授权框——这得用户点头，不是我能自己绕过去的。

**明确不接受的替代**：截 `design/board-mock.html` 那份原型冒充真机截图。
那正是 T6 刚刚删掉的那类说法（「built from real run data」，没人打开过那个文件），
在这儿重演一遍只会更糟，因为图比句子更像证据。

**第三个阻塞（2026-09-19 实际动手时才撞到）**：用户要求截图也是英文的，
而 **app 的界面全是中文**——`Sources/BossSDD/` 下 79 条用户可见中文字符串，
分布在 10 个文件里（`Theme.swift` 14 条状态名、`BoardWindow.swift` 14 条、
`InspectorView.swift` 19 条、`MenuBarContent.swift` 8 条等）。README 和技能
正文都是英文，界面是中文，截图放进去就露馅。见 T24。

**第四个阻塞**：computer-use 的 `request_access` 看不见这个 app。
实测：`list_apps` 用 `boss` / `plan` / `sdd` 查都是空；直接跑二进制、
改用 `open -n -a ... --env` 走 LaunchServices 重启（health 确认活着，
`{"port":18895,"ok":true,"runs":1}`）之后仍然查不到；而
`System Events` 的 `background only` 进程列表里**有** `BossSDD`。
推断（未证实）是这套工具只枚举常规激活策略的 app，而本 app 是
`LSUIElement = true` 的附属程序。

剩下的路是 `screencapture -l <windowid>`，它不受这个限制，但要用户在
系统设置里给当前进程授予「屏幕录制」权限。这一步只能用户自己点。

### T22 verifyMemoryEcho 的同款盲点 + 版本错配无人诊断（新增，未开始）

T19 收口时报上来两条，都核实过是真的，但超出它的范围：

1. `verifyMemoryEcho` 的 key 比较仍是 `EqualFold(got.Key, wantKey)`，
   和 T19 修掉的那处同一个盲点：两侧都归一化，于是分不清「看板折叠对了」
   和「看板没折叠」。GET / POST 回 `Gate` 照样能过。T19 之后这两个函数
   变得不对称了，下一个读的人会以为 echo 这边的 fold 是有意为之。
2. `client.go` 的 `appPath` 写死 `/Applications/BossSDD.app`，而
   `verifyIdentity` 只检查 `/api/health` 里有没有 `ok` 和 `version`
   **字段**，从不比对版本值。所以「旧 app + 新 MCP 二进制」是一个可达配置，
   不是理论风险。T19 收紧之后这种错配会以 `plan_memory_delete` 报错的形式
   冒出来——报错本身是对的（旧看板的回答确实指向一个不存在的行），但错在
   不好定位。要让它自报家门，最小改动点在 `verifyIdentity` 加一条版本下限。

另外 `mcp/main.go` 在 T19 之前就不是 gofmt-clean（`plan_memory_delete`
注册那几行的 key 对齐，约 397-402）。T19 按「不顺手重构」的规定没动。
要收就单独收，别混在别的节点里。

`write_scope`: `mcp/main.go`、`mcp/client.go`、`mcp/tools_test.go`。
`exclusive_resources`: `["gate:go-test"]`。

### T23 Store 路径不可配置 + HTTPServer 的弱引用陷阱（新增，未开始）

T20 报上来的，都核实过：

1. **store 路径没有任何覆盖入口**。`Sources/` 里唯一的环境变量是 `BOSS_SDD_PORT`，
   `BoardModel.init` 直接 `try Store()`。后果是真 app 无法端到端演练——T20 只能
   自己编一个宿主链 `BoardKit.o`，而 SwiftUI 那层外壳、`BOSS_SDD_PORT` 读取、
   旧数据导入、开机自启一律覆盖不到。最小改动是照着 `configuredPort` 的样子加
   `BOSS_SDD_DB` 或 `BOSS_SDD_HOME`，`LegacyImport.defaultRunsDirectory` 同理。
2. **`HTTPServer` 从自己的 listener 回调里只弱引用自己**。`stateUpdateHandler` 和
   `newConnectionHandler` 都 `[weak self]`，唯一的强引用是 `self.listener`。
   调用方一旦让 HTTPServer 出作用域，socket 仍然 bind、`lsof` 仍显示 LISTEN，
   而状态回调不再触发、请求不再被处理——**失败是静默的**。T20 第一次搭宿主
   就踩了这个。`BoardModel` 用 `let` 持有所以 app 没事，但这是留给下一个调用方
   的坑。`swift build` 现在就在 `HTTPServer.swift:82` 和 `:94` 报三条
   `weak ownership of capture 'self' differs...` 警告，说的正是这两处。
3. 次要：`API` 的 `port` 只用于 `/api/health` 的回显，而 `HTTPServer(port: 0)`
   在 bind 之前不知道端口，所以宿主得事后把端口塞回去。`APITests` 传 `port: 0`
   且从不断言这个字段，于是那里的 health 一直回 `"port":0`。这个字段要是想可信，
   应该由 server 提供而不是构造时传入。

`write_scope`: `Sources/BoardKit/HTTPServer.swift`、`Sources/BoardKit/Store.swift`、
`Sources/BoardKit/API.swift`、`Sources/BossSDD/BoardModel.swift`、`Tests/BoardKitTests/`。
`exclusive_resources`: `["gate:swift-test"]`。

### T24 app 界面英文化（新增，未开始，需用户拍板走哪条路）

`Sources/BossSDD/` 下 79 条用户可见中文字符串。仓库是公开且全英文的
（README、三份打包、`skills/shared/` 正文都是英文，后者还有 ASCII-only 门禁），
唯独界面是中文。用户要求 README 截图是英文的，所以这条挡在 T21 前面。

两条路，代价不同，**要用户定**：

1. **直接翻成英文**。改动最小，仓库从此前后一致。代价是用户自己日常用的
   也变英文了。
2. **做本地化**（英文为 base，中文作为一份 localization）。两边都留住，
   但要引入 `.lproj` / String Catalog、给 79 条串都建 key，工作量是第一条的
   几倍，而且 SwiftPM 的资源打包和 `bundle.sh` 的组装步骤都要跟着改。

我倾向第一条：这是个单机自用工具，公开仓库的一致性比保留中文界面值钱，
而且用户读英文没有障碍。但这是用户的界面，不该我替他决定。

`write_scope`: `Sources/BossSDD/`（若走第二条还包括 `Package.swift`、`Scripts/bundle.sh`）。
`depends_on`: []
## 风险与未决项

- 本轮仍无法用看板追踪：MCP 工具本会话未加载。状态落在本文件，重启后补录。
- 三平台的技能格式在快速演进，写进 README 的路径与字段有时效性，需注明查证日期。

## 待用户拍板

1. 技能在公开仓库里叫什么名字（暂定沿用 `plan-sdd`）。
2. 旧 `board.py serve`（PID 88040）什么时候收掉——换到 18888 后它已不碍事。
3. 应用图标、开机自启验证、选中运行持久化。
4. `scripts/board.py` 的最终删除时机。

## 门禁

- `swift test`
- `cd mcp && go test ./...`
- `./Scripts/bundle.sh`
