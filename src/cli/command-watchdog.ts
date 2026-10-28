export function shouldStartCommandWatchdog(args: string[], platform = process.platform): boolean {
  const firstPositional = platform === "darwin" ? args.findIndex((arg) => !arg.startsWith("-")) : 0;
  const positional = firstPositional === -1 ? [] : args.slice(firstPositional);
  const [command, subcommand] =
    platform === "darwin" ? positional.filter((arg) => arg !== "--safe-mode") : positional;
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
