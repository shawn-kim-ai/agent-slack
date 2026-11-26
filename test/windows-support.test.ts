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
import { dpapiProtect, dpapiUnprotect } from "../src/auth/windows-dpapi.ts";
import type { Credentials } from "../src/auth/schema.ts";

describe("Windows Firefox profile discovery", () => {
  test("resolves base directory per platform without throwing", () => {
    expect(
      getFirefoxBaseDir({
        platform: "win32",
        env: { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" },
        home: "C:\\Users\\alice",
      }),
    ).toBe("C:\\Users\\alice\\AppData\\Roaming\\Mozilla\\Firefox");

    expect(
      getFirefoxBaseDir({
        platform: "win32",
        env: {},
        home: "C:\\Users\\alice",
      }),
    ).toBe("C:\\Users\\alice\\AppData\\Roaming\\Mozilla\\Firefox");

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
  test("uses System32 rundll32.exe on Windows, open on macOS, xdg-open on Linux", () => {
    const url = "http://127.0.0.1:4321/?t=abc&foo=bar";
    const winCmd = getBrowserLaunchCommand(url, "win32");
    expect(winCmd.command.toLowerCase()).toEndWith("\\system32\\rundll32.exe");
    expect(winCmd.args).toEqual(["url.dll,FileProtocolHandler", url]);

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
    expect(detectInstallMethod("C:\\Users\\alice\\.bun\\bin\\bun.exe", {})).toBe("bun");
    expect(detectInstallMethod("/usr/local/bin/bun", {})).toBe("bun");
    expect(detectInstallMethod("C:\\Program Files\\nodejs\\node.exe", {})).toBe("npm");
    expect(
      detectInstallMethod(
        "C:\\Users\\alice\\AppData\\Local\\agent-slack\\bin\\agent-slack.exe",
        {},
      ),
    ).toBe("binary");
  });

  test("stages new binary first and defers .bak cleanup on Windows EPERM without rolling back", async () => {
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
      rm: async (p) => {
        calls.push(`rm:${p}`);
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
      "copy:C:\\tmp\\new.exe->C:\\bin\\agent-slack.exe.new",
      "rename:C:\\bin\\agent-slack.exe->C:\\bin\\agent-slack.exe.bak",
      "rename:C:\\bin\\agent-slack.exe.new->C:\\bin\\agent-slack.exe",
      "rm:C:\\bin\\agent-slack.exe.bak",
    ]);
  });

  test("leaves live binary untouched if staging copyFile fails", async () => {
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
      rm: async (p) => {
        calls.push(`rm:${p}`);
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

    expect(calls).toEqual(["copy:fail"]);
  });

  test("surfaces recovery path when both staged rename and backup restore fail", async () => {
    const ops: ReplaceBinaryOps = {
      copyFile: async () => {},
      chmod: async () => {},
      rm: async () => {},
      rename: async (src) => {
        if (src === "/bin/agent-slack.new" || src === "/bin/agent-slack.bak") {
          throw new Error("rename failed");
        }
      },
    };

    await expect(
      replaceBinaryFile({
        sourcePath: "/tmp/new",
        targetPath: "/bin/agent-slack",
        platform: "win32",
        ops,
      }),
    ).rejects.toThrow('recover manually from "/bin/agent-slack.bak"');
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
          xoxd_cookie: "xoxd-cookie-team-1",
        },
      },
      {
        workspace_url: "https://team3.slack.com",
        workspace_name: "Team 3",
        auth: {
          auth_type: "browser",
          xoxc_token: "xoxc-secret-3",
          xoxd_cookie: "xoxd-cookie-team-3",
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

    const sealed = sealWindowsDpapiCredentials(sampleCreds, { ops: fakeOps });
    expect(protectCalls).toBe(1);
    expect(sealed.dpapi_secrets).toBeTruthy();
    expect(JSON.stringify(sealed)).not.toContain("xoxc-secret-1");
    expect(JSON.stringify(sealed)).not.toContain("xoxc-secret-3");
    expect(JSON.stringify(sealed)).not.toContain("xoxd-cookie-team-1");
    expect(JSON.stringify(sealed)).not.toContain("xoxd-cookie-team-3");
    expect(JSON.stringify(sealed)).not.toContain("xoxb-secret-2");

    const hydrated = hydrateWindowsDpapiCredentials(sealed, fakeOps);
    expect(unprotectCalls).toBe(1);
    expect(hydrated.dpapi_secrets).toBeUndefined();
    expect(hydrated.workspaces).toEqual(sampleCreds.workspaces);
  });

  test("fails closed on transient decrypt error, missing envelope, partial bag, or downgrade of previously sealed store", () => {
    const workingOps: DpapiStoreOps = {
      protect: (buf) => Buffer.concat([Buffer.from("ENC:"), buf]),
      unprotect: (buf) => buf.subarray(4),
    };
    const sealed = sealWindowsDpapiCredentials(sampleCreds, { ops: workingOps });

    const failingOps: DpapiStoreOps = {
      protect: () => {
        throw new Error("PowerShell timed out");
      },
      unprotect: () => {
        throw new Error("PowerShell timed out");
      },
    };

    expect(() => hydrateWindowsDpapiCredentials(sealed, failingOps)).toThrow(
      "Failed to decrypt Windows DPAPI credentials",
    );
    expect(() =>
      hydrateWindowsDpapiCredentials({ ...sealed, dpapi_secrets: undefined }, workingOps),
    ).toThrow("no encrypted envelope");
    expect(() => sealWindowsDpapiCredentials(sealed, { ops: workingOps })).toThrow(
      "unhydrated Windows DPAPI placeholders",
    );
    expect(() =>
      sealWindowsDpapiCredentials(sampleCreds, { ops: failingOps, requireEncryption: true }),
    ).toThrow("refusing to downgrade to plaintext");
  });

  test("loads legacy plaintext credentials with zero DPAPI calls and falls back on initial protect error", () => {
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

    const fallback = sealWindowsDpapiCredentials(sampleCreds, {
      ops: failingOps,
      requireEncryption: false,
    });
    expect(fallback.dpapi_secrets).toBeUndefined();
    expect(fallback.workspaces).toEqual(sampleCreds.workspaces);
  });

  test.skipIf(process.platform !== "win32")(
    "round-trips real Windows CurrentUser DPAPI encryption",
    () => {
      const probe = Buffer.from("agent-slack-dpapi-smoke", "utf8");
      const enc = dpapiProtect(probe);
      expect(enc.equals(probe)).toBe(false);
      expect(dpapiUnprotect(enc).toString("utf8")).toBe("agent-slack-dpapi-smoke");

      const sealed = sealWindowsDpapiCredentials(sampleCreds, { requireEncryption: true });
      expect(sealed.dpapi_secrets).toBeTruthy();
      expect(JSON.stringify(sealed)).not.toContain("xoxc-secret-1");
      const hydrated = hydrateWindowsDpapiCredentials(sealed);
      expect(hydrated.workspaces).toEqual(sampleCreds.workspaces);
    },
  );
});
