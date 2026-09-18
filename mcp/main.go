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
