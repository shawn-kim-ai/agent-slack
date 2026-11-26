import { CREDENTIALS_FILE, KEYCHAIN_SERVICE } from "./paths.ts";
import { readJsonFile, writeJsonFile } from "../lib/fs.ts";
import { CredentialsSchema, type Credentials, type Workspace } from "./schema.ts";
import { keychainGet, keychainSet } from "./keychain.ts";
import {
  DPAPI_PLACEHOLDER,
  hydrateWindowsDpapiCredentials,
  sealWindowsDpapiCredentials,
} from "./windows-credential-store.ts";
import { isRecord } from "../lib/object-type-guards.ts";
import { platform } from "node:os";

export {
  hydrateWindowsDpapiCredentials,
  sealWindowsDpapiCredentials,
  type DpapiStoreOps,
} from "./windows-credential-store.ts";

const KEYCHAIN_PLACEHOLDER = "__KEYCHAIN__";
const IS_MACOS = platform() === "darwin";
const IS_WIN32 = platform() === "win32";

let cachedWindowsCredentials: { creds: Credentials; wasSealed: boolean } | null = null;

function normalizeWorkspaceUrl(workspaceUrl: string): string {
  const u = new URL(workspaceUrl);
  return `${u.protocol}//${u.host}`;
}

function isPlaceholderSecret(value: string | undefined): boolean {
  return !value || value === KEYCHAIN_PLACEHOLDER || value === DPAPI_PLACEHOLDER;
}

export async function loadCredentials(): Promise<Credentials> {
  if (IS_WIN32 && cachedWindowsCredentials) {
    return structuredClone(cachedWindowsCredentials.creds);
  }

  const fromFile = await readJsonFile<unknown>(CREDENTIALS_FILE);
  const parsed = CredentialsSchema.safeParse(fromFile ?? { version: 1, workspaces: [] });
  if (!parsed.success) {
    if (IS_WIN32 && isRecord(fromFile) && fromFile.dpapi_secrets !== undefined) {
      throw new Error(
        `Windows credentials file "${CREDENTIALS_FILE}" has a malformed DPAPI envelope; refusing to overwrite it. Delete the file and re-run "agent-slack auth import-desktop".`,
      );
    }
    return { version: 1, workspaces: [] };
  }

  if (IS_WIN32) {
    const wasSealed = Boolean(parsed.data.dpapi_secrets);
    const hydrated = hydrateWindowsDpapiCredentials(parsed.data);
    cachedWindowsCredentials = { creds: structuredClone(hydrated), wasSealed };
    return hydrated;
  }

  const { dpapi_secrets: _dpapi, ...creds } = parsed.data;
  const hydrated = creds.workspaces.map((w) => {
    const url = normalizeWorkspaceUrl(w.workspace_url);
    if (w.auth.auth_type === "browser") {
      const xoxc = keychainGet(`xoxc:${url}`, KEYCHAIN_SERVICE);
      const xoxd = keychainGet("xoxd", KEYCHAIN_SERVICE);
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
      const token = keychainGet(`token:${url}`, KEYCHAIN_SERVICE);
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
    const wasSealed =
      cachedWindowsCredentials?.wasSealed ??
      Boolean(
        CredentialsSchema.safeParse(await readJsonFile<unknown>(CREDENTIALS_FILE)).data
          ?.dpapi_secrets,
      );
    const sealed = sealWindowsDpapiCredentials(structuredClone(payload), {
      requireEncryption: wasSealed,
    });
    await writeJsonFile(CREDENTIALS_FILE, sealed);
    cachedWindowsCredentials = {
      creds: structuredClone(payload),
      wasSealed: Boolean(sealed.dpapi_secrets),
    };
    return;
  }

  const { dpapi_secrets: _dpapi, ...filePayload }: Credentials = structuredClone(payload);

  if (IS_MACOS) {
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
