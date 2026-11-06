import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { CliContext } from "../src/cli/context.ts";
import {
  apiErrorPayload,
  isReadOnlyApiMethod,
  parseApiParams,
  registerApiCommand,
} from "../src/cli/api-command.ts";
import { withEnvironment } from "./helpers/environment.ts";

const EXPECTED_ALLOWED_READ_METHODS = [
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
] as const;

const REJECTED_METHODS = [
  "client.counts",
  "subscriptions.thread.getView",
  "unknown.list",
  "chat.getNewThing",
  "files.getUploadURLExternal",
  "chat.postMessage",
  "chat.delete",
  "saved.update",
  "reactions.add",
] as const;

type RecordedTransportCall = {
  transport: "api" | "apiMultipart";
  method: string;
  params: Record<string, unknown>;
};

function createTestRig(options?: {
  errorToThrow?: unknown;
  failFirstWorkWithInvalidAuth?: boolean;
}) {
  const calls: RecordedTransportCall[] = [];
  let effectiveWorkspaceCalls = 0;
  let getClientCalls = 0;
  let withAutoRefreshCalls = 0;
  let workInvocations = 0;

  const makeTransport =
    (transport: "api" | "apiMultipart") =>
    async (method: string, params: Record<string, unknown>) => {
      calls.push({ transport, method, params });
      if (options?.errorToThrow !== undefined) {
        throw options.errorToThrow;
      }
      return {
        ok: true,
        transport,
        method,
        received: params,
        empty_list: [],
        null_field: null,
        empty_string: "",
      };
    };

  const client = { api: makeTransport("api"), apiMultipart: makeTransport("apiMultipart") };
  const ctx: CliContext = {
    effectiveWorkspaceUrl: (flag?: string) => {
      effectiveWorkspaceCalls += 1;
      return flag ?? "https://fixture.slack.com";
    },
    assertWorkspaceSpecifiedForChannelNames: async () => {},
    withAutoRefresh: async <T>(input: {
      workspaceUrl: string | undefined;
      work: () => Promise<T>;
    }) => {
      withAutoRefreshCalls += 1;
      try {
        return await input.work();
      } catch (err: unknown) {
        if (options?.failFirstWorkWithInvalidAuth && workInvocations === 1) {
          return await input.work();
        }
        throw err;
      }
    },
    getClientForWorkspace: async (workspaceUrl?: string) => {
      getClientCalls += 1;
      workInvocations += 1;
      if (options?.failFirstWorkWithInvalidAuth && workInvocations === 1) {
        throw new Error("invalid_auth");
      }
      return {
        client: client as never,
        auth: { auth_type: "browser", xoxc_token: "xoxc-test", xoxd_cookie: "xoxd-test" },
        workspace_url: workspaceUrl,
      };
    },
    normalizeUrl: (u: string) => u,
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    parseContentType: () => "any",
    parseCurl: () => ({
      workspace_url: "https://fixture.slack.com",
      xoxc_token: "xoxc-test",
      xoxd_cookie: "xoxd-test",
    }),
    importDesktop: async () => ({
      cookie_d: "",
      teams: [],
      source: { leveldb_path: "", cookies_path: "" },
    }),
    importChrome: () => ({ cookie_d: "", teams: [] }),
    importBrave: async () => null,
    importFirefox: async () => null,
  };

  return {
    ctx,
    calls,
    counts: () => ({
      effectiveWorkspaceCalls,
      getClientCalls,
      withAutoRefreshCalls,
      apiCalls: calls.length,
    }),
  };
}

async function invokeApiCommand(input: {
  ctx: CliContext;
  argv: readonly string[];
  env?: Record<string, string | undefined>;
}): Promise<{ exitCode: number; stdout: string[]; stderr: string[] }> {
  const originalExitCode = process.exitCode;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map((a) => String(a)).join(" "));
  });
  const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map((a) => String(a)).join(" "));
  });

  try {
    return await withEnvironment({ AGENT_SLACK_SAFE_MODE: undefined, ...input.env }, async () => {
      process.exitCode = 0;
      const program = new Command().option("--safe-mode");
      registerApiCommand({ program, ctx: input.ctx });
      await program.parseAsync(input.argv, { from: "user" });
      return { exitCode: process.exitCode ?? 0, stdout, stderr };
    });
  } finally {
    process.exitCode = originalExitCode ?? 0;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

describe("parseApiParams, isReadOnlyApiMethod, and apiErrorPayload", () => {
  test("merges --params JSON with -f fields (fields winning) and preserves '=' in values", () => {
    expect(
      parseApiParams({
        params: '{"channel":"C1","limit":5}',
        field: ["channel=C2", "ts=1770165109.628379", "query=a=b=c"],
      }),
    ).toEqual({ channel: "C2", limit: 5, ts: "1770165109.628379", query: "a=b=c" });
  });

  test.each(["[1]", "null", '"str"', "42", "true", "not json"])(
    "rejects non-object --params %p",
    (params) => {
      expect(() => parseApiParams({ params })).toThrow("--params must be a JSON object");
    },
  );

  test.each(["=x", "noequals"])("rejects invalid -f field %p", (pair) => {
    expect(() => parseApiParams({ field: [pair] })).toThrow("-f expects key=value");
  });

  test.each([...EXPECTED_ALLOWED_READ_METHODS])("allows reviewed read method %p", (method) => {
    expect(isReadOnlyApiMethod(method)).toBe(true);
  });

  test.each([...REJECTED_METHODS])("rejects non-allowlisted method %p", (method) => {
    expect(isReadOnlyApiMethod(method)).toBe(false);
  });

  test("preserves SDK error body and safely formats plain or null-prototype errors", () => {
    const sdkErr = Object.assign(new Error("missing_scope"), {
      data: { ok: false, error: "missing_scope", needed: "chat:write" },
    });
    expect(apiErrorPayload(sdkErr)).toEqual({
      ok: false,
      error: "missing_scope",
      needed: "chat:write",
    });
    expect(apiErrorPayload(new Error("channel_not_found"))).toEqual({
      ok: false,
      error: "channel_not_found",
    });
    expect(apiErrorPayload(Object.create(null))).toEqual({ ok: false, error: "[unprintable]" });
    const causeErr = new Error("request_failed");
    causeErr.cause = Object.create(null);
    expect(apiErrorPayload(causeErr)).toEqual({
      ok: false,
      error: "request_failed: [unprintable]",
    });
  });
});

describe("registerApiCommand action dispatch & safe-mode enforcement", () => {
  test.each([
    { argv: ["api", "auth.test", "--params", "[1]"], expected: "--params must be a JSON object" },
    { argv: ["api", "auth.test", "--params", "null"], expected: "--params must be a JSON object" },
    { argv: ["api", "auth.test", "--params", "{bad"], expected: "--params must be a JSON object" },
    { argv: ["api", "auth.test", "-f", "=val"], expected: "-f expects key=value" },
    { argv: ["api", "auth.test", "-f", "keyonly"], expected: "-f expects key=value" },
  ])("rejects invalid arguments before workspace resolution or auth", async (caseItem) => {
    const rig = createTestRig();
    const res = await invokeApiCommand({ ctx: rig.ctx, argv: caseItem.argv });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toEqual([]);
    expect(res.stderr.join("\n")).toContain(caseItem.expected);
    expect(rig.counts()).toEqual({
      effectiveWorkspaceCalls: 0,
      getClientCalls: 0,
      withAutoRefreshCalls: 0,
      apiCalls: 0,
    });
  });

  test.each([...EXPECTED_ALLOWED_READ_METHODS])(
    "allows reviewed read method %p in safe mode (flag/env, ordinary/multipart) with auto-refresh and raw JSON",
    async (method) => {
      const rigFlag = createTestRig();
      const resFlag = await invokeApiCommand({
        ctx: rigFlag.ctx,
        argv: [
          "--safe-mode",
          "api",
          method,
          "--params",
          '{"limit":2,"override":"from_params"}',
          "-f",
          "override=from_field",
          "-f",
          "filter=a=b",
        ],
      });
      expect(resFlag.exitCode).toBe(0);
      expect(rigFlag.counts()).toEqual({
        effectiveWorkspaceCalls: 1,
        getClientCalls: 1,
        withAutoRefreshCalls: 1,
        apiCalls: 1,
      });
      expect(JSON.parse(resFlag.stdout.join("\n"))).toEqual({
        ok: true,
        transport: "api",
        method,
        received: { limit: 2, override: "from_field", filter: "a=b" },
        empty_list: [],
        null_field: null,
        empty_string: "",
      });

      const rigEnvMultipart = createTestRig();
      const resEnvMultipart = await invokeApiCommand({
        ctx: rigEnvMultipart.ctx,
        argv: ["api", method, "--multipart", "-f", "cursor=dXNlcjpVMEc5V0ZYTlo="],
        env: { AGENT_SLACK_SAFE_MODE: "1" },
      });
      expect(resEnvMultipart.exitCode).toBe(0);
      expect(rigEnvMultipart.counts()).toEqual({
        effectiveWorkspaceCalls: 1,
        getClientCalls: 1,
        withAutoRefreshCalls: 1,
        apiCalls: 1,
      });
      expect(rigEnvMultipart.calls[0]).toEqual({
        transport: "apiMultipart",
        method,
        params: { cursor: "dXNlcjpVMEc5V0ZYTlo=" },
      });
    },
  );

  test.each([...REJECTED_METHODS])(
    "blocks %p in safe mode (flag/env and ordinary/multipart) before workspace/auth/network",
    async (method) => {
      for (const { flags, env } of [
        { flags: ["--safe-mode"], env: {} },
        { flags: [], env: { AGENT_SLACK_SAFE_MODE: "1" } },
      ]) {
        for (const multipart of [false, true]) {
          const rig = createTestRig();
          const argv = [
            ...flags,
            "api",
            method,
            ...(multipart ? ["--multipart"] : []),
            "-f",
            "channel=C123",
          ];
          const res = await invokeApiCommand({ ctx: rig.ctx, argv, env });
          expect(res.exitCode).toBe(1);
          expect(res.stdout).toEqual([]);
          expect(res.stderr.join("\n")).toContain(
            `Safe mode is active: "api ${method}" is blocked`,
          );
          expect(rig.counts()).toEqual({
            effectiveWorkspaceCalls: 0,
            getClientCalls: 0,
            withAutoRefreshCalls: 0,
            apiCalls: 0,
          });
        }
      }
    },
  );

  test("safe-off supports unclassified raw methods without outer withAutoRefresh", async () => {
    for (const method of ["client.counts", "saved.update", "files.getUploadURLExternal"]) {
      for (const multipart of [false, true]) {
        const rig = createTestRig();
        const argv = ["api", method, ...(multipart ? ["--multipart"] : []), "-f", "key=val"];
        const res = await invokeApiCommand({ ctx: rig.ctx, argv });
        expect(res.exitCode).toBe(0);
        expect(rig.counts()).toEqual({
          effectiveWorkspaceCalls: 1,
          getClientCalls: 1,
          withAutoRefreshCalls: 0,
          apiCalls: 1,
        });
        expect(rig.calls[0]?.transport).toBe(multipart ? "apiMultipart" : "api");
      }
    }
  });

  test("reviewed read method auto-refreshes on invalid_auth, whereas unclassified write method does not replay", async () => {
    const readRig = createTestRig({ failFirstWorkWithInvalidAuth: true });
    const readRes = await invokeApiCommand({ ctx: readRig.ctx, argv: ["api", "auth.test"] });
    expect(readRes.exitCode).toBe(0);
    expect(readRig.counts()).toEqual({
      effectiveWorkspaceCalls: 1,
      getClientCalls: 2,
      withAutoRefreshCalls: 1,
      apiCalls: 1,
    });

    const writeRig = createTestRig({ failFirstWorkWithInvalidAuth: true });
    const writeRes = await invokeApiCommand({
      ctx: writeRig.ctx,
      argv: ["api", "chat.postMessage"],
    });
    expect(writeRes.exitCode).toBe(1);
    expect(writeRig.counts().apiCalls).toBe(0);
    expect(writeRig.counts().getClientCalls).toBe(1);
    expect(writeRig.counts().withAutoRefreshCalls).toBe(0);
    expect(JSON.parse(writeRes.stdout.join("\n"))).toEqual({ ok: false, error: "invalid_auth" });
  });

  test("prints error JSON to stdout and error message to stderr on API failure", async () => {
    const sdkErr = Object.assign(new Error("An API error occurred: ratelimited"), {
      data: { ok: false, error: "ratelimited", retry_after: 5 },
    });
    const rig = createTestRig({ errorToThrow: sdkErr });
    const res = await invokeApiCommand({ ctx: rig.ctx, argv: ["api", "auth.test"] });
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stdout.join("\n"))).toEqual({
      ok: false,
      error: "ratelimited",
      retry_after: 5,
    });
    expect(res.stderr.join("\n")).toContain("An API error occurred: ratelimited");
  });
});

describe("api CLI subprocess proof (loopback fixture + preload + env -i)", () => {
  test("verifies source and built bundle CLI parsing, positive/multipart controls, error JSON, all 11 allowlisted methods, and 0 network calls on rejected methods", async () => {
    const repoRoot = join(import.meta.dir, "..");
    const preloadPath = join(repoRoot, ".agents", "skills", "verify-agent-slack", "preload.js");
    const runDir = mkdtempSync(join(tmpdir(), "agent-slack-api-cli-test-"));
    const distDir = join(runDir, "dist");
    for (const sub of ["home", "config", "cache", "data", "runtime", "tmp", "dist"]) {
      mkdirSync(join(runDir, sub), { recursive: true });
    }

    type ObservedRequest = { path: string; contentType: string; params: Record<string, string> };
    const observed: ObservedRequest[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const contentType = req.headers.get("content-type") ?? "";
        const entries = contentType.includes("multipart/form-data")
          ? [...(await req.formData()).entries()]
          : [...new URLSearchParams(await req.text()).entries()];
        const params = Object.fromEntries(
          entries.filter(([k]) => k !== "token").map(([k, v]) => [k, String(v)]),
        );
        observed.push({ path: url.pathname, contentType, params });
        if (url.pathname === "/api/error.method") {
          return Response.json({ ok: false, error: "custom_fixture_error" });
        }
        return Response.json({
          ok: true,
          path: url.pathname,
          transport: contentType.includes("multipart/form-data") ? "multipart" : "urlencoded",
          params,
          preserve_empty: [],
        });
      },
    });

    const baseEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: join(runDir, "home"),
      XDG_CONFIG_HOME: join(runDir, "config"),
      XDG_CACHE_HOME: join(runDir, "cache"),
      XDG_DATA_HOME: join(runDir, "data"),
      XDG_RUNTIME_DIR: join(runDir, "runtime"),
      TMPDIR: join(runDir, "tmp"),
      CI: "1",
      AGENT_SLACK_NO_UPDATE_CHECK: "1",
      SLACK_TOKEN: "xoxc-offline-fixture",
      SLACK_COOKIE_D: "offline-fixture",
      SLACK_WORKSPACE_URL: "https://fixture.slack.com",
      AGENT_SLACK_FIXTURE_PORT: String(server.port),
    };

    const runCli = async (input: {
      target: "source" | "bundle";
      args: string[];
      extraEnv?: Record<string, string>;
    }) => {
      const entry =
        input.target === "source" ? join(repoRoot, "src", "index.ts") : join(distDir, "index.js");
      const envArgs = Object.entries({ ...baseEnv, ...input.extraEnv }).map(
        ([k, v]) => `${k}=${v}`,
      );
      const proc = Bun.spawn(
        [
          "env",
          "-i",
          ...envArgs,
          process.execPath,
          "--no-env-file",
          "--preload",
          preloadPath,
          entry,
          ...input.args,
        ],
        { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
      );
      return {
        exitCode: await proc.exited,
        stdout: await new Response(proc.stdout).text(),
        stderr: await new Response(proc.stderr).text(),
      };
    };

    try {
      const buildProc = Bun.spawn(
        [
          process.execPath,
          "build",
          join(repoRoot, "src", "index.ts"),
          "--outdir",
          distDir,
          "--target=bun",
        ],
        { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
      );
      expect(await buildProc.exited).toBe(0);

      for (const target of ["source", "bundle"] as const) {
        observed.length = 0;
        const badParams = await runCli({ target, args: ["api", "auth.test", "--params", "[1,2]"] });
        expect(badParams.exitCode).toBe(1);
        expect(badParams.stderr).toContain("--params must be a JSON object");
        const badField = await runCli({ target, args: ["api", "auth.test", "-f", "=missingkey"] });
        expect(badField.exitCode).toBe(1);
        expect(badField.stderr).toContain("-f expects key=value");
        expect(observed).toHaveLength(0);

        for (const blocked of [
          "client.counts",
          "subscriptions.thread.getView",
          "unknown.list",
          "chat.getNewThing",
          "files.getUploadURLExternal",
        ]) {
          observed.length = 0;
          const resFlag = await runCli({
            target,
            args: ["--safe-mode", "api", blocked, "-f", "a=1"],
          });
          expect(resFlag.exitCode).toBe(1);
          expect(resFlag.stderr).toContain(`Safe mode is active: "api ${blocked}" is blocked`);
          const resEnvMulti = await runCli({
            target,
            args: ["api", blocked, "--multipart", "-f", "a=1"],
            extraEnv: { AGENT_SLACK_SAFE_MODE: "1" },
          });
          expect(resEnvMulti.exitCode).toBe(1);
          expect(resEnvMulti.stderr).toContain(`Safe mode is active: "api ${blocked}" is blocked`);
          expect(observed).toHaveLength(0);
        }

        observed.length = 0;
        const safeOffOrdinary = await runCli({
          target,
          args: [
            "api",
            "client.counts",
            "--params",
            '{"thread_counts_by_channel":true,"channel":"C_OLD"}',
            "-f",
            "channel=C_NEW",
            "-f",
            "expr=x=1=2",
          ],
        });
        expect(safeOffOrdinary.exitCode).toBe(0);
        expect(JSON.parse(safeOffOrdinary.stdout)).toEqual({
          ok: true,
          path: "/api/client.counts",
          transport: "urlencoded",
          params: { thread_counts_by_channel: "true", channel: "C_NEW", expr: "x=1=2" },
          preserve_empty: [],
        });

        observed.length = 0;
        const safeOffMultipart = await runCli({
          target,
          args: ["api", "saved.update", "--multipart", "-f", "item_id=C123"],
        });
        expect(safeOffMultipart.exitCode).toBe(0);
        expect(observed[0]?.path).toBe("/api/saved.update");
        expect(observed[0]?.contentType).toContain("multipart/form-data");
        expect(observed[0]?.params).toEqual({ item_id: "C123" });

        observed.length = 0;
        const errRes = await runCli({ target, args: ["api", "error.method"] });
        expect(errRes.exitCode).toBe(1);
        expect(JSON.parse(errRes.stdout)).toEqual({ ok: false, error: "custom_fixture_error" });
        expect(errRes.stderr).toContain("custom_fixture_error");

        for (const method of EXPECTED_ALLOWED_READ_METHODS) {
          observed.length = 0;
          const allowedRes = await runCli({
            target,
            args: ["--safe-mode", "api", method, "-f", "check=1"],
          });
          expect(allowedRes.exitCode).toBe(0);
          expect(observed).toHaveLength(1);
          expect(observed[0]?.path).toBe(`/api/${method}`);
        }
      }
    } finally {
      server.stop(true);
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
