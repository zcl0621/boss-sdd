#!/bin/sh
# Runs the plan-memory plugin tests. State goes to a throwaway directory, never to ~/.local/state.
cd "$(dirname "$0")" || exit 1
XDG_STATE_HOME=$(mktemp -d)
export XDG_STATE_HOME
trap 'rm -rf "$XDG_STATE_HOME"' EXIT
failed=0
for t in *.test.mjs; do
  if node "$t" >"$XDG_STATE_HOME/out" 2>&1; then
    echo "ok   $t"
  else
    echo "FAIL $t"
    grep -v '^\[plan-memory\]' "$XDG_STATE_HOME/out"
    failed=1
  fi
done
exit $failed
