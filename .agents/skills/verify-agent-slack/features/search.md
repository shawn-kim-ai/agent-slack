# Search messages

A user can search Slack messages and narrow results to a channel and author.

## Sub-features

- `search-messages` finds a matching message.
- `search-filter` narrows results to a channel and user.

## How to get to it (user POV)

- Run `agent-slack search messages <query> --channel <channel> --user <user>`.

## Driving it with the CLI

Preconditions:

- The coordinator has created the tagged self-DM message using the skill's live recipe. The active credential must be able to read the self-DM.

- **Search.** Before deleting the message, run the search and `jq` gate in the live recipe. The result must contain the tag at exactly `AS_TS`. The capture records the exit status and stderr.
- **Empty result.** A successful empty response does not prove a match. Report a failed read or missing tagged message.

## Gotchas

- Search results can include file downloads. Use only the unique run tag and the self-DM filter. Do not test `search files` or `search all` with this recipe.
- Channel-scoped search scans `conversations.history` and does not wait for the Slack search index. The offline helper proves a channel-scoped match against its fixture. Unscoped search uses Slack's search index and is not covered offline.
