import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

type EditorMode = "none" | "cancel" | "send";
type SafeMode = "flag" | "env" | "off";

type Cell = {
  name: string;
  argv: string[];
  safeMode: SafeMode;
  ci: boolean;
  editor: EditorMode;
  expectWrites: string[];
  expectExit: number | "nonzero";
  expectStderr?: string;
};

type CellResult = {
  cell: Cell;
  pass: boolean;
  detail: string;
};

const CHANNEL_ID = "C12345678";
const MESSAGE_TS = "1770000000.000001";
const FIXTURE_WORKSPACE_URL = "https://fixture.slack.com";
const PRELOAD = join(import.meta.dir, "preload.ts");

const WRITE_METHODS = new Set([
  "chat.postMessage",
  "chat.scheduleMessage",
  "chat.update",
  "chat.delete",
  "reactions.add",
  "reactions.remove",
  "files.getUploadURLExternal",
  "files.completeUploadExternal",
  "files.delete",
  "canvases.create",
  "canvases.edit",
  "drafts.create",
  "drafts.update",
]);

function reviewedCell(input: { name: string; argv: string[]; safeMode: SafeMode }): Cell {
  return { ...input, ci: false, editor: "cancel", expectWrites: [], expectExit: 0 };
}

function blockedCell(input: {
  name: string;
  argv: string[];
  safeMode: SafeMode;
  ci: boolean;
  stderr?: string;
}): Cell {
  return {
    name: input.name,
    argv: input.argv,
    safeMode: input.safeMode,
    ci: input.ci,
    editor: "none",
    expectWrites: [],
    expectExit: "nonzero",
    expectStderr: input.stderr,
  };
}

function postedCell(input: {
  name: string;
  argv: string[];
  safeMode: SafeMode;
  ci: boolean;
  editor: EditorMode;
  writes: string[];
}): Cell {
  return {
    name: input.name,
    argv: input.argv,
    safeMode: input.safeMode,
    ci: input.ci,
    editor: input.editor,
    expectWrites: input.writes,
    expectExit: 0,
  };
}

function cells(input: { attachFile: string; blocksFile: string; scheduleAt: string }): Cell[] {
  const { attachFile, blocksFile, scheduleAt } = input;
  const send = ["message", "send", CHANNEL_ID, "verify text"];
  const compose = ["message", "compose", CHANNEL_ID, "verify text"];
  const edit = ["message", "edit", CHANNEL_ID, "verify text", "--ts", MESSAGE_TS];
  const remove = ["message", "delete", CHANNEL_ID, "--ts", MESSAGE_TS];
  const sendAttach = [...send, "--attach", attachFile];
  const sendBlocks = [...send, "--blocks", blocksFile];
  const sendSchedule = [...send, "--schedule", scheduleAt];
  const sendScheduleIn = [...send, "--schedule-in", "3h"];
  const sendBroadcast = [...send, "--reply-broadcast", "--thread-ts", MESSAGE_TS];
  return [
    reviewedCell({ name: "send flag", argv: send, safeMode: "flag" }),
    reviewedCell({ name: "send env", argv: send, safeMode: "env" }),
    reviewedCell({ name: "compose flag", argv: compose, safeMode: "flag" }),
    reviewedCell({ name: "compose env", argv: compose, safeMode: "env" }),
    blockedCell({
      name: "send flag CI",
      argv: send,
      safeMode: "flag",
      ci: true,
      stderr: "unavailable in CI",
    }),
    blockedCell({
      name: "send env CI",
      argv: send,
      safeMode: "env",
      ci: true,
      stderr: "unavailable in CI",
    }),
    blockedCell({
      name: "send flag attach",
      argv: sendAttach,
      safeMode: "flag",
      ci: false,
      stderr: "--attach",
    }),
    blockedCell({
      name: "send flag blocks",
      argv: sendBlocks,
      safeMode: "flag",
      ci: false,
      stderr: "--blocks",
    }),
    blockedCell({
      name: "send flag schedule",
      argv: sendSchedule,
      safeMode: "flag",
      ci: false,
      stderr: "--schedule",
    }),
    blockedCell({
      name: "send flag schedule-in",
      argv: sendScheduleIn,
      safeMode: "flag",
      ci: false,
      stderr: "--schedule-in",
    }),
    blockedCell({
      name: "send flag reply-broadcast",
      argv: sendBroadcast,
      safeMode: "flag",
      ci: false,
      stderr: "--reply-broadcast",
    }),
    blockedCell({
      name: "edit flag",
      argv: edit,
      safeMode: "flag",
      ci: false,
      stderr: "is blocked",
    }),
    blockedCell({
      name: "edit env",
      argv: edit,
      safeMode: "env",
      ci: false,
      stderr: "is blocked",
    }),
    blockedCell({
      name: "edit flag CI",
      argv: edit,
      safeMode: "flag",
      ci: true,
      stderr: "is blocked",
    }),
    blockedCell({
      name: "edit env CI",
      argv: edit,
      safeMode: "env",
      ci: true,
      stderr: "is blocked",
    }),
    blockedCell({
      name: "delete flag",
      argv: remove,
      safeMode: "flag",
      ci: false,
      stderr: "is blocked",
    }),
    blockedCell({
      name: "delete env",
      argv: remove,
      safeMode: "env",
      ci: false,
      stderr: "is blocked",
    }),
    blockedCell({
      name: "delete flag CI",
      argv: remove,
      safeMode: "flag",
      ci: true,
      stderr: "is blocked",
    }),
    blockedCell({
      name: "delete env CI",
      argv: remove,
      safeMode: "env",
      ci: true,
      stderr: "is blocked",
    }),
    blockedCell({ name: "compose flag CI", argv: compose, safeMode: "flag", ci: true }),
    blockedCell({ name: "compose env CI", argv: compose, safeMode: "env", ci: true }),
    postedCell({
      name: "control send",
      argv: send,
      safeMode: "off",
      ci: false,
      editor: "none",
      writes: ["chat.postMessage"],
    }),
    postedCell({
      name: "control edit",
      argv: edit,
      safeMode: "off",
      ci: false,
      editor: "none",
      writes: ["chat.update"],
    }),
    postedCell({
      name: "control delete",
      argv: remove,
      safeMode: "off",
      ci: false,
      editor: "none",
      writes: ["chat.delete"],
    }),
    postedCell({
      name: "control compose CI",
      argv: compose,
      safeMode: "off",
      ci: true,
      editor: "none",
      writes: ["chat.postMessage"],
    }),
    postedCell({
      name: "control compose editor",
      argv: compose,
      safeMode: "off",
      ci: false,
      editor: "send",
      writes: ["chat.postMessage"],
    }),
    postedCell({
      name: "control send schedule",
      argv: sendSchedule,
      safeMode: "off",
      ci: false,
      editor: "none",
      writes: ["chat.scheduleMessage"],
    }),
  ];
}

function startStub(recorded: string[]): { url: string; stop: () => void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const match = url.pathname.match(/^\/api\/(.+)$/);
      if (req.method === "POST" && match?.[1]) {
        const [, method] = match;
        recorded.push(method);
        if (method === "chat.postMessage") {
          return Response.json({ ok: true, ts: MESSAGE_TS, channel: CHANNEL_ID });
        }
        if (method === "chat.scheduleMessage") {
          return Response.json({ ok: true, channel: CHANNEL_ID, scheduled_message_id: "Q1" });
        }
        if (method === "conversations.info") {
          return Response.json({ ok: true, channel: { id: CHANNEL_ID, name: "verify" } });
        }
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function withTimeout<T>(input: { promise: Promise<T>; ms: number; what: string }): Promise<T> {
  const { promise, ms, what } = input;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runCell(input: {
  cell: Cell;
  root: string;
  stubUrl: string;
  recorded: string[];
  home: string;
  fakeBin: string;
}): Promise<CellResult> {
  const { cell, root, stubUrl, recorded, home, fakeBin } = input;
  const fail = (detail: string): CellResult => ({ cell, pass: false, detail });
  recorded.length = 0;
  const argv = cell.safeMode === "flag" ? ["--safe-mode", ...cell.argv] : cell.argv;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      name !== "CI" &&
      name !== "AGENT_SLACK_SAFE_MODE" &&
      name !== "SLACK_TOKEN" &&
      name !== "SLACK_COOKIE" &&
      name !== "SLACK_COOKIE_D" &&
      name !== "SLACK_WORKSPACE_URL"
    ) {
      env[name] = value;
    }
  }
  if (cell.ci) {
    env.CI = "1";
  }
  if (cell.safeMode === "env") {
    env.AGENT_SLACK_SAFE_MODE = "1";
  }
  env.SLACK_TOKEN = "xoxc-verify";
  env.SLACK_COOKIE_D = "verify";
  env.SLACK_WORKSPACE_URL = FIXTURE_WORKSPACE_URL;
  env.VERIFY_SAFE_MODE_STUB_URL = stubUrl;
  env.HOME = home;
  env.PATH = `${fakeBin}:${process.env.PATH ?? ""}`;
  env.AGENT_SLACK_NO_UPDATE_CHECK = "1";
  env.AGENT_SLACK_COMMAND_TIMEOUT_MS = "60000";
  const proc = Bun.spawn([process.execPath, "--preload", PRELOAD, "src/index.ts", ...argv], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let stdout = "";
  let stderr = "";
  let editorUrl: string | null = null;
  let editorAction = "none";
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  const watchStderr = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        stderr += decoder.decode(value, { stream: true });
        const editorMatch = stderr.match(/Draft editor: (http:\/\/127\.0\.0\.1:\d+\S*)/);
        if (editorMatch?.[1] && !editorUrl) {
          const [, page] = editorMatch;
          const editorPage = new URL(page);
          editorUrl = editorPage.origin;
          const token = editorPage.searchParams.get("t");
          const headers: Record<string, string> = token ? { "x-draft-token": token } : {};
          if (cell.editor === "cancel") {
            editorAction = "cancel";
            await fetch(`${editorUrl}/cancel`, { method: "POST", headers });
          } else if (cell.editor === "send") {
            editorAction = "send";
            await fetch(`${editorUrl}/send`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...headers },
              body: JSON.stringify({ text: "human approved text" }),
            });
          }
        }
      }
      if (done) {
        break;
      }
    }
  })();

  let exitCode: number | null = null;
  try {
    if (cell.editor === "none") {
      exitCode = await withTimeout({ promise: proc.exited, ms: 30000, what: "CLI exit" });
    } else {
      await withTimeout({
        promise: (async () => {
          for (;;) {
            if (editorUrl) {
              return;
            }
            await new Promise((r) => setTimeout(r, 25));
          }
        })(),
        ms: 30000,
        what: "draft editor to open",
      });
      exitCode = await withTimeout({
        promise: proc.exited,
        ms: 30000,
        what: "CLI exit after editor action",
      });
    }
  } catch (error) {
    proc.kill();
    await watchStderr.catch(() => {});
    const seen = recorded.filter((m) => WRITE_METHODS.has(m));
    return fail(
      `${error instanceof Error ? error.message : String(error)}; writes so far: ${JSON.stringify(seen)}; stderr: ${stderr.trim()}`,
    );
  }
  stdout = await new Response(proc.stdout).text();
  await watchStderr;

  const writes = recorded.filter((m) => WRITE_METHODS.has(m));
  const observed = `exit=${exitCode} writes=${JSON.stringify(writes)} editor=${editorUrl !== null ? `opened (action ${editorAction})` : "closed"}`;
  const editorOpened = editorUrl !== null;
  const editorExpected = cell.editor !== "none";
  if (editorOpened !== editorExpected) {
    return fail(
      `${observed}; editor opened=${editorOpened}, expected=${editorExpected}; stderr: ${stderr.trim()}`,
    );
  }
  const exitOk = cell.expectExit === "nonzero" ? exitCode !== 0 : exitCode === cell.expectExit;
  if (!exitOk) {
    return fail(
      `${observed}; exit expected=${cell.expectExit}; stdout: ${stdout.trim()}; stderr: ${stderr.trim()}`,
    );
  }
  if (cell.expectStderr && !stderr.includes(cell.expectStderr)) {
    return fail(
      `${observed}; stderr missing ${JSON.stringify(cell.expectStderr)}; stderr: ${stderr.trim()}`,
    );
  }
  if (JSON.stringify([...writes].sort()) !== JSON.stringify([...cell.expectWrites].sort())) {
    return fail(`${observed}; writes expected=${JSON.stringify(cell.expectWrites)}`);
  }
  return { cell, pass: true, detail: observed };
}

async function runPreflight(input: {
  stubUrl: string;
  recorded: string[];
}): Promise<string | null> {
  const { stubUrl, recorded } = input;
  recorded.length = 0;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[name] = value;
    }
  }
  env.VERIFY_SAFE_MODE_STUB_URL = stubUrl;
  const proc = Bun.spawn(
    [
      process.execPath,
      "--preload",
      PRELOAD,
      "-e",
      `const r = await fetch("${FIXTURE_WORKSPACE_URL}/api/preflight", { method: "POST" }); if (!r.ok) throw new Error("preflight got " + r.status);`,
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  let exitCode: number;
  try {
    exitCode = await withTimeout({ promise: proc.exited, ms: 15000, what: "preload self-check" });
  } catch (error) {
    proc.kill();
    return error instanceof Error ? error.message : String(error);
  }
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    return `exit=${exitCode}; stderr: ${stderr.trim()}`;
  }
  if (!recorded.includes("preflight")) {
    return `exit=0 but the stub observed [${recorded.join(", ")}]`;
  }
  return null;
}

function makeFakeBin(dir: string): string {
  const fakeBin = join(dir, "fakebin");
  mkdirSync(fakeBin, { recursive: true });
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(join(fakeBin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  return fakeBin;
}

const root = join(import.meta.dir, "..", "..", "..");
const workdir = mkdtempSync(join(tmpdir(), "verify-safe-mode-"));
const home = join(workdir, "home");
mkdirSync(home, { recursive: true });
const attachFile = join(workdir, "report.md");
writeFileSync(attachFile, "verify attachment\n");
const blocksFile = join(workdir, "blocks.json");
writeFileSync(
  blocksFile,
  JSON.stringify([{ type: "section", text: { type: "mrkdwn", text: "hi" } }]),
);
const scheduleAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

const recorded: string[] = [];
const stub = startStub(recorded);
const preflightError = await runPreflight({ stubUrl: stub.url, recorded });
if (preflightError !== null) {
  console.log(`Harness invalid: preload self-check failed (${preflightError}).`);
  stub.stop();
  process.exit(1);
}
const fakeBin = makeFakeBin(workdir);
const results: CellResult[] = [];
try {
  for (const cell of cells({ attachFile, blocksFile, scheduleAt })) {
    const result = await runCell({ cell, root, stubUrl: stub.url, recorded, home, fakeBin });
    results.push(result);
    console.log(`${result.pass ? "PASS" : "FAIL"} ${cell.name}: ${result.detail}`);
  }
} finally {
  stub.stop();
}

const failures = results.filter((r) => !r.pass);
console.log(`\n${results.length - failures.length}/${results.length} cells passed.`);
if (failures.length > 0) {
  const blind = failures.filter((r) => r.cell.safeMode === "off");
  if (blind.length > 0) {
    console.log(
      `Harness invalid: ${blind.length} control cell(s) failed (${blind.map((r) => r.cell.name).join(", ")}), so the result is unknown. Fix the harness before reading the property cells.`,
    );
  } else {
    console.log(
      "Property violated: with safe mode enabled, a message-posting command posted without human review.",
    );
  }
  process.exit(1);
}
