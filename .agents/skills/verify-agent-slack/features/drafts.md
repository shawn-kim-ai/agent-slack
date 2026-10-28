# Manage drafts

A user can create, list, update, and delete a Slack-native draft without posting it.

## Sub-features

- `draft-create` creates a draft addressed to the self-DM.
- `draft-list` reads the draft and its destination.
- `draft-update` replaces its text.
- `draft-delete` removes the tagged draft.

## How to get to it (user POV)

- Run `agent-slack message draft create <target> <text>`.
- Run `agent-slack message draft list`, `message draft update <id> <text>`, or `message draft delete <id>`.

## Driving it with the CLI

Preconditions:

- The coordinator has completed the live identity and self-DM gates in the skill. Browser-style credentials are required. The local stub does not implement drafts.

- **Create.** Run `as_write draft-create`. Save the ID from the create response in `AS_DRAFT` and mark it read-only. The ID ties cleanup to the draft created by the authenticated operator in this run.
- **Update and delete.** Run the commands below. `as_write` checks identity, self-DM, draft ID, tag, destination, and last-updated timestamp immediately before each action.

```bash
export AS_DRAFT=$(jq -er '.draft.id | select(type == "string" and length > 0)' "$AS_EVIDENCE/draft-create.json")
readonly AS_DRAFT
as_write draft-update
as_capture draft-after-update as_cli message draft list --all --workspace "$AS_WORKSPACE"
jq -e --arg id "$AS_DRAFT" --arg dm "$AS_DM" --arg text "$AS_TAG draft edited" '[.drafts[]? | select(.id == $id and .text == $text and ([.destinations[].channel_id] == [$dm]))] | length == 1' "$AS_EVIDENCE/draft-after-update.json" >/dev/null
as_write draft-delete
as_capture draft-after-delete as_cli message draft list --all --workspace "$AS_WORKSPACE"
jq -e --arg id "$AS_DRAFT" --arg tag "$AS_TAG" 'all(.drafts[]?; .id != $id and ((.text // "") | contains($tag) | not))' "$AS_EVIDENCE/draft-after-delete.json" >/dev/null
```

- **Proof.** The list after update shows the exact edited text in the self-DM. The final list has neither the draft ID nor the tag. Save all responses and command statuses in private evidence.

## Gotchas

- Drafts use undocumented Slack endpoints and require browser-style auth. If unavailable, report the unmet precondition. Do not change credentials or test another destination.
- The list can contain unrelated drafts. Never delete those drafts. If the create response omits the ID, stop and report the tagged draft to the coordinator. Do not delete a draft identified by tag alone.
- If the draft changed after the pre-delete read, Slack can reject the supplied last-updated timestamp. Re-read and revalidate the tag and destination before retrying.
