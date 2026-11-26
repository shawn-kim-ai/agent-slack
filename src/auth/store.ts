import { CREDENTIALS_FILE, KEYCHAIN_SERVICE } from "./paths.ts";
import { readJsonFile, writeJsonFile } from "../lib/fs.ts";
import { CredentialsSchema, type Credentials, type Workspace } from "./schema.ts";
import { keychainGet, keychainSet } from "./keychain.ts";
import { dpapiProtect, dpapiUnprotect } from "./windows-dpapi.ts";
import { isRecord } from "../lib/object-type-guards.ts";
import { platform } from "node:os";

const KEYCHAIN_PLACEHOLDER = "__KEYCHAIN__";
const DPAPI_PLACEHOLDER = "__DPAPI__";
const IS_MACOS = platform() === "darwin";
const IS_WIN32 = platform() === "win32";

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
  xoxc: Record<string, string>;
  token: Record<string, string>;
};

function normalizeWorkspaceUrl(workspaceUrl: string): string {
  const u = new URL(workspaceUrl);
  return `${u.protocol}//${u.host}`;
}

function isPlaceholderSecret(value: string | undefined): boolean {
  return !value || value === KEYCHAIN_PLACEHOLDER || value === DPAPI_PLACEHOLDER;
}

function parseDpapiSecretBag(raw: Buffer): DpapiSecretBag | null {
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (!isRecord(parsed)) {
      return null;
    }
    const xoxd = typeof parsed.xoxd === "string" ? parsed.xoxd : undefined;
    const xoxc: Record<string, string> = {};
    if (isRecord(parsed.xoxc)) {
      for (const [k, v] of Object.entries(parsed.xoxc)) {
        if (typeof v === "string") {
          xoxc[k] = v;
        }
      }
    }
    const token: Record<string, string> = {};
    if (isRecord(parsed.token)) {
      for (const [k, v] of Object.entries(parsed.token)) {
        if (typeof v === "string") {
          token[k] = v;
        }
      }
    }
    return { xoxd, xoxc, token };
  } catch {
    return null;
  }
}

type SecretLookup = {
  getXoxc: (url: string, current: string) => string | null | undefined;
  getXoxd: (current: string) => string | null | undefined;
  getToken: (url: string, current: string) => string | null | undefined;
};

function hydrateWorkspaces(workspaces: Workspace[], lookup: SecretLookup): Workspace[] {
  return workspaces.map((w) => {
    const url = normalizeWorkspaceUrl(w.workspace_url);
    if (w.auth.auth_type === "browser") {
      return {
        ...w,
        auth: {
          auth_type: "browser" as const,
          xoxc_token: lookup.getXoxc(url, w.auth.xoxc_token) ?? w.auth.xoxc_token,
          xoxd_cookie: lookup.getXoxd(w.auth.xoxd_cookie) ?? w.auth.xoxd_cookie,
        },
      };
    }
    if (w.auth.auth_type === "standard") {
      return {
        ...w,
        auth: {
          auth_type: "standard" as const,
          token: lookup.getToken(url, w.auth.token) ?? w.auth.token,
        },
      };
    }
    return w;
  });
}

export function hydrateWindowsDpapiCredentials(
  creds: Credentials,
  ops: DpapiStoreOps = DEFAULT_DPAPI_OPS,
): Credentials {
  const { dpapi_secrets: dpapiSecrets, ...rest } = creds;
  if (!dpapiSecrets) {
    return rest;
  }

  let bag: DpapiSecretBag | null = null;
  try {
    const decrypted = ops.unprotect(Buffer.from(dpapiSecrets, "base64"));
    bag = parseDpapiSecretBag(decrypted);
  } catch {
    bag = null;
  }

  if (!bag) {
    return rest;
  }

  const workspaces = hydrateWorkspaces(rest.workspaces, {
    getXoxc: (url, current) => (current === DPAPI_PLACEHOLDER ? bag.xoxc[url] : current),
    getXoxd: (current) => (current === DPAPI_PLACEHOLDER ? bag.xoxd : current),
    getToken: (url, current) => (current === DPAPI_PLACEHOLDER ? bag.token[url] : current),
  });

  return { ...rest, workspaces };
}

export function sealWindowsDpapiCredentials(
  payload: Credentials,
  ops: DpapiStoreOps = DEFAULT_DPAPI_OPS,
): Credentials {
  const { dpapi_secrets: _ignored, ...clean } = payload;
  const bag: DpapiSecretBag = { xoxc: {}, token: {} };
  let hasSecret = false;

  for (const w of clean.workspaces) {
    const url = normalizeWorkspaceUrl(w.workspace_url);
    if (w.auth.auth_type === "browser") {
      if (!isPlaceholderSecret(w.auth.xoxc_token)) {
        bag.xoxc[url] = w.auth.xoxc_token;
        hasSecret = true;
      }
      if (!bag.xoxd && !isPlaceholderSecret(w.auth.xoxd_cookie)) {
        bag.xoxd = w.auth.xoxd_cookie;
        hasSecret = true;
      }
    } else if (w.auth.auth_type === "standard") {
      if (!isPlaceholderSecret(w.auth.token)) {
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
      const url = normalizeWorkspaceUrl(w.workspace_url);
      if (w.auth.auth_type === "browser") {
        return {
          ...w,
          auth: {
            auth_type: "browser" as const,
            xoxc_token: bag.xoxc[url] ? DPAPI_PLACEHOLDER : w.auth.xoxc_token,
            xoxd_cookie: bag.xoxd ? DPAPI_PLACEHOLDER : w.auth.xoxd_cookie,
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
  } catch {
    // Fall back to plaintext storage if DPAPI is unavailable.
    return clean;
  }
}

export async function loadCredentials(): Promise<Credentials> {
  const fromFile = await readJsonFile<unknown>(CREDENTIALS_FILE);
  const parsed = CredentialsSchema.safeParse(fromFile ?? { version: 1, workspaces: [] });
  if (!parsed.success) {
    return { version: 1, workspaces: [] };
  }

  if (IS_WIN32) {
    return hydrateWindowsDpapiCredentials(parsed.data);
  }

  // Optional: hydrate browser cookie/token from keychain for security.
  const { dpapi_secrets: _dpapi, ...creds } = parsed.data;
  const hydrated = hydrateWorkspaces(creds.workspaces, {
    getXoxc: (url) => keychainGet(`xoxc:${url}`, KEYCHAIN_SERVICE),
    getXoxd: () => keychainGet("xoxd", KEYCHAIN_SERVICE),
    getToken: (url) => keychainGet(`token:${url}`, KEYCHAIN_SERVICE),
  });

  return { ...creds, workspaces: hydrated };
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  const payload: Credentials = {
    ...credentials,
    updated_at: new Date().toISOString(),
    workspaces: credentials.workspaces.map((w) => ({
      ...w,
      workspace_url: normalizeWorkspaceUrl(w.workspace_url),
    })),
  };

  if (IS_WIN32) {
    const sealed = sealWindowsDpapiCredentials(structuredClone(payload));
    await writeJsonFile(CREDENTIALS_FILE, sealed);
    return;
  }

  // Store secrets in keychain when possible and avoid writing plaintext tokens to disk.
  // If keychain writes fail (or non-macOS), fall back to storing secrets in the file.
  const { dpapi_secrets: _dpapi, ...filePayload }: Credentials = structuredClone(payload);

  if (IS_MACOS) {
    // Browser auth: xoxd is shared across workspaces, xoxc is per-workspace.
    const firstBrowser = payload.workspaces.find((w) => w.auth.auth_type === "browser");
    let xoxdStored = false;
    if (
      firstBrowser?.auth.auth_type === "browser" &&
      !isPlaceholderSecret(firstBrowser.auth.xoxd_cookie)
    ) {
      const existing = keychainGet("xoxd", KEYCHAIN_SERVICE);
      xoxdStored =
        existing === firstBrowser.auth.xoxd_cookie ||
        keychainSet({
          account: "xoxd",
          value: firstBrowser.auth.xoxd_cookie,
          service: KEYCHAIN_SERVICE,
        });
    }

    for (const w of filePayload.workspaces) {
      if (w.auth.auth_type === "browser") {
        const account = `xoxc:${normalizeWorkspaceUrl(w.workspace_url)}`;
        const tokenStored =
          isPlaceholderSecret(w.auth.xoxc_token) ||
          keychainGet(account, KEYCHAIN_SERVICE) === w.auth.xoxc_token ||
          keychainSet({ account, value: w.auth.xoxc_token, service: KEYCHAIN_SERVICE });

        if (tokenStored) {
          w.auth.xoxc_token = KEYCHAIN_PLACEHOLDER;
        }
        if (xoxdStored) {
          w.auth.xoxd_cookie = KEYCHAIN_PLACEHOLDER;
        }
      }

      if (w.auth.auth_type === "standard") {
        const account = `token:${normalizeWorkspaceUrl(w.workspace_url)}`;
        const tokenStored =
          isPlaceholderSecret(w.auth.token) ||
          keychainGet(account, KEYCHAIN_SERVICE) === w.auth.token ||
          keychainSet({ account, value: w.auth.token, service: KEYCHAIN_SERVICE });
        if (tokenStored) {
          w.auth.token = KEYCHAIN_PLACEHOLDER;
        }
      }
    }
  }

  await writeJsonFile(CREDENTIALS_FILE, filePayload);
}

export async function upsertWorkspace(workspace: Workspace): Promise<Workspace> {
  const creds = await loadCredentials();
  const normalizedUrl = normalizeWorkspaceUrl(workspace.workspace_url);
  const next: Workspace = { ...workspace, workspace_url: normalizedUrl };

  const idx = creds.workspaces.findIndex(
    (w) => normalizeWorkspaceUrl(w.workspace_url) === normalizedUrl,
  );
  if (idx === -1) {
    creds.workspaces.push(next);
  } else {
    creds.workspaces[idx] = {
      ...creds.workspaces[idx],
      ...next,
      auth: next.auth,
    };
  }

  if (!creds.default_workspace_url) {
    creds.default_workspace_url = normalizedUrl;
  }
  await saveCredentials(creds);
  return next;
}

export async function upsertWorkspaces(workspaces: Workspace[]): Promise<void> {
  if (workspaces.length === 0) {
    return;
  }
  const creds = await loadCredentials();

  for (const workspace of workspaces) {
    const normalizedUrl = normalizeWorkspaceUrl(workspace.workspace_url);
    const next: Workspace = { ...workspace, workspace_url: normalizedUrl };

    const idx = creds.workspaces.findIndex(
      (w) => normalizeWorkspaceUrl(w.workspace_url) === normalizedUrl,
    );
    if (idx === -1) {
      creds.workspaces.push(next);
    } else {
      creds.workspaces[idx] = {
        ...creds.workspaces[idx],
        ...next,
        auth: next.auth,
      };
    }

    if (!creds.default_workspace_url) {
      creds.default_workspace_url = normalizedUrl;
    }
  }

  await saveCredentials(creds);
}

export async function setDefaultWorkspace(workspaceUrl: string): Promise<void> {
  const creds = await loadCredentials();
  creds.default_workspace_url = normalizeWorkspaceUrl(workspaceUrl);
  await saveCredentials(creds);
}

export async function removeWorkspace(workspaceUrl: string): Promise<void> {
  const creds = await loadCredentials();
  const normalized = normalizeWorkspaceUrl(workspaceUrl);
  creds.workspaces = creds.workspaces.filter(
    (w) => normalizeWorkspaceUrl(w.workspace_url) !== normalized,
  );
  if (creds.default_workspace_url === normalized) {
    creds.default_workspace_url = creds.workspaces[0]?.workspace_url;
  }
  await saveCredentials(creds);
}

export async function resolveWorkspaceForUrl(workspaceUrl: string): Promise<Workspace | null> {
  const creds = await loadCredentials();
  const normalized = normalizeWorkspaceUrl(workspaceUrl);
  return (
    creds.workspaces.find((w) => normalizeWorkspaceUrl(w.workspace_url) === normalized) ?? null
  );
}

export async function resolveDefaultWorkspace(): Promise<Workspace | null> {
  const creds = await loadCredentials();
  if (creds.default_workspace_url) {
    const byDefault = creds.workspaces.find((w) => w.workspace_url === creds.default_workspace_url);
    if (byDefault) {
      return byDefault;
    }
  }
  return creds.workspaces[0] ?? null;
}

// (reserved for future non-secret per-workspace metadata)
