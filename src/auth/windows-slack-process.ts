import { spawn } from "node:child_process";
import { runWindowsPowerShell } from "./windows-dpapi.ts";

export const DEFAULT_SLACK_STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 200;

export type SlackProcessOps = {
  getRunningSlackPath: () => string | null;
  stopSlack: () => void;
  isSlackRunning: () => boolean;
  startSlack: (exePath: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const CURRENT_SESSION_SLACK_EXPR =
  "$sid = (Get-Process -Id $PID).SessionId; Get-Process -Name slack -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $sid }";

function defaultGetRunningSlackPath(): string | null {
  try {
    return (
      runWindowsPowerShell({
        script: `${CURRENT_SESSION_SLACK_EXPR} | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path`,
        timeoutMs: DEFAULT_SLACK_STOP_TIMEOUT_MS,
      }) || null
    );
  } catch {
    return null;
  }
}

function defaultIsSlackRunning(): boolean {
  const out = runWindowsPowerShell({
    script: `@(${CURRENT_SESSION_SLACK_EXPR}).Count`,
    timeoutMs: DEFAULT_SLACK_STOP_TIMEOUT_MS,
  });
  if (!/^\d+$/.test(out)) {
    throw new Error(`Unexpected PowerShell Slack process count: "${out}"`);
  }
  return Number(out) > 0;
}

function defaultStopSlack(): void {
  runWindowsPowerShell({
    script: `${CURRENT_SESSION_SLACK_EXPR} | Stop-Process -Force -ErrorAction SilentlyContinue`,
    timeoutMs: DEFAULT_SLACK_STOP_TIMEOUT_MS,
  });
}

function defaultStartSlack(exePath: string): void {
  const child = spawn(exePath, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.on("error", () => {
    // Prevent unhandled async spawn errors (ENOENT/EACCES).
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
 * Temporarily force-stops Slack Desktop in the current Windows user session
 * while `work` extracts locked Cookies/LevelDB files, then relaunches Slack
 * if it was running.
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
    return await work();
  } finally {
    try {
      ops.startSlack(exePath);
    } catch {
      // Best-effort relaunch; never mask the primary result or error.
    }
  }
}
