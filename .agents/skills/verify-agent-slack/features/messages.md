# Read messages

A user can fetch one message or list channel history and inspect the rendered content.

## Sub-features

- `message-get` fetches one message by channel ID and timestamp.
- `message-list` lists recent channel history.
- `message-thread` lists a thread using a message URL or `--thread-ts`.

## How to get to it (user POV)

- Run `agent-slack message get <channel> --ts <timestamp>` or pass a Slack message URL.
- Run `agent-slack message list <channel>` for history, or supply a message URL or `--thread-ts` for a thread.

## Driving it with the CLI

Preconditions:

- Offline mode has its one fixture message. Live mode has passed the self-DM gates and sent the tagged message in the skill.

- **Offline get and list.** Run `.agents/skills/verify-agent-slack/offline.sh /tmp/agent-slack-evidence/messages-001`. The source and bundle each return `Hello *agent*` at `1700000000.000001`. The request log shows the four matching `conversations.history` responses.
- **Live get and list.** Run the `message get` and `message list` commands in the skill's live recipe. Both JSON results contain the tagged edited message at `AS_TS`. The raw history response also contains it.
- **Thread and URL entry points.** The offline fixture has no thread or Slack message URL. Report these paths as unverified until a permitted fixture or a coordinator-owned self-DM thread exists. Do not claim the channel-history proof covers them.

## Gotchas

- `message get` needs `--ts` for a channel ID. A `U...` user ID is not a read target.
- The CLI may download message attachments during reads. The offline fixture has none.
- The CLI returns compact JSON. Compare the displayed `content` and timestamp with the raw API response as well as the exit code.
