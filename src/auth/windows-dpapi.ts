import { execFileSync } from "node:child_process";

const DEFAULT_DPAPI_TIMEOUT_MS = 10_000;

export type DpapiOptions = {
  timeoutMs?: number;
};

const PS_BASE_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

const PS_UNPROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$b64 = [Console]::In.ReadToEnd().Trim()",
  "$enc = [Convert]::FromBase64String($b64)",
  "$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($dec))",
].join("; ");

const PS_PROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$b64 = [Console]::In.ReadToEnd().Trim()",
  "$raw = [Convert]::FromBase64String($b64)",
  "$enc = [System.Security.Cryptography.ProtectedData]::Protect($raw, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($enc))",
].join("; ");

function runDpapiPowerShell(input: {
  script: string;
  data: Buffer;
  options?: DpapiOptions;
}): Buffer {
  const timeout = input.options?.timeoutMs ?? DEFAULT_DPAPI_TIMEOUT_MS;
  const stdout = execFileSync("powershell", [...PS_BASE_ARGS, input.script], {
    input: input.data.toString("base64"),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout,
  }).trim();

  if (!stdout) {
    throw new Error("DPAPI PowerShell command returned empty output");
  }
  return Buffer.from(stdout, "base64");
}

/**
 * Decrypt a DPAPI-protected buffer for the current Windows user via PowerShell
 * stdin/stdout base64 transport (avoids writing decrypted secrets to disk).
 */
export function dpapiUnprotect(encrypted: Buffer, options: DpapiOptions = {}): Buffer {
  return runDpapiPowerShell({ script: PS_UNPROTECT_SCRIPT, data: encrypted, options });
}

/**
 * Encrypt a buffer for the current Windows user via DPAPI (CurrentUser scope)
 * using PowerShell stdin/stdout base64 transport.
 */
export function dpapiProtect(plaintext: Buffer, options: DpapiOptions = {}): Buffer {
  return runDpapiPowerShell({ script: PS_PROTECT_SCRIPT, data: plaintext, options });
}
