#!/usr/bin/env bash
set -euo pipefail

repo=$(git rev-parse --show-toplevel)
cd "$repo"
bun_bin=$(command -v bun)
evidence=${1:-$(mktemp -d "${TMPDIR:-/tmp}/agent-slack-evidence.XXXXXX")}
mkdir -p "$evidence"
evidence=$(cd "$evidence" && pwd -P)
run_dir=$(mktemp -d "${TMPDIR:-/tmp}/agent-slack-offline.XXXXXX")
server_pid=
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$run_dir"
}
trap cleanup EXIT
mkdir -p "$run_dir/home" "$run_dir/config" "$run_dir/cache" "$run_dir/data" "$run_dir/runtime" "$run_dir/tmp"

python3 .agents/skills/verify-agent-slack/stub.py "$run_dir/port" "$evidence/requests.jsonl" >"$evidence/stub.out" 2>"$evidence/stub.err" &
server_pid=$!
for _ in {1..100}; do
  [[ -s "$run_dir/port" ]] && break
  kill -0 "$server_pid"
  sleep 0.05
done
[[ -s "$run_dir/port" ]]
port=$(cat "$run_dir/port")
clean_env=(env -i "PATH=$PATH" "HOME=$run_dir/home" "XDG_CONFIG_HOME=$run_dir/config" "XDG_CACHE_HOME=$run_dir/cache" "XDG_DATA_HOME=$run_dir/data" "XDG_RUNTIME_DIR=$run_dir/runtime" "TMPDIR=$run_dir/tmp" "CI=1" "AGENT_SLACK_NO_UPDATE_CHECK=1" "SLACK_TOKEN=xoxc-offline-fixture" "SLACK_COOKIE_D=offline-fixture" "SLACK_WORKSPACE_URL=https://fixture.slack.com" "AGENT_SLACK_FIXTURE_PORT=$port")
preload=$repo/.agents/skills/verify-agent-slack/preload.js
source_cli=("${clean_env[@]}" "$bun_bin" run --no-env-file --preload "$preload" src/index.ts)
built_cli=("${clean_env[@]}" "$bun_bin" --no-env-file --preload "$preload" dist/index.js)

run() {
  local name=$1 expected=$2 status
  shift 2
  printf '%q ' "$@" >"$evidence/$name.command"
  printf '\n' >>"$evidence/$name.command"
  if "$@" >"$evidence/$name.out" 2>"$evidence/$name.err"; then status=0; else status=$?; fi
  printf '%s\n' "$status" >"$evidence/$name.status"
  if [[ "$status" != "$expected" ]]; then
    printf '%s exited %s, expected %s\n' "$name" "$status" "$expected" >&2
    return 1
  fi
}

: >"$evidence/requests.jsonl"
"${clean_env[@]}" "$bun_bin" run --no-env-file build >"$evidence/build.out" 2>"$evidence/build.err"
{
  printf 'installed agent-slack: '
  command -v agent-slack || true
  printf 'bun: %s\n' "$bun_bin"
  printf 'package version: '
  jq -r .version package.json
} >"$evidence/doctor.txt"
run blocked-host 1 "${clean_env[@]}" "$bun_bin" --no-env-file --preload "$preload" -e 'await fetch("https://example.com")'
grep -q 'Offline fixture refused a non-fixture request' "$evidence/blocked-host.err"
run source-version 0 "${source_cli[@]}" --version
run built-version 0 "${built_cli[@]}" --version
cmp "$evidence/source-version.out" "$evidence/built-version.out"
[[ $(cat "$evidence/built-version.out") == "$(jq -r .version package.json)" ]]
run source-help 0 "${source_cli[@]}" message --help
run built-help 0 "${built_cli[@]}" message --help
for surface in source built; do
  if [[ $surface == source ]]; then cli=("${source_cli[@]}"); else cli=("${built_cli[@]}"); fi
  run "$surface-validation" 1 "${cli[@]}" message send D11111111
  run "$surface-safe-edit" 1 "${cli[@]}" --safe-mode message edit D11111111 text --ts 1700000000.000001
  run "$surface-safe-delete" 1 "${cli[@]}" --safe-mode message delete D11111111 --ts 1700000000.000001
  run "$surface-safe-send" 1 "${cli[@]}" --safe-mode message send D11111111 text
  run "$surface-get" 0 "${cli[@]}" message get D11111111 --ts 1700000000.000001
  run "$surface-list" 0 "${cli[@]}" message list D11111111 --limit 1
  run "$surface-search" 0 "${cli[@]}" search messages no-such-query --channel D11111111
  grep -q 'required' "$evidence/$surface-validation.err"
  grep -q 'Safe mode is active' "$evidence/$surface-safe-edit.err"
  grep -q 'Safe mode is active' "$evidence/$surface-safe-delete.err"
  grep -q 'interactive draft editor is unavailable in CI' "$evidence/$surface-safe-send.err"
  jq -e '.message.ts == "1700000000.000001" and .message.channel_id == "D11111111" and .message.content == "Hello *agent*"' "$evidence/$surface-get.out" >/dev/null
  jq -e '.channel_id == "D11111111" and (.messages | length == 1) and .messages[0].ts == "1700000000.000001" and .messages[0].content == "Hello *agent*"' "$evidence/$surface-list.out" >/dev/null
  jq -e '.messages | length == 1 and .[0].ts == "1700000000.000001" and .[0].content == "Hello *agent*"' "$evidence/$surface-search.out" >/dev/null
done
jq -se 'length == 6 and all(.[]; .path == "/api/conversations.history" and .params.channel == ["D11111111"])' "$evidence/requests.jsonl" >/dev/null
printf 'Offline proof passed. Evidence: %s\n' "$evidence"
