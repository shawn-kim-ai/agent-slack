import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("draft CLI emits one JSON error with a stable code and preserves exit status", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-slack-draft-json-"));
  let listResponse: Record<string, unknown> = {
    ok: true,
    drafts: [{ id: "DrFixture", destinations: [{ channel_id: "D11111111" }] }],
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      switch (new URL(request.url).pathname) {
        case "/api/drafts.create":
          return Response.json({ ok: false, error: "attached_draft_exists" });
        case "/api/drafts.list":
          return Response.json(listResponse);
        default:
          return Response.json({ ok: false, error: "unexpected_fixture_request" }, { status: 500 });
      }
    },
  });
  const entry = process.env.AGENT_SLACK_DRAFT_TEST_ENTRY ?? "src/index.ts";
  async function run(...args: string[]) {
    const proc = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        resolve(".agents/skills/verify-agent-slack/preload.js"),
        entry,
        "message",
        "draft",
        ...args,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CI: "1",
          AGENT_SLACK_NO_UPDATE_CHECK: "1",
          SLACK_TOKEN: "xoxc-offline-fixture",
          SLACK_COOKIE_D: "offline-fixture",
          SLACK_WORKSPACE_URL: "https://fixture.slack.com",
          AGENT_SLACK_FIXTURE_PORT: String(server.port),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exit, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exit, stdout, stderr };
  }
  try {
    const duplicate = await run("create", "D11111111", "fixture", "--json");
    expect(duplicate.exit).toBe(1);
    expect(duplicate.stderr).toBe("");
    expect(JSON.parse(duplicate.stdout)).toEqual({
      ok: false,
      error: {
        code: "attached_draft_exists",
        message: expect.stringContaining("DrFixture"),
        draft_id: "DrFixture",
      },
    });

    const defaultError = await run("create", "D11111111", "fixture");
    expect(defaultError.exit).toBe(1);
    expect(defaultError.stdout).toBe("");
    expect(defaultError.stderr).toContain("attached_draft_exists");

    listResponse = { ok: true, drafts: [] };
    const unresolved = await run("--json", "create", "D11111111", "fixture");
    expect(unresolved.exit).toBe(1);
    expect(JSON.parse(unresolved.stdout).error).toEqual({
      code: "attached_draft_exists",
      message: expect.any(String),
    });

    const list = await run("list", "--json");
    expect(list.exit).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual({ ok: true, drafts: [], count: 0 });

    const missing = await run("delete", "DrMissing", "--json");
    expect(missing.exit).toBe(1);
    expect(JSON.parse(missing.stdout)).toEqual({
      ok: false,
      error: { code: "draft_error", message: expect.stringContaining("DrMissing") },
    });

    listResponse = { ok: false, error: "invalid_auth" };
    const authError = await run("update", "DrFixture", "fixture", "--json");
    expect(authError.exit).toBe(1);
    expect(JSON.parse(authError.stdout)).toEqual({
      ok: false,
      error: { code: "invalid_auth", message: expect.stringContaining("invalid_auth") },
    });
  } finally {
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}, 15000);
