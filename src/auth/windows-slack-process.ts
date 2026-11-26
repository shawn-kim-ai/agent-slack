import { execFileSync, spawn } from "node:child_process";

export const DEFAULT_SLACK_STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 200;
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

export type SlackProcessOps = {
  getRunningSlackPath: () => string | null;
  stopSlack: () => void;
  isSlackRunning: () => boolean;
  startSlack: (exePath: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

function runPowerShell(script: string): string {
  return execFileSync("powershell", [...PS_ARGS, script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  }).trim();
}

function defaultGetRunningSlackPath(): string | null {
  try {
    return (
      runPowerShell(
        "(Get-Process -Name slack -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path)",
      ) || null
    );
  } catch {
    return null;
  }
}

function defaultIsSlackRunning(): boolean {
  try {
    return (
      Number(runPowerShell("@(Get-Process -Name slack -ErrorAction SilentlyContinue).Count")) > 0
    );
  } catch {
    return false;
  }
}

function defaultStopSlack(): void {
  try {
    runPowerShell("Stop-Process -Name slack -Force -ErrorAction SilentlyContinue");
  } catch {
    // ignore if already exited
  }
}

function defaultStartSlack(exePath: string): void {
  const child = spawn(exePath, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
}

const DEFAULT_OPS: SlackProcessOps = {
  getRunningSlackPath: defaultGetRunningSlackPath,
  stopSlack: defaultStopSlack,
  isSlackRunning: defaultIsSlackRunning,
  startSlack: defaultStartSlack,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * Temporarily stops Slack Desktop on Windows while `work` extracts locked
 * Cookies/LevelDB files, then always relaunches Slack if it was running.
 *
 * Invariants:
 * 1. If Slack was not running, it is never launched.
 * 2. If Slack was running, `startSlack(exePath)` is always called in `finally`,
 *    even when stopping times out or `work()` throws.
 * 3. `work()` is only invoked after Slack exits (or fails fast on stop timeout).
 */
export async function withWindowsSlackStopped<T>(
  work: () => Promise<T>,
  options?: { stopTimeoutMs?: number; ops?: SlackProcessOps },
): Promise<T> {
  const ops = options?.ops ?? DEFAULT_OPS;
  const stopTimeoutMs = options?.stopTimeoutMs ?? DEFAULT_SLACK_STOP_TIMEOUT_MS;
  const exePath = ops.getRunningSlackPath();
  if (!exePath) {
    return await work();
  }

  let stopped = false;
  try {
    ops.stopSlack();
    const deadline = ops.now() + stopTimeoutMs;
    while (ops.isSlackRunning()) {
      if (ops.now() >= deadline) {
        throw new Error(
          `Timed out after ${stopTimeoutMs}ms waiting for Slack Desktop to exit. Quit Slack manually (including the system tray icon) and retry.`,
        );
      }
      await ops.sleep(POLL_INTERVAL_MS);
    }
    stopped = true;
    return await work();
  } finally {
    try {
      ops.startSlack(exePath);
    } catch {
      // Best-effort relaunch; never mask the primary result/error.
      void stopped;
    }
  }
}
