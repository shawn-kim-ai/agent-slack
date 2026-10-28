import { describe, expect, test } from "bun:test";
import { shouldStartCommandWatchdog } from "../src/cli/command-watchdog.ts";

describe("shouldStartCommandWatchdog", () => {
  test("guards regular commands", () => {
    expect(shouldStartCommandWatchdog(["message", "send", "#general", "hi"])).toBe(true);
    expect(
      shouldStartCommandWatchdog(["--safe-mode", "message", "send", "#general", "hi"], "darwin"),
    ).toBe(true);
  });

  test("skips commands that wait on the user", () => {
    expect(shouldStartCommandWatchdog([])).toBe(false);
    expect(shouldStartCommandWatchdog(["update"])).toBe(false);
    expect(shouldStartCommandWatchdog(["message", "draft", "#general"])).toBe(false);
    expect(shouldStartCommandWatchdog(["auth", "import-desktop"], "darwin")).toBe(false);
    expect(shouldStartCommandWatchdog(["auth", "import-brave"], "darwin")).toBe(false);
  });

  test("ignores global flags before the command", () => {
    expect(shouldStartCommandWatchdog(["--safe-mode", "auth", "import-desktop"], "darwin")).toBe(
      false,
    );
    expect(shouldStartCommandWatchdog(["--safe-mode", "auth", "import-brave"], "darwin")).toBe(
      false,
    );
    expect(
      shouldStartCommandWatchdog(["--safe-mode", "message", "draft", "#general"], "darwin"),
    ).toBe(false);
  });

  test("keeps the watchdog on for imports outside macOS", () => {
    for (const platform of ["linux", "win32"] as const) {
      expect(shouldStartCommandWatchdog(["auth", "import-desktop"], platform)).toBe(true);
      expect(shouldStartCommandWatchdog(["auth", "import-brave"], platform)).toBe(true);
      expect(shouldStartCommandWatchdog(["--safe-mode", "auth", "import-desktop"], platform)).toBe(
        true,
      );
    }
  });
});
