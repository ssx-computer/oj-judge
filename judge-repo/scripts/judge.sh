#!/bin/bash
# Sandboxed judge main controller (runs on the GitHub Actions runner host).
#
# Security model — untrusted user code NEVER runs on the host. There is NO
# static code scanning: every submission (compile + run) executes inside a
# hardened Docker container and is stopped by hard limits:
#   1. --network none            -> no network access (can't exfiltrate/leech,
#      can't link external resources during compile)
#   2. --memory / --cpus / --pids-limit
#                               -> cgroup hard limits (memory, CPU, fork bomb)
#   3. --cap-drop ALL --no-new-privileges --user 65534
#                               -> no privileges, no /dev access, can't escape
#   4. --read-only + tmpfs       -> can't touch the host filesystem
#   5. Judge data (testcases) is parsed on the HOST; only test INPUT files are
#      mounted into the container (read-only). Expected outputs NEVER enter the
#      container — comparison happens on the host after the container exits.
#   6. Per-case wall-clock kill via `timeout -s KILL` inside the container plus
#      an outer timeout (`action_timeout`, default 300s) on `docker run` itself.
#
# Output contract: writes result.json to CWD (same as the legacy judge.sh),
# consumed by .github/workflows/judge.yml -> /api/v1/internal/callback
set -u

# Python interpreter: prefer python3 (Linux runners), fall back to `python`.
# Probe by actually running it — some environments ship a broken python3 stub.
PY="python3"
if ! "$PY" -c "print(1)" >/dev/null 2>&1; then
  PY="python"
fi

SUBMISSION_ID="${SUBMISSION_ID:-}"
LANGUAGE="${LANGUAGE:-}"
SOURCE_FILE="${SOURCE_FILE:-}"
JUDGE_DATA="${JUDGE_DATA:-judge_data.json}"
# Expand a literal $HOME if the caller passed the path verbatim (GitHub
# Actions `env:` does NOT expand shell variables).
JUDGE_DATA="${JUDGE_DATA//\$HOME/$HOME}"

# ---------------- helpers ----------------
json_get() { # python expression on `inner` (the unwrapped data object)
  "$PY" -c "
import json,sys
d=json.load(open('$JUDGE_DATA'))
inner=d.get('data',d)
print($1)
" 2>/dev/null
}

fail_json() { # status message
  "$PY" - "$SUBMISSION_ID" "$1" "$2" <<'PY'
import json, sys
sid, status, msg = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({"submission_id": sid, "status": status,
                  "details": [{"status": status, "message": msg}]}, ensure_ascii=False))
PY
}

# ---------------- parse judge data (host side only) ----------------
TIME_LIMIT=$(json_get "inner.get('problem',{}).get('time_limit',1000)")
MEMORY_LIMIT=$(json_get "inner.get('problem',{}).get('memory_limit',256)")
N_CASES=$(json_get "len(inner.get('testcases',[]))")
JUDGE_TYPE=$(json_get "inner.get('problem',{}).get('judge_type','default')")
SPJ_LANG=$(json_get "inner.get('problem',{}).get('spj_language','')")
SPJ_CODE=$(json_get "inner.get('spj_code','')")

# Fail fast if judge data could not be parsed (missing file, API error, ...)
if [ -z "$TIME_LIMIT" ] || [ -z "$MEMORY_LIMIT" ] || [ -z "$N_CASES" ]; then
  fail_json system_error "Failed to parse judge data from $JUDGE_DATA" > result.json
  exit 0
fi

# Hard cap for the WHOLE judging action (compile + all test cases), in
# seconds. The admin can configure it via the site setting `action_timeout`
# (default 300); judge-data returns it as `action_timeout`. Beyond this the
# action is killed and system_error is reported.
ACTION_TIMEOUT=$(json_get "inner.get('action_timeout', 300)")
if ! [ "$ACTION_TIMEOUT" -ge 1 ] 2>/dev/null; then
  ACTION_TIMEOUT=300
fi

echo "Judge config: time_limit=${TIME_LIMIT}ms, memory_limit=${MEMORY_LIMIT}MB, testcases=${N_CASES}, judge_type=${JUDGE_TYPE}"
echo "Submission: id=${SUBMISSION_ID}, language=${LANGUAGE}, file=${SOURCE_FILE}"

# ---------------- 1. prepare sandbox workdir ----------------
WORK_DIR="/tmp/judge_${SUBMISSION_ID}"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/box" "$WORK_DIR/inputs" "$WORK_DIR/outputs" "$WORK_DIR/expected" "$WORK_DIR/cases"
chmod 777 "$WORK_DIR/box" "$WORK_DIR/outputs" "$WORK_DIR/cases"
chmod 755 "$WORK_DIR/inputs" "$WORK_DIR/expected"

SOURCE_EXT="${SOURCE_FILE##*.}"
[ "$SOURCE_EXT" = "$SOURCE_FILE" ] && SOURCE_EXT=""
SOURCE_FILENAME="solution${SOURCE_EXT:+.$SOURCE_EXT}"
cp "$SOURCE_FILE" "$WORK_DIR/box/$SOURCE_FILENAME"

# Inputs are mounted read-only into the container; expected stays on the host.
for i in $(seq 0 $((N_CASES - 1))); do
  json_get "inner['testcases'][$i]['input']" > "$WORK_DIR/inputs/$i.txt"
  json_get "inner['testcases'][$i]['expected_output']" > "$WORK_DIR/expected/$i.txt"
done
chmod -R a+r "$WORK_DIR/inputs"

# ---------------- 3. compile/run command + sandbox image per language ----------------
COMPILE_CMD=""
RUN_CMD=""
IMAGE=""
case "$LANGUAGE" in
  python)
    IMAGE="python:3.12-slim"
    RUN_CMD=""$PY" -B /box/$SOURCE_FILENAME"
    ;;
  cpp)
    IMAGE="sandbox:latest"
    COMPILE_CMD="g++ -std=c++17 -O2 -o /box/solution_bin /box/$SOURCE_FILENAME"
    RUN_CMD="/box/solution_bin"
    ;;
  java)
    IMAGE="eclipse-temurin:21-jdk"
    cp "$SOURCE_FILE" "$WORK_DIR/box/Main.java"
    COMPILE_CMD="javac /box/Main.java"
    RUN_CMD="java -cp /box Main"
    ;;
  javascript)
    IMAGE="node:22-bookworm-slim"
    RUN_CMD="node /box/$SOURCE_FILENAME"
    ;;
  c)
    IMAGE="sandbox:latest"
    COMPILE_CMD="gcc -std=c11 -O2 -o /box/solution_bin /box/$SOURCE_FILENAME"
    RUN_CMD="/box/solution_bin"
    ;;
  go)
    IMAGE="golang:1.24-bookworm"
    cp "$SOURCE_FILE" "$WORK_DIR/box/main.go"
    COMPILE_CMD="GOCACHE=/tmp/gocache GOFLAGS=-buildvcs=false go build -o /box/solution_bin /box/main.go"
    RUN_CMD="/box/solution_bin"
    ;;
  rust)
    IMAGE="rust:1-bookworm"
    cp "$SOURCE_FILE" "$WORK_DIR/box/main.rs"
    COMPILE_CMD="rustc -O -o /box/solution_bin /box/main.rs"
    RUN_CMD="/box/solution_bin"
    ;;
  *)
    echo "{\"submission_id\": \"$SUBMISSION_ID\", \"status\": \"system_error\", \"details\": [{\"status\": \"system_error\", \"message\": \"Unsupported language: $LANGUAGE\"}]}" > result.json
    exit 0
    ;;
esac

TL_SEC=$("$PY" -c "print(int($TIME_LIMIT / 1000) + 1)")
COMPILE_TIMEOUT="${COMPILE_TIMEOUT:-60}"   # seconds, capped for the compile phase
MEM_MB=$((MEMORY_LIMIT + 512))   # headroom for the compiler; runtime is capped by ulimit + cgroup

cp scripts/run_inner.sh "$WORK_DIR/box/run_inner.sh"
chmod +x "$WORK_DIR/box/run_inner.sh"

# Local sandbox image (built/cached by the workflow) takes priority; languages
# still on upstream images fall back to pulling.
if ! sudo docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Pulling sandbox image: $IMAGE"
  if ! sudo docker pull -q "$IMAGE" > /dev/null 2>&1; then
    fail_json system_error "Failed to prepare sandbox image $IMAGE" > result.json
    exit 0
  fi
else
  echo "Sandbox image $IMAGE already present locally"
fi

TOTAL_TIMEOUT=$ACTION_TIMEOUT   # hard cap for the whole judging action
echo "Running submission in hardened container ($IMAGE), total budget ${TOTAL_TIMEOUT}s"
timeout -s KILL "$TOTAL_TIMEOUT" sudo docker run --rm \
  --network none \
  --memory "${MEM_MB}m" --memory-swap "${MEM_MB}m" \
  --cpus 1 \
  --pids-limit 64 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user 65534:65534 \
  --read-only \
  --tmpfs /tmp:rw,size=128m \
  --tmpfs /dev/shm:rw,size=64m \
  -v "$WORK_DIR/box:/box" \
  -v "$WORK_DIR/inputs:/inputs:ro" \
  -v "$WORK_DIR/outputs:/outputs" \
  -w /box \
  "$IMAGE" \
  bash /box/run_inner.sh "$LANGUAGE" "$COMPILE_CMD" "$RUN_CMD" "$N_CASES" "$TL_SEC" "$((MEMORY_LIMIT * 1024))" "$COMPILE_TIMEOUT" \
  > "$WORK_DIR/container.log" 2>&1
RUN_RC=$?

if [ $RUN_RC -ne 0 ]; then
  if [ -f "$WORK_DIR/outputs/compile_error.txt" ]; then
    COMPILE_ERR=$(head -c 2000 "$WORK_DIR/outputs/compile_error.txt")
    echo "{\"submission_id\":\"$SUBMISSION_ID\",\"status\":\"compile_error\",\"details\":[{\"status\":\"compile_error\",\"message\":$(echo "$COMPILE_ERR" | "$PY" -c 'import sys,json; print(json.dumps(sys.stdin.read()))')}]}" > result.json
  elif [ $RUN_RC -eq 124 ]; then
    fail_json system_error "Judging exceeded the configured max runtime (${ACTION_TIMEOUT}s) and was stopped" > result.json
  else
    LOG_TAIL=$(tail -c 500 "$WORK_DIR/container.log" | tr '\n' ' ')
    fail_json system_error "Sandbox execution failed (exit $RUN_RC): $LOG_TAIL" > result.json
  fi
  exit 0
fi

# ---------------- 4. per-case results ----------------
META="$WORK_DIR/outputs/meta.json"
if [ ! -f "$META" ]; then
  fail_json system_error "Judge produced no per-case metadata" > result.json
  exit 0
fi

TOTAL_SCORE=0
MAX_SCORE=0
MAX_TIME=0
MAX_MEMORY=0
OVERALL_STATUS="accepted"
DETAILS="["

for i in $(seq 0 $((N_CASES - 1))); do
  SCORE=$(json_get "inner['testcases'][$i].get('score',10)")
  IS_SAMPLE=$(json_get "json.dumps(inner['testcases'][$i].get('is_sample',0))")
  MAX_SCORE=$((MAX_SCORE + SCORE))

  # read per-case metadata with python (robust against weird chars)
  META_LINE=$("$PY" -c "
import json
meta=json.load(open('$META'))
print(meta[$i]['exit_code'], meta[$i]['time_ms'], meta[$i].get('memory_kb', 0))
")
  EXIT_CODE=$(echo "$META_LINE" | awk '{print $1}')
  ELAPSED_MS=$(echo "$META_LINE" | awk '{print $2}')
  MEMORY_KB=$(echo "$META_LINE" | awk '{print $3}')
  MEMORY_USED=$((MEMORY_KB / 1024))   # KB -> MB

  TC_STATUS=""
  TC_MESSAGE=""

  if [ $ELAPSED_MS -gt $MAX_TIME ]; then MAX_TIME=$ELAPSED_MS; fi
  if [ $MEMORY_USED -gt $MAX_MEMORY ]; then MAX_MEMORY=$MEMORY_USED; fi

  if [ $EXIT_CODE -eq 124 ]; then
    TC_STATUS="time_limit_exceeded"
    TC_MESSAGE="Time limit exceeded (${ELAPSED_MS}ms > ${TIME_LIMIT}ms)"
    OVERALL_STATUS="time_limit_exceeded"
  elif [ $EXIT_CODE -eq 137 ]; then
    TC_STATUS="memory_limit_exceeded"
    TC_MESSAGE="Memory limit exceeded (cgroup OOM killed the process)"
    OVERALL_STATUS="memory_limit_exceeded"
  elif [ $EXIT_CODE -ne 0 ]; then
    TC_STATUS="runtime_error"
    ERROR_MSG=$(head -c 500 "$WORK_DIR/outputs/$i.err" 2>/dev/null || echo "Unknown error")
    TC_MESSAGE="Runtime error (exit code $EXIT_CODE): $ERROR_MSG"
    OVERALL_STATUS="runtime_error"
  else
    if [ "$JUDGE_TYPE" = "spj" ]; then
      TC_STATUS="pending_spj"   # resolved below by the SPJ container
    else
      VERDICT=$("$PY" -c "
expected = open('$WORK_DIR/expected/$i.txt').read()
actual = open('$WORK_DIR/outputs/$i.txt').read()
print('MATCH' if expected.strip() == actual.strip() else 'MISMATCH')
")
      if [ "$VERDICT" = "MATCH" ]; then
        TC_STATUS="accepted"
        TOTAL_SCORE=$((TOTAL_SCORE + SCORE))
      else
        TC_STATUS="wrong_answer"
        TC_MESSAGE="Output differs from expected"
        if [ "$OVERALL_STATUS" = "accepted" ]; then OVERALL_STATUS="wrong_answer"; fi
      fi
    fi
  fi

  echo "Testcase $((i+1))/$N_CASES: $TC_STATUS (${ELAPSED_MS}ms)"

  if [ "$TC_STATUS" != "pending_spj" ]; then
    if [ "$TC_STATUS" = "accepted" ]; then
      TC_SCORE=$SCORE
    else
      TC_SCORE=0
    fi
    if [ $i -gt 0 ]; then DETAILS+=","; fi
    DETAILS+="{\"status\":\"$TC_STATUS\",\"time_used\":$ELAPSED_MS,\"memory_used\":$MEMORY_USED,\"score\":$TC_SCORE,\"is_sample\":$IS_SAMPLE"
    if [ -n "$TC_MESSAGE" ]; then
      DETAILS+=",\"message\":$(echo "$TC_MESSAGE" | "$PY" -c 'import sys,json; print(json.dumps(sys.stdin.read()))')"
    fi
    DETAILS+="}"
  fi
done

# ---------------- 5. SPJ checkers (sandboxed too) ----------------
if [ "$JUDGE_TYPE" = "spj" ]; then
  if [ -z "$SPJ_LANG" ] || [ -z "$SPJ_CODE" ]; then
    fail_json system_error "SPJ problem missing spj_language/spj_code" > result.json
    exit 0
  fi

  # stage (in, out, expected) per case into a read-only mount for the SPJ container
  for i in $(seq 0 $((N_CASES - 1))); do
    mkdir -p "$WORK_DIR/cases/$i"
    cp "$WORK_DIR/inputs/$i.txt" "$WORK_DIR/cases/$i/in.txt"
    cp "$WORK_DIR/outputs/$i.txt" "$WORK_DIR/cases/$i/out.txt"
    cp "$WORK_DIR/expected/$i.txt" "$WORK_DIR/cases/$i/expected.txt"
  done
  chmod -R a+r "$WORK_DIR/cases"

  SPJ_COMPILE_CMD=""
  SPJ_CMD=""
  SPJ_IMAGE=""
  case "$SPJ_LANG" in
    python) SPJ_IMAGE="python:3.12-slim"; SPJ_CMD=""$PY" -B /box/spj_solution.py" ;;
    cpp) SPJ_IMAGE="sandbox:latest"; SPJ_COMPILE_CMD="g++ -std=c++17 -O2 -o /box/spj_bin /box/spj_solution.cpp"; SPJ_CMD="/box/spj_bin" ;;
    java) SPJ_IMAGE="eclipse-temurin:21-jdk"; printf '%s' "$SPJ_CODE" > "$WORK_DIR/box/SpjMain.java"; SPJ_COMPILE_CMD="javac /box/SpjMain.java"; SPJ_CMD="java -cp /box SpjMain" ;;
    javascript) SPJ_IMAGE="node:22-bookworm-slim"; SPJ_CMD="node /box/spj_solution.js" ;;
    c) SPJ_IMAGE="sandbox:latest"; SPJ_COMPILE_CMD="gcc -std=c11 -O2 -o /box/spj_bin /box/spj_solution.c"; SPJ_CMD="/box/spj_bin" ;;
    go) SPJ_IMAGE="golang:1.24-bookworm"; printf '%s' "$SPJ_CODE" > "$WORK_DIR/box/spj_main.go"; SPJ_COMPILE_CMD="GOCACHE=/tmp/gocache GOFLAGS=-buildvcs=false go build -o /box/spj_bin /box/spj_main.go"; SPJ_CMD="/box/spj_bin" ;;
    rust) SPJ_IMAGE="rust:1-bookworm"; printf '%s' "$SPJ_CODE" > "$WORK_DIR/box/spj_main.rs"; SPJ_COMPILE_CMD="rustc -O -o /box/spj_bin /box/spj_main.rs"; SPJ_CMD="/box/spj_bin" ;;
    *)
      fail_json system_error "Unsupported SPJ language: $SPJ_LANG" > result.json
      exit 0
      ;;
  esac

  # write SPJ source with the right extension (python/cpp/js/c use printf)
  case "$SPJ_LANG" in
    python|cpp|javascript|c) printf '%s' "$SPJ_CODE" > "$WORK_DIR/box/spj_solution.$([ "$SPJ_LANG" = "cpp" ] && echo cpp || ([ "$SPJ_LANG" = "javascript" ] && echo js || ([ "$SPJ_LANG" = "c" ] && echo c || echo py)))" ;;
  esac

  cp scripts/run_spj_inner.sh "$WORK_DIR/box/run_spj_inner.sh"
  chmod +x "$WORK_DIR/box/run_spj_inner.sh"

  if ! sudo docker image inspect "$SPJ_IMAGE" >/dev/null 2>&1; then
    echo "Pulling SPJ sandbox image: $SPJ_IMAGE"
    if ! sudo docker pull -q "$SPJ_IMAGE" > /dev/null 2>&1; then
      fail_json system_error "Failed to prepare SPJ sandbox image $SPJ_IMAGE" > result.json
      exit 0
    fi
  else
    echo "SPJ sandbox image $SPJ_IMAGE already present locally"
  fi

  SPJ_TOTAL_TIMEOUT=$ACTION_TIMEOUT
  timeout -s KILL "$SPJ_TOTAL_TIMEOUT" sudo docker run --rm \
    --network none \
    --memory "${MEM_MB}m" --memory-swap "${MEM_MB}m" \
    --cpus 1 \
    --pids-limit 64 \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --user 65534:65534 \
    --read-only \
    --tmpfs /tmp:rw,size=128m \
    --tmpfs /dev/shm:rw,size=64m \
    -v "$WORK_DIR/box:/box" \
    -v "$WORK_DIR/cases:/cases:ro" \
    -w /box \
    "$SPJ_IMAGE" \
    bash /box/run_spj_inner.sh "$SPJ_LANG" "$SPJ_CMD" "$SPJ_COMPILE_CMD" "$N_CASES" "$TL_SEC" "$COMPILE_TIMEOUT" \
    > "$WORK_DIR/spj_container.log" 2>&1
  SPJ_RC=$?

  if [ $SPJ_RC -ne 0 ]; then
    if [ -f "$WORK_DIR/box/spj_compile_error.txt" ]; then
      SPJ_ERR=$(head -c 2000 "$WORK_DIR/box/spj_compile_error.txt")
      echo "{\"submission_id\":\"$SUBMISSION_ID\",\"status\":\"system_error\",\"details\":[{\"status\":\"system_error\",\"message\":$(echo "$SPJ_ERR" | "$PY" -c 'import sys,json; print(json.dumps(sys.stdin.read()))')}]}" > result.json
    else
      fail_json system_error "SPJ sandbox execution failed (exit $SPJ_RC)" > result.json
    fi
    exit 0
  fi

  # merge SPJ verdicts into per-case results
  for i in $(seq 0 $((N_CASES - 1))); do
    SPJ_META=$("$PY" -c "
import json
meta=json.load(open('$WORK_DIR/box/spj_meta.json'))
print(meta[$i]['exit_code'], meta[$i]['time_ms'])
")
    SPJ_EXIT=$(echo "$SPJ_META" | awk '{print $1}')
    SPJ_MS=$(echo "$SPJ_META" | awk '{print $2}')
    SPJ_MSG=$(head -c 500 "$WORK_DIR/box/spj_stderr_${i}.txt" 2>/dev/null || echo "")

    if [ $SPJ_MS -gt $MAX_TIME ]; then MAX_TIME=$SPJ_MS; fi

    if [ $SPJ_EXIT -eq 124 ]; then
      TC_STATUS="time_limit_exceeded"
      TC_MESSAGE="SPJ time limit exceeded"
      OVERALL_STATUS="time_limit_exceeded"
    elif [ $SPJ_EXIT -eq 0 ]; then
      TC_STATUS="accepted"
      TOTAL_SCORE=$((TOTAL_SCORE + SCORE))
      TC_MESSAGE=""
    elif [ $SPJ_EXIT -eq 1 ]; then
      TC_STATUS="wrong_answer"
      TC_MESSAGE="SPJ: $SPJ_MSG"
      if [ "$OVERALL_STATUS" = "accepted" ]; then OVERALL_STATUS="wrong_answer"; fi
    else
      TC_STATUS="system_error"
      TC_MESSAGE="SPJ checker error (exit code $SPJ_EXIT): $SPJ_MSG"
      OVERALL_STATUS="system_error"
    fi

    SCORE=$(json_get "inner['testcases'][$i].get('score',10)")
    IS_SAMPLE=$(json_get "json.dumps(inner['testcases'][$i].get('is_sample',0))")
    if [ "$TC_STATUS" = "accepted" ]; then TC_SCORE=$SCORE; else TC_SCORE=0; fi
    if [ $i -gt 0 ]; then DETAILS+=","; fi
    DETAILS+="{\"status\":\"$TC_STATUS\",\"time_used\":$SPJ_MS,\"memory_used\":0,\"score\":$TC_SCORE,\"is_sample\":$IS_SAMPLE"
    if [ -n "$TC_MESSAGE" ]; then
      DETAILS+=",\"message\":$(echo "$TC_MESSAGE" | "$PY" -c 'import sys,json; print(json.dumps(sys.stdin.read()))')"
    fi
    DETAILS+="}"
  done
fi

DETAILS+="]"

echo "{\"submission_id\":\"$SUBMISSION_ID\",\"status\":\"$OVERALL_STATUS\",\"score\":$TOTAL_SCORE,\"time_used\":$MAX_TIME,\"memory_used\":$MAX_MEMORY,\"details\":$DETAILS}" > result.json
echo "Judge completed: status=$OVERALL_STATUS, score=$TOTAL_SCORE/$MAX_SCORE"

rm -rf "$WORK_DIR"
