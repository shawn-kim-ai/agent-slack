# Inspect authentication

A user can check the active Slack identity before using a workspace.

## Sub-features

- `auth-test` asks Slack to validate the selected credential and return the user and team IDs.
- `auth-isolation` prevents offline CLI runs from using inherited credentials.

## How to get to it (user POV)

- Run `agent-slack auth test --workspace <workspace>`.
- Run the offline verification helper for a credential-free proof of local CLI paths.

## Driving it with the CLI

Preconditions:

- For live mode, the coordinator has selected the workspace and can use its real credentials. Offline mode uses a fresh HOME and dummy browser credentials.

- **Offline isolation.** Run `.agents/skills/verify-agent-slack/offline.sh /tmp/agent-slack-evidence/auth-001`. It clears the inherited environment, disables `.env` loading and update checks, and uses a preload to send fixture requests to loopback and reject other origins. The log contains no token or cookie.
- **Live identity.** Run the `auth test` command in the skill's live setup. Its saved JSON contains only `ok`, `user_id`, and `team_id`, and `ok` is true.

## Gotchas

- Offline isolation does not prove that real credentials are valid. The helper does not import credentials or call `auth test` against Slack.
- `auth test` and `auth whoami` with stored credentials read agent-slack's own macOS keychain item. Live auth can auto-refresh credentials on failure. Do not run live checks concurrently.
- With fork PR 2, browser-credential API calls accept only canonical `https://*.slack.com` origins and refuse redirects.
- With fork PR 7 on macOS, desktop and Brave imports use a 120-second interactive keychain timeout by default and are exempt from the command watchdog. The timeout can be configured.
- For any import or keychain test that could reach the keychain, start the child with a fake command directory in `PATH` at process start or in the spawn `env`. Never fake `security` or another command by changing `process.env.PATH` inside a running Bun process. Before trusting the test, check that `command -v security` in the child resolves inside the fake directory and prove the fake ran using its own invocation log. If either check cannot be guaranteed, do not run the test.
- Auth import and workspace switching remain unverified by these recipes. Do not inspect credential files or print partially redacted secrets as evidence.
