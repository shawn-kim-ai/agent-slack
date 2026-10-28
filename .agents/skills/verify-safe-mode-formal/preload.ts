const stubUrl = process.env.VERIFY_SAFE_MODE_STUB_URL;
if (!stubUrl) {
  throw new Error("verify-safe-mode-formal preload needs VERIFY_SAFE_MODE_STUB_URL");
}

const FIXTURE_HOST = "fixture.slack.com";
const stub = new URL(stubUrl);
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (input instanceof Request) {
    throw new Error(
      `verify-safe-mode-formal: refusing Request-object fetch to ${input.url}; the stub only rewrites URL strings`,
    );
  }
  const raw = typeof input === "string" ? input : input.href;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return realFetch(input, init);
  }
  if (host !== FIXTURE_HOST) {
    throw new Error(
      `verify-safe-mode-formal: refusing fetch to ${raw}; only ${FIXTURE_HOST} is routed to the stub`,
    );
  }
  const target = new URL(raw);
  target.protocol = stub.protocol;
  target.host = stub.host;
  return realFetch(target.href, init);
}) as typeof fetch;
