import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { CliContext } from "../src/cli/context.ts";
import { registerMessageCommand } from "../src/cli/message-command.ts";
import {
  formatMessagesText,
  parseOutputFormat,
  renderMessagePayload,
} from "../src/lib/message-text-format.ts";
import { SlackApiClient } from "../src/slack/client.ts";
import { withEnvironment } from "./helpers/environment.ts";

const mockUsersById: Record<string, Record<string, unknown>> = {
  U11111111: { id: "U11111111", name: "ann", real_name: "Ann", profile: { display_name: "Ann" } },
  U22222222: { id: "U22222222", name: "bob", real_name: "Bob", profile: { display_name: "Bob" } },
};

async function runMessageCli(ctx: CliContext, argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const prevExitCode = process.exitCode;
  process.exitCode = 0;

  console.log = mock((...args: unknown[]) => {
    stdout.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.log;
  console.error = mock((...args: unknown[]) => {
    stderr.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.error;

  try {
    const program = new Command();
    registerMessageCommand({ program, ctx });
    await program.parseAsync(["message", ...argv], { from: "user" });
    return {
      exitCode: process.exitCode ?? 0,
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = prevExitCode ?? 0;
  }
}

describe("formatMessagesText", () => {
  test("prints one line per message in TZ=UTC and alternate TZ with newlines collapsed", async () => {
    const sample = [
      { ts: "1700000000.000001", author: { user_id: "U1" }, content: "hello\nworld\n\nbye" },
    ];
    await withEnvironment({ TZ: "UTC" }, () => {
      expect(formatMessagesText(sample)).toBe("2023-11-14 22:13:20 U1 hello world bye");
    });
    await withEnvironment({ TZ: "Asia/Tokyo" }, () => {
      expect(formatMessagesText(sample)).toBe("2023-11-15 07:13:20 U1 hello world bye");
    });
  });

  test("prefers resolved names, marks replies, and preserves Unicode", async () => {
    await withEnvironment({ TZ: "UTC" }, () => {
      const ts0 = "1700000000.000000";
      const m1 = {
        ts: "1700000000.000001",
        thread_ts: ts0,
        author: { user_id: "U1" },
        content: "안녕 🚀\n세계",
      };
      const m2 = { ts: ts0, thread_ts: ts0, author: { bot_id: "B1" }, content: "root" };
      const m3 = { ts: "1700000001.000000", author: { user_id: "U2" }, content: "real fallback" };
      const m4 = { ts: "1700000002.000000", author: { user_id: "U3" }, content: "handle fallback" };
      const m5 = { ts: "not-a-ts", content: "no author and raw ts" };
      const users = {
        U1: { id: "U1", display_name: "Ann", real_name: "Ann Real", name: "ann" },
        U2: { id: "U2", display_name: "", real_name: "Bob Real", name: "bob" },
        U3: { id: "U3", name: "carol" },
      };

      expect(formatMessagesText([m1, m2, m3, m4, m5], users).split("\n")).toEqual([
        "2023-11-14 22:13:20 Ann [reply] 안녕 🚀 세계",
        "2023-11-14 22:13:20 B1 root",
        "2023-11-14 22:13:21 Bob Real real fallback",
        "2023-11-14 22:13:22 carol handle fallback",
        "not-a-ts unknown no author and raw ts",
      ]);
    });
  });
});

describe("renderMessagePayload and parseOutputFormat", () => {
  test("json stays the default shape and text renders get/list/empty payloads", async () => {
    const payload = { channel_id: "D11111111", messages: [] };
    expect(renderMessagePayload(payload, "json")).toBe(JSON.stringify(payload, null, 2));

    await withEnvironment({ TZ: "UTC" }, () => {
      const getPayload = { message: { ts: "1700000000.000001", content: "hi" } };
      expect(renderMessagePayload(getPayload, "text")).toBe("2023-11-14 22:13:20 unknown hi");
      expect(renderMessagePayload({ channel_id: "D11111111" }, "text")).toBe("");
      const threadMsgs = [
        { ts: "1700000000.000001", author: { user_id: "U1" }, content: "root" },
        { ts: "1700000060.000002", author: { user_id: "U2" }, content: "reply without thread_ts" },
      ];
      expect(renderMessagePayload({ messages: threadMsgs }, "text")).toBe(
        "2023-11-14 22:13:20 U1 root\n2023-11-14 22:14:20 U2 reply without thread_ts",
      );
    });
  });

  test("parseOutputFormat defaults to json and rejects unknown values", () => {
    expect(parseOutputFormat(undefined)).toBe("json");
    expect(parseOutputFormat(" json ")).toBe("json");
    expect(parseOutputFormat("TEXT")).toBe("text");
    expect(() => parseOutputFormat("yaml")).toThrow(
      'Invalid --format value "yaml": must be "json" or "text"',
    );
  });
});

describe("message get and list CLI --format over loopback HTTP fixture", () => {
  const originalFetch = globalThis.fetch;
  let appDir = "";

  beforeEach(async () => {
    appDir = await mkdtemp(join(tmpdir(), "agent-slack-msg-format-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (appDir) {
      await rm(appDir, { recursive: true, force: true });
    }
  });

  function startLoopbackFixture() {
    const requests: { path: string; params: Record<string, string> }[] = [];
    let authLookups = 0;
    const defaultMsg = {
      type: "message",
      user: "U11111111",
      ts: "1700000000.000001",
      text: "Hello *agent*\nline two",
    };
    let history: Record<string, unknown>[] = [defaultMsg];
    let thread: Record<string, unknown>[] = [];

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const params = Object.fromEntries(new URLSearchParams(await req.text()));
        delete params.token;
        requests.push({ path: url.pathname, params });

        if (url.pathname === "/api/conversations.history") {
          if (params.latest && params.inclusive === "true" && params.limit === "1") {
            const exact =
              history.find((m) => m.ts === params.latest) ??
              thread.find((m) => m.ts === params.latest);
            return Response.json({ ok: true, messages: exact ? [exact] : [] });
          }
          return Response.json({ ok: true, messages: history, has_more: false });
        }
        if (url.pathname === "/api/conversations.replies") {
          return Response.json({ ok: true, messages: thread, has_more: false });
        }
        if (url.pathname === "/api/users.info") {
          const u = params.user ?? "";
          return Response.json({ ok: true, user: mockUsersById[u] ?? { id: u, name: u } });
        }
        return Response.json({ ok: false, error: "unsupported_fixture_request" });
      },
    });

    globalThis.fetch = ((reqInput: string | URL | Request, init?: RequestInit) => {
      const targetUrl = new URL(reqInput instanceof Request ? reqInput.url : String(reqInput));
      if (targetUrl.origin !== "https://fixture.slack.com") {
        throw new Error(`Refused external host: ${targetUrl.origin}`);
      }
      targetUrl.protocol = "http:";
      targetUrl.hostname = "127.0.0.1";
      targetUrl.port = String(server.port);
      const nextReq =
        reqInput instanceof Request ? new Request(targetUrl.toString(), reqInput) : targetUrl;
      return originalFetch(nextReq, { ...init, redirect: "error" });
    }) as typeof fetch;

    const auth = {
      auth_type: "browser" as const,
      workspace_url: "https://fixture.slack.com",
      xoxc_token: "xoxc-offline-fixture",
      xoxd_cookie: "offline-fixture",
    };
    const ctx = {
      effectiveWorkspaceUrl: (flag?: string) => flag ?? "https://fixture.slack.com",
      assertWorkspaceSpecifiedForChannelNames: async () => {},
      withAutoRefresh: async <T>(w: { workspaceUrl: string | undefined; work: () => Promise<T> }) =>
        w.work(),
      getClientForWorkspace: async () => {
        authLookups += 1;
        const client = new SlackApiClient(auth, { workspaceUrl: auth.workspace_url });
        return { client, auth, workspace_url: auth.workspace_url };
      },
      errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    } as unknown as CliContext;

    const setFixture = (h: Record<string, unknown>[], t?: Record<string, unknown>[]) => {
      history = h;
      thread = t ?? h.slice(0, 2);
    };
    return { server, ctx, requests, getAuthLookups: () => authLookups, setFixture };
  }

  test("rejects invalid --format before auth/API and blocks external hosts", async () => {
    const env = { TZ: "UTC", HOME: appDir, XDG_CONFIG_HOME: appDir, XDG_RUNTIME_DIR: appDir };
    await withEnvironment(env, async () => {
      const fx = startLoopbackFixture();
      try {
        expect(() => fetch("https://example.com")).toThrow("Refused external host");
        const badGet = ["get", "D11111111", "--ts", "1700000000.000001", "--format", "yaml"];
        const getRes = await runMessageCli(fx.ctx, badGet);
        expect(getRes.exitCode).toBe(1);
        expect(getRes.stdout).toBe("");
        expect(getRes.stderr).toContain('Invalid --format value "yaml": must be "json" or "text"');

        const listRes = await runMessageCli(fx.ctx, ["list", "D11111111", "--format", "xml"]);
        expect(listRes.exitCode).toBe(1);
        expect(listRes.stdout).toBe("");
        expect(listRes.stderr).toContain('Invalid --format value "xml": must be "json" or "text"');
        expect(fx.getAuthLookups()).toBe(0);
        expect(fx.requests).toHaveLength(0);
      } finally {
        await fx.server.stop(true);
      }
    });
  });

  test("preserves JSON parity, covers get/list variants, and proves source vs bundle parity", async () => {
    const threeMessages = [
      {
        type: "message",
        user: "U11111111",
        ts: "1700000000.000001",
        thread_ts: "1700000000.000001",
        reply_count: 1,
        text: "First line\nsecond line",
      },
      {
        type: "message",
        user: "U22222222",
        ts: "1700000060.000002",
        thread_ts: "1700000000.000001",
        text: "Reply 🚀\nwith unicode",
      },
      { type: "message", bot_id: "B99999999", ts: "1700000120.000003", text: "Bot message" },
    ];
    const env = { TZ: "UTC", HOME: appDir, XDG_CONFIG_HOME: appDir, XDG_RUNTIME_DIR: appDir };
    await withEnvironment(env, async () => {
      const fx = startLoopbackFixture();
      try {
        const out = async (args: string[]) => (await runMessageCli(fx.ctx, args)).stdout;
        const url = "https://fixture.slack.com/archives/D11111111/p1700000000000001";

        const getDef = await out(["get", "D11111111", "--ts", "1700000000.000001"]);
        expect(JSON.parse(getDef).message.ts).toBe("1700000000.000001");
        expect(
          await out(["get", "D11111111", "--ts", "1700000000.000001", "--format", "json"]),
        ).toBe(getDef);
        const listDef = await out(["list", "D11111111"]);
        expect(JSON.parse(listDef).channel_id).toBe("D11111111");
        expect(await out(["list", "D11111111", "--format", "json"])).toBe(listDef);

        fx.setFixture([]);
        expect(await out(["list", "D11111111", "--format", "text"])).toBe("");

        fx.setFixture(threeMessages, threeMessages.slice(0, 2));
        expect(
          await out(["get", "D11111111", "--ts", "1700000060.000002", "--format", "text"]),
        ).toBe("2023-11-14 22:14:20 U22222222 [reply] Reply 🚀 with unicode");
        expect(await out(["get", url, "--format", "text", "--resolve-users"])).toBe(
          "2023-11-14 22:13:20 Ann First line second line",
        );
        expect(
          (await out(["list", "D11111111", "--format", "text", "--resolve-users"])).split("\n"),
        ).toEqual([
          "2023-11-14 22:13:20 Ann First line second line",
          "2023-11-14 22:14:20 Bob [reply] Reply 🚀 with unicode",
          "2023-11-14 22:15:20 B99999999 Bot message",
        ]);
        const threadCmd =
          "list D11111111 --thread-ts 1700000000.000001 --format text --resolve-users".split(" ");
        expect((await out(threadCmd)).split("\n")).toEqual([
          "2023-11-14 22:13:20 Ann First line second line",
          "2023-11-14 22:14:20 Bob Reply 🚀 with unicode",
        ]);
        expect((await out(["list", url, "--format", "text"])).split("\n")).toEqual([
          "2023-11-14 22:13:20 U11111111 First line second line",
          "2023-11-14 22:14:20 U22222222 Reply 🚀 with unicode",
        ]);

        fx.setFixture([
          { type: "message", user: "U11111111", ts: "1700000000.000001", text: "0123456789abcdef" },
        ]);
        for (const [maxBody, expected] of [
          ["0", "2023-11-14 22:13:20 U11111111 …"],
          ["8", "2023-11-14 22:13:20 U11111111 01234567 …"],
          ["8000", "2023-11-14 22:13:20 U11111111 0123456789abcdef"],
          ["-1", "2023-11-14 22:13:20 U11111111 0123456789abcdef"],
        ] as const) {
          const cmd =
            `get D11111111 --ts 1700000000.000001 --max-body-chars ${maxBody} --format text`.split(
              " ",
            );
          expect(await out(cmd)).toBe(expected);
        }

        fx.setFixture(threeMessages, threeMessages.slice(0, 2));
        const preload = join(process.cwd(), ".agents/skills/verify-agent-slack/preload.js");
        const cleanEnv = [
          "env",
          "-i",
          `PATH=${process.env.PATH ?? ""}`,
          `HOME=${appDir}`,
          `XDG_CONFIG_HOME=${appDir}`,
          `XDG_RUNTIME_DIR=${appDir}`,
          `TMPDIR=${appDir}`,
          "TZ=UTC",
          "CI=1",
          "AGENT_SLACK_NO_UPDATE_CHECK=1",
          "SLACK_TOKEN=xoxc-offline-fixture",
          "SLACK_COOKIE_D=offline-fixture",
          "SLACK_WORKSPACE_URL=https://fixture.slack.com",
          `AGENT_SLACK_FIXTURE_PORT=${fx.server.port}`,
        ];
        const buildCmd = [...cleanEnv, process.execPath, "run", "--no-env-file", "build"];
        expect(await Bun.spawn(buildCmd, { stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
        const execCli = async (script: string, args: string[]) => {
          const n = fx.requests.length;
          const cmd = [
            ...cleanEnv,
            process.execPath,
            "--no-env-file",
            "--preload",
            preload,
            script,
            ...args,
          ];
          const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
          const [exitCode, stdout, stderr] = await Promise.all([
            p.exited,
            new Response(p.stdout).text(),
            new Response(p.stderr).text(),
          ]);
          return { exitCode, stdout, stderr, trace: fx.requests.slice(n) };
        };
        for (const args of [
          ["message", "get", "D11111111", "--ts", "1700000000.000001", "--format", "invalid"],
          ["message", "get", "D11111111", "--ts", "1700000060.000002", "--format", "text"],
          ["message", "list", "D11111111", "--format", "text", "--refresh-users"],
        ]) {
          const srcRes = await execCli("src/index.ts", args);
          const distRes = await execCli("dist/index.js", args);
          expect(distRes).toEqual(srcRes);
          expect(srcRes.exitCode).toBe(args.includes("invalid") ? 1 : 0);
        }
      } finally {
        await fx.server.stop(true);
      }
    });
  });
});
