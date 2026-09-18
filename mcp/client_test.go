package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
)

// newTestBoard points a board at an httptest server instead of the real
// loopback port, so these tests never touch 127.0.0.1:18888 or the app.
func newTestBoard(t *testing.T, handler http.HandlerFunc) *board {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return &board{
		base:   server.URL,
		port:   18888,
		client: server.Client(),
	}
}

func mustContain(t *testing.T, err error, substrings ...string) {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	for _, s := range substrings {
		if !strings.Contains(err.Error(), s) {
			t.Fatalf("error %q does not contain %q", err.Error(), s)
		}
	}
}

// ---- verdict: pure logic, no network ----

func TestVerdictReportsNon2xxStatus(t *testing.T) {
	b := &board{port: 18888}
	err := b.verdict(probeResult{status: http.StatusNotFound})
	mustContain(t, err, "18888", "HTTP 404", "lsof -nP -iTCP:18888 -sTCP:LISTEN", "BOSS_SDD_PORT")
}

func TestVerdictReportsMissingFields(t *testing.T) {
	b := &board{port: 18888}
	err := b.verdict(probeResult{status: http.StatusOK}) // probe left zero-valued: OK/Version both nil
	mustContain(t, err, "18888", "ok/version", "lsof -nP -iTCP:18888 -sTCP:LISTEN", "BOSS_SDD_PORT")
}

func TestVerdictAcceptsRealHealthShape(t *testing.T) {
	ok, version := true, "9.9.9"
	b := &board{port: 18888}
	err := b.verdict(probeResult{status: http.StatusOK, probe: healthProbe{OK: &ok, Version: &version}})
	if err != nil {
		t.Fatalf("a real health shape must not be diagnosed as a foreign process: %v", err)
	}
}

// ---- verifyIdentity: caching semantics (Finding 1 / Finding 4) ----

// The classic reported bug and the worse variant the reviewer measured: a
// squatter whose body decodes cleanly into any wireXxx struct must still be
// caught, because verifyIdentity checks the board's real shape, not whatever
// struct the caller happened to be decoding into.
func TestVerifyIdentityCachesAfterFirstProbe(t *testing.T) {
	var requests int32
	b := newTestBoard(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requests, 1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`)) // plausible-looking, but not the board's shape
	})

	first := b.verifyIdentity(context.Background())
	mustContain(t, first, "ok/version")

	second := b.verifyIdentity(context.Background())
	mustContain(t, second, "ok/version")

	if got := atomic.LoadInt32(&requests); got != 1 {
		t.Fatalf("expected the verdict to be cached after the first probe, got %d requests", got)
	}
}

// A transport failure (nothing listening yet) must not be locked in as a
// verdict — the next call has to probe again once launchApp() has had its
// chance, rather than a fluke permanently marking the board "fine" or "broken".
func TestVerifyIdentityLeavesUnresolvedOnTransportFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := server.URL
	server.Close() // nothing is listening now

	b := &board{base: url, port: 18888, client: server.Client()}
	if err := b.verifyIdentity(context.Background()); err != nil {
		t.Fatalf("a transport failure must not produce a verdict: %v", err)
	}
	if b.identityDone {
		t.Fatal("a transport failure must not be cached as a resolved identity")
	}
}

// ---- call(): end-to-end diagnosis for real tool shapes ----

// The originally reported bug: a foreign 404 responder must produce a
// diagnosis, not a bare status.
func TestCallDiagnosesForeignProcessOn404(t *testing.T) {
	b := newTestBoard(t, func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	var out wireHealth
	err := b.call(context.Background(), "GET", "/api/health", nil, &out)
	mustContain(t, err, "18888", "HTTP 404", "lsof -nP -iTCP:18888 -sTCP:LISTEN", "BOSS_SDD_PORT")
}

// Finding 1, regression test against a real tool shape: a squatter answering
// 200 {"status":"ok"} decodes into wireRun (what e.g. plan_set_task decodes
// into) without any JSON error, so the old per-call decode-failure trigger
// never fired. verifyIdentity's own dedicated probe must still catch it.
func TestCallDetectsStatusOkSquatterOnRealToolShape(t *testing.T) {
	b := newTestBoard(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})
	var out wireRun
	err := b.call(context.Background(), "PUT", "/api/runs/r1/tasks/T1", nil, &out)
	mustContain(t, err, "18888", "ok/version", "lsof -nP -iTCP:18888 -sTCP:LISTEN", "BOSS_SDD_PORT")
}

// Same squatter, but hitting plan_board_status's own call shape directly:
// GET /api/health decoded into wireHealth. Before the fix this returned
// err == nil with a zero-valued (OK:false) health, which plan_board_status
// would have reported as "board is up, zero runs" — worse than the original
// bare-404 bug, because it looks like a normal, if empty, answer.
func TestCallDetectsStatusOkSquatterOnHealthEndpointItself(t *testing.T) {
	b := newTestBoard(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})
	var health wireHealth
	err := b.call(context.Background(), "GET", "/api/health", nil, &health)
	if err == nil {
		t.Fatalf("must not silently report a healthy board: decoded %#v", health)
	}
	mustContain(t, err, "ok/version")
}

// Finding 4: against a squatter, a plan_set_tasks-shaped batch of many calls
// must not multiply the probe. The cached verdict (Finding 1) should reduce
// an N-call batch to exactly one HTTP request total, not one probe per call.
func TestCallCachesBadIdentityAcrossBatch(t *testing.T) {
	var requests int32
	b := newTestBoard(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requests, 1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})

	const batch = 20
	for i := 0; i < batch; i++ {
		var out wireRun
		err := b.call(context.Background(), "PUT", fmt.Sprintf("/api/runs/r1/tasks/T%d", i), nil, &out)
		mustContain(t, err, "ok/version")
	}
	if got := atomic.LoadInt32(&requests); got != 1 {
		t.Fatalf("expected exactly one probe for the whole batch, got %d requests", got)
	}
}

// ---- resolve()/diagnosePort(): Finding 2, the probe's own failure must
// never destroy the caller's real error ----

func TestResolveFallsBackToOriginalErrorWhenProbeFails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	url := server.URL
	server.Close() // simulate the squatter having vanished before the probe dials

	b := &board{base: url, port: 18888, client: server.Client()}
	original := &ambiguousError{err: fmt.Errorf("看板返回 HTTP 404")}
	err := b.resolve(context.Background(), original)
	if err == nil || err.Error() != "看板返回 HTTP 404" {
		t.Fatalf("a failed probe must fall back to the original error unchanged, got %v", err)
	}
}

// End-to-end variant of the same scenario: the squatter answers the real
// request, then the listener disappears before diagnosePort's own probe
// dials a fresh connection (the board sends Connection: close on every
// response, so the probe always needs a new TCP connection).
func TestCallFallsBackWhenSquatterVanishesBetweenRequestAndProbe(t *testing.T) {
	server := httptest.NewUnstartedServer(nil)
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Match the board: Connection: close on every response, so the probe
		// always dials fresh rather than reusing a pooled connection — which
		// is exactly why a vanished squatter shows up as a dial failure.
		w.Header().Set("Connection", "close")
		http.NotFound(w, r)
		server.Listener.Close() // stop accepting new connections right after answering
	})
	server.Start()
	defer server.Close()

	b := &board{base: server.URL, port: 18888, client: server.Client()}
	b.cacheIdentity(nil) // identity was already confirmed healthy earlier in the session

	var out wireHealth
	err := b.call(context.Background(), "GET", "/api/health", nil, &out)
	if err == nil || err.Error() != "看板返回 HTTP 404" {
		t.Fatalf("expected the original 404 to survive a failed re-probe, got %v", err)
	}
}

// ---- real board errors must pass through untouched ----

func TestCallPassesThroughRealBoardError(t *testing.T) {
	b := newTestBoard(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"ok":true,"version":"9.9.9","port":18888,"runs":0}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":{"code":"invalid","message":"依赖未完成，不能转 running"}}`))
	})
	var out wireRun
	err := b.call(context.Background(), "PUT", "/api/runs/r1/tasks/T1", nil, &out)
	if err == nil || err.Error() != "依赖未完成，不能转 running" {
		t.Fatalf("expected the board's own message unchanged, got %v", err)
	}
}

func TestCallSucceedsWhenBoardAnswersNormally(t *testing.T) {
	b := newTestBoard(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true,"version":"9.9.9","port":18888,"runs":2}`))
	})
	var out wireHealth
	if err := b.call(context.Background(), "GET", "/api/health", nil, &out); err != nil {
		t.Fatalf("unexpected error on a normal board response: %v", err)
	}
	if !out.OK || out.Version != "9.9.9" || out.Runs != 2 {
		t.Fatalf("decoded health does not match response: %#v", out)
	}
}

// ---- isRefused: Finding 3 ----

func TestIsRefusedOnlyMatchesConnectionRefused(t *testing.T) {
	refused := &net.OpError{Op: "dial", Net: "tcp", Err: &os.SyscallError{Syscall: "connect", Err: syscall.ECONNREFUSED}}
	if !isRefused(refused) {
		t.Fatalf("ECONNREFUSED must be classified as refused: %v", refused)
	}

	reset := &net.OpError{Op: "read", Net: "tcp", Err: &os.SyscallError{Syscall: "read", Err: syscall.ECONNRESET}}
	if isRefused(reset) {
		t.Fatalf("a connection reset must not be classified as refused (it should not trigger launchApp): %v", reset)
	}

	if isRefused(context.DeadlineExceeded) {
		t.Fatal("a timeout must not be classified as refused")
	}
}

func TestIsRefusedTrueForARealRefusal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := server.URL
	server.Close() // nothing is listening now

	_, err := http.Get(url)
	if err == nil {
		t.Fatal("expected an error dialing a closed listener")
	}
	if !isRefused(err) {
		t.Fatalf("a real connection refused must be classified as refused: %v", err)
	}
}

// ---- newBoard(): constructor coverage ----

func TestNewBoardDefaultsToDefaultPort(t *testing.T) {
	t.Setenv("BOSS_SDD_PORT", "")
	b := newBoard()
	if b.port != defaultPort {
		t.Fatalf("expected default port %d, got %d", defaultPort, b.port)
	}
	want := fmt.Sprintf("http://127.0.0.1:%d", defaultPort)
	if b.base != want {
		t.Fatalf("expected base %q, got %q", want, b.base)
	}
}

func TestNewBoardHonorsPortOverride(t *testing.T) {
	t.Setenv("BOSS_SDD_PORT", "23456")
	b := newBoard()
	if b.port != 23456 {
		t.Fatalf("expected overridden port 23456, got %d", b.port)
	}
	if b.base != "http://127.0.0.1:23456" {
		t.Fatalf("expected overridden base, got %q", b.base)
	}
}
