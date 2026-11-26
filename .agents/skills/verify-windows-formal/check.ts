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
    for (const renameOk of bools) {
      for (const copyOk of bools) {
        for (const chmodOk of bools) {
          for (const rmOk of bools) {
            cells += 1;
            const fsState = new Map<string, string>([
              ["/bin/app", "OLD"],
              ["/tmp/new", "NEW"],
            ]);
            const ops: ReplaceBinaryOps = {
              rename: async (src, dest) => {
                if (src === "/bin/app" && !renameOk) {
                  throw new Error("rename failed");
                }
                const val = fsState.get(src);
                if (!val) {
                  throw new Error(`missing ${src}`);
                }
                fsState.set(dest, val);
                fsState.delete(src);
              },
              copyFile: async (src, dest) => {
                if (!copyOk) {
                  throw new Error("copy failed");
                }
                const val = fsState.get(src);
                if (!val) {
                  throw new Error(`missing ${src}`);
                }
                fsState.set(dest, val);
              },
              chmod: async () => {
                if (!chmodOk) {
                  throw new Error("chmod failed");
                }
              },
              rm: async (p) => {
                if (!rmOk) {
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
            const label = `self-update(${platform},ren=${renameOk},cp=${copyOk},ch=${chmodOk},rm=${rmOk})`;

            assert(
              finalBin === "OLD" || finalBin === "NEW",
              `${label}:BinaryAlwaysPresent finalBin=${String(finalBin)}`,
            );

            if (platform === "win32" && renameOk && copyOk && !rmOk) {
              assert(
                !threw && deferred && finalBin === "NEW",
                `${label}:WinDeferred threw=${threw},deferred=${deferred},final=${String(finalBin)}`,
              );
              reachedDeferred = true;
            }

            if (renameOk && !copyOk) {
              assert(
                threw && finalBin === "OLD",
                `${label}:RollbackRestoresOld threw=${threw},final=${String(finalBin)}`,
              );
              reachedRollback = true;
            }
          }
        }
      }
    }
  }

  assert(
    reachedRollback && reachedDeferred,
    `self-update:Controls rollback=${reachedRollback},deferred=${reachedDeferred}`,
  );
  console.log(`PASS self-update state machine: ${cells} states verified`);
}

function verifyDpapiAndFallbackMatrix(): void {
  const datasets: { name: string; creds: Credentials; hasSecrets: boolean }[] = [
    { name: "empty", creds: { version: 1, workspaces: [] }, hasSecrets: false },
    {
      name: "browserOnly",
      hasSecrets: true,
      creds: {
        version: 1,
        workspaces: [
          {
            workspace_url: "https://a.slack.com",
            auth: { auth_type: "browser", xoxc_token: "xoxc-1", xoxd_cookie: "xoxd-1" },
          },
        ],
      },
    },
    {
      name: "standardOnly",
      hasSecrets: true,
      creds: {
        version: 1,
        workspaces: [
          {
            workspace_url: "https://b.slack.com",
            auth: { auth_type: "standard", token: "xoxb-2" },
          },
        ],
      },
    },
    {
      name: "mixed",
      hasSecrets: true,
      creds: {
        version: 1,
        workspaces: [
          {
            workspace_url: "https://a.slack.com",
            auth: { auth_type: "browser", xoxc_token: "xoxc-1", xoxd_cookie: "xoxd-1" },
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

      const sealed = sealWindowsDpapiCredentials(ds.creds, ops);
      const label = `dpapi(${ds.name},ok=${dpapiOk})`;

      assert(protectCalls <= 1, `${label}:MaxOneProtect protectCalls=${protectCalls}`);

      if (dpapiOk && ds.hasSecrets) {
        const serialized = JSON.stringify(sealed);
        assert(
          !serialized.includes("xoxc-1") &&
            !serialized.includes("xoxd-1") &&
            !serialized.includes("xoxb-2"),
          `${label}:NoPlaintextLeak`,
        );
      }

      const hydrated = hydrateWindowsDpapiCredentials(sealed, ops);
      assert(unprotectCalls <= 1, `${label}:MaxOneUnprotect unprotectCalls=${unprotectCalls}`);
      assert(hydrated.dpapi_secrets === undefined, `${label}:StripsCiphertext`);
      assert(
        JSON.stringify(hydrated.workspaces) === JSON.stringify(ds.creds.workspaces),
        `${label}:NoTokenLoss`,
      );

      if (dpapiOk && ds.hasSecrets) {
        let failedClosed = false;
        try {
          hydrateWindowsDpapiCredentials(sealed, {
            protect: ops.protect,
            unprotect: () => {
              throw new Error("transient timeout");
            },
          });
        } catch {
          failedClosed = true;
        }
        assert(failedClosed, `${label}:FailClosedOnTransientDecryptError`);
      }
    }
  }

  for (const p of ["darwin", "linux", "win32", "freebsd", "sunos"] as NodeJS.Platform[]) {
    let threw = false;
    try {
      getFirefoxBaseDir({ platform: p, env: { APPDATA: "C:\\AppData" }, home: "/home/u" });
    } catch {
      threw = true;
    }
    assert(!threw, `firefox-base-dir(${p}):NoThrow`);
  }

  console.log(`PASS DPAPI credential store & fallback: ${cells} states + 5 platforms verified`);
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
          let stopCalls = 0;
          let startCalls = 0;
          let workCalls = 0;
          let pollCount = 0;
          let clock = 0;

          const ops: SlackProcessOps = {
            getRunningSlackPath: () => (initiallyRunning ? "C:\\slack\\slack.exe" : null),
            stopSlack: () => {
              stopCalls += 1;
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
            startSlack: () => {
              startCalls += 1;
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
                workCalls += 1;
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
              stopCalls === 0 && startCalls === 0 && workCalls === 1,
              `${label}:NeverStartIfNotRunning stop=${stopCalls},start=${startCalls},work=${workCalls}`,
            );
          } else {
            assert(
              stopCalls === 1 && startCalls === 1,
              `${label}:AlwaysRelaunchIfRunning stop=${stopCalls},start=${startCalls}`,
            );
            if (stopMode === "timeout") {
              assert(workCalls === 0 && threw, `${label}:NoWorkWhileLocked`);
            } else {
              assert(
                workCalls === 1 && threw === (workMode === "throws"),
                `${label}:WorkExecutedOnce`,
              );
            }
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
