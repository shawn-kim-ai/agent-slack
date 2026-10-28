import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("keychain integration", () => {
  for (const fixture of ["auto-refresh", "linux-safe-storage"]) {
    test(fixture, () => {
      const temp = mkdtempSync(join(tmpdir(), "agent-slack-test-"));
      try {
        writeFileSync(join(temp, "secret-tool"), "#!/bin/sh\nprintf fixture-password", {
          mode: 0o700,
        });
        const result = spawnSync(
          process.execPath,
          [join(import.meta.dir, "fixtures", `${fixture}.ts`)],
          {
            encoding: "utf8",
            env: { ...process.env, PATH: `${temp}:${process.env.PATH ?? ""}` },
          },
        );
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    });
  }
});
