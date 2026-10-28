# agent-slack verification map

Use this index to choose the user paths affected by a change. The recipes use the CLI and the two modes in [the verification skill](../SKILL.md).

## Baseline preconditions

- Run from the repository root with locked dependencies installed.
- For offline work, run `offline.sh` with a new evidence directory. The fixture has one message in `D11111111` and supports only `conversations.history`.
- For live work, the coordinator must complete the identity and self-DM gates in the skill. The live recipe has not yet been proved.
- Keep each run's evidence outside the temporary state that cleanup removes. Live evidence can contain private content.

## Driving conventions

- The offline helper runs the source and bundle commands with isolated state. Run it again after changes.
- In live recipes, `as_cli`, `AS_WORKSPACE`, `AS_SELF`, `AS_DM`, `AS_TAG`, and `AS_EVIDENCE` come from the skill's live setup. Use only the verified self-DM for writes.
- Record the exact command, exit code, stdout, stderr, feature ID, and entry point. Confirm mutations with a separate read.
- Record an unmet precondition as a failure or skip with its reason. Do not claim that a different entry point proves it.

## Features

- [Read messages](messages.md) covers single messages and channel history.
- [Send and edit messages](send-edit.md) covers posting, editing, deleting, and safe-mode guards.
- [Manage drafts](drafts.md) covers Slack-native drafts.
- [Search messages](search.md) covers message search in a self-DM.
- [Inspect authentication](auth.md) covers the secret-free live identity check and offline credential isolation.
