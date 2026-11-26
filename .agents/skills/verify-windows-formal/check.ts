import { getFirefoxBaseDir } from "../../../src/auth/firefox-profile.ts";
import {
  hydrateWindowsDpapiCredentials,
  sealWindowsDpapiCredentials,
  type DpapiStoreOps,
} from "../../../src/auth/store.ts";
import type { Credentials } from "../../../src/auth/schema.ts";
import {
  DEFAULT_SLACK_STOP_TIMEOUT_MS,
  withWindowsSlackStopped,
  type SlackProcessOps,
} from "../../../src/auth/windows-slack-process.ts";
import { replaceBinaryFile, type ReplaceBinaryOps } from "../../../src/lib/update.ts";

let passed = 0;
let failed = 0;

function assert(cond: boolean, message: string): void {
  if (cond) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`FAIL ${message}`);
}

async function verifySelfUpdateMatrix(): Promise<void> {
  const platforms: NodeJS.Platform[] = ["win32", "linux"];
  const bools = [true, false];
  let cells = 0;
  let reachedRollback = false;
  let reachedDeferred = false;

  for (const platform of platforms) {
    for (const copyOk of bools) {
      for (const chmodOk of bools) {
        for (const backupRenameOk of bools) {
          for (const stagedRenameOk of bools) {
            for (const rmOk of bools) {
              cells += 1;
              const fsState = new Map<string, string>([
                ["/bin/app", "OLD"],
                ["/tmp/new", "NEW"],
              ]);
              const ops: ReplaceBinaryOps = {
                copyFile: async (src, dest) => {
                  if (!copyOk) {
                    throw new Error("copy failed");
                  }
                  fsState.set(dest, fsState.get(src)!);
                },
                chmod: async () => {
                  if (!chmodOk) {
                    throw new Error("chmod failed");
                  }
                },
                rename: async (src, dest) => {
                  if (src === "/bin/app" && !backupRenameOk) {
                    throw new Error("backup rename failed");
                  }
                  if (src === "/bin/app.new" && !stagedRenameOk) {
                    throw new Error("staged rename failed");
                  }
                  const val = fsState.get(src);
                  if (!val) {
                    throw new Error(`missing ${src}`);
                  }
                  fsState.set(dest, val);
                  fsState.delete(src);
                },
                rm: async (p) => {
                  if (p === "/bin/app.bak" && !rmOk) {
                    const err = new Error("EPERM") as NodeJS.ErrnoException;
                    err.code = "EPERM";
                    throw err;
                  }
                  fsState.delete(p);
                },
              };

              let threw = false;
              let deferred = false;
              try {
                const res = await replaceBinaryFile({
                  sourcePath: "/tmp/new",
                  targetPath: "/bin/app",
                  platform,
                  ops,
                });
                deferred = res.backupCleanupDeferred;
              } catch {
                threw = true;
              }

              const finalBin = fsState.get("/bin/app");
              const label = `self-update(${platform},cp=${copyOk},ch=${chmodOk},bk=${backupRenameOk},st=${stagedRenameOk},rm=${rmOk})`;

              assert(
                finalBin === "OLD" || finalBin === "NEW",
                `${label}:BinaryAlwaysPresent finalBin=${String(finalBin)}`,
              );

              if (platform === "linux" && copyOk && !chmodOk) {
                assert(threw && finalBin === "OLD", `${label}:LinuxChmodFailKeepsOld`);
              }

              const swapped =
                copyOk && (platform === "win32" || chmodOk) && backupRenameOk && stagedRenameOk;
              if (platform === "win32" && swapped && !rmOk) {
                assert(!threw && deferred && finalBin === "NEW", `${label}:WinDeferred`);
                reachedDeferred = true;
              }
              if (
                copyOk &&
                (platform === "win32" || chmodOk) &&
                backupRenameOk &&
                !stagedRenameOk
              ) {
                assert(threw && finalBin === "OLD", `${label}:StagedRenameRollbackRestoresOld`);
                reachedRollback = true;
              }
            }
          }
        }
      }
    }
  }

  assert(reachedRollback && reachedDeferred, "self-update:Controls");
  console.log(`PASS self-update state machine: ${cells} states verified`);
}

function verifyDpapiAndFallbackMatrix(): void {
  const datasets: { name: string; creds: Credentials; hasSecrets: boolean }[] = [
    { name: "empty", creds: { version: 1, workspaces: [] }, hasSecrets: false },
    {
      name: "multiBrowserAndStandard",
      hasSecrets: true,
      creds: {
        version: 1,
        workspaces: [
          {
            workspace_url: "https://a.slack.com",
            auth: { auth_type: "browser", xoxc_token: "xoxc-1", xoxd_cookie: "xoxd-a" },
          },
          {
            workspace_url: "https://c.slack.com",
            auth: { auth_type: "browser", xoxc_token: "xoxc-3", xoxd_cookie: "xoxd-c" },
          },
          {
            workspace_url: "https://b.slack.com",
            auth: { auth_type: "standard", token: "xoxb-2" },
          },
        ],
      },
    },
  ];

  let cells = 0;
  for (const ds of datasets) {
    for (const dpapiOk of [true, false]) {
      cells += 1;
      let protectCalls = 0;
      let unprotectCalls = 0;
      const ops: DpapiStoreOps = {
        protect: (buf) => {
          protectCalls += 1;
          if (!dpapiOk) {
            throw new Error("DPAPI protect failed");
          }
          return Buffer.concat([Buffer.from("DPAPI:"), buf]);
        },
        unprotect: (buf) => {
          unprotectCalls += 1;
          if (!dpapiOk) {
            throw new Error("DPAPI unprotect failed");
          }
          return buf.subarray(6);
        },
      };

      const sealed = sealWindowsDpapiCredentials(ds.creds, { ops, requireEncryption: false });
      const label = `dpapi(${ds.name},ok=${dpapiOk})`;

      assert(protectCalls <= 1, `${label}:MaxOneProtect`);

      if (dpapiOk && ds.hasSecrets) {
        const serialized = JSON.stringify(sealed);
        assert(Boolean(sealed.dpapi_secrets), `${label}:EnvelopePresent`);
        assert(
          !serialized.includes("xoxc-1") &&
            !serialized.includes("xoxd-a") &&
            !serialized.includes("xoxd-c") &&
            !serialized.includes("xoxb-2"),
          `${label}:NoPlaintextLeak`,
        );

        let downgradeBlocked = false;
        try {
          sealWindowsDpapiCredentials(ds.creds, {
            ops: {
              protect: () => {
                throw new Error("timeout");
              },
              unprotect: ops.unprotect,
            },
            requireEncryption: true,
          });
        } catch {
          downgradeBlocked = true;
        }
        assert(downgradeBlocked, `${label}:NoSilentPlaintextDowngrade`);

        let decryptFailedClosed = false;
        try {
          hydrateWindowsDpapiCredentials(sealed, {
            protect: ops.protect,
            unprotect: () => {
              throw new Error("transient timeout");
            },
          });
        } catch {
          decryptFailedClosed = true;
        }
        assert(decryptFailedClosed, `${label}:FailClosedOnTransientDecryptError`);

        let partialBagFailedClosed = false;
        try {
          hydrateWindowsDpapiCredentials(sealed, {
            protect: ops.protect,
            unprotect: () =>
              Buffer.from(JSON.stringify({ xoxc: {}, xoxd_by_workspace: {}, token: {} })),
          });
        } catch {
          partialBagFailedClosed = true;
        }
        assert(partialBagFailedClosed, `${label}:FailClosedOnPartialBag`);
      }

      const hydrated = hydrateWindowsDpapiCredentials(sealed, ops);
      assert(unprotectCalls <= 1, `${label}:MaxOneUnprotect`);
      assert(hydrated.dpapi_secrets === undefined, `${label}:StripsCiphertext`);
      assert(
        JSON.stringify(hydrated.workspaces) === JSON.stringify(ds.creds.workspaces),
        `${label}:NoTokenLoss`,
      );
    }
  }

  assert(
    getFirefoxBaseDir({ platform: "win32", env: { APPDATA: "C:\\AppData" }, home: "C:\\u" }) ===
      "C:\\AppData\\Mozilla\\Firefox",
    "firefox-base-dir(win32):ExpectedPath",
  );
  assert(
    getFirefoxBaseDir({ platform: "darwin", env: {}, home: "/Users/u" }) ===
      "/Users/u/Library/Application Support/Firefox",
    "firefox-base-dir(darwin):ExpectedPath",
  );
  assert(
    getFirefoxBaseDir({ platform: "linux", env: {}, home: "/home/u" }) ===
      "/home/u/.mozilla/firefox",
    "firefox-base-dir(linux):ExpectedPath",
  );
  assert(
    getFirefoxBaseDir({ platform: "freebsd", env: {}, home: "/home/u" }) === null,
    "firefox-base-dir(freebsd):NullWithoutThrow",
  );

  console.log(
    `PASS DPAPI credential store & fallback: ${cells} states + 4 platform assertions verified`,
  );
}

async function verifyRestartSlackMatrix(): Promise<void> {
  const stopModes = ["immediate", "delayed", "timeout"] as const;
  const workModes = ["ok", "throws"] as const;
  const startModes = ["ok", "throws"] as const;
  let cells = 0;

  for (const initiallyRunning of [false, true]) {
    for (const stopMode of stopModes) {
      for (const workMode of workModes) {
        for (const startMode of startModes) {
          cells += 1;
          const trace: string[] = [];
          let pollCount = 0;
          let clock = 0;
          const slackExe = "C:\\slack\\slack.exe";

          const ops: SlackProcessOps = {
            getRunningSlackPath: () => (initiallyRunning ? slackExe : null),
            stopSlack: () => {
              trace.push("stop");
            },
            isSlackRunning: () => {
              pollCount += 1;
              if (stopMode === "immediate") {
                return false;
              }
              if (stopMode === "delayed") {
                return pollCount < 3;
              }
              return true;
            },
            startSlack: (exe) => {
              trace.push(`start:${exe}`);
              if (startMode === "throws") {
                throw new Error("spawn failed");
              }
            },
            sleep: async (ms) => {
              clock += ms;
            },
            now: () => clock,
          };

          let threw = false;
          try {
            await withWindowsSlackStopped(
              async () => {
                trace.push("work");
                if (workMode === "throws") {
                  throw new Error("work failed");
                }
                return "done";
              },
              { stopTimeoutMs: DEFAULT_SLACK_STOP_TIMEOUT_MS, ops },
            );
          } catch {
            threw = true;
          }

          const label = `restart-slack(run=${initiallyRunning},stop=${stopMode},work=${workMode},start=${startMode})`;

          if (!initiallyRunning) {
            assert(
              trace.join(",") === "work",
              `${label}:NeverStartIfNotRunning trace=${trace.join(",")}`,
            );
          } else if (stopMode === "timeout") {
            assert(
              threw && trace.join(",") === `stop,start:${slackExe}`,
              `${label}:NoWorkWhileLocked trace=${trace.join(",")}`,
            );
          } else {
            assert(
              threw === (workMode === "throws") &&
                trace.join(",") === `stop,work,start:${slackExe}`,
              `${label}:ExactOrderAndExePath trace=${trace.join(",")}`,
            );
          }
        }
      }
    }
  }

  console.log(`PASS --restart-slack lifecycle: ${cells} states verified`);
}

await verifySelfUpdateMatrix();
verifyDpapiAndFallbackMatrix();
await verifyRestartSlackMatrix();

console.log(`\nSummary: ${passed} assertions passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
