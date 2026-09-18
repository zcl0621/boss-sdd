// plan-sdd-mcp exposes the Plan SDD board to an agent as MCP tools.
//
// The board app owns the store and every scheduling invariant — a task may not
// enter `running` before its dependencies are done, and two active tasks may not
// hold the same exclusive resource. This process only translates tool calls into
// requests against the app's loopback API, so those rules cannot be bypassed here.
package main

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"os"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const version = "0.1.0"

func main() {
	log.SetOutput(os.Stderr)
	log.SetFlags(0)

	api := newBoard()
	server := mcp.NewServer(&mcp.Implementation{
		Name:        "plan-sdd",
		Title:       "Plan SDD 看板",
		Description: "把 plan-sdd 的运行、任务 DAG 与调度状态读写到本机看板 app。",
		Version:     version,
	}, nil)

	registerTools(server, api)

	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		log.Fatalf("plan-sdd-mcp: %v", err)
	}
}

// ---- inputs ----

type statusInput struct{}

type createRunInput struct {
	Title   string `json:"title" jsonschema:"计划名称，用户能认出来的一句话"`
	Project string `json:"project,omitempty" jsonschema:"项目路径或名称，用于区分同名计划"`
}

type updateRunInput struct {
	Run     string  `json:"run" jsonschema:"运行 ID"`
	Status  *string `json:"status,omitempty" jsonschema:"计划状态：pending/planning/awaiting_confirmation/running/review/blocked/done"`
	Summary *string `json:"summary,omitempty" jsonschema:"当前进度说明，写可检查的结论"`
}

type taskInput struct {
	ID                string    `json:"id" jsonschema:"任务 ID，同一运行内唯一且稳定，例如 T1"`
	Title             *string   `json:"title,omitempty" jsonschema:"任务标题；新建任务必填"`
	Status            *string   `json:"status,omitempty" jsonschema:"任务状态：pending/running/review/blocked/done"`
	Detail            *string   `json:"detail,omitempty" jsonschema:"可检查的进展证据、验证结果、复核结论或阻塞原因；不放依赖和范围"`
	Agent             *string   `json:"agent,omitempty" jsonschema:"实际负责人，例如派发时用的 subagent 名称"`
	DependsOn         *[]string `json:"depends_on,omitempty" jsonschema:"依赖的任务 ID；传数组整体替换，传空数组清空，省略则保留原值"`
	WriteScope        *[]string `json:"write_scope,omitempty" jsonschema:"会写入的路径前缀；新建任务必填。传数组整体替换，传空数组清空，省略则保留原值"`
	ExclusiveResource *[]string `json:"exclusive_resource,omitempty" jsonschema:"独占资源标识，例如 gate:full-suite；传数组整体替换，传空数组清空，省略则保留原值"`
}

type setTaskInput struct {
	Run string `json:"run" jsonschema:"运行 ID"`
	taskInput
}

type setTasksInput struct {
	Run   string      `json:"run" jsonschema:"运行 ID"`
	Tasks []taskInput `json:"tasks" jsonschema:"一次写入的任务列表，通常是计划成形后把整张 DAG 一次写完"`
}

type runInput struct {
	Run string `json:"run" jsonschema:"运行 ID"`
}

type getRunInput struct {
	Run           string `json:"run" jsonschema:"运行 ID"`
	IncludeEvents bool   `json:"include_events,omitempty" jsonschema:"是否附带最近 20 条活动记录"`
}

type memoryListInput struct {
	Project string `json:"project" jsonschema:"项目路径或名称，与 plan_create_run 的 project 保持一致"`
	Kind    string `json:"kind,omitempty" jsonschema:"按类型过滤：gate/run_recipe/convention/hard_rule/exclusive_resource/note，留空返回全部"`
}

type memoryKeyInput struct {
	Project string `json:"project" jsonschema:"项目路径或名称"`
	Key     string `json:"key" jsonschema:"记忆的 key；大小写不敏感，服务端只存小写"`
}

type memoryAddInput struct {
	Project string `json:"project" jsonschema:"项目路径或名称"`
	Key     string `json:"key" jsonschema:"记忆的 key，同一 project 内按 key upsert；只能是 ASCII 字母、数字、- _ .，最长 64 字符，会被存成小写"`
	Value   string `json:"value" jsonschema:"记忆的内容"`
	Kind    string `json:"kind" jsonschema:"类型：gate/run_recipe/convention/hard_rule/exclusive_resource/note"`
	Source  string `json:"source" jsonschema:"出处：文件+行号，或读出这个值的命令，让这条记忆可以被低成本证伪；不能为空"`
}

// ---- outputs ----

type statusOutput struct {
	OK      bool         `json:"ok"`
	Version string       `json:"version"`
	Port    int          `json:"port"`
	Runs    []runSummary `json:"runs"`
}

type runOutput struct {
	Run   runSummary `json:"run"`
	Graph graphView  `json:"graph"`
}

type taskOutput struct {
	Task  *taskView `json:"task"`
	Graph graphView `json:"graph"`
}

type batchOutput struct {
	Written []string          `json:"written"`
	Failed  map[string]string `json:"failed,omitempty"`
	Graph   graphView         `json:"graph"`
}

type fullRunOutput struct {
	Run    runSummary  `json:"run"`
	Tasks  []taskView  `json:"tasks"`
	Graph  graphView   `json:"graph"`
	Events []wireEvent `json:"recent_events,omitempty"`
}

// wireMemory mirrors the board's own memory JSON (Sources/BoardKit/Models.swift
// Memory). Kept separate from memoryView below so the two can drift on purpose:
// this one is what the wire actually says, the other is what the agent sees.
type wireMemory struct {
	Project   string `json:"project"`
	Key       string `json:"key"`
	Value     string `json:"value"`
	Kind      string `json:"kind"`
	Source    string `json:"source"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type wireMemoryList struct {
	Memories []wireMemory `json:"memories"`
}

// wireMemoryDeleted mirrors DELETE /api/memories/<key>'s body, which is not a
// Memory: just enough to confirm what was actually removed.
type wireMemoryDeleted struct {
	Deleted string `json:"deleted"`
	Project string `json:"project"`
}

// memoryView is what a tool call actually hands the agent. source rides along
// on every read path on purpose: a memory whose provenance the agent cannot
// see is the exact failure project memory exists to prevent.
type memoryView struct {
	Project   string `json:"project"`
	Key       string `json:"key"`
	Value     string `json:"value"`
	Kind      string `json:"kind"`
	Source    string `json:"source"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type memoryListOutput struct {
	Memories []memoryView `json:"memories"`
}

type memoryDeleteOutput struct {
	Deleted string `json:"deleted"`
	Project string `json:"project"`
}

// ---- registration ----

func registerTools(server *mcp.Server, api *board) {
	mcp.AddTool(server, &mcp.Tool{
		Name:  "plan_board_status",
		Title: "看板状态",
		Description: "看板 app 是否在跑，以及本机上已有哪些运行。" +
			"恢复会话时先调这个认领已有运行，不要凭标题相似就接管别的运行。" +
			"app 没启动时会自动拉起。",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ statusInput) (*mcp.CallToolResult, statusOutput, error) {
		var health wireHealth
		if err := api.call(ctx, "GET", "/api/health", nil, &health); err != nil {
			return nil, statusOutput{}, err
		}
		var list wireRunList
		if err := api.call(ctx, "GET", "/api/runs", nil, &list); err != nil {
			return nil, statusOutput{}, err
		}
		out := statusOutput{OK: health.OK, Version: health.Version, Port: health.Port, Runs: []runSummary{}}
		for index := range list.Runs {
			out.Runs = append(out.Runs, summarize(&list.Runs[index]))
		}
		return nil, out, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "plan_create_run",
		Title:       "新建运行",
		Description: "为本次计划建一条运行记录，返回 run_id。同一计划恢复时复用原 ID，不要重复创建。",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in createRunInput) (*mcp.CallToolResult, runOutput, error) {
		if strings.TrimSpace(in.Title) == "" {
			return nil, runOutput{}, fmt.Errorf("title 不能为空")
		}
		var run wireRun
		body := map[string]any{"title": in.Title, "project": in.Project}
		if err := api.call(ctx, "POST", "/api/runs", body, &run); err != nil {
			return nil, runOutput{}, err
		}
		return nil, runOutput{Run: summarize(&run), Graph: viewGraph(&run)}, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "plan_update_run",
		Title:       "更新计划状态",
		Description: "改计划整体状态或进度摘要。计划待确认用 awaiting_confirmation，缺输入或外部条件用 blocked 并写明原因。",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in updateRunInput) (*mcp.CallToolResult, runOutput, error) {
		body := map[string]any{}
		if in.Status != nil {
			body["status"] = *in.Status
		}
		if in.Summary != nil {
			body["summary"] = *in.Summary
		}
		var run wireRun
		if err := api.call(ctx, "PATCH", "/api/runs/"+in.Run, body, &run); err != nil {
			return nil, runOutput{}, err
		}
		return nil, runOutput{Run: summarize(&run), Graph: viewGraph(&run)}, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:  "plan_set_task",
		Title: "写入单个任务",
		Description: "新建或更新一个任务，返回该任务和最新的图投影（含 ready_task_ids），" +
			"所以写完不需要再单独校验一次。" +
			"看板会拒绝两种非法写入：依赖未完成就转 running，以及与活动任务抢同一个独占资源。",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in setTaskInput) (*mcp.CallToolResult, taskOutput, error) {
		var run wireRun
		path := "/api/runs/" + in.Run + "/tasks/" + in.ID
		if err := api.call(ctx, "PUT", path, taskBody(in.taskInput), &run); err != nil {
			return nil, taskOutput{}, err
		}
		return nil, taskOutput{Task: findTask(&run, in.ID), Graph: viewGraph(&run)}, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:  "plan_set_tasks",
		Title: "批量写入任务",
		Description: "一次写入多个任务，计划成形后把整张 DAG 一次写完就用这个。" +
			"整批在看板的一个事务里落盘：任何一条被拒，整批都不写，看板保持原样。" +
			"按给定顺序校验，所以「先把 T1 标 done，再让依赖它的 T2 转 running」可以放同一批。" +
			"返回写成功的、失败的原因和最终图投影。" +
			"整批被拒时 written 为空（确实一条都没落盘），failed 会列出本批的每一条任务、都挂同一条原因——" +
			"那是整批的拒绝理由，不代表每条任务各自都有问题；照原因改完再整批重发。",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in setTasksInput) (*mcp.CallToolResult, batchOutput, error) {
		out := batchOutput{Written: []string{}}
		var run wireRun
		if err := api.call(ctx, "PUT", "/api/runs/"+in.Run+"/tasks", batchBody(in.Tasks), &run); err != nil {
			// The board applies the batch atomically, so a rejection means nothing
			// landed: every task in the batch failed, all for the same reason.
			if len(in.Tasks) == 0 {
				return nil, out, err
			}
			out.Failed = map[string]string{}
			for _, task := range in.Tasks {
				out.Failed[task.ID] = err.Error()
			}
			// Report the board as it actually stands now — unchanged by this call.
			if graphErr := api.call(ctx, "GET", "/api/runs/"+in.Run, nil, &run); graphErr != nil {
				return nil, out, err
			}
			out.Graph = viewGraph(&run)
			return nil, out, nil
		}
		for _, task := range in.Tasks {
			out.Written = append(out.Written, task.ID)
		}
		out.Graph = viewGraph(&run)
		return nil, out, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:  "plan_graph",
		Title: "读图投影",
		Description: "只读：依赖图是否合法、哪些节点现在可派发、活动节点占着什么、其余节点卡在什么上。" +
			"调度每一轮只从 ready_task_ids 里选，并自己避开 write_scope 重叠。" +
			"valid 不为 true 时不得开始实施。",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in runInput) (*mcp.CallToolResult, graphView, error) {
		var run wireRun
		if err := api.call(ctx, "GET", "/api/runs/"+in.Run, nil, &run); err != nil {
			return nil, graphView{}, err
		}
		return nil, viewGraph(&run), nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "plan_get_run",
		Title:       "读取运行",
		Description: "取一条运行的全部任务、图投影，以及可选的最近活动记录。恢复上下文时用。",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in getRunInput) (*mcp.CallToolResult, fullRunOutput, error) {
		var run wireRun
		if err := api.call(ctx, "GET", "/api/runs/"+in.Run, nil, &run); err != nil {
			return nil, fullRunOutput{}, err
		}
		out := fullRunOutput{Run: summarize(&run), Tasks: viewTasks(&run), Graph: viewGraph(&run)}
		if in.IncludeEvents && len(run.Events) > 0 {
			start := len(run.Events) - 20
			if start < 0 {
				start = 0
			}
			out.Events = run.Events[start:]
		}
		return nil, out, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:  "plan_memory_list",
		Title: "列出项目记忆",
		Description: "列出某个项目下记的记忆，可选按 kind 过滤。每条都带 source。" +
			"勘察前先看这个，但列出来的每一条都只是上一轮留下的说法，不是本轮的事实：" +
			"都要连 source 一起交给本轮对应的勘察 lane 去核，lane 回来时要给出结论，" +
			"并且把 source 指的那一行按今天仓库里的样子原样引回来。" +
			"没有这条引文之前，不管是门禁命令、运行方式还是硬规则，都不许拿来用。" +
			"空列表不能证明这个项目从没记过东西——project 只要有一个字符对不上（大小写、多一层路径），" +
			"就会查出空结果而不是报错。理应有记忆却是空的时候，先核对 project 拼写是否和写入时完全一致，" +
			"别直接当成新项目重新勘察。",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in memoryListInput) (*mcp.CallToolResult, memoryListOutput, error) {
		if in.Kind != "" && strings.TrimSpace(in.Kind) == "" {
			return nil, memoryListOutput{}, fmt.Errorf("kind 全是空白：想不按类型过滤就别传这个字段，传空白会被当成没传，容易看不出发生了什么")
		}
		var wire wireMemoryList
		if err := api.call(ctx, "GET", "/api/memories?"+memoryListQuery(in.Project, in.Kind), nil, &wire); err != nil {
			return nil, memoryListOutput{}, err
		}
		if err := verifyMemoryList(in.Project, in.Kind, wire.Memories); err != nil {
			return nil, memoryListOutput{}, err
		}
		out := memoryListOutput{Memories: make([]memoryView, 0, len(wire.Memories))}
		for _, m := range wire.Memories {
			out.Memories = append(out.Memories, toMemoryView(m))
		}
		return nil, out, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:  "plan_memory_get",
		Title: "读取单条记忆",
		Description: "按 project+key 读一条记忆，返回值和 source。" +
			"读到的是上一轮留下的说法，不是本轮的事实：要用它，先按 source 把今天仓库里的那一行原样看一遍。" +
			"key 大小写不敏感——服务端只存小写，返回的 key 以服务端为准，可能跟传入的大小写不一样，别拿传入的那份去跟别处比对。",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in memoryKeyInput) (*mcp.CallToolResult, memoryView, error) {
		var wire wireMemory
		if err := api.call(ctx, "GET", memoryKeyPath(in.Project, in.Key), nil, &wire); err != nil {
			return nil, memoryView{}, err
		}
		if err := verifyMemoryEcho(in.Project, in.Key, wire); err != nil {
			return nil, memoryView{}, err
		}
		return nil, toMemoryView(wire), nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:  "plan_memory_add",
		Title: "写入一条记忆",
		Description: "新增或覆盖一条项目记忆，按 project+key upsert，同一 key 再写一次就是覆盖，不会重复。" +
			"source 必填且不能是空白——写清楚这是从哪个文件的哪一行，或者哪条命令的输出里读到的，" +
			"这是让记忆能被低成本证伪的关键，没有 source 的记忆不如不记。" +
			"返回的是服务端实际存下的那条（key 会被转成小写），照返回值汇报，不要照抄自己传入的 key。",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in memoryAddInput) (*mcp.CallToolResult, memoryView, error) {
		if strings.TrimSpace(in.Source) == "" {
			return nil, memoryView{}, fmt.Errorf("source 不能为空：写清楚这条记忆是从哪个文件/命令读出来的，没有出处的记忆没法判断是否过期")
		}
		var wire wireMemory
		if err := api.call(ctx, "POST", "/api/memories", memoryAddBody(in), &wire); err != nil {
			return nil, memoryView{}, err
		}
		if err := verifyMemoryEcho(in.Project, in.Key, wire); err != nil {
			return nil, memoryView{}, err
		}
		return nil, toMemoryView(wire), nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:  "plan_memory_delete",
		Title: "删除一条记忆",
		Description: "按 project+key 删除一条记忆；key 不存在会报错，不会静默当成功处理。" +
			"只删已经核过、确认不成立的那条。没核成——source 指的文件打不开、命令这轮跑不了——不算不成立，" +
			"这种就留着别动：下一轮看来，删掉的和从没记过的是一个样子。",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in memoryKeyInput) (*mcp.CallToolResult, memoryDeleteOutput, error) {
		var wire wireMemoryDeleted
		if err := api.call(ctx, "DELETE", memoryKeyPath(in.Project, in.Key), nil, &wire); err != nil {
			return nil, memoryDeleteOutput{}, err
		}
		if err := verifyMemoryDeleted(in.Project, in.Key, wire); err != nil {
			return nil, memoryDeleteOutput{}, err
		}
		return nil, memoryDeleteOutput{Deleted: wire.Deleted, Project: wire.Project}, nil
	})
}

// taskBody keeps the board's own patch semantics: a field left out is untouched,
// a list sent as an array replaces the stored one, and an empty array clears it.
func taskBody(in taskInput) map[string]any {
	body := map[string]any{}
	if in.Title != nil {
		body["title"] = *in.Title
	}
	if in.Status != nil {
		body["status"] = *in.Status
	}
	if in.Detail != nil {
		body["detail"] = *in.Detail
	}
	if in.Agent != nil {
		body["agent"] = *in.Agent
	}
	if in.DependsOn != nil {
		body["depends_on"] = *in.DependsOn
	}
	if in.WriteScope != nil {
		body["write_scope"] = *in.WriteScope
	}
	if in.ExclusiveResource != nil {
		body["exclusive_resource"] = *in.ExclusiveResource
	}
	return body
}

// batchBody wraps the same per-task bodies the single-task route takes, each
// carrying its own id, for the board's transactional batch route. Reusing
// taskBody keeps the list tri-state identical on both paths.
func batchBody(tasks []taskInput) map[string]any {
	entries := make([]map[string]any, 0, len(tasks))
	for _, task := range tasks {
		body := taskBody(task)
		body["id"] = task.ID
		entries = append(entries, body)
	}
	return map[string]any{"tasks": entries}
}

// encodeQueryRFC3986 renders a query string the way the board's own parser
// reads it, which url.Values.Encode() alone does not.
//
// Encode() follows the application/x-www-form-urlencoded convention and
// represents a space as '+'. The board parses the query string with Swift's
// URLComponents (Sources/BoardKit/API.swift's query()), which follows
// RFC 3986: '+' is a literal character there, and only %XX escapes are
// decoded. So a space sent as '+' arrives at the board as a literal '+', not
// a space — and `project` is documented as "项目路径或名称" and is routinely
// an absolute macOS path, where spaces are the common case, not a corner one.
// Concretely: encoding "/Users/zhang/My Project" through plain Encode() sends
// "...My+Project" on the wire, which URLComponents decodes to "My+Project"
// (a literal plus), not "My Project" — so a POST (project in the JSON body,
// unaffected by any of this) writes under the real path while every GET/
// DELETE (project in the query string) asks about a path with a literal '+'
// in it, finds no rows, and returns an empty result with no error at all.
//
// The fix: Encode() never emits a literal '+' for an actual '+' character in
// the input — that gets escaped to "%2B" — so every '+' left in its output
// represents an encoded space, and rewriting those to "%20" is safe and
// exactly matches what URLComponents decodes back to a real space.
func encodeQueryRFC3986(values url.Values) string {
	return strings.ReplaceAll(values.Encode(), "+", "%20")
}

// memoryProjectQuery builds the query string GET/DELETE /api/memories/<key>
// takes: just `project`, percent-encoded — project rides in the query string
// rather than the path because it may well be an absolute filesystem path,
// not a safe single path segment.
func memoryProjectQuery(project string) string {
	values := url.Values{}
	values.Set("project", project)
	return encodeQueryRFC3986(values)
}

// memoryListQuery builds GET /api/memories's query string: `project` always,
// `kind` only when the caller actually asked to filter — an empty (or
// whitespace-only) kind must stay absent, not turn into the literal string
// "kind=" (which the board would 400 on: an empty kind is invalid, not "no
// filter"). The value sent is trimmed, not raw: the board does not trim kind
// (MemoryKind's exact enum match has no fold or trim of its own), so a
// padded kind like " gate" would otherwise reach the board unchanged and 400
// with "unknown memory kind ' gate'" — a value the caller never actually
// typed as their intended filter.
func memoryListQuery(project, kind string) string {
	values := url.Values{}
	values.Set("project", project)
	if trimmedKind := strings.TrimSpace(kind); trimmedKind != "" {
		values.Set("kind", trimmedKind)
	}
	return encodeQueryRFC3986(values)
}

// memoryKeyPath builds the path+query GET and DELETE /api/memories/<key>
// share. Pulled out of both call sites so the percent-escaping of key (a
// caller could type anything here; the MCP layer does not itself enforce
// isValidMemoryKey's alphabet before forwarding) is one pure, tested function
// rather than inline string concatenation duplicated — and silently
// droppable — in two handlers.
func memoryKeyPath(project, key string) string {
	return "/api/memories/" + url.PathEscape(key) + "?" + memoryProjectQuery(project)
}

// memoryAddBody builds POST /api/memories's body. Unlike taskBody there is no
// tri-state here: every field is required on this route, so every field is
// always sent as given.
func memoryAddBody(in memoryAddInput) map[string]any {
	return map[string]any{
		"project": in.Project,
		"key":     in.Key,
		"value":   in.Value,
		"kind":    in.Kind,
		"source":  in.Source,
	}
}

func toMemoryView(m wireMemory) memoryView {
	return memoryView{
		Project:   m.Project,
		Key:       m.Key,
		Value:     m.Value,
		Kind:      m.Kind,
		Source:    m.Source,
		CreatedAt: m.CreatedAt,
		UpdatedAt: m.UpdatedAt,
	}
}

// verifyMemoryEcho guards against trusting a successful json.Decode by
// itself: a wrong-but-well-formed response decodes cleanly into wireMemory
// with every field zeroed, and would otherwise be reported to the agent as a
// real memory. It also catches a subtler case a bare non-empty check would
// miss — the board answering with someone else's record (wrong project, or a
// key that doesn't even match the one asked for).
//
// GET and POST both echo back the *stored* record, which the board already
// normalized before it ever reached SQL — mirroring
// Sources/BoardKit/Store.swift's normalizedProject (trims whitespace) and
// normalizedKey (trims, then lower-cases). So the comparison here applies the
// same normalization to the caller's input rather than comparing raw: a
// project with incidental leading/trailing whitespace round-trips to the same
// (trimmed) project, and a key differing only in case or whitespace
// round-trips to the same (trimmed, lower-cased) key. Comparing raw would
// misreport a whitespace-padded project as "a different project" when nothing
// happened but a trim — a false accusation that points at the board instead
// of at the caller's own input.
//
// The normalization is applied to the caller's side only; got is compared
// verbatim, the same asymmetry verifyMemoryDeleted documents at length. That
// is what makes the key comparison able to tell "the board folded the key
// correctly" apart from "the board did not fold it at all": folding both
// sides (strings.EqualFold) accepted a board echoing `Gate` for a row stored
// as `gate`, which is a row that is not in the table.
func verifyMemoryEcho(project, key string, got wireMemory) error {
	// Reachable on its own (not merely a weaker echo of the checks below) only
	// when project/key trim to empty: verifyMemoryEcho("", "", wireMemory{})
	// would pass both the project and key comparisons below trivially — both
	// reduce to "" == "" — with no guard here at all. For a non-empty
	// project/key that degenerate case is already caught below (a zeroed
	// got.Project/got.Key cannot equal a non-empty want value), so this branch
	// is belt-and-suspenders there; pinned by
	// TestVerifyMemoryEchoRejectsZeroedRecordEvenWithEmptyProjectAndKey rather
	// than dropped, since the empty-project/key case is real (the board
	// itself rejects an empty project, so a caller could plausibly hit this
	// before ever reaching the network).
	if got.Key == "" || got.Project == "" {
		return fmt.Errorf("看板返回的记忆缺少 key/project 字段，形状不对：%+v", got)
	}
	wantProject := strings.TrimSpace(project)
	if got.Project != wantProject {
		return fmt.Errorf("看板返回了别的项目的记忆：请求 project=%q，返回 project=%q", wantProject, got.Project)
	}
	wantKey := strings.ToLower(strings.TrimSpace(key))
	if got.Key != wantKey {
		return fmt.Errorf("看板返回了别的 key 的记忆：请求 key=%q，返回 key=%q", wantKey, got.Key)
	}
	// project and key can be right while source is empty — a different bug
	// (the board dropping a field, or a caller-side helper losing it before
	// the request went out) that a project/key-only check would miss entirely.
	// source is the one field this whole table exists to keep visible to the
	// agent, so a response missing it must not be handed over as a real memory.
	if strings.TrimSpace(got.Source) == "" {
		return fmt.Errorf("看板返回的记忆缺少 source：project=%q key=%q，没有出处就不该当真记忆用", got.Project, got.Key)
	}
	return nil
}

// verifyMemoryDeleted is verifyMemoryEcho's counterpart for DELETE, whose
// response is a {"deleted","project"} pair rather than a full memory.
//
// All three memory routes now answer with the board's *normalized* spelling:
// Store.deleteMemory returns the (project, key) pair it actually deleted and
// Sources/BoardKit/API.swift's DELETE branch encodes that pair, the way GET
// and POST already echoed the stored record. So the comparison here is the
// same shape as verifyMemoryEcho's — normalize the caller's input the way the
// board would, then require the response to match it exactly:
//
//   - project is trimmed only. Store.normalizedProject trims and deliberately
//     does not case-fold (MemoryTests.projectsAreNotCaseFolded pins that), so
//     folding here would accept a project the board never stored.
//   - key is trimmed and lower-cased, mirroring Store.normalizedKey.
//
// The normalization is applied to the caller's side only; got is compared
// verbatim. That asymmetry is the whole point. A caller legitimately types
// " Gate " and must not be told the delete went wrong, but a board that
// answers " proj " or "Gate" has named a row that is not the row it deleted,
// and naming the wrong row is exactly what this function exists to catch.
// Normalizing got as well (EqualFold, or trimming got.Deleted) would forgive
// the board for the one mistake worth reporting.
func verifyMemoryDeleted(project, key string, got wireMemoryDeleted) error {
	// Unreachable through plan_memory_delete against a real board, and kept
	// anyway. Checked rather than assumed: an empty/whitespace-only project
	// makes memoryProjectQuery emit "project=", which API.swift's
	// requiredQuery rejects with 400 ("must not be empty"), and a non-empty
	// but blank project dies one step later in Store.normalizedProject; an
	// empty key makes memoryKeyPath produce "/api/memories/?project=...",
	// which splits to 2 segments ("api", "memories") — verified with a
	// Foundation probe — and DELETE has no 2-segment memories route, so it
	// 404s at the default branch (it does not fall through to the list route,
	// which is GET-only). Either way board.call returns an error and this
	// function is never reached. It stays because it is the only check that
	// fires when project and key both normalize to empty: the two comparisons
	// below are satisfied trivially then ("" == ""), so a zeroed response
	// would otherwise be reported as a real delete. Pinned by
	// TestVerifyMemoryDeletedRejectsZeroedRecordEvenWithEmptyProjectAndKey.
	if got.Deleted == "" || got.Project == "" {
		return fmt.Errorf("看板返回的删除结果缺少字段，形状不对：%+v", got)
	}
	wantProject := strings.TrimSpace(project)
	if got.Project != wantProject {
		return fmt.Errorf("看板删除了别的项目下的记忆：请求 project=%q，返回 project=%q", wantProject, got.Project)
	}
	wantKey := strings.ToLower(strings.TrimSpace(key))
	if got.Deleted != wantKey {
		return fmt.Errorf("看板删除了别的 key：请求 key=%q，返回 deleted=%q", wantKey, got.Deleted)
	}
	return nil
}

// verifyMemoryList checks every entry the board handed back actually belongs
// to the query the caller made, rather than assuming a clean decode of the
// list means the filtering happened correctly.
//
// project is compared trimmed for the same reason verifyMemoryEcho compares
// it trimmed: store.memories(project:) normalizes project before querying,
// so every returned row's project is the board's trimmed value, not the
// caller's raw one. kind is compared trimmed too, matching memoryListQuery's
// own trim — comparing raw here while the query builder sends trimmed would
// silently stop matching the moment a caller passed a padded kind, the exact
// shape of asymmetry that caused the project bug this function already fixes
// once for project.
//
// What this function cannot do: prove a wrong-but-empty list wrong. It is a
// per-entry filter, so zero entries vacuously satisfy every check here —
// there is no oracle inside an empty list telling us whether "no rows for
// this exact project" is correct or is a caller-side typo/case/whitespace
// mismatch. That gap is real and is not something a per-entry check can
// close from the response alone; plan_memory_list's tool description warns
// the agent about it instead (a documentation mitigation, not a code one).
func verifyMemoryList(project, kind string, memories []wireMemory) error {
	wantProject := strings.TrimSpace(project)
	wantKind := strings.TrimSpace(kind)
	for _, m := range memories {
		if m.Project != wantProject {
			return fmt.Errorf("看板返回了别的项目的记忆：请求 project=%q，某条记录 project=%q（key=%q）", wantProject, m.Project, m.Key)
		}
		if wantKind != "" && m.Kind != wantKind {
			return fmt.Errorf("看板返回了类型不符的记忆：请求 kind=%q，某条记录 kind=%q（key=%q）", wantKind, m.Kind, m.Key)
		}
		if strings.TrimSpace(m.Source) == "" {
			return fmt.Errorf("看板返回的记忆缺少 source：project=%q key=%q，没有出处就不该当真记忆用", m.Project, m.Key)
		}
	}
	return nil
}
