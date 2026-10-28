# Search messages

A user can search Slack messages and narrow results to a channel and author.

## Sub-features

- `search-messages` finds a matching message.
- `search-filter` narrows results to a channel and user.

## How to get to it (user POV)

- Run `agent-slack search messages <query> --channel <channel> --user <user>`.

## Driving it with the CLI

Preconditions:

- The coordinator has created the tagged self-DM message using the skill's live recipe. Slack search and access to the self-DM must be available to the active credential. The local stub does not implement search.

- **Search.** Before deleting the message, run `as_capture search as_cli search messages "$AS_TAG" --workspace "$AS_WORKSPACE" --channel "$AS_DM" --user "$AS_SELF"`. Confirm that the result contains `AS_TS` and the tag. Capture the exit status and stderr.
- **Empty result.** If Slack has not indexed the message or the account cannot search that DM, report the unmet precondition. A successful empty response does not prove a match.

## Gotchas

- Search results can include file downloads. Use only the unique run tag and the self-DM filter. Do not test `search files` or `search all` with this recipe.
- Search indexing and permission behavior belong to Slack. The offline fixture cannot prove them.
