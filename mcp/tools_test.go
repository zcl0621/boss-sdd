package main

import (
	"reflect"
	"testing"
)

func ptr[T any](value T) *T { return &value }

// The board distinguishes "leave this list alone" from "make this list empty",
// and that distinction has to survive the MCP layer.
func TestTaskBodyOmitsUntouchedFields(t *testing.T) {
	body := taskBody(taskInput{ID: "T1", Detail: ptr("只改说明")})
	if _, present := body["depends_on"]; present {
		t.Fatalf("omitted list must not be sent: %v", body)
	}
	if body["detail"] != "只改说明" {
		t.Fatalf("detail not forwarded: %v", body)
	}
	if len(body) != 1 {
		t.Fatalf("only the named field should be sent, got %v", body)
	}
}

func TestTaskBodyForwardsEmptyListAsClear(t *testing.T) {
	body := taskBody(taskInput{ID: "T2", DependsOn: ptr([]string{})})
	value, present := body["depends_on"]
	if !present {
		t.Fatal("an empty list means clear and must be sent")
	}
	if !reflect.DeepEqual(value, []string{}) {
		t.Fatalf("expected empty slice, got %#v", value)
	}
}

func TestViewGraphSeparatesActiveFromBlocked(t *testing.T) {
	run := &wireRun{
		Tasks: []wireTask{
			{ID: "T1", Status: "running", Agent: "implementer", ExclusiveResource: []string{"gate:tests"}},
			{ID: "T2", Status: "pending", DependsOn: []string{"T1"}},
			{ID: "T3", Status: "pending", ExclusiveResource: []string{"gate:tests"}},
			{ID: "T4", Status: "done"},
		},
		Graph: wireGraph{
			Valid:             true,
			ReadyTaskIDs:      []string{"T3"},
			TopologicalLayers: [][]string{{"T1", "T3", "T4"}, {"T2"}},
			WaitingOn:         map[string][]string{"T2": {"T1"}},
			BlockedBy: map[string]wireBlocked{
				"T3": {ResourceConflicts: []wireConflict{{TaskID: "T1", Resources: []string{"gate:tests"}}}},
			},
		},
	}

	view := viewGraph(run)
	if len(view.Active) != 1 || view.Active[0].ID != "T1" {
		t.Fatalf("active should hold only the running task: %#v", view.Active)
	}
	if len(view.Active[0].ExclusiveResource) != 1 {
		t.Fatal("an active task must report what it is holding")
	}
	// T3 is in ready_task_ids, so it is not reported as blocked even though it
	// would be refused — the write guard is what enforces that, not the ready set.
	if len(view.Blocked) != 1 || view.Blocked[0].ID != "T2" {
		t.Fatalf("blocked should list T2 only: %#v", view.Blocked)
	}
	if !reflect.DeepEqual(view.Blocked[0].WaitingOn, []string{"T1"}) {
		t.Fatalf("T2 must report what it waits on: %#v", view.Blocked[0])
	}
}

func TestSummarizeCountsProgress(t *testing.T) {
	run := &wireRun{
		ID: "abc", Title: "示例", Status: "running",
		Tasks: []wireTask{{Status: "done"}, {Status: "done"}, {Status: "pending"}},
		Graph: wireGraph{ReadyTaskIDs: []string{"T3"}},
	}
	got := summarize(run)
	if got.DoneCount != 2 || got.TaskCount != 3 || got.ReadyCount != 1 {
		t.Fatalf("unexpected counts: %#v", got)
	}
}
