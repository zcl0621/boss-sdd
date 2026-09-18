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

// batchBody does two things taskBody does not: it attaches each task's own id to
// its entry, and it preserves input order. Order is load-bearing — the board
// validates a batch incrementally, in the order given, so reordering entries turns
// the advertised "finish T1, then start T2" batch into a wholesale 409 while every
// order-insensitive batch still returns 200. Both mutations are silent without this.
func TestBatchBodyKeepsEntryOrderAndPairsEachIDWithItsOwnFields(t *testing.T) {
	body := batchBody([]taskInput{
		{ID: "T1", Status: ptr("done")},
		{ID: "T2", Status: ptr("running"), DependsOn: ptr([]string{"T1"})},
		{ID: "T3", Detail: ptr("只改说明")},
	})
	entries, ok := body["tasks"].([]map[string]any)
	if !ok {
		t.Fatalf("tasks must be a list of task bodies, got %#v", body["tasks"])
	}
	if len(entries) != 3 {
		t.Fatalf("expected three entries, got %d: %v", len(entries), entries)
	}

	// Input order, entry for entry. A reversed or map-ranged build passes every
	// other assertion here and still breaks the ordered-guard contract.
	if entries[0]["id"] != "T1" || entries[1]["id"] != "T2" || entries[2]["id"] != "T3" {
		t.Fatalf("entry order or ids not preserved: %v", entries)
	}

	// Each id must carry its own fields, not the first entry's or a neighbour's.
	if entries[0]["status"] != "done" {
		t.Fatalf("T1 lost its status: %v", entries[0])
	}
	if entries[1]["status"] != "running" {
		t.Fatalf("T2 lost its status: %v", entries[1])
	}
	if !reflect.DeepEqual(entries[1]["depends_on"], []string{"T1"}) {
		t.Fatalf("T2 lost its dependency: %#v", entries[1]["depends_on"])
	}
	if entries[2]["detail"] != "只改说明" {
		t.Fatalf("T3 lost its detail: %v", entries[2])
	}

	// Wrapping must not resurrect fields the caller left out: entry 0 named only a
	// status, so it carries exactly that plus its id, and no list key at all.
	for _, key := range []string{"depends_on", "write_scope", "exclusive_resource", "detail", "title"} {
		if _, present := entries[0][key]; present {
			t.Fatalf("untouched field %q must not be sent: %v", key, entries[0])
		}
	}
	if len(entries[0]) != 2 {
		t.Fatalf("expected only id and status on the first entry, got %v", entries[0])
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
