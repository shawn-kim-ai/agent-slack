import { afterEach, describe, expect, mock, test } from "bun:test";
import { SlackApiClient } from "../src/slack/client.ts";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  delete process.env.AGENT_SLACK_RATE_LIMIT_MAX_WAIT_MS;
});

function browserAuth() {
  return {
    auth_type: "browser" as const,
    xoxc_token: "xoxc-test",
    xoxd_cookie: "xoxd-test",
  };
}

type ObservedRequest = { url: string; cookie: string | null };

function redirectHonoringFetch(observed: ObservedRequest[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const cookie = new Headers(init?.headers).get("cookie");
    observed.push({ url, cookie });
    if (url.startsWith("https://workspace.slack.com/api/")) {
      if (init?.redirect === "error") {
        throw new TypeError('Refusing redirect when redirect mode is "error"');
      }
      observed.push({ url: "https://collector.example/steal", cookie });
    }
    return new Response(JSON.stringify({ ok: true }));
  }) as unknown as typeof fetch;
}

describe("SlackApiClient credential destinations", () => {
  test("rejects unsafe workspace origins before browser credentials can be sent", () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ ok: true })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(
      () => new SlackApiClient(browserAuth(), { workspaceUrl: "https://collector.example" }),
    ).toThrow("canonical HTTPS Slack workspace origin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("revalidates immediately before both browser transports", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ ok: true })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new SlackApiClient(browserAuth(), {
      workspaceUrl: "https://workspace.slack.com",
    });

    (client as unknown as { workspaceUrl: string }).workspaceUrl = "https://collector.example";

    await expect(client.api("auth.test")).rejects.toThrow("canonical HTTPS Slack workspace origin");
    await expect(client.apiMultipart("files.createCanvas")).rejects.toThrow(
      "canonical HTTPS Slack workspace origin",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a redirect response is never followed with browser credentials", async () => {
    const observed: { url: string; cookie: string | null }[] = [];
    globalThis.fetch = redirectHonoringFetch(observed);
    const client = new SlackApiClient(browserAuth(), {
      workspaceUrl: "https://workspace.slack.com",
    });

    await expect(client.api("auth.test")).rejects.toThrow(TypeError);
    await expect(client.apiMultipart("files.createCanvas")).rejects.toThrow(TypeError);

    expect(observed.map((request) => request.url)).not.toContain("https://collector.example/steal");
    for (const request of observed) {
      expect(request.url.startsWith("https://workspace.slack.com/api/")).toBe(true);
    }
  });

  test("a redirect-following fetch would deliver the cookie to the redirect target", async () => {
    const observed: { url: string; cookie: string | null }[] = [];
    globalThis.fetch = redirectHonoringFetch(observed);

    await fetch("https://workspace.slack.com/api/auth.test", {
      method: "POST",
      headers: { Cookie: `d=${encodeURIComponent("xoxd-test")}` },
      redirect: "follow",
    });

    expect(
      observed.find((request) => request.url === "https://collector.example/steal")?.cookie,
    ).toContain("xoxd-test");
  });

  test("rejects redirects for both browser transports", async () => {
    const fetchMock = mock(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new SlackApiClient(browserAuth(), {
      workspaceUrl: "https://workspace.slack.com",
    });

    await expect(client.api("auth.test")).resolves.toEqual({ ok: true });
    await expect(client.apiMultipart("files.createCanvas")).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.redirect).toBe("error");
    }
  });
});

describe("SlackApiClient browser multipart transport", () => {
  test("retries HTTP 429 responses using Retry-After", async () => {
    // Fail-fast defaults to 0ms; opt in to waiting so the retry path runs.
    process.env.AGENT_SLACK_RATE_LIMIT_MAX_WAIT_MS = "30000";
    const responses = [
      new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "2" },
      }),
      new Response(JSON.stringify({ ok: true, file_id: "F12345678" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ];
    const fetchMock = mock(async (_input: string | URL | Request, _init?: RequestInit) => {
      return responses.shift()!;
    });
    const delays: number[] = [];
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    globalThis.setTimeout = ((callback: () => void, delay?: number) => {
      delays.push(delay ?? 0);
      callback();
      return 0;
    }) as unknown as typeof setTimeout;

    const client = new SlackApiClient(browserAuth(), {
      workspaceUrl: "https://workspace.slack.com",
    });

    await expect(
      client.apiMultipart("files.createCanvas", {
        title: "Launch plan",
        markdown: "# Launch plan\n",
      }),
    ).resolves.toEqual({ ok: true, file_id: "F12345678" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([2000]);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.body).toBeInstanceOf(FormData);
      expect(call[1]?.redirect).toBe("error");
    }
  });
});
