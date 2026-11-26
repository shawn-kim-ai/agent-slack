import { describe, expect, test } from "bun:test";
import { getFirefoxBaseDir, pickCandidatesByProfile } from "../src/auth/firefox-profile.ts";
import { getBrowserLaunchCommand } from "../src/cli/draft-server.ts";
import {
  detectInstallMethod,
  replaceBinaryFile,
  type ReplaceBinaryOps,
} from "../src/lib/update.ts";
import {
  DEFAULT_SLACK_STOP_TIMEOUT_MS,
  withWindowsSlackStopped,
  type SlackProcessOps,
} from "../src/auth/windows-slack-process.ts";
import {
  hydrateWindowsDpapiCredentials,
  sealWindowsDpapiCredentials,
  type DpapiStoreOps,
} from "../src/auth/store.ts";
import type { Credentials } from "../src/auth/schema.ts";

describe("Windows Firefox profile discovery", () => {
  test("resolves base directory per platform without throwing", () => {
    expect(
      getFirefoxBaseDir({
        platform: "win32",
        env: { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" },
        home: "C:\\Users\\alice",
      }),
    ).toContain("Mozilla");

    expect(
      getFirefoxBaseDir({
        platform: "win32",
        env: {},
        home: "C:\\Users\\alice",
      }),
    ).toContain("Roaming");

    expect(getFirefoxBaseDir({ platform: "darwin", env: {}, home: "/Users/alice" })).toBe(
      "/Users/alice/Library/Application Support/Firefox",
    );
    expect(getFirefoxBaseDir({ platform: "linux", env: {}, home: "/home/alice" })).toBe(
      "/home/alice/.mozilla/firefox",
    );
    expect(getFirefoxBaseDir({ platform: "freebsd", env: {}, home: "/home/alice" })).toBeNull();
  });

  test("matches Windows backslash profile paths by basename", () => {
    const candidates = [
      {
        name: "default-release",
        path: "C:\\Users\\alice\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\abc123.default-release",
        isDefault: true,
      },
    ];
    expect(pickCandidatesByProfile(candidates, "abc123.default-release")).toHaveLength(1);
    expect(pickCandidatesByProfile(candidates, "default-release")).toHaveLength(1);
    expect(pickCandidatesByProfile(candidates, "missing")).toHaveLength(0);
  });
});

describe("Draft editor browser launch command", () => {
  test("uses rundll32 on Windows, open on macOS, xdg-open on Linux", () => {
    const url = "http://127.0.0.1:4321/?t=abc&foo=bar";
    expect(getBrowserLaunchCommand(url, "win32")).toEqual({
      command: "rundll32",
      args: ["url.dll,FileProtocolHandler", url],
    });
    expect(getBrowserLaunchCommand(url, "darwin")).toEqual({
      command: "open",
      args: [url],
    });
    expect(getBrowserLaunchCommand(url, "linux")).toEqual({
      command: "xdg-open",
      args: [url],
    });
  });
});

describe("Windows self-update behavior", () => {
  test("detects bun.exe, node.exe, and standalone binary", () => {
    expect(detectInstallMethod("C:\\Users\\alice\\.bun\\bin\\bun.exe")).toBe("bun");
    expect(detectInstallMethod("/usr/local/bin/bun")).toBe("bun");
    expect(detectInstallMethod("C:\\Program Files\\nodejs\\node.exe")).toBe("npm");
    expect(
      detectInstallMethod("C:\\Users\\alice\\AppData\\Local\\agent-slack\\bin\\agent-slack.exe"),
    ).toBe("binary");
  });

  test("defers .bak cleanup on Windows EPERM without rolling back", async () => {
    const calls: string[] = [];
    const ops: ReplaceBinaryOps = {
      rename: async (src, dest) => {
        calls.push(`rename:${src}->${dest}`);
      },
      copyFile: async (src, dest) => {
        calls.push(`copy:${src}->${dest}`);
      },
      chmod: async () => {
        calls.push("chmod");
      },
      rm: async () => {
        calls.push("rm");
        const err = new Error("EPERM: resource busy or locked") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      },
    };

    const result = await replaceBinaryFile({
      sourcePath: "C:\\tmp\\new.exe",
      targetPath: "C:\\bin\\agent-slack.exe",
      platform: "win32",
      ops,
    });

    expect(result).toEqual({ backupCleanupDeferred: true });
    expect(calls).toEqual([
      "rename:C:\\bin\\agent-slack.exe->C:\\bin\\agent-slack.exe.bak",
      "copy:C:\\tmp\\new.exe->C:\\bin\\agent-slack.exe",
      "rm",
    ]);
  });

  test("restores backup if copyFile fails", async () => {
    const calls: string[] = [];
    const ops: ReplaceBinaryOps = {
      rename: async (src, dest) => {
        calls.push(`rename:${src}->${dest}`);
      },
      copyFile: async () => {
        calls.push("copy:fail");
        throw new Error("disk full");
      },
      chmod: async () => {
        calls.push("chmod");
      },
      rm: async () => {
        calls.push("rm");
      },
    };

    await expect(
      replaceBinaryFile({
        sourcePath: "/tmp/new",
        targetPath: "/bin/agent-slack",
        platform: "linux",
        ops,
      }),
    ).rejects.toThrow("disk full");

    expect(calls).toEqual([
      "rename:/bin/agent-slack->/bin/agent-slack.bak",
      "copy:fail",
      "rename:/bin/agent-slack.bak->/bin/agent-slack",
    ]);
  });
});

describe("Windows --restart-slack process lifecycle", () => {
  test("never stops or launches Slack when Slack is not running", async () => {
    const events: string[] = [];
    const ops: SlackProcessOps = {
      getRunningSlackPath: () => null,
      stopSlack: () => events.push("stop"),
      isSlackRunning: () => false,
      startSlack: () => events.push("start"),
      sleep: async () => {},
      now: () => 0,
    };

    const res = await withWindowsSlackStopped(
      async () => {
        events.push("work");
        return "ok";
      },
      { ops },
    );

    expect(res).toBe("ok");
    expect(events).toEqual(["work"]);
  });

  test("stops, waits for exit, runs work, and always relaunches Slack", async () => {
    const events: string[] = [];
    let runningChecks = 0;
    let time = 0;
    const ops: SlackProcessOps = {
      getRunningSlackPath: () => "C:\\Users\\alice\\AppData\\Local\\slack\\slack.exe",
      stopSlack: () => events.push("stop"),
      isSlackRunning: () => {
        runningChecks += 1;
        return runningChecks < 2;
      },
      startSlack: (exe) => events.push(`start:${exe}`),
      sleep: async (ms) => {
        time += ms;
      },
      now: () => time,
    };

    const res = await withWindowsSlackStopped(
      async () => {
        events.push("work");
        return 42;
      },
      { ops },
    );

    expect(res).toBe(42);
    expect(events).toEqual([
      "stop",
      "work",
      "start:C:\\Users\\alice\\AppData\\Local\\slack\\slack.exe",
    ]);
  });

  test("relaunches Slack even when work throws", async () => {
    const events: string[] = [];
    const ops: SlackProcessOps = {
      getRunningSlackPath: () => "C:\\slack\\slack.exe",
      stopSlack: () => events.push("stop"),
      isSlackRunning: () => false,
      startSlack: (exe) => events.push(`start:${exe}`),
      sleep: async () => {},
      now: () => 0,
    };

    await expect(
      withWindowsSlackStopped(
        async () => {
          events.push("work");
          throw new Error("extract failed");
        },
        { ops },
      ),
    ).rejects.toThrow("extract failed");

    expect(events).toEqual(["stop", "work", "start:C:\\slack\\slack.exe"]);
  });

  test("fails fast on stop timeout (5s default) without running work and still relaunches", async () => {
    const events: string[] = [];
    let time = 0;
    const ops: SlackProcessOps = {
      getRunningSlackPath: () => "C:\\slack\\slack.exe",
      stopSlack: () => events.push("stop"),
      isSlackRunning: () => true,
      startSlack: (exe) => events.push(`start:${exe}`),
      sleep: async (ms) => {
        time += ms;
      },
      now: () => time,
    };

    expect(DEFAULT_SLACK_STOP_TIMEOUT_MS).toBe(5_000);
    await expect(
      withWindowsSlackStopped(
        async () => {
          events.push("work");
          return "never";
        },
        { ops },
      ),
    ).rejects.toThrow("Timed out after 5000ms");

    expect(events).toEqual(["stop", "start:C:\\slack\\slack.exe"]);
  });
});

describe("Windows DPAPI batched credential store", () => {
  const sampleCreds: Credentials = {
    version: 1,
    default_workspace_url: "https://team1.slack.com",
    workspaces: [
      {
        workspace_url: "https://team1.slack.com",
        workspace_name: "Team 1",
        auth: {
          auth_type: "browser",
          xoxc_token: "xoxc-secret-1",
          xoxd_cookie: "xoxd-cookie-shared",
        },
      },
      {
        workspace_url: "https://team2.slack.com",
        workspace_name: "Team 2",
        auth: {
          auth_type: "standard",
          token: "xoxb-secret-2",
        },
      },
    ],
  };

  test("encrypts and decrypts all workspaces in a single DPAPI call each", () => {
    let protectCalls = 0;
    let unprotectCalls = 0;
    const fakeOps: DpapiStoreOps = {
      protect: (buf) => {
        protectCalls += 1;
        return Buffer.concat([Buffer.from("ENC:"), buf]);
      },
      unprotect: (buf) => {
        unprotectCalls += 1;
        expect(buf.subarray(0, 4).toString("utf8")).toBe("ENC:");
        return buf.subarray(4);
      },
    };

    const sealed = sealWindowsDpapiCredentials(sampleCreds, fakeOps);
    expect(protectCalls).toBe(1);
    expect(sealed.dpapi_secrets).toBeTruthy();
    expect(JSON.stringify(sealed)).not.toContain("xoxc-secret-1");
    expect(JSON.stringify(sealed)).not.toContain("xoxd-cookie-shared");
    expect(JSON.stringify(sealed)).not.toContain("xoxb-secret-2");

    const hydrated = hydrateWindowsDpapiCredentials(sealed, fakeOps);
    expect(unprotectCalls).toBe(1);
    expect(hydrated.dpapi_secrets).toBeUndefined();
    expect(hydrated.workspaces).toEqual(sampleCreds.workspaces);
  });

  test("loads legacy plaintext credentials with zero DPAPI calls and falls back on protect error", () => {
    let unprotectCalls = 0;
    const failingOps: DpapiStoreOps = {
      protect: () => {
        throw new Error("DPAPI unavailable");
      },
      unprotect: () => {
        unprotectCalls += 1;
        throw new Error("should not be called");
      },
    };

    const loaded = hydrateWindowsDpapiCredentials(sampleCreds, failingOps);
    expect(unprotectCalls).toBe(0);
    expect(loaded.workspaces).toEqual(sampleCreds.workspaces);

    const fallback = sealWindowsDpapiCredentials(sampleCreds, failingOps);
    expect(fallback.dpapi_secrets).toBeUndefined();
    expect(fallback.workspaces).toEqual(sampleCreds.workspaces);
  });
});
