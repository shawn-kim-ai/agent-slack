import { CREDENTIALS_FILE } from "./paths.ts";
import type { Credentials, Workspace } from "./schema.ts";
import { dpapiProtect, dpapiUnprotect } from "./windows-dpapi.ts";
import { isRecord } from "../lib/object-type-guards.ts";

export const DPAPI_PLACEHOLDER = "__DPAPI__";

export type DpapiStoreOps = {
  protect: (plaintext: Buffer) => Buffer;
  unprotect: (encrypted: Buffer) => Buffer;
};

const DEFAULT_DPAPI_OPS: DpapiStoreOps = {
  protect: (plaintext) => dpapiProtect(plaintext),
  unprotect: (encrypted) => dpapiUnprotect(encrypted),
};

type DpapiSecretBag = {
  xoxd?: string;
  xoxd_by_workspace: Record<string, string>;
  xoxc: Record<string, string>;
  token: Record<string, string>;
};

function normalizeUrl(workspaceUrl: string): string {
  const u = new URL(workspaceUrl);
  return `${u.protocol}//${u.host}`;
}

function isPlaceholder(value: string | undefined): boolean {
  return !value || value === "__KEYCHAIN__" || value === DPAPI_PLACEHOLDER;
}

function extractStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string") {
        out[k] = v;
      }
    }
  }
  return out;
}

function parseDpapiSecretBag(raw: Buffer): DpapiSecretBag | null {
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (!isRecord(parsed)) {
      return null;
    }
    return {
      xoxd: typeof parsed.xoxd === "string" ? parsed.xoxd : undefined,
      xoxd_by_workspace: extractStringRecord(parsed.xoxd_by_workspace),
      xoxc: extractStringRecord(parsed.xoxc),
      token: extractStringRecord(parsed.token),
    };
  } catch {
    return null;
  }
}

export function hasDpapiPlaceholder(workspaces: Workspace[]): boolean {
  return workspaces.some((w) =>
    w.auth.auth_type === "browser"
      ? w.auth.xoxc_token === DPAPI_PLACEHOLDER || w.auth.xoxd_cookie === DPAPI_PLACEHOLDER
      : w.auth.token === DPAPI_PLACEHOLDER,
  );
}

function recoveryHint(): string {
  return `If your Windows password changed or the file was copied from another machine, delete "${CREDENTIALS_FILE}" and re-run "agent-slack auth import-desktop".`;
}

export function hydrateWindowsDpapiCredentials(
  creds: Credentials,
  ops: DpapiStoreOps = DEFAULT_DPAPI_OPS,
): Credentials {
  const { dpapi_secrets: dpapiSecrets, ...rest } = creds;
  if (!dpapiSecrets) {
    if (hasDpapiPlaceholder(rest.workspaces)) {
      throw new Error(
        `Windows credentials contain DPAPI placeholders but no encrypted envelope. ${recoveryHint()}`,
      );
    }
    return rest;
  }

  let bag: DpapiSecretBag | null = null;
  let decryptError: unknown;
  try {
    const decrypted = ops.unprotect(Buffer.from(dpapiSecrets, "base64"));
    bag = parseDpapiSecretBag(decrypted);
  } catch (err) {
    decryptError = err;
  }

  if (!bag) {
    if (hasDpapiPlaceholder(rest.workspaces)) {
      throw new Error(`Failed to decrypt Windows DPAPI credentials. ${recoveryHint()}`, {
        cause: decryptError,
      });
    }
    return rest;
  }

  const workspaces = rest.workspaces.map((w) => {
    const url = normalizeUrl(w.workspace_url);
    if (w.auth.auth_type === "browser") {
      const xoxc = w.auth.xoxc_token === DPAPI_PLACEHOLDER ? bag.xoxc[url] : w.auth.xoxc_token;
      const xoxd =
        w.auth.xoxd_cookie === DPAPI_PLACEHOLDER
          ? (bag.xoxd_by_workspace[url] ?? bag.xoxd)
          : w.auth.xoxd_cookie;
      return {
        ...w,
        auth: {
          auth_type: "browser" as const,
          xoxc_token: xoxc ?? w.auth.xoxc_token,
          xoxd_cookie: xoxd ?? w.auth.xoxd_cookie,
        },
      };
    }
    if (w.auth.auth_type === "standard") {
      const token = w.auth.token === DPAPI_PLACEHOLDER ? bag.token[url] : w.auth.token;
      return {
        ...w,
        auth: {
          auth_type: "standard" as const,
          token: token ?? w.auth.token,
        },
      };
    }
    return w;
  });

  if (hasDpapiPlaceholder(workspaces)) {
    throw new Error(
      `Windows DPAPI envelope is missing one or more workspace secrets. ${recoveryHint()}`,
    );
  }

  return { ...rest, workspaces };
}

export function sealWindowsDpapiCredentials(
  payload: Credentials,
  options?: { ops?: DpapiStoreOps; requireEncryption?: boolean },
): Credentials {
  const ops = options?.ops ?? DEFAULT_DPAPI_OPS;
  const requireEncryption = options?.requireEncryption ?? false;
  const { dpapi_secrets: _existing, ...clean } = payload;

  if (hasDpapiPlaceholder(clean.workspaces)) {
    throw new Error(
      "Refusing to save credentials containing unhydrated Windows DPAPI placeholders.",
    );
  }

  const bag: DpapiSecretBag = { xoxd_by_workspace: {}, xoxc: {}, token: {} };
  let hasSecret = false;

  for (const w of clean.workspaces) {
    const url = normalizeUrl(w.workspace_url);
    if (w.auth.auth_type === "browser") {
      if (!isPlaceholder(w.auth.xoxc_token)) {
        bag.xoxc[url] = w.auth.xoxc_token;
        hasSecret = true;
      }
      if (!isPlaceholder(w.auth.xoxd_cookie)) {
        bag.xoxd_by_workspace[url] = w.auth.xoxd_cookie;
        hasSecret = true;
      }
    } else if (w.auth.auth_type === "standard") {
      if (!isPlaceholder(w.auth.token)) {
        bag.token[url] = w.auth.token;
        hasSecret = true;
      }
    }
  }

  if (!hasSecret) {
    return clean;
  }

  try {
    const encrypted = ops.protect(Buffer.from(JSON.stringify(bag), "utf8"));
    const sealedWorkspaces = clean.workspaces.map((w) => {
      const url = normalizeUrl(w.workspace_url);
      if (w.auth.auth_type === "browser") {
        return {
          ...w,
          auth: {
            auth_type: "browser" as const,
            xoxc_token: bag.xoxc[url] ? DPAPI_PLACEHOLDER : w.auth.xoxc_token,
            xoxd_cookie: bag.xoxd_by_workspace[url] ? DPAPI_PLACEHOLDER : w.auth.xoxd_cookie,
          },
        };
      }
      if (w.auth.auth_type === "standard") {
        return {
          ...w,
          auth: {
            auth_type: "standard" as const,
            token: bag.token[url] ? DPAPI_PLACEHOLDER : w.auth.token,
          },
        };
      }
      return w;
    });

    return {
      ...clean,
      dpapi_secrets: encrypted.toString("base64"),
      workspaces: sealedWorkspaces,
    };
  } catch (err) {
    if (requireEncryption) {
      throw new Error(
        "Windows DPAPI encryption failed while saving previously encrypted credentials; refusing to downgrade to plaintext.",
        { cause: err },
      );
    }
    process.stderr.write(
      `Warning: Windows DPAPI encryption unavailable (${err instanceof Error ? err.message : String(err)}); saving credentials in plaintext.\n`,
    );
    return clean;
  }
}
