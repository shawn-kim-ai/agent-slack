import { strict as assert } from "node:assert";
import { mock } from "bun:test";

delete process.env.AGENT_SLACK_KEYCHAIN_TIMEOUT_MS;
const keychain = await import("../../src/auth/keychain.ts");
const originalTimeout = keychain.getKeychainTimeoutMs;
const timeouts: number[] = [];
mock.module("../../src/auth/keychain.ts", () => ({
  ...keychain,
  getKeychainTimeoutMs: (options: Parameters<typeof originalTimeout>[0]) => {
    const timeout = originalTimeout(options);
    timeouts.push(timeout);
    return timeout;
  },
}));
Object.defineProperty(process, "platform", { value: "linux" });
const { getSafeStoragePasswords } = await import("../../src/auth/desktop-crypto.ts");
const passwords = [...getSafeStoragePasswords("v11", { interactive: true })];
assert.deepEqual(timeouts, [3_000, 3_000, 3_000, 3_000]);
assert.deepEqual(passwords, ["fixture-password", "", "peanuts"]);
