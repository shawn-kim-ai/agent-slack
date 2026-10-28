const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

export function isSafeModeEnabled(input?: {
  cliFlag?: boolean;
  env?: Record<string, string | undefined>;
}): boolean {
  if (input?.cliFlag) {
    return true;
  }
  const env = input?.env ?? process.env;
  const raw = env.AGENT_SLACK_SAFE_MODE?.trim().toLowerCase();
  return raw !== undefined && TRUTHY_VALUES.has(raw);
}
