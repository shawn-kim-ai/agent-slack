# Send and edit messages

A user can send a message, edit its text, and delete it. Safe mode blocks edit and delete and redirects sends to an editor.

## Sub-features

- `message-send` sends text to a channel or DM.
- `message-edit` replaces message text.
- `message-delete` removes a message.
- `safe-mode` blocks edit and delete and guards a redirected send in CI.

## How to get to it (user POV)

- Run `agent-slack message send <target> <text>`.
- Run `agent-slack message edit <target> <text> --ts <timestamp>` or `agent-slack message delete <target> --ts <timestamp>`.
- Add the global `--safe-mode` flag to exercise the guard.

## Driving it with the CLI

Preconditions:

- Offline mode uses the fixture and `CI=1`. Live mode requires the coordinator's verified self-DM and a unique tag.

- **Offline guards.** Run `.agents/skills/verify-agent-slack/offline.sh /tmp/agent-slack-evidence/guards-001`. Both CLI targets reject edit, delete, and safe-mode send before any write request. `requests.jsonl` contains only the four reads from the message feature.
- **Live send and edit.** Run the send, edit, get, list, and raw history commands in the skill. The returned channel is `AS_DM`; all subsequent reads contain `AS_TAG` and `AS_TS`.
- **Live delete.** Run the skill's cleanup after confirming the tag and author. The post-delete list has no tagged message or matching timestamp.

## Gotchas

- Safe-mode send outside CI opens an interactive editor. Do not invoke it in the offline proof.
- Do not use scheduled sends, file attachments, broadcasts, or another channel in the live recipe. Those paths remain unverified.
- A successful send followed by a failed check can leave a message. Apply the skill's tagged cleanup after confirming its identity.
