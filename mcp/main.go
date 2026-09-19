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
		Title:       "Plan SDD Board",
		Description: "Reads and writes plan-sdd runs, the task DAG and scheduling state on the local board app.",
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
	Title   string `json:"title" jsonschema:"Plan name: one line the user will recognize."`
	Project string `json:"project,omitempty" jsonschema:"Project path or name; tells apart plans that share a title."`
}

type updateRunInput struct {
	Run     string  `json:"run" jsonschema:"Run ID"`
	Status  *string `json:"status,omitempty" jsonschema:"Plan status: pending/planning/awaiting_confirmation/running/review/blocked/done"`
	Summary *string `json:"summary,omitempty" jsonschema:"Where the plan stands right now; write a conclusion someone can check."`
}

type taskInput struct {
	ID                string    `json:"id" jsonschema:"Task ID: unique and stable within the run, e.g. T1"`
	Title             *string   `json:"title,omitempty" jsonschema:"Task title; required when creating a task."`
	Status            *string   `json:"status,omitempty" jsonschema:"Task status: pending/running/review/blocked/done"`
	Detail            *string   `json:"detail,omitempty" jsonschema:"Checkable evidence of progress, verification output, a review verdict, or the reason for a block; dependencies and scope do not go here."`
	Agent             *string   `json:"agent,omitempty" jsonschema:"Who is actually on it, e.g. the subagent name it was dispatched to."`
	DependsOn         *[]string `json:"depends_on,omitempty" jsonschema:"Task IDs this one depends on. An array replaces the stored list wholesale, an empty array clears it, omitting the field leaves it untouched."`
	WriteScope        *[]string `json:"write_scope,omitempty" jsonschema:"Path prefixes this task will write to; required when creating a task. An array replaces the stored list wholesale, an empty array clears it, omitting the field leaves it untouched."`
	ExclusiveResource *[]string `json:"exclusive_resource,omitempty" jsonschema:"Exclusive resource identifiers, e.g. gate:full-suite. An array replaces the stored list wholesale, an empty array clears it, omitting the field leaves it untouched."`
}

type setTaskInput struct {
	Run string `json:"run" jsonschema:"Run ID"`
	taskInput
}

type setTasksInput struct {
	Run   string      `json:"run" jsonschema:"Run ID"`
	Tasks []taskInput `json:"tasks" jsonschema:"The tasks to write in one call; usually the whole DAG at once, after the plan has taken shape."`
}

type runInput struct {
	Run string `json:"run" jsonschema:"Run ID"`
}

type getRunInput struct {
	Run           string `json:"run" jsonschema:"Run ID"`
	IncludeEvents bool   `json:"include_events,omitempty" jsonschema:"Whether to include the 20 most recent activity records."`
}

type memoryListInput struct {
	Project string `json:"project" jsonschema:"Project path or name; keep it identical to plan_create_run's project."`
	Kind    string `json:"kind,omitempty" jsonschema:"Filter by kind: gate/run_recipe/convention/hard_rule/exclusive_resource/note. Leave it out to get everything."`
}

type memoryKeyInput struct {
	Project string `json:"project" jsonschema:"Project path or name"`
	Key     string `json:"key" jsonschema:"The memory's key. Case-insensitive; the server stores only lower case."`
}

type memoryAddInput struct {
	Project string `json:"project" jsonschema:"Project path or name"`
	Key     string `json:"key" jsonschema:"The memory's key; upserted by key within a project. ASCII letters, digits and - _ . only, at most 64 characters, stored lower-cased."`
	Value   string `json:"value" jsonschema:"The memory's content."`
	Kind    string `json:"kind" jsonschema:"Kind: gate/run_recipe/convention/hard_rule/exclusive_resource/note"`
	Source  string `json:"source" jsonschema:"Provenance: file + line number, or the command this value was read out of, so the memory stays cheap to falsify. Must not be empty."`
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
		Title: "Board status",
		Description: "Whether the board app is running, and which runs already exist on this machine. " +
			"Call this first when resuming a session, to claim the run you already have — " +
			"do not take over a different run just because its title looks similar. " +
			"The app is launched automatically if it is not already up.",
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
		Title:       "New run",
		Description: "Opens a run record for this plan and returns its run_id. Resuming the same plan reuses the original ID; do not create a second run for it.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in createRunInput) (*mcp.CallToolResult, runOutput, error) {
		if strings.TrimSpace(in.Title) == "" {
			return nil, runOutput{}, fmt.Errorf("title must not be empty")
		}
		var run wireRun
		body := map[string]any{"title": in.Title, "project": in.Project}
		if err := api.call(ctx, "POST", "/api/runs", body, &run); err != nil {
			return nil, runOutput{}, err
		}
		return nil, runOutput{Run: summarize(&run), Graph: viewGraph(&run)}, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:  "plan_update_run",
		Title: "Update plan status",
		Description: "Changes the plan's overall status or its progress summary. " +
			"Use awaiting_confirmation while the plan is waiting on the user, and blocked when an input or an external condition is missing — with the reason written down.",
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
		Title: "Write one task",
		Description: "Creates or updates one task and returns it together with the current graph projection (ready_task_ids included), " +
			"so there is no need to validate separately after writing. " +
			"The board refuses two illegal writes: moving to running while a dependency is unfinished, and taking an exclusive resource an active task already holds.",
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
		Title: "Write tasks in a batch",
		Description: "Writes several tasks at once; use it to lay down the whole DAG in one call after the plan has taken shape. " +
			"The batch lands inside a single board transaction: if any one entry is refused, nothing is written and the board is left exactly as it was. " +
			"Entries are validated in the order given, so \"mark T1 done, then move T2, which depends on it, to running\" can go in the same batch. " +
			"Returns what was written, why anything failed, and the resulting graph projection. " +
			"When the whole batch is refused, written is empty (nothing landed at all) and failed lists every task in the batch against the same one reason — " +
			"that is the batch's rejection reason, not a separate problem with each task; fix what it names and resend the whole batch.",
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
		Title: "Read the graph projection",
		Description: "Read-only: whether the dependency graph is valid, which nodes can be dispatched right now, what the active nodes are holding, and what the rest are stuck on. " +
			"Each scheduling pass picks only from ready_task_ids, and avoids write_scope overlap itself. " +
			"Do not start implementing while valid is not true.",
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
		Title:       "Read a run",
		Description: "Fetches one run's tasks, its graph projection, and optionally its most recent activity records. Use it when restoring context.",
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
		Title: "List project memory",
		Description: "Lists the memory entries recorded under a project, optionally filtered by kind. Every entry carries its source. " +
			"Read this before recon, but treat each line as a claim left behind by an earlier run, not as a fact about this one: " +
			"hand every entry, source and all, to this run's matching recon lane to check; the lane must come back with a verdict " +
			"and must quote the line the source points at exactly as the repository holds it today. " +
			"Until that quotation exists, nothing here may be used — not a gate command, not a way of running the project, not a hard rule. " +
			"An empty list is no proof the project never recorded anything: one character off in project (case, one extra path segment) " +
			"returns an empty result rather than an error. When memory should be there and the list is empty, check the project spelling against what was written " +
			"before treating this as a new project and starting recon over.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in memoryListInput) (*mcp.CallToolResult, memoryListOutput, error) {
		if in.Kind != "" && strings.TrimSpace(in.Kind) == "" {
			return nil, memoryListOutput{}, fmt.Errorf("kind is all whitespace: leave the field out when you do not want a kind filter. Blank is treated as absent, which makes it hard to see what happened")
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
		Title: "Read one memory entry",
		Description: "Reads one memory entry by project+key and returns its value and its source. " +
			"What comes back is a claim left behind by an earlier run, not a fact about this one: before using it, follow the source and read that line as the repository holds it today. " +
			"key is case-insensitive — the server stores only lower case, so the returned key is the server's spelling and may differ in case from the one sent; compare against the returned key, never against the one you passed in.",
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
		Title: "Write one memory entry",
		Description: "Adds or overwrites one project memory entry, upserted by project+key: writing the same key again overwrites it rather than duplicating it. " +
			"source is required and must not be blank — say which file and line, or which command's output, the value was read from. " +
			"That is what keeps a memory cheap to falsify; a memory with no source is worse than no memory at all. " +
			"A project holds at most 100 entries. The cap refuses only a write that would add a NEW key past it; an upsert onto a key that already exists is always allowed. " +
			"Being refused at the cap means the memory tidy-up is overdue: run the tidy-up, then retry this write once. " +
			"Do not delete or upsert over another entry to make room for the one in your hand — evicting for space is the one thing the cap was built to refuse. " +
			"What comes back is the record the server actually stored (key lower-cased); report the returned values, not the key you passed in.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in memoryAddInput) (*mcp.CallToolResult, memoryView, error) {
		if strings.TrimSpace(in.Source) == "" {
			return nil, memoryView{}, fmt.Errorf("source must not be empty: say which file or command this memory was read out of; with no provenance there is no way to tell whether it has gone stale")
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
		Title: "Delete one memory entry",
		Description: "Deletes one memory entry by project+key; a key that does not exist is an error, never silently treated as a success. " +
			"Delete only an entry you checked and found no longer holds. Failing to check it — the file the source names will not open, the command will not run this round — is not the same as finding it false, " +
			"so leave that one alone: to the next run, a deleted entry and one that was never recorded look exactly the same.",
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
// a space — and `project` is documented as "Project path or name" and is routinely
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
		return fmt.Errorf("the board returned a memory with no key/project field; wrong shape: %+v", got)
	}
	wantProject := strings.TrimSpace(project)
	if got.Project != wantProject {
		return fmt.Errorf("the board returned a memory from a different project: requested project=%q, got project=%q", wantProject, got.Project)
	}
	wantKey := strings.ToLower(strings.TrimSpace(key))
	if got.Key != wantKey {
		return fmt.Errorf("the board returned a memory under a different key: requested key=%q, got key=%q", wantKey, got.Key)
	}
	// project and key can be right while source is empty — a different bug
	// (the board dropping a field, or a caller-side helper losing it before
	// the request went out) that a project/key-only check would miss entirely.
	// source is the one field this whole table exists to keep visible to the
	// agent, so a response missing it must not be handed over as a real memory.
	if strings.TrimSpace(got.Source) == "" {
		return fmt.Errorf("the board returned a memory with no source: project=%q key=%q; with no provenance it must not be used as a real memory", got.Project, got.Key)
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
		return fmt.Errorf("the board's delete result is missing fields; wrong shape: %+v", got)
	}
	wantProject := strings.TrimSpace(project)
	if got.Project != wantProject {
		return fmt.Errorf("the board deleted a memory from a different project: requested project=%q, got project=%q", wantProject, got.Project)
	}
	wantKey := strings.ToLower(strings.TrimSpace(key))
	if got.Deleted != wantKey {
		return fmt.Errorf("the board deleted a different key: requested key=%q, got deleted=%q", wantKey, got.Deleted)
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
			return fmt.Errorf("the board returned a memory from a different project: requested project=%q, one record has project=%q (key=%q)", wantProject, m.Project, m.Key)
		}
		if wantKind != "" && m.Kind != wantKind {
			return fmt.Errorf("the board returned a memory of the wrong kind: requested kind=%q, one record has kind=%q (key=%q)", wantKind, m.Kind, m.Key)
		}
		if strings.TrimSpace(m.Source) == "" {
			return fmt.Errorf("the board returned a memory with no source: project=%q key=%q; with no provenance it must not be used as a real memory", m.Project, m.Key)
		}
	}
	return nil
}
