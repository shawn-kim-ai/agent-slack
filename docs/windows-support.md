# Windows Support Design

This document captures the architecture, trade-offs, and phased implementation plan for first-class Windows support in `agent-slack`.

## Goals & Principles

- **Fork-first, upstream-clean**: Keep changes modular, well-tested, and clean enough for upstream PRs to `stablyai/agent-slack`.
- **Zero native addons**: Use built-in Node/Bun APIs (`node:crypto`, `bun:sqlite` / `node:sqlite`) and standard Windows OS utilities (`powershell`, `rundll32`) so single-file executables (`bun build --compile`) stay self-contained.
- **Honest platform boundaries**: Support what works reliably without elevated privileges or AV-triggering tricks; give clear guidance where OS security models block extraction.

## Phase 1: Core Bug Fixes & Auth Extraction

### 1.1 Firefox Windows Support & Auth Fallback (`src/auth/firefox-profile.ts`)

- **Problem**: `getFirefoxBaseDir()` unconditionally threw on `win32`, crashing the entire auth fallback chain (`desktop → chrome → brave → firefox`) whenever a workspace selector missed or auto-refresh fell through (upstream issue #184). Additionally, `pickCandidatesByProfile()` and `copySqliteForRead()` split paths on `"/"` instead of using `node:path`'s `basename()`.
- **Design**:
  - Support `win32` in `getFirefoxBaseDir()`: `join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Mozilla", "Firefox")`.
  - Scan `join(baseDir, "Profiles")` on both macOS and Windows (previously macOS used relative `"Profiles"` and Linux scanned `baseDir`).
  - Replace `path.split("/").pop()` with `basename()` so Windows backslash paths work properly.
  - Because Firefox stores `cookies.sqlite` and `storage/default/.../ls/data.sqlite` without OS-level encryption, Windows Firefox extraction works out of the box once paths are fixed.
  - Chrome/Brave on Windows (Chromium 127+) use App-Bound Encryption (`v20`) backed by a SYSTEM-privileged elevation service, so user-space extraction is intentionally not supported; `auth import-chrome` and `auth import-brave` surface clear macOS-only guidance on Windows.

### 1.2 Slack Desktop Extraction & DPAPI Hardening (`src/auth/desktop.ts`, `src/auth/desktop-crypto.ts`, `src/cli/auth-command.ts`)

- **DPAPI without plaintext temp files**:
  - Replace temporary key files in `tmpdir()` with PowerShell stdin/stdout base64 transport (`-NoProfile -NonInteractive`, resolved from `System32`, with `$ErrorActionPreference = 'Stop'` and 10s timeout). Decrypted AES keys never touch disk.
  - Electron `safeStorage` on Windows continues to use DPAPI (`Local State` → `os_crypt.encrypted_key`), so Slack Desktop extraction remains reliable.
- **Locked Cookies DB handling**:
  - When Slack Desktop holds an exclusive lock on `Network/Cookies` (`EBUSY` / `EPERM` / `EACCES`), emit a clear message instructing the user to fully quit Slack (including the system tray icon) or re-run with `--restart-slack`. Copies `-wal`/`-shm`/`-journal` SQLite sidecars alongside `Cookies`.
  - Provide an opt-in `--restart-slack` flag on `agent-slack auth import-desktop` (Windows only): captures the running Slack executable path in the current Windows user session via PowerShell, force-stops Slack (`Stop-Process -Force`), waits up to 5s for exit, extracts credentials, and relaunches Slack in a `finally` block.

### 1.3 Draft Editor Browser Launch (`src/cli/draft-server.ts`)

- **Problem**: `execFile("start", [url])` fails with `ENOENT` on Windows because `start` is a `cmd.exe` built-in, not an executable.
- **Design**: Use `execFile("rundll32", ["url.dll,FileProtocolHandler", url])` on `win32`, which avoids shell parsing and `&` query-string escaping bugs.

### 1.4 Self-Update (`src/lib/update.ts`, `src/index.ts`)

- **Bun detection**: Check both `bun` and `bun.exe` (case-insensitive) in `detectInstallMethod()`.
- **Locked `.exe` replacement**: Windows allows renaming a running `.exe` (`currentBin` → `currentBin.bak`) and copying the new binary into `currentBin`, but removing `.bak` fails with `EPERM`/`EBUSY` until the process exits.
  - On `win32`, treat `rm(backupPath)` failure after `copyFile` as non-fatal instead of rolling back the update.
  - On CLI startup (`src/index.ts`), synchronously remove `${process.execPath}.bak` on `win32` if present (best-effort; ignores lock errors).

## Phase 2: CI & Release Build Stability

- **Windows CI (`.github/workflows/ci.yml`)**: Run build, typecheck, and tests on a `[ubuntu-latest, windows-latest]` matrix (keeping lint/format on Ubuntu to avoid redundant work).
- **Bun version pinning & smoke tests (`.github/workflows/publish.yml`)**:
  - Pin `bun-version` instead of `latest` to prevent compiler regressions (e.g., upstream issue #169 where Bun 1.4.0 produced stock `bun` binaries).
  - Smoke-test compiled release binaries (`--version`) before publishing.
- **Windows ARM64 (`scripts/build-release-assets.sh`)**:
  - Add `bun-windows-arm64` → `agent-slack-windows-arm64.exe` alongside `agent-slack-windows-x64.exe`.

## Phase 3: Native Installer, DPAPI Credential Store & Docs

### 3.1 PowerShell Installer (`install.ps1`)

- Native `irm ... | iex` installer for Windows PowerShell 5.1+ and PowerShell 7+:
  - Detects true CPU architecture (`AMD64` / `ARM64`) via registry (works under x64 emulation on ARM64).
  - Downloads `agent-slack-windows-{x64|arm64}.exe` and verifies SHA-256 against `checksums-sha256.txt`.
  - Installs to `%LOCALAPPDATA%\agent-slack\bin\agent-slack.exe` (overridable via `AGENT_SLACK_INSTALL_DIR`) and registers it in user `HKCU\Environment\Path` with `WM_SETTINGCHANGE` broadcast.

### 3.2 Windows DPAPI Credential Storage (`src/auth/store.ts`, `src/auth/windows-dpapi.ts`)

- **Path**: Keep `~/.config/agent-slack/credentials.json` for cross-platform consistency and backward compatibility.
- **Encryption**: Because NTFS ignores POSIX `0o600`, encrypt workspace secrets on Windows using DPAPI (`ProtectedData::Protect`, `DataProtectionScope::CurrentUser`).
- **Batching for performance**: Encrypt/decrypt all workspace secrets in a **single** DPAPI envelope (`dpapi_secrets` field on `credentials.json`, with `__DPAPI__` placeholders on workspace auth entries) so each CLI invocation spawns PowerShell at most once (~150–250ms) instead of once per workspace/token.
- **Backward compatibility**: Plaintext `credentials.json` files continue to load cleanly and are transparently upgraded on the next write; if DPAPI fails, fall back gracefully to plaintext storage just as macOS falls back when Keychain is unavailable.

### 3.3 Documentation Alignment

- Update `README.md` with Windows installation (`install.ps1` + `npm`) and auth notes (`import-desktop`, `import-firefox`, `--restart-slack`).
- Keep `skills/agent-slack/SKILL.md` concise and aligned per `AGENTS.md`.
