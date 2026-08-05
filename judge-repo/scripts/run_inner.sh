#!/bin/bash
# Runs INSIDE the sandbox container (untrusted code side).
# Compiles the solution (if needed), then executes it once per test case.
#
# Security invariants (enforced by the host `docker run` flags, not by this
# script):
#   - network disabled        (--network none)
#   - memory / CPU / PID caps (--memory, --cpus, --pids-limit)
#   - no privileges           (--cap-drop ALL, --no-new-privileges, --user)
#   - read-only rootfs        (--read-only + tmpfs /tmp)
#   - expected outputs NEVER exist inside this container: the host compares
#     outputs to expected values AFTER the container exits.
#
# Usage: run_inner.sh <language> <compile_cmd> <run_cmd> <n_cases> <tl_sec> <mem_kb> <compile_timeout>
set -u

WORK=/box
INPUTS=/inputs
OUT=/outputs

LANGUAGE="$1"
COMPILE_CMD="$2"
RUN_CMD="$3"
N_CASES="$4"
TL_SEC="$5"
MEM_KB="$6"
COMPILE_TIMEOUT="$7"

cd "$WORK"

if [ -n "$COMPILE_CMD" ]; then
  echo "Compiling: $COMPILE_CMD"
  # Compilation is capped too: a hostile/oversized source must not hog the
  # container (or exhaust the job budget) during the compile phase.
  if ! timeout -s KILL "$COMPILE_TIMEOUT" bash -c "$COMPILE_CMD" > /tmp/compile_out.txt 2>&1; then
    echo "COMPILE_FAIL"
    { echo "Compilation failed (timeout ${COMPILE_TIMEOUT}s):"; head -c 2000 /tmp/compile_out.txt; } > "$OUT/compile_error.txt"
    exit 2
  fi
  echo "Compilation OK"
fi

rm -f "$OUT/meta.json"
{
  echo '['
  # GNU time (-v) exists in the self-built sandbox image and enables per-case
  # peak RSS; upstream images without it fall back to memory_kb=0.
  if [ -x /usr/bin/time ]; then
    TIME_WRAPPER="/usr/bin/time -v"
  else
    TIME_WRAPPER=""
  fi

  for i in $(seq 0 $((N_CASES - 1))); do
    if [ ! -f "$INPUTS/$i.txt" ]; then
      echo "missing input $i" >&2
      exit 3
    fi
    START=$(date +%s%N)
    # Soft ulimit as an extra guard; cgroup --memory is the hard limit.
    ( ulimit -v "$MEM_KB" 2>/dev/null || true
      timeout -s KILL "$TL_SEC" $TIME_WRAPPER bash -c "cd '$WORK' && $RUN_CMD < '$INPUTS/$i.txt' > '$OUT/$i.txt' 2> '$OUT/$i.err'" 2> "$OUT/$i.mem"
    )
    RC=$?
    END=$(date +%s%N)
    MS=$(( (END - START) / 1000000 ))
    MEMORY_KB=0
    if [ -s "$OUT/$i.mem" ]; then
      MEMORY_KB=$(grep "Maximum resident set size" "$OUT/$i.mem" 2>/dev/null | awk '{print $NF}' | head -1)
      [ -z "$MEMORY_KB" ] && MEMORY_KB=0
    fi
    if [ "$i" -gt 0 ]; then echo ','; fi
    printf '{"index":%d,"exit_code":%d,"time_ms":%d,"memory_kb":%d}' "$i" "$RC" "$MS" "$MEMORY_KB"
  done
  echo
  echo ']'
} > "$OUT/meta.json"

exit 0
