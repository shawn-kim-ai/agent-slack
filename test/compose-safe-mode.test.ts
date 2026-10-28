import { describe, expect, test } from "bun:test";
import { composeMessage } from "../src/cli/compose-actions.ts";
import { createCliContext, type CliContext } from "../src/cli/context.ts";
import { SlackApiClient, type SlackAuth } from "../src/slack/client.ts";
import { withEnvironment } from "./helpers/environment.ts";

function stubContext(calls: string[]): CliContext {
  const auth: SlackAuth = { auth_type: "browser", xoxc_token: "test", xoxd_cookie: "test" };
  const client = new SlackApiClient(auth);
  client.api = async (method: string) => {
    calls.push(method);
    if (method === "conversations.info") {
      return { channel: { name: "test" } };
    }
    if (method === "chat.postMessage") {
      return { ts: "123.456" };
    }
    throw new Error(`Unexpected API method: ${method}`);
  };
  return {
    ...createCliContext(),
    effectiveWorkspaceUrl: () => undefined,
    assertWorkspaceSpecifiedForChannelNames: async () => {},
    withAutoRefresh: async <T>({ work }: { work: () => Promise<T> }) => work(),
    getClientForWorkspace: async () => ({ client, auth }),
  };
}

describe("composeMessage in CI", () => {
  test.each([
    ["environment", { env: "1", safeMode: false }],
    ["caller", { env: undefined, safeMode: true }],
  ])("blocks safe mode from the %s before any API call", async (_source, { env, safeMode }) => {
    await withEnvironment({ CI: "1", AGENT_SLACK_SAFE_MODE: env }, async () => {
      const calls: string[] = [];
      await expect(
        composeMessage({
          ctx: stubContext(calls),
          targetInput: "C12345678",
          initialText: "x",
          options: {},
          safeMode,
        }),
      ).rejects.toThrow("cannot skip the editor in CI");
      expect(calls).toEqual([]);
    });
  });

  test("sends through the CI shortcut when safe mode is off", async () => {
    await withEnvironment({ CI: "1", AGENT_SLACK_SAFE_MODE: undefined }, async () => {
      const calls: string[] = [];
      const result = await composeMessage({
        ctx: stubContext(calls),
        targetInput: "C12345678",
        initialText: "x",
        options: {},
      });
      expect(result).toMatchObject({ sent: true, editor: "skipped" });
      expect(calls).toContain("chat.postMessage");
    });
  });
});
