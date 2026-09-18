package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
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

// ---- memory query builders ----

// decodeLikeURLComponents mirrors how the board's own parser reads a query
// value (Sources/BoardKit/API.swift's query(), backed by Swift's
// URLComponents): only %XX escapes are decoded, and '+' stays a literal
// character. This is deliberately NOT url.QueryUnescape/url.ParseQuery, which
// follow the different application/x-www-form-urlencoded convention where
// '+' means space — using either of those to check round-tripping would
// hide exactly the bug round 3 found, rather than exposing it.
func decodeLikeURLComponents(t *testing.T, raw string) string {
	t.Helper()
	decoded, err := url.PathUnescape(raw)
	if err != nil {
		t.Fatalf("could not decode %q: %v", raw, err)
	}
	return decoded
}

// project rides in the query string precisely because it may be an absolute
// filesystem path — slashes, colons and spaces included — so it must survive
// a round trip through percent-encoding rather than being pasted in raw.
//
// This pins the round 3 finding directly: url.Values.Encode() alone encodes
// a space as '+' (the x-www-form-urlencoded convention), but the board reads
// the query with Swift's URLComponents, which follows RFC 3986 and treats
// '+' as a literal character — so a space sent as '+' arrives at the board
// as a literal '+', not a space. The wire bytes below are exactly what
// memoryProjectQuery puts on the wire for a path containing a space.
func TestMemoryProjectQueryEncodesPath(t *testing.T) {
	got := memoryProjectQuery("/Users/zhang/Project/boss sdd")
	want := "project=%2FUsers%2Fzhang%2FProject%2Fboss%20sdd"
	if got != want {
		t.Fatalf("expected the space escaped as %%20 (RFC 3986 — what the board's URLComponents parser decodes), got %q", got)
	}
}

// Same bug, proven via round-trip decoding instead of a hard-coded string:
// decode the query value the way the board actually decodes it and check we
// get the original project back. Under the old (unfixed) encoding this fails
// with "/Users/zhang/My+Project" — a literal plus where the space was.
func TestMemoryProjectQueryRoundTripsUnderTheBoardsOwnDecodingRules(t *testing.T) {
	original := "/Users/zhang/My Project"
	query := memoryProjectQuery(original)
	const prefix = "project="
	if !strings.HasPrefix(query, prefix) {
		t.Fatalf("expected query to start with %q, got %q", prefix, query)
	}
	decoded := decodeLikeURLComponents(t, strings.TrimPrefix(query, prefix))
	if decoded != original {
		t.Fatalf("round trip through the board's own (RFC 3986) decoding failed: wire bytes %q decoded back to %q, want %q", query, decoded, original)
	}
}

func TestMemoryListQueryOmitsEmptyKind(t *testing.T) {
	got := memoryListQuery("proj", "")
	if got != "project=proj" {
		t.Fatalf("an empty kind must not appear at all (not even as kind=), got %q", got)
	}
}

// A whitespace-only kind is the caller having (probably accidentally) asked
// to filter by nothing; it must be dropped the same way an empty kind is,
// not sent to the board where it would 400.
func TestMemoryListQueryOmitsWhitespaceOnlyKind(t *testing.T) {
	got := memoryListQuery("proj", "   ")
	if got != "project=proj" {
		t.Fatalf("a whitespace-only kind must be dropped like an empty one, got %q", got)
	}
}

// The board does not trim kind (MemoryKind's enum match is exact, no fold or
// trim), so a padded kind must be trimmed on our side before it goes out —
// otherwise it 400s as "unknown memory kind ' gate'", naming a value with
// whitespace the caller never intended as part of it.
func TestMemoryListQueryTrimsPaddedKind(t *testing.T) {
	got := memoryListQuery("proj", " gate ")
	if got != "kind=gate&project=proj" { // url.Values.Encode() sorts keys alphabetically
		t.Fatalf("expected the kind sent trimmed, got %q", got)
	}
}

func TestMemoryListQueryIncludesKindWhenGiven(t *testing.T) {
	got := memoryListQuery("proj", "gate")
	values, err := url.ParseQuery(got)
	if err != nil {
		t.Fatalf("query string did not parse: %v", err)
	}
	if values.Get("project") != "proj" || values.Get("kind") != "gate" {
		t.Fatalf("expected both project and kind, got %q", got)
	}
}

// ---- memoryKeyPath: the same encoding fix applies to the path segment ----

func TestMemoryKeyPathEscapesKeyForPathSegment(t *testing.T) {
	got := memoryKeyPath("proj", "a/b c")
	want := "/api/memories/a%2Fb%20c?project=proj"
	if got != want {
		t.Fatalf("expected the key percent-escaped as a path segment, got %q", got)
	}
}

// Path escaping (url.PathEscape) already renders a space as %20, unlike
// url.Values.Encode() — so the key side of this never had round 3's bug. This
// pins that a space in project (query side) and a space in key (path side)
// both come out correctly at once.
func TestMemoryKeyPathEscapesSpacesInBothProjectAndKey(t *testing.T) {
	got := memoryKeyPath("/Users/zhang/My Project", "gate check")
	want := "/api/memories/gate%20check?project=%2FUsers%2Fzhang%2FMy%20Project"
	if got != want {
		t.Fatalf("expected spaces escaped as %%20 on both sides, got %q", got)
	}
}

// ---- memoryAddBody: every field required, none omitted ----

func TestMemoryAddBodyForwardsAllFields(t *testing.T) {
	body := memoryAddBody(memoryAddInput{
		Project: "p", Key: "Gate.Swift-Test", Value: "swift test", Kind: "gate", Source: "mcp/main.go:1",
	})
	want := map[string]any{
		"project": "p", "key": "Gate.Swift-Test", "value": "swift test", "kind": "gate", "source": "mcp/main.go:1",
	}
	if !reflect.DeepEqual(body, want) {
		t.Fatalf("expected every field forwarded verbatim, got %#v", body)
	}
}

// ---- toMemoryView: a straight field-for-field copy, source included ----

func TestToMemoryViewCarriesSource(t *testing.T) {
	view := toMemoryView(wireMemory{
		Project: "p", Key: "gate.swift-test", Value: "swift test", Kind: "gate",
		Source: "mcp/main.go:1", CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-02T00:00:00Z",
	})
	want := memoryView{
		Project: "p", Key: "gate.swift-test", Value: "swift test", Kind: "gate",
		Source: "mcp/main.go:1", CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-02T00:00:00Z",
	}
	if !reflect.DeepEqual(view, want) {
		t.Fatalf("expected a field-for-field copy, got %#v", view)
	}
}

// ---- verifyMemoryEcho: catches a decode that "succeeded" into garbage ----

func TestVerifyMemoryEchoAcceptsMatchingRecord(t *testing.T) {
	err := verifyMemoryEcho("proj", "Gate.Swift-Test", wireMemory{Project: "proj", Key: "gate.swift-test", Source: "src"})
	if err != nil {
		t.Fatalf("case-folded key match must be accepted: %v", err)
	}
}

func TestVerifyMemoryEchoRejectsZeroedRecord(t *testing.T) {
	// This is the exact shape a squatter or a wrong-route bug produces: Decode
	// succeeds, every field is the zero value.
	err := verifyMemoryEcho("proj", "gate", wireMemory{})
	if err == nil {
		t.Fatal("a zeroed response must not be accepted as a real memory")
	}
}

// The zeroed-record guard is dead weight for a non-empty project/key (the
// mismatch checks below already catch it then) — it is load-bearing only
// when project and key both trim to empty, where the mismatch checks would
// otherwise pass trivially ("" == "" and EqualFold("", "")). Pinned rather
// than silently left to rot as unreachable code.
func TestVerifyMemoryEchoRejectsZeroedRecordEvenWithEmptyProjectAndKey(t *testing.T) {
	err := verifyMemoryEcho("", "", wireMemory{})
	if err == nil {
		t.Fatal("an all-empty response must not be accepted just because the request also had empty project/key")
	}
}

func TestVerifyMemoryEchoRejectsWrongProject(t *testing.T) {
	err := verifyMemoryEcho("proj-a", "gate", wireMemory{Project: "proj-b", Key: "gate"})
	if err == nil {
		t.Fatal("a memory from a different project must be rejected")
	}
}

func TestVerifyMemoryEchoRejectsWrongKey(t *testing.T) {
	err := verifyMemoryEcho("proj", "gate", wireMemory{Project: "proj", Key: "convention"})
	if err == nil {
		t.Fatal("a memory under a different key must be rejected")
	}
}

// source is the whole point of this table; a response with the right
// project and key but no source must not reach the agent as a real memory.
func TestVerifyMemoryEchoRejectsMissingSource(t *testing.T) {
	err := verifyMemoryEcho("proj", "gate", wireMemory{Project: "proj", Key: "gate", Source: "   "})
	if err == nil {
		t.Fatal("a matching project/key with a blank source must still be rejected")
	}
}

// ---- verifyMemoryDeleted ----

func TestVerifyMemoryDeletedAcceptsMatchingCaseFoldedKey(t *testing.T) {
	err := verifyMemoryDeleted("proj", "Gate.Swift-Test", wireMemoryDeleted{Deleted: "gate.swift-test", Project: "proj"})
	if err != nil {
		t.Fatalf("case-folded match must be accepted: %v", err)
	}
}

func TestVerifyMemoryDeletedRejectsWrongKey(t *testing.T) {
	err := verifyMemoryDeleted("proj", "gate", wireMemoryDeleted{Deleted: "other", Project: "proj"})
	if err == nil {
		t.Fatal("deleting the wrong key must be reported, not swallowed")
	}
}

// Same reachability note as verifyMemoryEcho's pinned zeroed-record case.
func TestVerifyMemoryDeletedRejectsZeroedRecordEvenWithEmptyProjectAndKey(t *testing.T) {
	err := verifyMemoryDeleted("", "", wireMemoryDeleted{})
	if err == nil {
		t.Fatal("an all-empty delete response must not be accepted just because the request also had empty project/key")
	}
}

// ---- verifyMemoryList ----
//
// Note what this section does NOT contain: a test asserting that a wrong
// project produces an empty (rather than erroring) list. There isn't one to
// write — a per-entry filter over zero entries has nothing to check, so an
// empty list is not verifiable from the response alone. See verifyMemoryList's
// doc comment; the mitigation for that gap is in plan_memory_list's tool
// description, not here.

func TestVerifyMemoryListRejectsForeignProjectEntry(t *testing.T) {
	err := verifyMemoryList("proj-a", "", []wireMemory{{Project: "proj-a", Key: "k1", Source: "src"}, {Project: "proj-b", Key: "k2", Source: "src"}})
	if err == nil {
		t.Fatal("a list mixing in another project's memory must be rejected")
	}
}

func TestVerifyMemoryListRejectsMismatchedKindWhenFilterGiven(t *testing.T) {
	err := verifyMemoryList("proj", "gate", []wireMemory{{Project: "proj", Key: "k1", Kind: "note", Source: "src"}})
	if err == nil {
		t.Fatal("an entry not matching the requested kind filter must be rejected")
	}
}

// The kind filter is compared trimmed on both sides — the presence check
// ("was a filter even requested") and the per-entry comparison — matching
// memoryListQuery's own trim. Comparing raw here while the query builder
// sends trimmed would silently stop matching a padded kind, the same
// asymmetry that caused the project bug this function already guards against
// for project.
func TestVerifyMemoryListTrimsKindLikeTheQueryBuilderDoes(t *testing.T) {
	err := verifyMemoryList("proj", " gate ", []wireMemory{{Project: "proj", Key: "k1", Kind: "gate", Source: "src"}})
	if err != nil {
		t.Fatalf("a padded kind filter must be compared trimmed, like the query builder sends it: %v", err)
	}
}

func TestVerifyMemoryListAcceptsUnfilteredMixedKinds(t *testing.T) {
	err := verifyMemoryList("proj", "", []wireMemory{{Project: "proj", Key: "k1", Kind: "note", Source: "src"}, {Project: "proj", Key: "k2", Kind: "gate", Source: "src"}})
	if err != nil {
		t.Fatalf("no kind filter means any kind is fine: %v", err)
	}
}

// source is required on every read path, list included: a memory table
// where source can silently go missing from a list entry defeats the reason
// the table exists just as much as a missing source on a single get would.
func TestVerifyMemoryListRejectsMissingSource(t *testing.T) {
	err := verifyMemoryList("proj", "", []wireMemory{{Project: "proj", Key: "k1", Kind: "note", Source: "  "}})
	if err == nil {
		t.Fatal("a listed entry with a blank source must be rejected")
	}
}

// ---- round 2: comparisons must mirror the board's own normalization,
// not the caller's raw input ----
//
// Sources/BoardKit/Store.swift's normalizedProject trims whitespace before a
// project ever reaches SQL, and GET/POST echo back that stored (trimmed)
// value. A caller passing a whitespace-padded project is not sending "a
// different project" — comparing raw would misreport a correct round trip as
// the board returning someone else's record.
func TestVerifyMemoryEchoTrimsProjectLikeTheBoardDoes(t *testing.T) {
	err := verifyMemoryEcho(" /Users/zhang/Project/boss-sdd ", "gate", wireMemory{
		Project: "/Users/zhang/Project/boss-sdd", Key: "gate", Source: "src",
	})
	if err != nil {
		t.Fatalf("a whitespace-padded project must be compared trimmed, like the board compares it: %v", err)
	}
}

// normalizedKey trims *and* lower-cases; EqualFold alone (round 1) handles
// the fold but not the trim.
func TestVerifyMemoryEchoTrimsAndFoldsKeyLikeTheBoardDoes(t *testing.T) {
	err := verifyMemoryEcho("proj", " Gate.Swift-Test ", wireMemory{Project: "proj", Key: "gate.swift-test", Source: "src"})
	if err != nil {
		t.Fatalf("a whitespace-padded, mixed-case key must be compared trimmed and folded: %v", err)
	}
}

// The verifyMemoryEcho counterpart of
// TestVerifyMemoryDeletedRejectsAnUnfoldedKeyEcho, and the hole
// strings.EqualFold left open on this side. Store.normalizedKey lower-cases
// before the row is ever written, so GET and POST echo back `gate`; a board
// answering `Gate` has named a key that is not in the table. Folding both
// sides made the check unable to tell "the board folded the key correctly"
// apart from "the board did not fold it at all" — the one mistake worth
// reporting.
func TestVerifyMemoryEchoRejectsAnUnfoldedKeyEcho(t *testing.T) {
	err := verifyMemoryEcho("proj", "Gate", wireMemory{Project: "proj", Key: "Gate", Source: "src"})
	if err == nil {
		t.Fatal("the board stores keys lower-cased; an unfolded echo names a row that does not exist and must be reported")
	}
	if !strings.Contains(err.Error(), "别的 key") {
		t.Fatalf("expected the wrong-key message, got %v", err)
	}
}

// The padded half, mirroring TestVerifyMemoryDeletedRejectsAPaddedKeyEcho.
// The board never stores a padded key, so a padded echo is the board's own
// bug rather than the caller's input leaking through. EqualFold already
// rejected this one; it is pinned so the strict form keeps rejecting it.
func TestVerifyMemoryEchoRejectsAPaddedKeyEcho(t *testing.T) {
	err := verifyMemoryEcho("proj", "gate", wireMemory{Project: "proj", Key: " gate ", Source: "src"})
	if err == nil {
		t.Fatal("a whitespace-padded echoed key is not a key the board can have stored")
	}
}

// store.memories(project:) normalizes project the same way memory(project:key:)
// does, so every listed row's project is the board's trimmed value too.
func TestVerifyMemoryListTrimsProjectLikeTheBoardDoes(t *testing.T) {
	err := verifyMemoryList(" proj ", "", []wireMemory{{Project: "proj", Key: "k1", Source: "src"}})
	if err != nil {
		t.Fatalf("a whitespace-padded project must be compared trimmed here too: %v", err)
	}
}

// DELETE now answers with the board's normalized (project, key) pair, the way
// GET and POST always did: Store.deleteMemory returns what it removed and
// API.swift's DELETE branch encodes that. So the caller's side is normalized
// and the response must match exactly — a padded, mixed-case caller spelling
// still verifies clean, which is the case the strict form must not break.
func TestVerifyMemoryDeletedAcceptsTheNormalizedEchoForAPaddedMixedCaseCaller(t *testing.T) {
	err := verifyMemoryDeleted(" proj ", " Gate ", wireMemoryDeleted{Deleted: "gate", Project: "proj"})
	if err != nil {
		t.Fatalf("a caller typing \" Gate \" against project \" proj \" must still verify clean: %v", err)
	}
}

// The hole the old `got.Project != project && got.Project != trimmedProject`
// pair of accepted spellings left open. Store.normalizedProject trims before the row is ever
// touched, so a board answering with the caller's untrimmed project has named
// a project it did not delete from. The old form accepted it because the
// caller's raw spelling was one of the two accepted answers.
func TestVerifyMemoryDeletedRejectsAnUntrimmedProjectEcho(t *testing.T) {
	err := verifyMemoryDeleted(" proj ", "gate", wireMemoryDeleted{Deleted: "gate", Project: " proj "})
	if err == nil {
		t.Fatal("a board echoing back the caller's untrimmed project has not named the row it deleted; that must be reported")
	}
	if !strings.Contains(err.Error(), "别的项目") {
		t.Fatalf("expected the wrong-project message, got %v", err)
	}
}

// The matching hole on the key side, which `strings.EqualFold` could not see.
// Store.normalizedKey lower-cases before the DELETE runs, so the deleted row
// is `gate`; a board answering `Gate` is naming a key that is not in the
// table. EqualFold called that a match.
func TestVerifyMemoryDeletedRejectsAnUnfoldedKeyEcho(t *testing.T) {
	err := verifyMemoryDeleted("proj", "Gate", wireMemoryDeleted{Deleted: "Gate", Project: "proj"})
	if err == nil {
		t.Fatal("the board stores keys lower-cased; an unfolded echo names a row that does not exist and must be reported")
	}
	if !strings.Contains(err.Error(), "别的 key") {
		t.Fatalf("expected the wrong-key message, got %v", err)
	}
}

// Trimming got.Deleted was the other half of the old tolerance. The board
// never stores a padded key, so a padded echo is the board's own bug, not the
// caller's input leaking through.
func TestVerifyMemoryDeletedRejectsAPaddedKeyEcho(t *testing.T) {
	err := verifyMemoryDeleted("proj", "gate", wireMemoryDeleted{Deleted: " gate ", Project: "proj"})
	if err == nil {
		t.Fatal("a whitespace-padded deleted key is not a key the board can have stored")
	}
}

// ---- end-to-end against an HTTP double of the board's memory contract ----
//
// No real BossSDD.app was reachable in this session: the app process starts
// but never opens :18888 here (checked with `lsof -nP -iTCP:18888
// -sTCP:LISTEN`), most likely for lack of a real window-server session in
// this sandbox. So this exercises the full path a tool actually takes —
// query-string building, board.call, and the verify*/toMemoryView shape
// checks together — against a double that reproduces the exact contract
// quirks called out in the task: key lower-cased server-side, POST answering
// 200 (not 201), {"error":{"code","message"}} on failure, and the two
// distinct 400s for an absent vs. empty `project`. This is a double's output,
// not the real app's.
// Mirrors Sources/BoardKit/Store.swift's normalizedProject/normalizedKey:
// project is trimmed only, key is trimmed and lower-cased. Reproduced here
// (rather than just lower-casing the key like round 1 did) because that
// asymmetry is exactly what round 2 of this task found the verifiers missing.
func doubleNormalizedProject(project string) string { return strings.TrimSpace(project) }
func doubleNormalizedKey(key string) string         { return strings.ToLower(strings.TrimSpace(key)) }

// doubleQueryValue reads one query parameter the way the board's own parser
// does — Swift's URLComponents, RFC 3986 rules, '+' left literal — rather
// than the way r.URL.Query() reads it (Go's x-www-form-urlencoded rules,
// '+' decoded as space).
//
// This distinction is the whole round 3 bug: with r.URL.Query(), a project
// containing a space sent (before the fix) as a literal '+' would decode
// back to a space here, silently repairing memoryProjectQuery's mistake —
// the double would then agree with the tool code even though the real board
// does not, so the test proves nothing. Reported present separately from the
// decoded value, mirroring requiredQuery's absent/empty distinction.
func doubleQueryValue(rawQuery, name string) (value string, present bool) {
	for _, pair := range strings.Split(rawQuery, "&") {
		if pair == "" {
			continue
		}
		key, val, _ := strings.Cut(pair, "=")
		decodedKey, err := url.PathUnescape(key)
		if err != nil {
			continue
		}
		if decodedKey != name {
			continue
		}
		decodedVal, err := url.PathUnescape(val)
		if err != nil {
			decodedVal = val
		}
		return decodedVal, true
	}
	return "", false
}

// doubleSegments splits the request path into per-segment-decoded pieces the
// way Sources/BoardKit/API.swift's route() does:
//
//	let segments = path.split(separator: "/").map { $0.removingPercentEncoding ?? ... }
//
// i.e. split on raw "/" FIRST, decode each piece SECOND. This is
// deliberately not r.URL.Path, which Go's net/url decodes as a whole before
// splitting — so a %2F in one segment silently becomes a real "/" and
// produces an extra segment indistinguishable from a caller who forgot to
// escape a "/" in the first place. Using r.URL.EscapedPath() (still
// percent-encoded) and decoding piece by piece is what actually lets this
// double catch a dropped url.PathEscape on the key.
func doubleSegments(r *http.Request) []string {
	var segments []string
	for _, part := range strings.Split(r.URL.EscapedPath(), "/") {
		if part == "" {
			continue
		}
		if decoded, err := url.PathUnescape(part); err == nil {
			segments = append(segments, decoded)
		} else {
			segments = append(segments, part)
		}
	}
	return segments
}

func newMemoryContractDouble(t *testing.T) *board {
	t.Helper()
	type record struct{ project, key, value, kind, source, createdAt, updatedAt string }
	store := map[string]record{}

	writeErr := func(w http.ResponseWriter, status int, code, message string) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": message}})
	}
	// requireProject deliberately returns the RAW query value, unnormalized —
	// matching Sources/BoardKit/API.swift's requiredQuery, which only checks
	// presence/non-emptiness. Normalization happens one layer down, inside
	// Store, on the value each route actually stores or queries with. Decoded
	// via doubleQueryValue (RFC 3986, '+' literal), not r.URL.Query() (which
	// would decode '+' as space and paper over round 3's bug).
	requireProject := func(w http.ResponseWriter, r *http.Request) (string, bool) {
		project, present := doubleQueryValue(r.URL.RawQuery, "project")
		if !present {
			writeErr(w, 400, "invalid_request", "missing query parameter 'project'")
			return "", false
		}
		if project == "" {
			writeErr(w, 400, "invalid_request", "query parameter 'project' must not be empty")
			return "", false
		}
		return project, true
	}
	encodeRecord := func(w http.ResponseWriter, rec record) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		json.NewEncoder(w).Encode(map[string]string{
			"project": rec.project, "key": rec.key, "value": rec.value, "kind": rec.kind, "source": rec.source,
			"created_at": rec.createdAt, "updated_at": rec.updatedAt,
		})
	}

	handler := func(w http.ResponseWriter, r *http.Request) {
		segments := doubleSegments(r)
		isAPI := len(segments) >= 2 && segments[0] == "api"

		switch {
		case r.Method == "GET" && isAPI && len(segments) == 2 && segments[1] == "health":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(200)
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "version": "double", "port": 18888, "runs": 0})

		case r.Method == "POST" && isAPI && len(segments) == 2 && segments[1] == "memories":
			var body struct{ Project, Key, Value, Kind, Source string }
			json.NewDecoder(r.Body).Decode(&body)
			if strings.TrimSpace(body.Source) == "" {
				writeErr(w, 400, "invalid_request", "source must not be empty")
				return
			}
			project := doubleNormalizedProject(body.Project)
			key := doubleNormalizedKey(body.Key)
			rec := record{project: project, key: key, value: body.Value, kind: body.Kind, source: body.Source,
				createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z"}
			store[project+"\x00"+key] = rec
			encodeRecord(w, rec) // upsert: always 200, never 201

		case r.Method == "GET" && isAPI && len(segments) == 2 && segments[1] == "memories":
			rawProject, ok := requireProject(w, r)
			if !ok {
				return
			}
			project := doubleNormalizedProject(rawProject)
			kind, _ := doubleQueryValue(r.URL.RawQuery, "kind")
			memories := []map[string]string{}
			for _, rec := range store {
				if rec.project != project {
					continue
				}
				if kind != "" && rec.kind != kind {
					continue
				}
				memories = append(memories, map[string]string{
					"project": rec.project, "key": rec.key, "value": rec.value, "kind": rec.kind, "source": rec.source,
					"created_at": rec.createdAt, "updated_at": rec.updatedAt,
				})
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(200)
			json.NewEncoder(w).Encode(map[string]any{"memories": memories})

		// GET-by-key echoes the *stored* (normalized) record, same as list —
		// this route goes through Store.memory(project:key:), which normalizes
		// both before querying and returns the decoded row. Routing requires
		// EXACTLY 3 segments (api, memories, key) the way
		// Sources/BoardKit/API.swift's `parts.count == 3` does — a key
		// forwarded to the wire with an unescaped "/" produces a 4th segment
		// and falls through to "no route" instead of silently matching here,
		// which is what actually makes this double sensitive to a dropped
		// url.PathEscape on the key.
		case r.Method == "GET" && isAPI && len(segments) == 3 && segments[1] == "memories":
			rawProject, ok := requireProject(w, r)
			if !ok {
				return
			}
			project := doubleNormalizedProject(rawProject)
			key := doubleNormalizedKey(segments[2])
			rec, found := store[project+"\x00"+key]
			if !found {
				writeErr(w, 404, "not_found", fmt.Sprintf("memory %s not found for project %s", key, project))
				return
			}
			encodeRecord(w, rec)

		// DELETE looks the record up by its normalized project+key and echoes
		// back that same normalized pair, reproducing
		// Sources/BoardKit/API.swift's DELETE branch as it now stands:
		// `store.deleteMemory` returns the (project, key) it actually removed
		// and the route encodes `["deleted": removed.key, "project":
		// removed.project]`. It used to echo the raw path segment and raw
		// query value instead (`DELETE .../Gate` answering `"Gate"` while
		// deleting `gate`); that is fixed on the Swift side, so a double that
		// still echoed raw would be modelling a server that no longer exists
		// and would keep verifyMemoryDeleted's matching tolerance alive here.
		case r.Method == "DELETE" && isAPI && len(segments) == 3 && segments[1] == "memories":
			rawProject, ok := requireProject(w, r)
			if !ok {
				return
			}
			project := doubleNormalizedProject(rawProject)
			key := doubleNormalizedKey(segments[2])
			if _, found := store[project+"\x00"+key]; !found {
				writeErr(w, 404, "not_found", fmt.Sprintf("memory %s not found for project %s", key, project))
				return
			}
			delete(store, project+"\x00"+key)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(200)
			json.NewEncoder(w).Encode(map[string]string{"deleted": key, "project": project})

		default:
			writeErr(w, 404, "not_found", "no route for "+r.Method+" "+r.URL.Path)
		}
	}

	server := httptest.NewServer(http.HandlerFunc(handler))
	t.Cleanup(server.Close)
	return &board{base: server.URL, port: 18888, client: server.Client()}
}

// ---- handler wiring: registerTools itself, not just the pure helpers ----
//
// Everything above tests taskBody/memoryAddBody/memoryKeyPath/verifyMemory*
// as pure functions. None of it calls registerTools, so none of it would
// notice a handler's closure silently skipping one of them — dropping the
// blank-source pre-check, skipping a verifyMemoryEcho/verifyMemoryList/
// verifyMemoryDeleted call, or building the URL without memoryKeyPath. A
// reviewer mutated exactly those five things and every existing test stayed
// green. The tests below drive the four memory tools through an in-memory
// MCP client/server pair (mcp.NewInMemoryTransports), the same
// mcp.AddTool-registered handlers main() wires up, so a dropped call is a
// call that never happens on this path either — not a fact asserted about
// the handler's source text.

// newToolSession wires registerTools onto a real (in-process) MCP server and
// connects a client to it over an in-memory transport pair, so tests can
// drive the four memory tools exactly as an agent would: by name and
// arguments, through session.CallTool.
func newToolSession(t *testing.T, api *board) *mcp.ClientSession {
	t.Helper()
	server := mcp.NewServer(&mcp.Implementation{Name: "test-server", Version: "v0.0.1"}, nil)
	registerTools(server, api)

	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	ctx := context.Background()
	if _, err := server.Connect(ctx, serverTransport, nil); err != nil {
		t.Fatalf("server.Connect failed: %v", err)
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "v0.0.1"}, nil)
	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("client.Connect failed: %v", err)
	}
	t.Cleanup(func() { session.Close() })
	return session
}

// newMaliciousBoard is newMemoryContractDouble's opposite: a double that
// answers /api/health honestly (so board.call's identity check passes) but
// answers every other route however the test dictates — used to prove a
// verify* call is actually wired into a handler by feeding it a
// wrong-but-well-formed response and checking the tool call surfaces an
// error rather than quietly accepting it.
func newMaliciousBoard(t *testing.T, other http.HandlerFunc) *board {
	t.Helper()
	handler := func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(200)
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "version": "double", "port": 18888, "runs": 0})
			return
		}
		other(w, r)
	}
	server := httptest.NewServer(http.HandlerFunc(handler))
	t.Cleanup(server.Close)
	return &board{base: server.URL, port: 18888, client: server.Client()}
}

// resultErrorText concatenates a CallToolResult's text content, for
// inspecting what a failed tool call actually told the agent.
func resultErrorText(result *mcp.CallToolResult) string {
	var sb strings.Builder
	for _, c := range result.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			sb.WriteString(tc.Text)
		}
	}
	return sb.String()
}

// decodeStructured unmarshals a successful CallToolResult's StructuredContent
// into a concrete type. The client side of the MCP SDK does not know the
// server's Go type, so StructuredContent arrives as generic JSON (a
// map[string]any); round-tripping it through json.Marshal/Unmarshal recovers
// a typed value for assertions.
func decodeStructured[T any](t *testing.T, result *mcp.CallToolResult) T {
	t.Helper()
	var out T
	raw, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatalf("marshal structured content: %v", err)
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal structured content into %T: %v (raw=%s)", out, err, raw)
	}
	return out
}

// Pins the blank-source pre-check inside plan_memory_add's handler by
// checking for THAT check's own distinguishing wording. If the pre-check is
// dropped, the request still fails — the double also rejects a blank source
// — but with the board's own message instead, and this assertion catches
// that difference rather than just checking "some error happened".
func TestToolPlanMemoryAddRejectsBlankSource(t *testing.T) {
	b := newMemoryContractDouble(t)
	session := newToolSession(t, b)
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name: "plan_memory_add",
		Arguments: map[string]any{
			"project": "proj", "key": "gate.x", "value": "v", "kind": "gate", "source": "   ",
		},
	})
	if err != nil {
		t.Fatalf("CallTool transport error: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected an error result for a blank source, got success: %#v", result.StructuredContent)
	}
	if text := resultErrorText(result); !strings.Contains(text, "没法判断是否过期") {
		t.Fatalf("expected the handler's OWN blank-source message (distinct from the board's), got %q — "+
			"if the board's generic message came back instead, the client-side pre-check has been silently dropped", text)
	}
}

// A whitespace-only kind must be flagged, not silently treated as "no
// filter" (the board's optionalKind would treat it as absent too, so simply
// forwarding it gives the caller no signal at all that their filter was
// ignored).
func TestToolPlanMemoryListRejectsWhitespaceOnlyKind(t *testing.T) {
	b := newMemoryContractDouble(t)
	session := newToolSession(t, b)
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "plan_memory_list",
		Arguments: map[string]any{"project": "proj", "kind": "   "},
	})
	if err != nil {
		t.Fatalf("CallTool transport error: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected an error result for a whitespace-only kind, got success: %#v", result.StructuredContent)
	}
	if text := resultErrorText(result); !strings.Contains(text, "kind 全是空白") {
		t.Fatalf("expected the whitespace-only-kind message, got %q", text)
	}
}

// Happy path for all four tools, driven through the actual registered
// handlers rather than by calling board.call directly.
func TestToolPlanMemoryAddGetListDeleteRoundTrip(t *testing.T) {
	b := newMemoryContractDouble(t)
	session := newToolSession(t, b)
	ctx := context.Background()

	addResult, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "plan_memory_add",
		Arguments: map[string]any{
			"project": "proj", "key": "Gate.Swift-Test", "value": "cd mcp && go test ./...",
			"kind": "gate", "source": "mcp/tools_test.go:1",
		},
	})
	if err != nil || addResult.IsError {
		t.Fatalf("add failed: err=%v result=%s", err, resultErrorText(addResult))
	}
	added := decodeStructured[memoryView](t, addResult)
	if added.Key != "gate.swift-test" || added.Source != "mcp/tools_test.go:1" {
		t.Fatalf("unexpected add result: %#v", added)
	}

	getResult, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "plan_memory_get",
		Arguments: map[string]any{"project": "proj", "key": "Gate.Swift-Test"},
	})
	if err != nil || getResult.IsError {
		t.Fatalf("get failed: err=%v result=%s", err, resultErrorText(getResult))
	}
	got := decodeStructured[memoryView](t, getResult)
	if got.Source != "mcp/tools_test.go:1" {
		t.Fatalf("get lost source: %#v", got)
	}

	listResult, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "plan_memory_list",
		Arguments: map[string]any{"project": "proj"},
	})
	if err != nil || listResult.IsError {
		t.Fatalf("list failed: err=%v result=%s", err, resultErrorText(listResult))
	}
	list := decodeStructured[memoryListOutput](t, listResult)
	if len(list.Memories) != 1 || list.Memories[0].Source != "mcp/tools_test.go:1" {
		t.Fatalf("unexpected list result: %#v", list)
	}

	deleteResult, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "plan_memory_delete",
		Arguments: map[string]any{"project": "proj", "key": "GATE.SWIFT-TEST"},
	})
	if err != nil || deleteResult.IsError {
		t.Fatalf("delete failed: err=%v result=%s", err, resultErrorText(deleteResult))
	}
	deleted := decodeStructured[memoryDeleteOutput](t, deleteResult)
	if deleted.Deleted == "" {
		t.Fatalf("unexpected delete result: %#v", deleted)
	}
}

// Pins that plan_memory_add's handler actually calls verifyMemoryEcho:
// a double answering with a different project than requested must surface
// as a tool error, not a quietly "successful" add under the wrong project.
func TestToolPlanMemoryAddDetectsWrongProjectEcho(t *testing.T) {
	b := newMaliciousBoard(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		json.NewEncoder(w).Encode(map[string]string{
			"project": "someone-elses-project", "key": "gate.x", "value": "v", "kind": "gate", "source": "src",
			"created_at": "t", "updated_at": "t",
		})
	})
	session := newToolSession(t, b)
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name: "plan_memory_add",
		Arguments: map[string]any{
			"project": "proj", "key": "gate.x", "value": "v", "kind": "gate", "source": "src",
		},
	})
	if err != nil {
		t.Fatalf("CallTool transport error: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected plan_memory_add to reject a response naming a different project (verifyMemoryEcho must be wired in), got success: %#v", result.StructuredContent)
	}
}

// Same pin, for plan_memory_get: a double answering with a different key
// than requested must surface as an error.
func TestToolPlanMemoryGetDetectsWrongKeyEcho(t *testing.T) {
	b := newMaliciousBoard(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		json.NewEncoder(w).Encode(map[string]string{
			"project": "proj", "key": "some-other-key", "value": "v", "kind": "gate", "source": "src",
			"created_at": "t", "updated_at": "t",
		})
	})
	session := newToolSession(t, b)
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "plan_memory_get",
		Arguments: map[string]any{"project": "proj", "key": "gate.x"},
	})
	if err != nil {
		t.Fatalf("CallTool transport error: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected plan_memory_get to reject a response naming a different key (verifyMemoryEcho must be wired in), got success: %#v", result.StructuredContent)
	}
}

// Pins that plan_memory_list's handler actually calls verifyMemoryList: a
// double mixing in a foreign project's entry must surface as an error.
func TestToolPlanMemoryListDetectsForeignProjectEntry(t *testing.T) {
	b := newMaliciousBoard(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		json.NewEncoder(w).Encode(map[string]any{"memories": []map[string]string{
			{"project": "someone-elses-project", "key": "k1", "value": "v", "kind": "note", "source": "src",
				"created_at": "t", "updated_at": "t"},
		}})
	})
	session := newToolSession(t, b)
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "plan_memory_list",
		Arguments: map[string]any{"project": "proj"},
	})
	if err != nil {
		t.Fatalf("CallTool transport error: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected plan_memory_list to reject a foreign-project entry (verifyMemoryList must be wired in), got success: %#v", result.StructuredContent)
	}
}

// Pins that plan_memory_delete's handler actually calls verifyMemoryDeleted:
// a double echoing a different deleted key than requested must surface as
// an error.
func TestToolPlanMemoryDeleteDetectsWrongKeyEcho(t *testing.T) {
	b := newMaliciousBoard(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		json.NewEncoder(w).Encode(map[string]string{"deleted": "some-other-key", "project": "proj"})
	})
	session := newToolSession(t, b)
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "plan_memory_delete",
		Arguments: map[string]any{"project": "proj", "key": "gate.x"},
	})
	if err != nil {
		t.Fatalf("CallTool transport error: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected plan_memory_delete to reject a response naming a different deleted key (verifyMemoryDeleted must be wired in), got success: %#v", result.StructuredContent)
	}
}

// The same tightening at the handler level, against a board that behaves the
// way the board did before 4f26a4d: it echoes the caller's raw path segment
// and raw query value instead of the pair the store acted on. That server
// deleted `gate` under project `proj` and reported `Gate` under ` proj `, and
// the old verifier accepted both halves — the untrimmed project because the
// caller's raw spelling was explicitly allowed, the unfolded key because
// EqualFold does not care about case. It now surfaces as a tool error.
//
// This is also the version-skew case: a current MCP binary talking to a stale
// BossSDD.app fails plan_memory_delete here rather than reporting a row name
// that was never in the table.
func TestToolPlanMemoryDeleteRejectsAPreFixRawEchoingBoard(t *testing.T) {
	b := newMaliciousBoard(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		json.NewEncoder(w).Encode(map[string]string{"deleted": "Gate", "project": " proj "})
	})
	session := newToolSession(t, b)
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "plan_memory_delete",
		Arguments: map[string]any{"project": " proj ", "key": "Gate"},
	})
	if err != nil {
		t.Fatalf("CallTool transport error: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected plan_memory_delete to reject a raw echo of project/key (the row deleted was \"gate\" under \"proj\"), got success: %#v", result.StructuredContent)
	}
}

// Pins that plan_memory_get's handler actually escapes the key before
// building the URL (memoryKeyPath / url.PathEscape). Against the faithful
// double's now-strict, per-segment-decoded routing (doubleSegments), a key
// containing "/" that reaches the wire unescaped produces a 4-segment path
// that falls through to "no route" instead of addressing the one record —
// so this fails if that escaping is ever dropped from the handler.
func TestToolPlanMemoryGetRoundTripsKeyContainingSlash(t *testing.T) {
	b := newMemoryContractDouble(t)
	session := newToolSession(t, b)
	ctx := context.Background()

	addResult, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "plan_memory_add",
		Arguments: map[string]any{
			"project": "proj", "key": "a/b", "value": "v", "kind": "note", "source": "src",
		},
	})
	if err != nil || addResult.IsError {
		t.Fatalf("seeding add failed: err=%v result=%s", err, resultErrorText(addResult))
	}

	getResult, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "plan_memory_get",
		Arguments: map[string]any{"project": "proj", "key": "a/b"},
	})
	if err != nil {
		t.Fatalf("CallTool transport error: %v", err)
	}
	if getResult.IsError {
		t.Fatalf("expected the escaped key to still address one record; got an error "+
			"(a dropped url.PathEscape would produce exactly this): %s", resultErrorText(getResult))
	}
}

func TestMemoryToolsEndToEndAgainstContractDouble(t *testing.T) {
	b := newMemoryContractDouble(t)
	ctx := context.Background()
	project := "/Users/zhang/Project/boss-sdd"

	// add: mixed-case key must come back lower-cased, source must survive.
	var added wireMemory
	err := b.call(ctx, "POST", "/api/memories", memoryAddBody(memoryAddInput{
		Project: project, Key: "Gate.Swift-Test", Value: "cd mcp && go test ./...", Kind: "gate", Source: "mcp/tools_test.go:1",
	}), &added)
	if err != nil {
		t.Fatalf("add failed: %v", err)
	}
	if verr := verifyMemoryEcho(project, "Gate.Swift-Test", added); verr != nil {
		t.Fatalf("add response failed the echo check: %v", verr)
	}
	if added.Key != "gate.swift-test" {
		t.Fatalf("expected the server's lower-cased key, got %q", added.Key)
	}
	if added.Source != "mcp/tools_test.go:1" {
		t.Fatalf("source did not survive the write path: %#v", added)
	}

	// get: lookup by the original mixed-case key must still hit the same record.
	var got wireMemory
	if err := b.call(ctx, "GET", "/api/memories/"+url.PathEscape("Gate.Swift-Test")+"?"+memoryProjectQuery(project), nil, &got); err != nil {
		t.Fatalf("get failed: %v", err)
	}
	if verr := verifyMemoryEcho(project, "Gate.Swift-Test", got); verr != nil {
		t.Fatalf("get response failed the echo check: %v", verr)
	}
	if got.Source != "mcp/tools_test.go:1" {
		t.Fatalf("source did not survive the read path: %#v", got)
	}

	// list: must include the record and carry its source.
	var list wireMemoryList
	if err := b.call(ctx, "GET", "/api/memories?"+memoryListQuery(project, ""), nil, &list); err != nil {
		t.Fatalf("list failed: %v", err)
	}
	if verr := verifyMemoryList(project, "", list.Memories); verr != nil {
		t.Fatalf("list response failed the verify check: %v", verr)
	}
	if len(list.Memories) != 1 || list.Memories[0].Source != "mcp/tools_test.go:1" {
		t.Fatalf("expected the one record with its source, got %#v", list.Memories)
	}

	// add with blank source: the double enforces the same 400 the real board does.
	var rejected wireMemory
	err = b.call(ctx, "POST", "/api/memories", memoryAddBody(memoryAddInput{
		Project: project, Key: "other", Value: "v", Kind: "note", Source: "   ",
	}), &rejected)
	if err == nil || !strings.Contains(err.Error(), "source") {
		t.Fatalf("expected a source-related 400, got %v", err)
	}

	// project present but empty: distinct message from project absent.
	var empty wireMemoryList
	err = b.call(ctx, "GET", "/api/memories?project=", nil, &empty)
	if err == nil || !strings.Contains(err.Error(), "must not be empty") {
		t.Fatalf("expected the empty-project message, got %v", err)
	}

	// delete: removes the record and echoes the lower-cased key back.
	var deleted wireMemoryDeleted
	if err := b.call(ctx, "DELETE", "/api/memories/"+url.PathEscape("GATE.SWIFT-TEST")+"?"+memoryProjectQuery(project), nil, &deleted); err != nil {
		t.Fatalf("delete failed: %v", err)
	}
	if verr := verifyMemoryDeleted(project, "GATE.SWIFT-TEST", deleted); verr != nil {
		t.Fatalf("delete response failed the verify check: %v", verr)
	}

	// get after delete: 404, not a silently empty record.
	var afterDelete wireMemory
	err = b.call(ctx, "GET", "/api/memories/"+url.PathEscape("gate.swift-test")+"?"+memoryProjectQuery(project), nil, &afterDelete)
	if err == nil {
		t.Fatalf("expected a not-found error after delete, got a decoded record: %#v", afterDelete)
	}
}

// Round 2 regression, end-to-end: a caller passing a project with incidental
// leading/trailing whitespace must see a normal add/get/list/delete cycle,
// not "the board returned a different project's record" — because the board
// trims the project before it ever reaches SQL (Store.normalizedProject) and
// echoes back the trimmed value on every read path.
func TestMemoryToolsEndToEndToleratesWhitespacePaddedProject(t *testing.T) {
	b := newMemoryContractDouble(t)
	ctx := context.Background()
	padded := "  /Users/zhang/Project/boss-sdd  "
	trimmed := strings.TrimSpace(padded)

	var added wireMemory
	err := b.call(ctx, "POST", "/api/memories", memoryAddBody(memoryAddInput{
		Project: padded, Key: "note.padding", Value: "v", Kind: "note", Source: "mcp/tools_test.go:2",
	}), &added)
	if err != nil {
		t.Fatalf("add failed: %v", err)
	}
	if verr := verifyMemoryEcho(padded, "note.padding", added); verr != nil {
		t.Fatalf("add response for a padded project must verify clean: %v", verr)
	}
	if added.Project != trimmed {
		t.Fatalf("expected the board's trimmed project, got %q", added.Project)
	}

	var got wireMemory
	if err := b.call(ctx, "GET", "/api/memories/note.padding?"+memoryProjectQuery(padded), nil, &got); err != nil {
		t.Fatalf("get failed: %v", err)
	}
	if verr := verifyMemoryEcho(padded, "note.padding", got); verr != nil {
		t.Fatalf("get response for a padded project must verify clean: %v", verr)
	}

	var list wireMemoryList
	if err := b.call(ctx, "GET", "/api/memories?"+memoryListQuery(padded, ""), nil, &list); err != nil {
		t.Fatalf("list failed: %v", err)
	}
	if verr := verifyMemoryList(padded, "", list.Memories); verr != nil {
		t.Fatalf("list response for a padded project must verify clean: %v", verr)
	}

	var deleted wireMemoryDeleted
	if err := b.call(ctx, "DELETE", "/api/memories/note.padding?"+memoryProjectQuery(padded), nil, &deleted); err != nil {
		t.Fatalf("delete failed: %v", err)
	}
	if verr := verifyMemoryDeleted(padded, "note.padding", deleted); verr != nil {
		t.Fatalf("delete response for a padded project must verify clean: %v", verr)
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
