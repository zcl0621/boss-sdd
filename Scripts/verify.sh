#!/bin/bash
# Verifies this repository end to end on this machine. One command, one exit code.
#
#   ./Scripts/verify.sh
#
# Stages, in order, stopping at the first failure:
#   build   release build of both halves (Swift app, Go MCP server)
#   test    swift test, then go test ./...
#   bundle  ./Scripts/bundle.sh — assembles .build/BossSDD.app
#   live    boots the server the app contains against a throwaway database on an
#           OS-assigned port and drives it over real HTTP
#
# The live stage links the very object file the release app links
# (.build/release/BoardKit.o) and hands Store an explicit database path, so it
# can never reach the real board at ~/.claude/plan-sdd/board.sqlite3. The script
# checks that file's timestamp before and after and fails if it moved.
#
# Nothing is left behind: the server is killed and the temporary directory
# removed on every exit path — success, failure, or interrupt.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REAL_DB="$HOME/.claude/plan-sdd/board.sqlite3"

WORK=""
SERVER_PID=""
STAGE="startup"
PORT=""
HTTP_STATUS=""
HTTP_BODY=""

# --- lifecycle ---------------------------------------------------------------

cleanup() {
    local status=$?
    trap - EXIT INT TERM
    if [[ -n "$SERVER_PID" ]]; then
        # Grouped with stderr closed so bash's own "Terminated: 15" job notice
        # does not land in the output of an otherwise clean run.
        {
            if kill -0 "$SERVER_PID" 2>/dev/null; then
                kill "$SERVER_PID" 2>/dev/null || true
                local waited=0
                while kill -0 "$SERVER_PID" 2>/dev/null && (( waited < 25 )); do
                    sleep 0.2
                    waited=$(( waited + 1 ))
                done
                kill -9 "$SERVER_PID" 2>/dev/null || true
            fi
            wait "$SERVER_PID" || true
        } 2>/dev/null
        echo "cleanup: live server (pid $SERVER_PID) stopped"
    fi
    if [[ -n "$WORK" ]] && [[ -d "$WORK" ]]; then
        rm -rf "$WORK"
        echo "cleanup: removed $WORK"
    fi
    if (( status != 0 )); then
        echo "verify.sh FAILED in stage '$STAGE' (exit $status)" >&2
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'STAGE="$STAGE, interrupted"; exit 130' INT
trap 'STAGE="$STAGE, terminated"; exit 143' TERM

stage() {
    STAGE="$1"
    printf '\n=== stage: %s — %s ===\n' "$1" "$2"
}

fail() {
    printf 'verify.sh: %s\n' "$*" >&2
    exit 1
}

# --- assertions --------------------------------------------------------------

check() { # check <what> <expected> <actual>
    if [[ "$2" == "$3" ]]; then
        printf '  ok    %-44s %s\n' "$1" "$3"
    else
        printf '  FAIL  %s\n        expected: %s\n        actual:   %s\n' "$1" "$2" "$3" >&2
        exit 1
    fi
}

check_contains() { # check_contains <what> <needle> <haystack>
    if [[ "$3" == *"$2"* ]]; then
        printf '  ok    %-44s contains %s\n' "$1" "$2"
    else
        printf '  FAIL  %s\n        should contain: %s\n        actual:         %s\n' "$1" "$2" "$3" >&2
        exit 1
    fi
}

# --- HTTP --------------------------------------------------------------------

# request <method> <path> [json-body] [extra curl args...]
# Sets HTTP_STATUS and HTTP_BODY. A body implies Content-Type: application/json,
# which is what the API requires of every write.
request() {
    local method="$1" path="$2" json="${3-}"
    shift 3 2>/dev/null || shift $#
    local out="$WORK/response.json"
    local args=(--silent --show-error --output "$out" --write-out '%{http_code}'
                --max-time 20 -X "$method" "http://127.0.0.1:$PORT$path")
    if [[ -n "$json" ]]; then
        args+=(-H 'Content-Type: application/json' --data-binary "$json")
    fi
    HTTP_STATUS="$(curl "${args[@]}" "$@")"
    HTTP_BODY="$(cat "$out")"
}

jqv() { printf '%s' "$HTTP_BODY" | jq -r "$1"; }

real_db_stamp() {
    if [[ -e "$REAL_DB" ]]; then
        stat -f '%m/%z' "$REAL_DB"
    else
        echo "absent"
    fi
}

# --- preflight ---------------------------------------------------------------

cd "$ROOT"
stage preflight "tools this flow needs"
for tool in swift go jq curl swiftc; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is not on PATH"
    printf '  ok    %-44s %s\n' "$tool" "$(command -v "$tool")"
done

REAL_DB_BEFORE="$(real_db_stamp)"
printf '  ok    %-44s %s\n' "real board (must not move)" "$REAL_DB_BEFORE"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/boss-sdd-verify.XXXXXX")"
printf '  ok    %-44s %s\n' "throwaway directory" "$WORK"

# --- 1. build ----------------------------------------------------------------

stage build "release build of both halves"
swift build -c release --product BossSDD
( cd "$ROOT/mcp" && go build ./... )

# --- 2. test -----------------------------------------------------------------

stage test "swift test"
swift test

stage test "go test ./..."
( cd "$ROOT/mcp" && go test ./... )

# --- 3. bundle ---------------------------------------------------------------

stage bundle "./Scripts/bundle.sh"
"$ROOT/Scripts/bundle.sh"
[[ -x "$ROOT/.build/BossSDD.app/Contents/MacOS/BossSDD" ]] \
    || fail "bundle.sh did not produce an executable app binary"
[[ -x "$ROOT/.build/BossSDD.app/Contents/Resources/plan-sdd-mcp" ]] \
    || fail "bundle.sh did not put plan-sdd-mcp in the bundle"

# --- 4. live -----------------------------------------------------------------

stage live "boot the server and drive it over real HTTP"

# The app itself is a SwiftUI menu bar application whose BoardModel hard-codes
# Store() — i.e. ~/.claude/plan-sdd/board.sqlite3 — with no override. So this
# stage hosts the same server out of the same compiled BoardKit the release app
# links, with the one thing the app does not let us choose: the database path.
cat > "$WORK/livecheck-server.swift" <<'SWIFT'
import Foundation
import BoardKit

// Holds the bound port so API reports the port actually listening rather than
// the 0 that was requested.
final class PortBox: @unchecked Sendable { var value: UInt16 = 0 }

let arguments = CommandLine.arguments
guard arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: livecheck-server <database-path>\n".utf8))
    exit(2)
}

setvbuf(stdout, nil, _IOLBF, 0)

let store: Store
do {
    store = try Store(path: URL(fileURLWithPath: arguments[1]))
} catch {
    FileHandle.standardError.write(Data("store error: \(error)\n".utf8))
    exit(1)
}

// These stay at file scope on purpose: HTTPServer's listener callbacks hold the
// server weakly, so a server that goes out of scope stops reporting its state
// (and stops serving) while the socket still looks bound from outside.
let box = PortBox()
let server = HTTPServer(port: 0) { request in
    API(store: store, port: box.value).handle(request)
}
server.onStateChange { state in
    switch state {
    case .listening(let port):
        box.value = port
        print("listening \(port)")
        fflush(stdout)
    case .failed(let reason):
        FileHandle.standardError.write(Data("failed \(reason)\n".utf8))
        exit(1)
    case .stopped:
        break
    }
}
server.start()
dispatchMain()
SWIFT

swiftc -O -I "$ROOT/.build/release" \
    "$WORK/livecheck-server.swift" "$ROOT/.build/release/BoardKit.o" \
    -lsqlite3 -o "$WORK/livecheck-server"

DB="$WORK/board.sqlite3"
"$WORK/livecheck-server" "$DB" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!

# Port 0 means the OS picks; read back what it picked rather than guessing.
for _ in $(seq 1 100); do
    PORT="$(awk '/^listening /{print $2; exit}' "$WORK/server.log" 2>/dev/null || true)"
    [[ -n "$PORT" ]] && break
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        cat "$WORK/server.log" >&2
        fail "the live server exited before it reported a port"
    fi
    sleep 0.1
done
[[ -n "$PORT" ]] || { cat "$WORK/server.log" >&2; fail "no port reported within 10s"; }
printf '  ok    %-44s %s (pid %s)\n' "listening on" "127.0.0.1:$PORT" "$SERVER_PID"

# Interlock: a fresh throwaway database has no runs. If this stage ever ended up
# pointed at the real board, this is where it would show.
request GET /api/health
check "health status" 200 "$HTTP_STATUS"
check "health ok" true "$(jqv .ok)"
check "health version" "$(awk -F'"' '/^public let boardKitVersion/{print $2}' "$ROOT/Sources/BoardKit/HTTPServer.swift")" "$(jqv .version)"
check "health port" "$PORT" "$(jqv .port)"
check "runs in the throwaway database" 0 "$(jqv .runs)"

# -- a run --------------------------------------------------------------------

request POST /api/runs '{"title":"verify.sh live check","project":"verify.sh-live"}'
check "create run status" 201 "$HTTP_STATUS"
RUN_ID="$(jqv .id)"
check "created run title" "verify.sh live check" "$(jqv .title)"
check "created run status field" planning "$(jqv .status)"
[[ -n "$RUN_ID" && "$RUN_ID" != null ]] || fail "no run id came back"
printf '  ok    %-44s %s\n' "run id" "$RUN_ID"

# -- a DAG with a real dependency and a contended resource --------------------

request PUT "/api/runs/$RUN_ID/tasks" '{"tasks":[
  {"id":"T1","title":"holds the gate","exclusive_resource":["gate:verify-live"]},
  {"id":"T2","title":"waits for T1","depends_on":["T1"]},
  {"id":"T3","title":"wants the same gate","exclusive_resource":["gate:verify-live"]}
]}'
check "write tasks status" 200 "$HTTP_STATUS"
check "graph valid" true "$(jqv .graph.valid)"
check "graph topological layers" "T1+T3 T2" "$(jqv '.graph.topological_layers | map(join("+")) | join(" ")')"
check "ready tasks" "T1,T3" "$(jqv '.graph.ready_task_ids | join(",")')"
check "T2 waiting on" "T1" "$(jqv '.graph.waiting_on.T2 | join(",")')"
check "T2 blocked by dependency" "T1" "$(jqv '.graph.blocked_by.T2.dependency_task_ids | join(",")')"
check "T1 dependents" "T2" "$(jqv '.graph.dependents.T1 | join(",")')"

# -- starting a task whose dependency is not done is refused ------------------

request PUT "/api/runs/$RUN_ID/tasks/T2" '{"status":"running"}'
check "start blocked task status" 409 "$HTTP_STATUS"
check "start blocked task error code" conflict "$(jqv .error.code)"
check_contains "start blocked task message" "not ready" "$(jqv .error.message)"

# -- two tasks contending for one exclusive resource is refused ---------------

request PUT "/api/runs/$RUN_ID/tasks/T1" '{"status":"running"}'
check "start T1 status" 200 "$HTTP_STATUS"
check "T1 is running" running "$(jqv '.tasks[] | select(.id=="T1") | .status')"
check "ready tasks after T1 started" "T3" "$(jqv '.graph.ready_task_ids | join(",")')"
check "T3 resource conflict holder" "T1" "$(jqv '.graph.blocked_by.T3.resource_conflicts[0].task_id')"
check "T3 resource conflict resource" "gate:verify-live" "$(jqv '.graph.blocked_by.T3.resource_conflicts[0].resources | join(",")')"

request PUT "/api/runs/$RUN_ID/tasks/T3" '{"status":"running"}'
check "contended start status" 409 "$HTTP_STATUS"
check "contended start error code" conflict "$(jqv .error.code)"
check_contains "contended start message" "exclusive resource conflict" "$(jqv .error.message)"

request GET "/api/runs/$RUN_ID"
check "T3 still pending after refusal" pending "$(jqv '.tasks[] | select(.id=="T3") | .status')"

# -- the guards the README documents ------------------------------------------

request GET /api/health '' -H 'Origin: http://example.invalid'
check "request carrying Origin" 403 "$HTTP_STATUS"

request POST /api/runs '' --data-binary '{"title":"no content type"}' -H 'Content-Type: text/plain'
check "write without a JSON content type" 400 "$HTTP_STATUS"

# -- memory: write, read back, delete -----------------------------------------
# Keys are folded to lower case in Store; every answer must name the stored
# spelling, not the one that was sent.

request POST /api/memories '{"project":"verify.sh-live","key":"Gate.Live-Check","value":"./Scripts/verify.sh","kind":"gate","source":"Scripts/verify.sh live stage"}'
check "write memory status" 200 "$HTTP_STATUS"
check "written memory key is folded" "gate.live-check" "$(jqv .key)"
check "written memory project" "verify.sh-live" "$(jqv .project)"
check "written memory kind" gate "$(jqv .kind)"

request GET "/api/memories/gate.live-check?project=verify.sh-live"
check "read memory status" 200 "$HTTP_STATUS"
check "read memory key" "gate.live-check" "$(jqv .key)"
check "read memory value" "./Scripts/verify.sh" "$(jqv .value)"

request GET "/api/memories?project=verify.sh-live&kind=gate"
check "list memories by kind" 1 "$(jqv '.memories | length')"

request DELETE "/api/memories/Gate.Live-Check?project=verify.sh-live"
check "delete memory status" 200 "$HTTP_STATUS"
check "delete names the stored key" "gate.live-check" "$(jqv .deleted)"
check "delete names the stored project" "verify.sh-live" "$(jqv .project)"

request GET "/api/memories/gate.live-check?project=verify.sh-live"
check "deleted memory is gone" 404 "$HTTP_STATUS"
check "deleted memory error code" not_found "$(jqv .error.code)"

request GET /api/health
check "runs after the live stage" 1 "$(jqv .runs)"

# -- the throwaway database is the one that was written ----------------------

[[ -s "$DB" ]] || fail "the throwaway database was never written: $DB"
printf '  ok    %-44s %s bytes\n' "throwaway database written" "$(stat -f %z "$DB")"

REAL_DB_AFTER="$(real_db_stamp)"
check "real board untouched (mtime/size)" "$REAL_DB_BEFORE" "$REAL_DB_AFTER"

STAGE="done"
printf '\n=== all stages passed: build, test, bundle, live ===\n'
