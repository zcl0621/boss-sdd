package main

// Mirrors of the board's JSON, kept to the fields this server actually forwards.
// The app remains the single source of truth for the schema.

type wireTask struct {
	ID                string   `json:"id"`
	Title             string   `json:"title"`
	Status            string   `json:"status"`
	Detail            string   `json:"detail"`
	Agent             string   `json:"agent"`
	DependsOn         []string `json:"depends_on"`
	WriteScope        []string `json:"write_scope"`
	ExclusiveResource []string `json:"exclusive_resource"`
}

type wireConflict struct {
	TaskID    string   `json:"task_id"`
	Resources []string `json:"resources"`
}

type wireBlocked struct {
	DependencyTaskIDs []string       `json:"dependency_task_ids"`
	ResourceConflicts []wireConflict `json:"resource_conflicts"`
}

type wireGraphError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type wireGraph struct {
	Valid             bool                   `json:"valid"`
	Errors            []wireGraphError       `json:"errors"`
	ReadyTaskIDs      []string               `json:"ready_task_ids"`
	TopologicalLayers [][]string             `json:"topological_layers"`
	WaitingOn         map[string][]string    `json:"waiting_on"`
	BlockedBy         map[string]wireBlocked `json:"blocked_by"`
}

type wireEvent struct {
	At     string `json:"at"`
	Action string `json:"action"`
	Task   string `json:"task"`
	Status string `json:"status"`
	Note   string `json:"note"`
}

type wireRun struct {
	ID      string      `json:"id"`
	Title   string      `json:"title"`
	Project string      `json:"project"`
	Status  string      `json:"status"`
	Summary string      `json:"summary"`
	Tasks   []wireTask  `json:"tasks"`
	Events  []wireEvent `json:"events"`
	Graph   wireGraph   `json:"graph"`
}

type wireRunList struct {
	Runs []wireRun `json:"runs"`
}

type wireHealth struct {
	OK      bool   `json:"ok"`
	Version string `json:"version"`
	Port    int    `json:"port"`
	Runs    int    `json:"runs"`
}
