import { describe, expect, test } from "bun:test";
import { formatOutboundSlackText } from "../src/slack/format-outbound.ts";

describe("formatOutboundSlackText", () => {
  test("promotes bare user IDs to Slack mention tokens", () => {
    expect(formatOutboundSlackText("@U05BRPTKL6A heads up")).toBe("<@U05BRPTKL6A> heads up");
    expect(formatOutboundSlackText("cc @W123456A and @BABCDEFG")).toBe(
      "cc <@W123456A> and <@BABCDEFG>",
    );
  });

  test("leaves already-formatted mention tokens alone", () => {
    expect(formatOutboundSlackText("hi <@U123456A>!")).toBe("hi <@U123456A>!");
    expect(formatOutboundSlackText("hi <@U123456A|nick>!")).toBe("hi <@U123456A|nick>!");
  });

  test("leaves already-formatted usergroup mention tokens alone", () => {
    expect(formatOutboundSlackText("ping <!subteam^S12345678|@team>")).toBe(
      "ping <!subteam^S12345678|@team>",
    );
    expect(formatOutboundSlackText("ping <!subteam^S12345678>")).toBe("ping <!subteam^S12345678>");
  });

  test("promotes broadcast mentions", () => {
    expect(formatOutboundSlackText("@here ping")).toBe("<!here> ping");
    expect(formatOutboundSlackText("cc @channel and @everyone")).toBe(
      "cc <!channel> and <!everyone>",
    );
  });

  test("rewrites CommonMark links as Slack manual links", () => {
    expect(formatOutboundSlackText("see [PR #42](https://example.com/pull/42)")).toBe(
      "see <https://example.com/pull/42|PR #42>",
    );
    expect(formatOutboundSlackText("mail [Bob](mailto:bob@example.com)")).toBe(
      "mail <mailto:bob@example.com|Bob>",
    );
    expect(formatOutboundSlackText("[a <b> & c](https://example.com)")).toBe(
      "<https://example.com|a &lt;b&gt; &amp; c>",
    );
  });

  test("preserves balanced parentheses inside a CommonMark link URL", () => {
    expect(formatOutboundSlackText("See [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) now")).toBe(
      "See <https://en.wikipedia.org/wiki/Foo_(bar)|Foo> now",
    );
  });

  test("leaves CommonMark links with token-breaking URL characters alone", () => {
    expect(formatOutboundSlackText("see [x](https://ex.com/a>b)")).toBe(
      "see [x](https://ex.com/a&gt;b)",
    );
    expect(formatOutboundSlackText("see [x](https://ex.com/a|b)")).toBe(
      "see [x](https://ex.com/a|b)",
    );
    expect(formatOutboundSlackText("see [x](https://ex.com/a<b)")).toBe(
      "see [x](https://ex.com/a&lt;b)",
    );
  });

  test("keeps pipes in CommonMark link labels", () => {
    expect(formatOutboundSlackText("see [a|b](https://example.com)")).toBe(
      "see <https://example.com|a|b>",
    );
  });

  test("converts image-like CommonMark to a link after the bang", () => {
    expect(formatOutboundSlackText("see ![alt](https://example.com/i.png)")).toBe(
      "see !<https://example.com/i.png|alt>",
    );
  });

  test("leaves CommonMark link syntax in code and non-http targets alone", () => {
    expect(formatOutboundSlackText("run `[x](https://example.com)`")).toBe(
      "run `[x](https://example.com)`",
    );
    expect(formatOutboundSlackText("```\n[x](https://example.com)\n```")).toBe(
      "```\n[x](https://example.com)\n```",
    );
    expect(formatOutboundSlackText("see [notes](./notes.md)")).toBe("see [notes](./notes.md)");
  });

  test("escapes bare < > & in literal text", () => {
    expect(formatOutboundSlackText("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  });

  test("does not escape inside already-formatted Slack tokens", () => {
    expect(formatOutboundSlackText("see <https://example.com|link>")).toBe(
      "see <https://example.com|link>",
    );
    expect(formatOutboundSlackText("mail <mailto:bob@example.com|Bob>")).toBe(
      "mail <mailto:bob@example.com|Bob>",
    );
    expect(formatOutboundSlackText("see <https://a.test/?x=1&y=2>")).toBe(
      "see <https://a.test/?x=1&y=2>",
    );
  });

  test("does not promote email-like or mid-word @", () => {
    expect(formatOutboundSlackText("mail me at user@Udomain.com")).toBe(
      "mail me at user@Udomain.com",
    );
  });

  test("handles empty input", () => {
    expect(formatOutboundSlackText("")).toBe("");
  });

  test("leaves an existing Slack link with a CommonMark-looking label alone", () => {
    expect(
      formatOutboundSlackText("see <https://example.com|[label](https://other.example)>"),
    ).toBe("see <https://example.com|[label](https://other.example)>");
  });

  test("restores a Slack token nested in a rewritten CommonMark label", () => {
    expect(formatOutboundSlackText("[ping <@U12345678>](https://example.com)")).toBe(
      "<https://example.com|ping <@U12345678>>",
    );
  });

  test("real-world CI dump stays readable with mention + URL", () => {
    const input =
      '@U05BRPTKL6A heads up: CI "Install dependencies" is failing: https://github.com/x/y/actions/runs/1 & it needs <fix>';
    expect(formatOutboundSlackText(input)).toBe(
      '<@U05BRPTKL6A> heads up: CI "Install dependencies" is failing: https://github.com/x/y/actions/runs/1 &amp; it needs &lt;fix&gt;',
    );
  });
});
