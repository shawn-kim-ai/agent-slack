---
name: verify-agent-slack
description: Verify the agent-slack CLI from source and its built bundle. Use when changing commands, Slack output, authentication, or CLI safety behavior.
---

# Verify agent-slack

Read [the feature map](features/README.md) and select every affected entry point. The primary targets are `bun run src/index.ts` and the bundle produced by `bun run build` and run with `bun dist/index.js`. The compiled binary produced by `bun build --compile` is secondary and needs a separate run when a change affects it. Report each untested target and entry point.

## Launch

Work from the repository root. Install the locked dependencies before starting an offline run. `bun install --frozen-lockfile` can use the network, so run it during preparation, not as an offline proof. Each CLI invocation is a short-lived process. The offline helper builds the bundle and starts a disposable local HTTP server on an OS-assigned loopback port. Its readiness signal is the port file created by the server. It creates a fresh HOME, XDG directories, and temporary directory, disables Bun's `.env` loading, clears inherited credentials and proxy variables, disables update checks, and supplies dummy browser credentials for the stub. It shuts down its own server and removes its temporary state on exit, including on failed checks.

```sh
.agents/skills/verify-agent-slack/offline.sh /tmp/agent-slack-evidence/run-001
```

Use a new evidence directory for each run. Do not run two offline helpers in the same checkout at once because each rebuilds `dist`. The helper requires Bun, Python 3, and `jq`. It uses `env -i` and `--no-env-file`; do not remove either. No real credentials are required. It sends requests only to its loopback stub. The stub accepts only `conversations.history` for `D11111111` and records requests and responses without the dummy token or cookie. It returns an error for other API methods. The standard-token client uses the Slack SDK's default API address and cannot be redirected through `SLACK_WORKSPACE_URL`. The browser-token client uses that workspace URL. Do not try a standard token, a real token, a Slack URL, an auth import, or an unlisted CLI command in this offline environment. A missing token can trigger desktop and browser credential discovery. Do not use `message compose`; in CI it can send immediately. Safe mode blocks edit and delete, but it is not a general network or write sandbox.

## Doctor

Run the offline helper above first. Its `doctor.txt` records the installed `agent-slack` path, the Bun path, and the package version. It checks that the source and freshly built bundle report that same version. The installed binary is identified, not executed. If the helper fails, inspect its `.command`, `.status`, `.out`, and `.err` files before driving another feature.

For live mode, run `auth test` as shown below and retain only `ok`, `user_id`, and `team_id`. The command calls Slack, and an auth failure can cause automatic desktop credential refresh. Do not use `auth whoami` as a secret-free diagnostic because it prints partially redacted token values. Never print credential files or environment variables.

## Drive

Offline proof runs help, version, missing-text validation, safe-mode edit and delete guards, the CI safe-mode send guard, and `message get` plus `message list` against the stub on both primary targets. It checks exit codes, output content, and exactly four history requests. The commands and response JSON are in the evidence directory. Other feature paths need their own proof. See the feature map.

### Live mode for the coordinator only

This recipe is **unproven** until the coordinator runs it once. Do not run it as a delegate. Live runs use the operator's real credentials. Never overlap two live runs. Automatic auth refresh can rewrite `~/.config/agent-slack/credentials.json`. Never write to a channel other than the operator's self-DM. Use a unique run tag in every test message and draft, including edited text. Do not test attachments, scheduled sends, broadcasts, reactions, or compose with this recipe.

Run the following in Bash from the repository root. Set `AS_WORKSPACE` to the exact workspace URL after confirming the intended account. Keep the same shell throughout. The checks stop if identity, self-DM, message, or draft evidence does not match. A self-DM that Slack refuses to open or identify is an unmet precondition. Stop without choosing another channel.

```bash
set -euo pipefail
umask 077
export AS_WORKSPACE='https://YOUR-WORKSPACE.slack.com'
readonly AS_WORKSPACE
export AGENT_SLACK_NO_UPDATE_CHECK=1
unset AGENT_SLACK_SAFE_MODE
AS_EVIDENCE=$(mktemp -d "${TMPDIR:-/tmp}/agent-slack-live.XXXXXX")
AS_TAG="[as-verify $(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')]"
export AS_EVIDENCE AS_TAG
readonly AS_EVIDENCE AS_TAG
as_cli() { bun run --no-env-file src/index.ts "$@"; }
as_capture() {
  local name=$1 rc=0
  shift
  printf '%q ' "$@" > "$AS_EVIDENCE/$name.command"
  printf '\n' >> "$AS_EVIDENCE/$name.command"
  "$@" > "$AS_EVIDENCE/$name.json" 2> "$AS_EVIDENCE/$name.err" || rc=$?
  printf '%s\n' "$rc" > "$AS_EVIDENCE/$name.status"
  return "$rc"
}
as_cli auth test --workspace "$AS_WORKSPACE" 2> "$AS_EVIDENCE/auth.err" | jq -e '{ok, user_id, team_id} | select(.ok == true and (.user_id | type == "string") and (.team_id | type == "string"))' > "$AS_EVIDENCE/auth.json"
printf '0\n' > "$AS_EVIDENCE/auth.status"
AS_SELF=$(jq -er '.user_id | select(test("^[UW][A-Z0-9]+$"))' "$AS_EVIDENCE/auth.json")
AS_TEAM=$(jq -er '.team_id | select(test("^T[A-Z0-9]+$"))' "$AS_EVIDENCE/auth.json")
readonly AS_SELF AS_TEAM
as_capture dm-open as_cli user dm-open "$AS_SELF" --workspace "$AS_WORKSPACE"
jq -e --arg self "$AS_SELF" '.channel_type == "dm" and .user_ids == [$self] and (.dm_channel_id | test("^D[A-Z0-9]+$"))' "$AS_EVIDENCE/dm-open.json" >/dev/null
export AS_SELF
export AS_DM=$(jq -er .dm_channel_id "$AS_EVIDENCE/dm-open.json")
readonly AS_DM
```

The CLI has no raw API command. Use its own client to verify the opened channel and capture the raw history response. The `conversations.info` check is a read-only gate before any test message.

```bash
as_capture dm-info bun --no-env-file -e 'import { createCliContext } from "./src/cli/context.ts"; const c = createCliContext(); const workspaceUrl = process.env.AS_WORKSPACE; const result = await c.withAutoRefresh({ workspaceUrl, work: async () => (await c.getClientForWorkspace(workspaceUrl)).client.api("conversations.info", { channel: process.env.AS_DM }) }); console.log(JSON.stringify(result, null, 2));'
jq -e --arg self "$AS_SELF" --arg dm "$AS_DM" '.ok == true and .channel.id == $dm and .channel.is_im == true and .channel.user == $self' "$AS_EVIDENCE/dm-info.json" >/dev/null
```

Use this function for every test write. It checks the current identity and self-DM before each action and fixes each destination to the verified ID. Edit and delete also require the run tag and author. Draft update and delete require the ID returned by this run, the tag, and the self-DM destination.

```bash
as_write() {
  local action=$1 draft_ts
  as_cli auth test --workspace "$AS_WORKSPACE" 2> "$AS_EVIDENCE/$action-auth.err" |
    jq -e --arg self "$AS_SELF" --arg team "$AS_TEAM" '{ok, user_id, team_id} | select(.ok == true and .user_id == $self and .team_id == $team)' > "$AS_EVIDENCE/$action-auth.json" || return 1
  as_capture "$action-dm-info" bun --no-env-file -e 'import { createCliContext } from "./src/cli/context.ts"; const c = createCliContext(); const workspaceUrl = process.env.AS_WORKSPACE; const result = await c.withAutoRefresh({ workspaceUrl, work: async () => (await c.getClientForWorkspace(workspaceUrl)).client.api("conversations.info", { channel: process.env.AS_DM }) }); console.log(JSON.stringify(result, null, 2));' || return 1
  jq -e --arg self "$AS_SELF" --arg dm "$AS_DM" '.ok == true and .channel.id == $dm and .channel.is_im == true and .channel.user == $self' "$AS_EVIDENCE/$action-dm-info.json" >/dev/null || return 1
  case "$action" in
    send) as_capture send as_cli message send "$AS_DM" "$AS_TAG initial" --workspace "$AS_WORKSPACE" ;;
    edit|delete)
      as_capture "$action-before" as_cli message get "$AS_DM" --ts "$AS_TS" --workspace "$AS_WORKSPACE" || return 1
      jq -e --arg dm "$AS_DM" --arg ts "$AS_TS" --arg self "$AS_SELF" --arg tag "$AS_TAG" '.message.channel_id == $dm and .message.ts == $ts and .message.author.user_id == $self and (.message.content | contains($tag))' "$AS_EVIDENCE/$action-before.json" >/dev/null || return 1
      if [[ $action == edit ]]; then
        as_capture edit as_cli message edit "$AS_DM" "$AS_TAG edited" --ts "$AS_TS" --workspace "$AS_WORKSPACE"
      else
        as_capture delete as_cli message delete "$AS_DM" --ts "$AS_TS" --workspace "$AS_WORKSPACE"
      fi ;;
    draft-create) as_capture draft-create as_cli message draft create "$AS_DM" "$AS_TAG draft" --workspace "$AS_WORKSPACE" ;;
    draft-update|draft-delete)
      as_capture "$action-before" as_cli message draft list --all --workspace "$AS_WORKSPACE" || return 1
      draft_ts=$(jq -er --arg id "$AS_DRAFT" --arg dm "$AS_DM" --arg tag "$AS_TAG" '[.drafts[]? | select(.id == $id and (.text | contains($tag)) and ([.destinations[].channel_id] == [$dm]) and ((.file_ids // []) | length == 0) and (.last_updated_ts | type == "string" and length > 0))] | if length == 1 then .[0].last_updated_ts else empty end' "$AS_EVIDENCE/$action-before.json") || return 1
      if [[ $action == draft-update ]]; then
        as_capture draft-update as_cli message draft update "$AS_DRAFT" "$AS_TAG draft edited" --channel "$AS_DM" --last-updated-ts "$draft_ts" --workspace "$AS_WORKSPACE"
      else
        as_capture draft-delete as_cli message draft delete "$AS_DRAFT" --last-updated-ts "$draft_ts" --workspace "$AS_WORKSPACE"
      fi ;;
    *) printf 'Unknown write action: %s\n' "$action" >&2; return 1 ;;
  esac
}
as_write send
jq -e --arg dm "$AS_DM" '.ok == true and .channel_id == $dm and (.ts | type == "string" and test("^[0-9]+\\.[0-9]+$"))' "$AS_EVIDENCE/send.json" >/dev/null
export AS_TS=$(jq -er .ts "$AS_EVIDENCE/send.json")
readonly AS_TS
as_write edit
as_capture get as_cli message get "$AS_DM" --ts "$AS_TS" --workspace "$AS_WORKSPACE"
as_capture list as_cli message list "$AS_DM" --limit 20 --workspace "$AS_WORKSPACE"
as_capture history bun --no-env-file -e 'import { createCliContext } from "./src/cli/context.ts"; const c = createCliContext(); const workspaceUrl = process.env.AS_WORKSPACE; const result = await c.withAutoRefresh({ workspaceUrl, work: async () => (await c.getClientForWorkspace(workspaceUrl)).client.api("conversations.history", { channel: process.env.AS_DM, latest: process.env.AS_TS, inclusive: true, limit: 1 }) }); console.log(JSON.stringify(result, null, 2));'
jq -e --arg dm "$AS_DM" --arg ts "$AS_TS" --arg text "$AS_TAG edited" '.message.channel_id == $dm and .message.ts == $ts and .message.content == $text' "$AS_EVIDENCE/get.json" >/dev/null
jq -e --arg ts "$AS_TS" --arg text "$AS_TAG edited" 'any(.messages[]; .ts == $ts and .content == $text)' "$AS_EVIDENCE/list.json" >/dev/null
jq -e --arg ts "$AS_TS" --arg self "$AS_SELF" --arg text "$AS_TAG edited" '.ok == true and any(.messages[]; .ts == $ts and .user == $self and .text == $text)' "$AS_EVIDENCE/history.json" >/dev/null
```

To exercise drafts, follow [the draft recipe](features/drafts.md) before cleanup. It requires browser auth and is optional when that precondition is absent. Record the skip. Preserve these JSON files in a private evidence directory. The history and list may contain other self-DM messages; do not publish them without review.

## Evidence

Capture the exact action, exit status, stdout, stderr, and the resulting state. The offline helper writes those to its evidence directory, including the stub's request and response JSON. The live recipe captures CLI JSON and raw `conversations.history` JSON. The live capture function records each command, exit code, stdout, and stderr in the private evidence directory. The filtered auth check records a success status; on failure, retain its stderr and report the failure. Verify a write with a separate read. A mocked Slack response proves the local client path and rendering, not Slack permissions or server behavior. A help or guard pass does not prove a mutation.

## Cleanup

The offline helper's EXIT trap stops only the stub PID it started and removes only its own temporary directory. It retains the evidence. Confirm the output directory still contains `requests.jsonl`, both `*-get.out` files, and their status files after the helper exits.

For live cleanup, first re-read the message and verify its channel, timestamp, author, and tag. Delete only that verified message. Do not delete by channel, date, or a guessed ID. If any check fails, stop and report the remaining tagged item to the coordinator. Use the draft cleanup in its feature file for a tagged draft. Then inspect history and draft list again to confirm the tagged items are gone. Keep evidence; it may contain private Slack content.

```bash
as_write delete
as_capture after-delete as_cli message list "$AS_DM" --limit 20 --workspace "$AS_WORKSPACE"
jq -e --arg ts "$AS_TS" --arg tag "$AS_TAG" 'all((.messages // [])[]; .ts != $ts and ((.content // "") | contains($tag) | not))' "$AS_EVIDENCE/after-delete.json" >/dev/null
as_capture history-after-delete bun --no-env-file -e 'import { createCliContext } from "./src/cli/context.ts"; const c = createCliContext(); const workspaceUrl = process.env.AS_WORKSPACE; const result = await c.withAutoRefresh({ workspaceUrl, work: async () => (await c.getClientForWorkspace(workspaceUrl)).client.api("conversations.history", { channel: process.env.AS_DM, latest: process.env.AS_TS, inclusive: true, limit: 1 }) }); console.log(JSON.stringify(result, null, 2));'
jq -e --arg ts "$AS_TS" '.ok == true and all((.messages // [])[]; .ts != $ts)' "$AS_EVIDENCE/history-after-delete.json" >/dev/null
```

A failed live command can leave a tagged item behind. Re-read its exact ID and content before cleanup. Do not delete anything whose tag or self-DM destination cannot be confirmed.

## Helpers

`offline.sh [evidence-directory]` runs the offline proof. With no argument it creates and prints a new directory under the system temporary directory. `stub.py <ready-file> <request-log>` is the executable loopback fixture used by the helper. The helper owns its process and teardown. Use `/t3-maintain-verification-skill` when the CLI or its user-facing entry points change.
