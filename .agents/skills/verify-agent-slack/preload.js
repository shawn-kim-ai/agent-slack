const fixtureOrigin = "https://fixture.slack.com";
const port = process.env.AGENT_SLACK_FIXTURE_PORT;
if (!port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error("Offline fixture needs a valid loopback port");
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== fixtureOrigin) {
    throw new Error("Offline fixture refused a non-fixture request");
  }
  url.protocol = "http:";
  url.hostname = "127.0.0.1";
  url.port = port;
  const request = input instanceof Request ? new Request(url, input) : url;
  return originalFetch(request, { ...init, redirect: "error" });
};
