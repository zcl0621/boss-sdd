package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	appPath = "/Applications/BossSDD.app"
	// Must match BoardKit.defaultBoardPort.
	defaultPort = 18888
	// minBoardVersion is the oldest BoardKit whose loopback wire contract the
	// checks in this binary are written against. It is compared with the
	// version /api/health reports, i.e. BoardKit's own boardKitVersion in
	// Sources/BoardKit/HTTPServer.swift.
	//
	// Why a floor at all: appPath above is a fixed location, so "a stale
	// BossSDD.app sitting in /Applications, a freshly built MCP binary" is a
	// configuration an operator reaches by rebuilding only one half. Without
	// this, verdict below checked only that ok/version were present, never
	// their value, and the skew surfaced much later as a confusing failure
	// about a memory row rather than about the app.
	//
	// The floor moves with the wire contract, not with every release: bump
	// boardKitVersion's minor component when a route's request or response
	// shape changes in a way this binary's verify* checks depend on, then
	// raise this to match. 0.2.0 is the first version whose DELETE
	// /api/memories route answers with the board's normalized (project, key)
	// pair; verifyMemoryDeleted in main.go requires exactly that, and against
	// a 0.1.0 board it reports a row name that was never in the table.
	minBoardVersion = "0.2.0"
)

// compareBoardVersion orders two dotted-numeric version strings by component,
// returning -1/0/+1 and whether both sides could be parsed at all. Missing
// trailing components read as 0, so "0.2" and "0.2.0" are the same version.
//
// Per-component and numeric rather than lexical on purpose: a string compare
// puts "0.10.0" before "0.9.0", which would read a newer board as stale the
// first time the minor component reaches double digits.
func compareBoardVersion(got, want string) (int, bool) {
	gotParts, ok := parseBoardVersion(got)
	if !ok {
		return 0, false
	}
	wantParts, ok := parseBoardVersion(want)
	if !ok {
		return 0, false
	}
	for i := 0; i < len(gotParts) || i < len(wantParts); i++ {
		g, w := 0, 0
		if i < len(gotParts) {
			g = gotParts[i]
		}
		if i < len(wantParts) {
			w = wantParts[i]
		}
		switch {
		case g < w:
			return -1, true
		case g > w:
			return 1, true
		}
	}
	return 0, true
}

// parseBoardVersion splits a dotted-numeric version into its components,
// reporting false for anything else — an empty string, a pre-release suffix,
// a name. Callers must treat that as "no opinion" rather than "too old": a
// version that is not dotted-numeric did not come from a BossSDD.app build,
// so the version floor has nothing to say about it.
func parseBoardVersion(version string) ([]int, bool) {
	fields := strings.Split(strings.TrimSpace(version), ".")
	parts := make([]int, 0, len(fields))
	for _, field := range fields {
		n, err := strconv.Atoi(field)
		if err != nil || n < 0 {
			return nil, false
		}
		parts = append(parts, n)
	}
	return parts, true
}

// board talks to the Plan SDD app's loopback API. The app owns the store and all
// the scheduling invariants; this process only translates MCP calls into requests.
type board struct {
	base   string
	port   int
	client *http.Client

	// identityMu guards a once-per-process verdict on whether the port
	// actually holds the board (see verifyIdentity). Checking it is a real
	// network round trip, so it is cached rather than repeated on every call.
	identityMu   sync.Mutex
	identityDone bool
	identityErr  error
}

func newBoard() *board {
	port := defaultPort
	if raw := os.Getenv("BOSS_SDD_PORT"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			port = parsed
		}
	}
	return &board{
		base:   fmt.Sprintf("http://127.0.0.1:%d", port),
		port:   port,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

type apiError struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// ambiguousError marks a send() failure whose response didn't look like the
// board's own JSON (neither a {"error":{...}} body nor the shape the caller
// asked to decode into). It is a useful secondary signal — e.g. a plain HTTP
// 404 — but NOT the primary defense: a squatter that echoes back a
// plausible-looking JSON object (say {"status":"ok"}) decodes into any wireXxx
// struct without error, so this alone would miss it. verifyIdentity is what
// actually guards against that case; see its doc comment.
type ambiguousError struct {
	err error
}

func (e *ambiguousError) Error() string { return e.err.Error() }
func (e *ambiguousError) Unwrap() error { return e.err }

// healthProbe mirrors the fields plan_board_status relies on. Pointers so a
// present-but-falsy value (ok:false, version:"") is distinguishable from an
// absent field — only absence means "this isn't the board".
type healthProbe struct {
	OK      *bool   `json:"ok"`
	Version *string `json:"version"`
}

// probeResult is the outcome of one GET /api/health round trip, kept apart
// from any verdict about it: a transport failure (dial error, ctx cancelled)
// says nothing about who is on the port, so callers must be able to tell it
// apart from "got a response and it looked wrong".
type probeResult struct {
	transportErr error
	status       int
	probe        healthProbe
	decodeErr    error
}

// call sends one request, launching the board app and retrying if nothing is listening.
func (b *board) call(ctx context.Context, method, path string, body, out any) error {
	// Confirm once per process that the port actually holds the board before
	// trusting anything it says. This is the fix for the case send()'s own
	// error-shaped detection cannot catch: a squatter whose response decodes
	// cleanly into whatever wireXxx struct the caller happens to be using.
	if err := b.verifyIdentity(ctx); err != nil {
		return err
	}
	if err := b.send(ctx, method, path, body, out); err == nil || !isRefused(err) {
		return b.resolve(ctx, err)
	}
	if err := launchApp(); err != nil {
		return fmt.Errorf("看板未运行，且无法启动 %s：%w", appPath, err)
	}
	deadline := time.Now().Add(12 * time.Second)
	for {
		time.Sleep(400 * time.Millisecond)
		err := b.send(ctx, method, path, body, out)
		if err == nil || !isRefused(err) {
			return b.resolve(ctx, err)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("看板已启动但 %s 仍无响应：%w", b.base, err)
		}
	}
}

// verifyIdentity confirms, once per process, that whatever is listening on
// the port is actually the board — a plain GET /api/health, checked against
// the board's real shape rather than whatever struct the caller wanted to
// decode into. It runs before the first real request from call() and caches
// the verdict, so the cost is one extra round trip for the process's whole
// lifetime, not one per call (a 20-task plan_set_tasks batch against a
// squatter now costs one probe total, not 20).
//
// A transport failure (most likely: nothing is listening yet, before
// launchApp() has had its chance) is not a verdict either way, so it is left
// uncached — the next call probes again instead of wrongly locking in "it's
// fine" or "it's broken" from a fluke.
func (b *board) verifyIdentity(ctx context.Context) error {
	b.identityMu.Lock()
	if b.identityDone {
		err := b.identityErr
		b.identityMu.Unlock()
		return err
	}
	b.identityMu.Unlock()

	result := b.probeHealth(ctx)
	if result.transportErr != nil {
		return nil
	}
	verdict := b.verdict(result)
	b.cacheIdentity(verdict)
	return verdict
}

func (b *board) cacheIdentity(err error) {
	b.identityMu.Lock()
	b.identityDone = true
	b.identityErr = err
	b.identityMu.Unlock()
}

// resolve turns a send() error into something actionable. Ordinary errors
// (including the board's own {"error":{...}} messages) pass through
// unchanged; an ambiguousError is checked against /api/health first, because
// that's the only way to tell "the board answered with a real error" apart
// from "something else is squatting on the port". A conclusive verdict here
// is also cached, so a squatter that only reveals itself mid-session (the
// board crashed partway through a batch, say) is diagnosed once, not on every
// remaining call.
func (b *board) resolve(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	var amb *ambiguousError
	if !errors.As(err, &amb) {
		return err
	}
	return b.diagnosePort(ctx, amb.err)
}

// diagnosePort probes /api/health directly (bypassing send()'s decoding,
// since that's exactly what's in question) to tell the operator what's
// actually listening on the board's port. fallback is the error the caller
// already had; if the probe itself can't complete — the squatter vanished
// between the original request and this one, or ctx got cancelled — that
// must never destroy the caller's real error, so fallback is what's returned.
func (b *board) diagnosePort(ctx context.Context, fallback error) error {
	result := b.probeHealth(ctx)
	if result.transportErr != nil {
		return fallback
	}
	verdict := b.verdict(result)
	b.cacheIdentity(verdict)
	if verdict != nil {
		return verdict
	}
	return fallback
}

func (b *board) probeHealth(ctx context.Context) probeResult {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, b.base+"/api/health", bytes.NewReader(nil))
	if err != nil {
		return probeResult{transportErr: err}
	}
	response, err := b.client.Do(request)
	if err != nil {
		return probeResult{transportErr: err}
	}
	defer response.Body.Close()

	result := probeResult{status: response.StatusCode}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		result.decodeErr = json.NewDecoder(response.Body).Decode(&result.probe)
	}
	return result
}

// verdict turns one probeResult into an error describing why the port isn't
// the board, or nil when it is.
func (b *board) verdict(r probeResult) error {
	next := fmt.Sprintf(
		"排查占用进程：lsof -nP -iTCP:%d -sTCP:LISTEN；也可以设置环境变量 BOSS_SDD_PORT 换一个端口再试。",
		b.port,
	)
	if r.status < 200 || r.status >= 300 {
		return fmt.Errorf("端口 %d 上的进程不是看板：健康检查 GET /api/health 返回 HTTP %d。%s", b.port, r.status, next)
	}
	if r.decodeErr != nil {
		return fmt.Errorf("端口 %d 上的进程不是看板：健康检查响应不是合法 JSON（%v）。%s", b.port, r.decodeErr, next)
	}
	if r.probe.OK == nil || r.probe.Version == nil {
		return fmt.Errorf("端口 %d 上的进程不是看板：健康检查响应缺少 ok/version 字段。%s", b.port, next)
	}
	// A distinct failure from the ones above: the port really is the board,
	// it is just an older build than this binary's checks were written
	// against. The message therefore points at the app, not at the port —
	// `lsof` and BOSS_SDD_PORT are the wrong advice here, and following them
	// wastes the operator's time.
	//
	// An unparseable version yields ok == false and is deliberately let
	// through; see parseBoardVersion.
	if cmp, ok := compareBoardVersion(*r.probe.Version, minBoardVersion); ok && cmp < 0 {
		return fmt.Errorf(
			"端口 %d 上的看板版本过旧：health 报告 version=%q，本 MCP 需要 >= %s。"+
				"这是 BossSDD.app 没跟着 MCP 一起重建导致的版本不一致；"+
				"请重新构建并重新安装 app（./Scripts/bundle.sh --install），然后重试。",
			b.port, *r.probe.Version, minBoardVersion,
		)
	}
	return nil
}

func (b *board) send(ctx context.Context, method, path string, body, out any) error {
	var reader *bytes.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	} else {
		reader = bytes.NewReader(nil)
	}
	request, err := http.NewRequestWithContext(ctx, method, b.base+path, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := b.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	decoder := json.NewDecoder(response.Body)
	if response.StatusCode >= 400 {
		var failure apiError
		if decoder.Decode(&failure) == nil && failure.Error.Message != "" {
			return fmt.Errorf("%s", failure.Error.Message)
		}
		return &ambiguousError{err: fmt.Errorf("看板返回 HTTP %d", response.StatusCode)}
	}
	if out == nil {
		return nil
	}
	if err := decoder.Decode(out); err != nil {
		return &ambiguousError{err: err}
	}
	return nil
}

// isRefused reports whether err means "nothing is listening on the port" —
// specifically ECONNREFUSED — as opposed to some other transport failure
// (a reset, a timeout, a cancelled context) that says nothing about whether
// the app needs launching. Matching any *net.OpError here was too broad: a
// mid-response connection reset would read as "not running" and trigger a
// pointless launchApp() + up to 12s of retries against a port something is
// actually holding.
func isRefused(err error) bool {
	return errors.Is(err, syscall.ECONNREFUSED)
}

func launchApp() error {
	if _, err := os.Stat(appPath); err != nil {
		return err
	}
	return exec.Command("/usr/bin/open", "-g", "-a", appPath).Run()
}
