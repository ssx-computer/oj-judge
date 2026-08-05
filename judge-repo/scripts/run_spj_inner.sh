#!/bin/bash
# Runs INSIDE the SPJ sandbox container.
# SPJ checkers are admin-authored, but they still run sandboxed (no network,
# capped resources) for defense in depth. The SPJ receives
# (input, output, expected) per test case, exactly like a normal judge.
#
# Usage: run_spj_inner.sh <spj_language> <spj_run_cmd> <spj_compile_cmd> <n_cases> <tl_sec> <compile_timeout>
set -u

WORK=/box
CASES=/cases

SPJ_LANGUAGE="$1"
SPJ_CMD="$2"
SPJ_COMPILE_CMD="$3"
N_CASES="$4"
TL_SEC="$5"
COMPILE_TIMEOUT="$6"

cd "$WORK"

if [ -n "$SPJ_COMPILE_CMD" ]; then
  echo "Compiling SPJ: $SPJ_COMPILE_CMD"
  if ! timeout -s KILL "$COMPILE_TIMEOUT" bash -c "$SPJ_COMPILE_CMD" > /tmp/spj_compile_out.txt 2>&1; then
    echo "SPJ_COMPILE_FAIL"
    { echo "SPJ compilation failed (timeout ${COMPILE_TIMEOUT}s):"; head -c 2000 /tmp/spj_compile_out.txt; } > "$WORK/spj_compile_error.txt"
    exit 2
  fi
  echo "SPJ compilation OK"
fi

rm -f "$WORK/spj_meta.json"
{
  echo '['
  for i in $(seq 0 $((N_CASES - 1))); do
    IN="$CASES/$i/in.txt"
    OUT="$CASES/$i/out.txt"
    EXP="$CASES/$i/expected.txt"
    [ -f "$EXP" ] || : > "$EXP"

    START=$(date +%s%N)
    timeout -s KILL "$TL_SEC" bash -c "cd '$WORK' && $SPJ_CMD '$IN' '$OUT' '$EXP'" \
      > /tmp/spj_stdout.txt 2> "$WORK/spj_stderr_${i}.txt"
    RC=$?
    END=$(date +%s%N)
    MS=$(( (END - START) / 1000000 ))
    if [ "$i" -gt 0 ]; then echo ','; fi
    printf '{"index":%d,"exit_code":%d,"time_ms":%d}' "$i" "$RC" "$MS"
  done
  echo
  echo ']'
} > "$WORK/spj_meta.json"

exit 0
