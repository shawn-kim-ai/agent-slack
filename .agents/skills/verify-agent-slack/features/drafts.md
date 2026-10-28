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

- The coordinator has completed the live identity and self-DM gates in the skill. Browser-style credentials are required. With fork PR 10, an existing draft attached to the self-DM composer prevents creation. Treat it as an unmet precondition. The local stub does not implement drafts.

- **Create.** The commands below create the draft and save its ID in `AS_DRAFT`. The ID ties cleanup to the draft created by the authenticated operator in this run.
- **Update and delete.** Run the commands below. `as_write` checks identity, self-DM, draft ID, tag, destination, and last-updated timestamp immediately before each action.

```bash
if ! as_write draft-create; then
  if grep -Eq 'attached_draft_exists|already attached to' "$AS_EVIDENCE/draft-create.err"; then
    printf 'Unmet precondition: a draft is already attached to the self-DM composer.\n' | tee "$AS_EVIDENCE/draft-precondition.txt" >&2
  fi
  exit 1
fi
AS_DRAFT=$(jq -er '.draft.id | select(type == "string" and length > 0)' "$AS_EVIDENCE/draft-create.json")
export AS_DRAFT
readonly AS_DRAFT
as_write draft-update
as_capture draft-after-update as_cli message draft list --all --workspace "$AS_WORKSPACE"
jq -e --arg id "$AS_DRAFT" --arg dm "$AS_DM" --arg text "$AS_TAG draft edited" '[.drafts[]? | select(.id == $id and .text == $text and ([.destinations[].channel_id] == [$dm]))] | length == 1' "$AS_EVIDENCE/draft-after-update.json" >/dev/null
as_write draft-delete
as_capture draft-after-delete as_cli message draft list --workspace "$AS_WORKSPACE"
jq -e --arg id "$AS_DRAFT" --arg tag "$AS_TAG" 'all(.drafts[]?; .id != $id and ((.text // "") | contains($tag) | not))' "$AS_EVIDENCE/draft-after-delete.json" >/dev/null
AS_DRAFT_CLEAN=1
```

- **Proof.** The list after update shows the exact edited text in the self-DM. The final active list has neither the draft ID nor the tag. Save all responses and command statuses in private evidence.

## Gotchas

- Drafts use undocumented Slack endpoints and require browser-style auth. If unavailable, report the unmet precondition. Do not change credentials or test another destination.
- With fork PR 10, creation attaches the draft to the destination composer. Slack can reject a second create with `attached_draft_exists`; the CLI can report that a draft is already attached. Stop and record the unmet precondition. Never update or delete a draft this run did not create.
- `drafts.list` returns one page, so absence from a list is not an exhaustive absence check. The list can contain unrelated drafts. Never delete those drafts. If the create response omits the ID, stop and report the tagged draft to the coordinator. Do not delete a draft identified by tag alone.
- If the draft changed after the pre-delete read, Slack can reject the supplied last-updated timestamp. Re-read and revalidate the tag and destination before retrying.
