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

- **Create.** Run `as_capture draft-create as_cli message draft create "$AS_DM" "$AS_TAG draft" --workspace "$AS_WORKSPACE"`. Run `export AS_DRAFT=$(jq -er '.draft.id | select(type == "string" and length > 0)' "$AS_EVIDENCE/draft-create.json")`.
- **Read before update.** Run `as_capture draft-before-update as_cli message draft list --all --workspace "$AS_WORKSPACE"`. Run the check below. It requires exactly one matching draft, the tag, and only the self-DM destination.

```bash
jq -e --arg id "$AS_DRAFT" --arg dm "$AS_DM" --arg tag "$AS_TAG" '[.drafts[]? | select(.id == $id and (.text | contains($tag)) and ([.destinations[].channel_id] == [$dm]) and ((.file_ids // []) | length == 0))] | length == 1' "$AS_EVIDENCE/draft-before-update.json" >/dev/null
as_capture draft-update as_cli message draft update "$AS_DRAFT" "$AS_TAG draft edited" --workspace "$AS_WORKSPACE"
as_capture draft-before-delete as_cli message draft list --all --workspace "$AS_WORKSPACE"
jq -e --arg id "$AS_DRAFT" --arg dm "$AS_DM" --arg tag "$AS_TAG" '[.drafts[]? | select(.id == $id and (.text | contains($tag)) and ([.destinations[].channel_id] == [$dm]) and ((.file_ids // []) | length == 0) and (.last_updated_ts | type == "string"))] | length == 1' "$AS_EVIDENCE/draft-before-delete.json" >/dev/null
AS_DRAFT_TS=$(jq -er --arg id "$AS_DRAFT" '.drafts[] | select(.id == $id) | .last_updated_ts' "$AS_EVIDENCE/draft-before-delete.json")
as_capture draft-delete as_cli message draft delete "$AS_DRAFT" --last-updated-ts "$AS_DRAFT_TS" --workspace "$AS_WORKSPACE"
as_capture draft-after-delete as_cli message draft list --all --workspace "$AS_WORKSPACE"
jq -e --arg id "$AS_DRAFT" --arg tag "$AS_TAG" 'all(.drafts[]?; .id != $id and ((.text // "") | contains($tag) | not))' "$AS_EVIDENCE/draft-after-delete.json" >/dev/null
```

- **Proof.** The two list results show the tagged draft in the self-DM before update and delete. The final list has neither the draft ID nor the tag. Save all responses and command statuses in private evidence.

## Gotchas

- Drafts use undocumented Slack endpoints and require browser-style auth. If unavailable, report the unmet precondition. Do not change credentials or test another destination.
- The list can contain unrelated drafts. Never delete those drafts. If the create response omits the ID, locate the exact tag and self-DM in a fresh list before any cleanup.
- If the draft changed after the pre-delete read, Slack can reject the supplied last-updated timestamp. Re-read and revalidate the tag and destination before retrying.
