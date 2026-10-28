import { describe, expect, test } from "bun:test";
import { request, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { openDraftEditor } from "../src/cli/draft-server";

async function startEditor() {
  const sent: string[] = [];
  let opened: (url: URL) => void = () => {};
  const address = new Promise<URL>((resolve) => {
    opened = resolve;
  });
  const result = openDraftEditor(
    {
      channelName: "private-channel-for-test",
      initialText: "private-draft-for-test",
      onSend: async (text) => {
        sent.push(text);
        return { ts: "123.456" };
      },
    },
    (url) => opened(new URL(url)),
  );
  return { url: await address, sent, result };
}

function call(
  url: URL,
  options: { path: string; method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number | undefined; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: url.port,
        path: options.path,
        method: options.method,
        headers: options.headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

async function stopEditor(editor: Awaited<ReturnType<typeof startEditor>>) {
  try {
    await call(editor.url, {
      path: "/cancel",
      method: "POST",
      headers: { "X-Draft-Token": editor.url.searchParams.get("t") ?? "" },
    });
  } catch {}
  await editor.result;
}

describe("draft editor session", () => {
  test("rejects malformed request targets without interrupting the editor", async () => {
    const editor = await startEditor();
    try {
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(Number(editor.url.port), "127.0.0.1", () => {
          socket.write("GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        });
        socket.setTimeout(1000, () => socket.destroy(new Error("Request timed out")));
        socket.on("data", (data) => {
          resolve(data.toString());
          socket.destroy();
        });
        socket.on("error", reject);
      });
      expect(response).toStartWith("HTTP/1.1 400 ");
      const page = await call(editor.url, { path: editor.url.pathname + editor.url.search });
      expect(page.status).toBe(200);
    } finally {
      await stopEditor(editor);
    }
  });

  test("protects the editor and send endpoint", async () => {
    const editor = await startEditor();
    const token = editor.url.searchParams.get("t");
    expect(token).toBeTruthy();
    if (!token) {
      throw new Error("Missing session token");
    }
    const { origin } = editor.url;
    const evilOrigin = `http://evil.example:${editor.url.port}`;
    try {
      for (const path of ["/", "/?t=wrong"]) {
        const response = await call(editor.url, { path });
        expect(response.status).toBe(403);
        expect(response.body).not.toContain("private-channel-for-test");
        expect(response.body).not.toContain("private-draft-for-test");
        expect(response.body).not.toContain("sessionToken");
      }
      const page = await call(editor.url, { path: editor.url.pathname + editor.url.search });
      expect(page.status).toBe(200);
      expect(page.headers["referrer-policy"]).toBe("no-referrer");
      expect(page.body).toContain("private-channel-for-test");
      expect(page.body).toContain(token);

      const denied: Record<string, string>[] = [
        {},
        { "X-Draft-Token": "x".repeat(token.length) },
        { "X-Draft-Token": token, Origin: "http://evil.example" },
        { Host: `evil.example:${editor.url.port}`, Origin: evilOrigin },
        { Host: `evil.example:${editor.url.port}`, Origin: evilOrigin, "X-Draft-Token": token },
      ];
      for (const headers of denied) {
        const response = await call(editor.url, {
          path: "/send",
          method: "POST",
          headers,
          body: JSON.stringify({ text: "must not send" }),
        });
        expect(response.status).toBe(403);
        expect(editor.sent).toEqual([]);
      }
      const response = await call(editor.url, {
        path: "/send",
        method: "POST",
        headers: { Origin: origin, "X-Draft-Token": token },
        body: JSON.stringify({ text: "hello from the editor" }),
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ ok: true, ts: "123.456" });
      expect(editor.sent).toEqual(["hello from the editor"]);
      expect(await editor.result).toEqual({ sent: true, text: "hello from the editor" });
    } finally {
      await stopEditor(editor);
    }
  });

  test("protects the cancel endpoint", async () => {
    const editor = await startEditor();
    const token = editor.url.searchParams.get("t");
    expect(token).toBeTruthy();
    if (!token) {
      throw new Error("Missing session token");
    }
    const evilOrigin = `http://evil.example:${editor.url.port}`;
    try {
      const denied: Record<string, string>[] = [
        {},
        { "X-Draft-Token": "x".repeat(token.length) },
        { "X-Draft-Token": token, Origin: "http://evil.example" },
        { Host: `evil.example:${editor.url.port}`, Origin: evilOrigin },
        { Host: `evil.example:${editor.url.port}`, Origin: evilOrigin, "X-Draft-Token": token },
      ];
      for (const headers of denied) {
        const response = await call(editor.url, {
          path: "/cancel",
          method: "POST",
          headers,
        });
        expect(response.status).toBe(403);
        expect(editor.sent).toEqual([]);
      }
      const response = await call(editor.url, {
        path: "/cancel",
        method: "POST",
        headers: { Origin: editor.url.origin, "X-Draft-Token": token },
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ ok: true });
      expect(await editor.result).toEqual({ cancelled: true });
      expect(editor.sent).toEqual([]);
    } finally {
      await stopEditor(editor);
    }
  });

  test.each(["send", "cancel"])(
    "accepts %s without an Origin when the token matches",
    async (action) => {
      const editor = await startEditor();
      try {
        const token = editor.url.searchParams.get("t");
        if (!token) {
          throw new Error("Missing session token");
        }
        const response = await call(editor.url, {
          path: `/${action}`,
          method: "POST",
          headers: { "X-Draft-Token": token },
          body: action === "send" ? JSON.stringify({ text: "without origin" }) : undefined,
        });
        expect(response.status).toBe(200);
        expect(await editor.result).toEqual(
          action === "send" ? { sent: true, text: "without origin" } : { cancelled: true },
        );
        expect(editor.sent).toEqual(action === "send" ? ["without origin"] : []);
      } finally {
        await stopEditor(editor);
      }
    },
  );
});
