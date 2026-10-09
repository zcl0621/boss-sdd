#!/bin/sh
# Runs the context-keeper unit tests. State goes to a throwaway directory, never to ~/.local/state.
# Exit status is non-zero if any test failed.
cd "$(dirname "$0")" || exit 1
XDG_STATE_HOME=$(mktemp -d)
export XDG_STATE_HOME
OPENCODE_TODO_DIR=$XDG_STATE_HOME/todos
export OPENCODE_TODO_DIR
trap 'rm -rf "$XDG_STATE_HOME"' EXIT
failed=0
for t in *.test.mjs; do
  if node "$t" >"$XDG_STATE_HOME/out" 2>&1; then
    echo "ok   $t"
  else
    echo "FAIL $t"
    grep -v '^\[context-keeper\]' "$XDG_STATE_HOME/out"
    failed=1
  fi
done
exit $failed
