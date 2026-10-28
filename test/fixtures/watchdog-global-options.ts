import { strict as assert } from "node:assert";
import { Command } from "commander";

process.argv = [process.execPath, "agent-slack"];
Command.prototype.parse = function () {
  if (process.env.TEST_VALUE_OPTION === "1") {
    this.option("--fixture-value <value>");
  }
  assert(this.options.some((option) => option.long === "--safe-mode"));
  const valueOptions = this.options.filter((option) => option.required || option.optional);
  assert.deepEqual(
    valueOptions.map((option) => option.flags),
    [],
  );
  return this;
};
Command.prototype.outputHelp = function () {};
await import("../../src/index.ts");
