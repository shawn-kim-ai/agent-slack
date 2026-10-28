---
name: verify-safe-mode-formal
description: "Exhaustively verify safe mode over every message-posting command (send, edit, delete, compose) times every enablement (flag, env) times CI. Use when touching safe-mode gating, message dispatch, the compose redirect, or the draft editor, and before merging any change to the covered files."
---

# Verify safe mode (formal)

Property: with safe mode on, no message-posting command reaches Slack without a human reviewing the text in the draft editor first.

Harm if it breaks: an agent running under `--safe-mode` posts, edits, or deletes a Slack message with no human in the loop, while the operator believes that is impossible.

## Run it

One command from the repo root. The full run takes about 4 seconds for 23 CLI spawns, measured on macOS arm64. It needs only bun.

```bash
.agents/skills/verify-safe-mode-formal/run.sh
```

Exit 0 means every cell passed. Exit 1 names each failing cell with what the stub Slack server observed. No installs, no sudo, no network beyond localhost. The check never touches real credentials. Every cell runs the CLI with a blank temp HOME and fake `SLACK_TOKEN`/`SLACK_COOKIE_D` against a stub Slack server on 127.0.0.1.

## What it does

The check runs 23 cells. Each cell runs the real CLI (`bun src/index.ts`, the same entry the build compiles) with a stub Slack server recording every API method.

- Core: send, edit, delete, compose, each with safe mode on via `--safe-mode` and via `AGENT_SLACK_SAFE_MODE=1`, each with and without `CI`. Safe-mode cells assert zero write calls reach the stub. Editor cells drive the real draft editor server and cancel it. CI cells assert the command fails closed.
- Send-flag rejections: `--attach`, `--blocks`, `--schedule`, `--schedule-in`, `--reply-broadcast` under safe mode assert the redirect rejects the flags before anything posts.
- Controls: the same commands with safe mode off assert the write IS observed (`chat.postMessage`, `chat.scheduleMessage`, `chat.update`, `chat.delete`). A control proves the harness can see that sink, so a passing safe-mode cell is evidence, not blindness. One control clicks Send in the real editor and asserts the post lands.

## Coverage record

Covered commands: `message send`, `message edit`, `message delete`, `message compose`.

Covered code:

- `src/cli/message-command.ts`: the four action closures and their `safeModeActive()` gates.
- `src/cli/safe-mode.ts`: `isSafeModeEnabled`, `redirectSendToDraft`, `safeModeBlockedError`.
- `src/cli/compose-actions.ts`: `composeMessage`, `draftWithEditor` (the CI skip).
- `src/cli/draft-server.ts`: `openDraftEditor` (the review gate the check drives).
- `src/cli/message-actions.ts`: `sendMessage`, `editMessage`, `deleteMessage` (the sinks).

Sync commit: `adda22908cecb3fbb53be7b44b8c1e0876d6688b`. The check describes the code at that commit. If any covered file changed after it, re-confirm the check still describes the code before trusting a pass, then move the sync commit forward to the commit you confirmed against.

## Reading a result

A property cell that fails with `writes=[...]` is a real break until proven otherwise. It names the exact Slack write that escaped. The usual cause is a dispatch change that added a path around a gate, moved a gate after a sink, or taught the editor skip a new condition. Fix the code, not the cell.

A failing control means the harness is blind, not that the product broke. Suspect the stub first: a new required read API the stub answers poorly, a changed CLI entry path, or a changed editor handshake. Fix `check.ts`, re-run, and only then read the property cells.

`timed out waiting for draft editor to open` on an editor cell means the CLI exited without opening the editor. The `writes so far` field shows whether it posted instead.

## Known findings

FINDING-001 (open): `message compose` under safe mode with `CI=1` posts without human review. Cells `compose flag CI` and `compose env CI` fail with `writes=["chat.postMessage"]` and stdout `{"ok": true, "sent": true, "editor": "skipped"}`. Counterexample in code terms: the compose action in `src/cli/message-command.ts` calls `composeMessage` without consulting `safeModeActive()`, and `draftWithEditor` in `src/cli/compose-actions.ts` sees `CI` and calls the send function directly. The property holds for these cells once compose is gated or the CI skip honors safe mode. Do not encode this finding as expected-failure in the check. It stays red until the code is fixed.

## Bounds and assumptions

- Exhaustive over the matrix only: four commands, two enablements, CI on and off, five send-flag classes. A new send-capable command is not covered until a cell names it.
- `--safe-mode` is passed before the subcommand, the position commander parses as a global option.
- An opened draft editor counts as human review. The check cancels instead of sending, so it proves the review gate was reached, not what the human would do there.
- The stub answers `conversations.info` and the write methods with canned `ok` payloads. Controls prove each asserted sink is reachable through those payloads.

## Out of scope

- `message react add/remove`. No safe-mode gate on main, and the safe-mode docs promise send, edit, and delete only. Closest second target for a follow-up property.
- `canvas` writes, `drafts.*`, scheduled-message cancel, and file uploads outside `send --attach`. None is a message post.
- Trust in the editor itself. The localhost `/send` endpoint accepts unauthenticated posts, so a local process could click Send for the human. That is a separate property about the editor server, not about dispatch gating.
