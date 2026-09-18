package main

// The board's own JSON carries the full run — 21 tasks with prose detail and 200
// events runs to tens of kilobytes. These projections keep a tool result to what
// the scheduling agent actually reads.

type runSummary struct {
	RunID      string `json:"run_id"`
	Title      string `json:"title"`
	Project    string `json:"project"`
	Status     string `json:"status"`
	Summary    string `json:"summary,omitempty"`
	TaskCount  int    `json:"task_count"`
	DoneCount  int    `json:"done_count"`
	ReadyCount int    `json:"ready_count"`
}

type taskView struct {
	ID                string   `json:"id"`
	Title             string   `json:"title"`
	Status            string   `json:"status"`
	Agent             string   `json:"agent,omitempty"`
	Detail            string   `json:"detail,omitempty"`
	DependsOn         []string `json:"depends_on,omitempty"`
	WriteScope        []string `json:"write_scope,omitempty"`
	ExclusiveResource []string `json:"exclusive_resource,omitempty"`
}

type activeTask struct {
	ID                string   `json:"id"`
	Status            string   `json:"status"`
	Agent             string   `json:"agent,omitempty"`
	WriteScope        []string `json:"write_scope,omitempty"`
	ExclusiveResource []string `json:"exclusive_resource,omitempty"`
}

type blockedTask struct {
	ID                string   `json:"id"`
	WaitingOn         []string `json:"waiting_on,omitempty"`
	ResourceHeldBy    []string `json:"resource_held_by,omitempty"`
	ConflictResources []string `json:"conflict_resources,omitempty"`
}

// graphView is what the scheduler reads every round: whether the DAG is legal,
// which nodes may be dispatched now, what the active nodes are holding, and why
// everything else is waiting.
type graphView struct {
	Valid        bool          `json:"valid"`
	Errors       []string      `json:"errors,omitempty"`
	ReadyTaskIDs []string      `json:"ready_task_ids"`
	Layers       [][]string    `json:"topological_layers"`
	Active       []activeTask  `json:"active,omitempty"`
	Blocked      []blockedTask `json:"blocked,omitempty"`
}

func summarize(run *wireRun) runSummary {
	done := 0
	for _, task := range run.Tasks {
		if task.Status == "done" {
			done++
		}
	}
	return runSummary{
		RunID:      run.ID,
		Title:      run.Title,
		Project:    run.Project,
		Status:     run.Status,
		Summary:    run.Summary,
		TaskCount:  len(run.Tasks),
		DoneCount:  done,
		ReadyCount: len(run.Graph.ReadyTaskIDs),
	}
}

func viewGraph(run *wireRun) graphView {
	graph := run.Graph
	view := graphView{
		Valid:        graph.Valid,
		ReadyTaskIDs: graph.ReadyTaskIDs,
		Layers:       graph.TopologicalLayers,
	}
	if view.ReadyTaskIDs == nil {
		view.ReadyTaskIDs = []string{}
	}
	if view.Layers == nil {
		view.Layers = [][]string{}
	}
	for _, failure := range graph.Errors {
		view.Errors = append(view.Errors, failure.Message)
	}

	ready := map[string]bool{}
	for _, id := range graph.ReadyTaskIDs {
		ready[id] = true
	}
	for _, task := range run.Tasks {
		switch task.Status {
		case "running", "review":
			view.Active = append(view.Active, activeTask{
				ID:                task.ID,
				Status:            task.Status,
				Agent:             task.Agent,
				WriteScope:        task.WriteScope,
				ExclusiveResource: task.ExclusiveResource,
			})
			continue
		case "done":
			continue
		}
		if ready[task.ID] {
			continue
		}
		blocked := blockedTask{ID: task.ID, WaitingOn: graph.WaitingOn[task.ID]}
		for _, conflict := range graph.BlockedBy[task.ID].ResourceConflicts {
			blocked.ResourceHeldBy = append(blocked.ResourceHeldBy, conflict.TaskID)
			blocked.ConflictResources = append(blocked.ConflictResources, conflict.Resources...)
		}
		if len(blocked.WaitingOn) > 0 || len(blocked.ResourceHeldBy) > 0 {
			view.Blocked = append(view.Blocked, blocked)
		}
	}
	return view
}

func viewTasks(run *wireRun) []taskView {
	views := make([]taskView, 0, len(run.Tasks))
	for _, task := range run.Tasks {
		views = append(views, taskView{
			ID:                task.ID,
			Title:             task.Title,
			Status:            task.Status,
			Agent:             task.Agent,
			Detail:            task.Detail,
			DependsOn:         task.DependsOn,
			WriteScope:        task.WriteScope,
			ExclusiveResource: task.ExclusiveResource,
		})
	}
	return views
}

func findTask(run *wireRun, id string) *taskView {
	for _, task := range run.Tasks {
		if task.ID == id {
			view := taskView{
				ID: task.ID, Title: task.Title, Status: task.Status, Agent: task.Agent,
				Detail: task.Detail, DependsOn: task.DependsOn,
				WriteScope: task.WriteScope, ExclusiveResource: task.ExclusiveResource,
			}
			return &view
		}
	}
	return nil
}
