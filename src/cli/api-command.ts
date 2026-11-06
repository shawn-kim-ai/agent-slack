import type { Command } from "commander";
import { type CliContext, errorMessage } from "./context.ts";
import { isSafeModeEnabled } from "./safe-mode.ts";

/**
 * Individually reviewed Slack Web API read-only methods permitted in safe mode:
 * - auth.test: Check authentication and identity (https://docs.slack.dev/reference/methods/auth.test/)
 * - conversations.history: Fetch a conversation's message history (https://docs.slack.dev/reference/methods/conversations.history/)
 * - conversations.replies: Retrieve a message thread (https://docs.slack.dev/reference/methods/conversations.replies/)
 * - conversations.info: Retrieve metadata about a conversation (https://docs.slack.dev/reference/methods/conversations.info/)
 * - users.info: Retrieve information about a user (https://docs.slack.dev/reference/methods/users.info/)
 * - users.list: List all users in a Slack team (https://docs.slack.dev/reference/methods/users.list/)
 * - chat.getPermalink: Retrieve a permalink URL for a specific message (https://docs.slack.dev/reference/methods/chat.getPermalink/)
 * - search.messages: Search for messages matching a query (https://docs.slack.dev/reference/methods/search.messages/)
 * - search.files: Search for files matching a query (https://docs.slack.dev/reference/methods/search.files/)
 * - files.info: Retrieve information about a file (https://docs.slack.dev/reference/methods/files.info/)
 * - files.list: List files within a team, channel, or user scope (https://docs.slack.dev/reference/methods/files.list/)
 */
const SAFE_MODE_READ_ONLY_API_METHODS: ReadonlySet<string> = new Set([
  "auth.test",
  "conversations.history",
  "conversations.replies",
  "conversations.info",
  "users.info",
  "users.list",
  "chat.getPermalink",
  "search.messages",
  "search.files",
  "files.info",
  "files.list",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseApiParams(input: {
  params?: string;
  field?: string[];
}): Record<string, unknown> {
  let out: Record<string, unknown> = {};
  if (input.params !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.params);
    } catch {
      throw new Error("--params must be a JSON object");
    }
    if (!isPlainObject(parsed)) {
      throw new Error("--params must be a JSON object");
    }
    out = { ...parsed };
  }
  for (const pair of input.field ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`-f expects key=value, got "${pair}"`);
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

export function isReadOnlyApiMethod(method: string): boolean {
  return SAFE_MODE_READ_ONLY_API_METHODS.has(method);
}

export function apiErrorPayload(err: unknown): Record<string, unknown> {
  if (isPlainObject(err) && isPlainObject(err.data)) {
    return err.data;
  }
  return { ok: false, error: errorMessage(err) };
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerApiCommand(input: { program: Command; ctx: CliContext }): void {
  input.program
    .command("api")
    .description(
      "Call any Slack Web API method with the configured auth and print the raw JSON response",
    )
    .argument("<method>", "Slack Web API method, e.g. auth.test or conversations.replies")
    .option("--workspace <url>", "Workspace selector (full URL or unique substring)")
    .option("--params <json>", "Method arguments as a JSON object")
    .option("-f, --field <key=value>", "Add one string argument (repeatable)", collect, [])
    .option(
      "--multipart",
      "Send as multipart/form-data (some internal methods, e.g. saved.update, ignore form-urlencoded arguments)",
    )
    .action(
      async (
        method: string,
        options: { workspace?: string; params?: string; field?: string[]; multipart?: boolean },
      ) => {
        let params: Record<string, unknown>;
        const readOnly = isReadOnlyApiMethod(method);
        try {
          params = parseApiParams(options);
          if (isSafeModeEnabled({ cliFlag: Boolean(input.program.opts().safeMode) }) && !readOnly) {
            throw new Error(
              `Safe mode is active: "api ${method}" is blocked because only reviewed read-only Web API methods (${[...SAFE_MODE_READ_ONLY_API_METHODS].join(", ")}) can run without human review.`,
            );
          }
        } catch (err: unknown) {
          console.error(input.ctx.errorMessage(err));
          process.exitCode = 1;
          return;
        }
        try {
          const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
          const work = async () => {
            const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
            return options.multipart
              ? await client.apiMultipart(method, params)
              : await client.api(method, params);
          };
          const resp = readOnly
            ? await input.ctx.withAutoRefresh({ workspaceUrl, work })
            : await work();
          console.log(JSON.stringify(resp, null, 2));
        } catch (err: unknown) {
          console.log(JSON.stringify(apiErrorPayload(err), null, 2));
          console.error(input.ctx.errorMessage(err));
          process.exitCode = 1;
        }
      },
    );
}
