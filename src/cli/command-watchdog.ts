export function shouldStartCommandWatchdog(args: string[], platform = process.platform): boolean {
  const firstPositional = platform === "darwin" ? args.findIndex((arg) => !arg.startsWith("-")) : 0;
  const [command, subcommand] = firstPositional === -1 ? [] : args.slice(firstPositional);
  if (!command || command === "update") {
    return false;
  }
  if (command === "message" && subcommand === "draft") {
    return false;
  }
  if (
    platform === "darwin" &&
    command === "auth" &&
    (subcommand === "import-desktop" || subcommand === "import-brave")
  ) {
    return false;
  }
  return true;
}
