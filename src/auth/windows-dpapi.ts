import { execFileSync } from "node:child_process";
import { win32 } from "node:path";

export const DEFAULT_DPAPI_TIMEOUT_MS = 10_000;

export type DpapiOptions = {
  timeoutMs?: number;
};

export type PowerShellRunOptions = {
  script: string;
  input?: string;
  timeoutMs?: number;
};

const PS_BASE_ARGS = ["-NoProfile", "-NonInteractive", "-Command"];

const PS_UNPROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Security",
  "$b64 = [Console]::In.ReadToEnd().Trim()",
  "$enc = [Convert]::FromBase64String($b64)",
  "$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($dec))",
].join("; ");

const PS_PROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Security",
  "$b64 = [Console]::In.ReadToEnd().Trim()",
  "$raw = [Convert]::FromBase64String($b64)",
  "$enc = [System.Security.Cryptography.ProtectedData]::Protect($raw, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($enc))",
].join("; ");

export function resolveWindowsSystemBinary(
  relativeUnderSystem32: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const systemRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
  return win32.join(systemRoot, "System32", relativeUnderSystem32);
}

export function runWindowsPowerShell(options: PowerShellRunOptions): string {
  const psExe = resolveWindowsSystemBinary("WindowsPowerShell\\v1.0\\powershell.exe");
  const timeout = options.timeoutMs ?? DEFAULT_DPAPI_TIMEOUT_MS;
  return execFileSync(psExe, [...PS_BASE_ARGS, options.script], {
    input: options.input,
    encoding: "utf8",
    stdio: [options.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    timeout,
  }).trim();
}

function runDpapiPowerShell(input: {
  script: string;
  data: Buffer;
  options?: DpapiOptions;
}): Buffer {
  const stdout = runWindowsPowerShell({
    script: input.script,
    input: input.data.toString("base64"),
    timeoutMs: input.options?.timeoutMs ?? DEFAULT_DPAPI_TIMEOUT_MS,
  });
  if (!stdout) {
    throw new Error("DPAPI PowerShell command returned empty output");
  }
  return Buffer.from(stdout, "base64");
}

export function dpapiUnprotect(encrypted: Buffer, options: DpapiOptions = {}): Buffer {
  return runDpapiPowerShell({ script: PS_UNPROTECT_SCRIPT, data: encrypted, options });
}

export function dpapiProtect(plaintext: Buffer, options: DpapiOptions = {}): Buffer {
  return runDpapiPowerShell({ script: PS_PROTECT_SCRIPT, data: plaintext, options });
}
