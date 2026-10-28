import { strict as assert } from "node:assert";
import { mock } from "bun:test";
import { getKeychainTimeoutMs, macKeychainPasswords } from "../../src/auth/keychain.ts";
import type { KeychainOptions } from "../../src/auth/keychain.ts";

delete process.env.SLACK_TOKEN;
delete process.env.AGENT_SLACK_KEYCHAIN_TIMEOUT_MS;
let reads = 0;
let writes = 0;
const store = await import("../../src/auth/store.ts");
mock.module("../../src/auth/desktop.ts", () => ({
  extractFromSlackDesktop: async (options: KeychainOptions = {}) => {
    const passwords = macKeychainPasswords([{ service: "fixture" }], {
      ...options,
      read: (_query, received) => {
        reads++;
        assert.notEqual(received.interactive, true);
        assert.equal(getKeychainTimeoutMs(received), 3_000);
        return { ok: true, value: "fixture-password" };
      },
    });
    assert.equal(passwords.next().value, "fixture-password");
    return {
      cookie_d: "fixture-cookie",
      teams: [{ url: "https://fixture.slack.com", token: "fixture-token" }],
    };
  },
}));
mock.module("../../src/auth/store.ts", () => ({
  ...store,
  upsertWorkspaces: async () => {
    writes++;
  },
}));

const { createCliContext } = await import("../../src/cli/context.ts");
let attempts = 0;
const result = await createCliContext().withAutoRefresh({
  workspaceUrl: undefined,
  work: async () => {
    attempts++;
    if (attempts === 1) {
      throw new Error("invalid_auth");
    }
    return "retried";
  },
});
assert.equal(result, "retried");
assert.equal(attempts, 2);
assert.equal(reads, 1);
assert.equal(writes, 1);
