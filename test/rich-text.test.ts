import { describe, expect, test } from "bun:test";
import { createCliContext, type CliContext } from "../src/cli/context.ts";
import { editMessage, sendMessage } from "../src/cli/message-actions.ts";
import { SlackApiClient } from "../src/slack/client.ts";
import { createDraft, listDrafts, updateDraft } from "../src/slack/drafts.ts";
import { renderSlackMessageContent } from "../src/slack/render.ts";
import { parseInlineElements, textToRichTextBlocks } from "../src/slack/rich-text.ts";

describe("parseInlineElements", () => {
  test("plain text returns single text element", () => {
    expect(parseInlineElements("Hello world")).toEqual([{ type: "text", text: "Hello world" }]);
  });

  test("*bold* is parsed with bold style", () => {
    expect(parseInlineElements("Hello *world*!")).toEqual([
      { type: "text", text: "Hello " },
      { type: "text", text: "world", style: { bold: true } },
      { type: "text", text: "!" },
    ]);
  });

  test("_italic_ is parsed with italic style", () => {
    expect(parseInlineElements("This is _important_")).toEqual([
      { type: "text", text: "This is " },
      { type: "text", text: "important", style: { italic: true } },
    ]);
  });

  test("~strike~ is parsed with strike style", () => {
    expect(parseInlineElements("~done~")).toEqual([
      { type: "text", text: "done", style: { strike: true } },
    ]);
  });

  test("`code` is parsed with code style", () => {
    expect(parseInlineElements("Run `npm install`")).toEqual([
      { type: "text", text: "Run " },
      { type: "text", text: "npm install", style: { code: true } },
    ]);
  });

  test("[label](url) CommonMark links are parsed as link elements", () => {
    expect(parseInlineElements("See [PR #42](https://example.com/pull/42) *now*")).toEqual([
      { type: "text", text: "See " },
      { type: "link", url: "https://example.com/pull/42", text: "PR #42" },
      { type: "text", text: " " },
      { type: "text", text: "now", style: { bold: true } },
    ]);
  });

  test("[label](url) with balanced parentheses in the URL keeps the full URL", () => {
    expect(parseInlineElements("See [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) now")).toEqual([
      { type: "text", text: "See " },
      { type: "link", url: "https://en.wikipedia.org/wiki/Foo_(bar)", text: "Foo" },
      { type: "text", text: " now" },
    ]);
  });

  test("[label](url) stays literal inside code and for non-http targets", () => {
    expect(parseInlineElements("`[x](https://example.com)` and [notes](./notes.md)")).toEqual([
      { type: "text", text: "[x](https://example.com)", style: { code: true } },
      { type: "text", text: " and [notes](./notes.md)" },
    ]);
  });

  test("[label](url) with token-breaking URL characters stays literal", () => {
    expect(parseInlineElements("see [x](https://ex.com/a>b)")).toEqual([
      { type: "text", text: "see [x](https://ex.com/a>b)" },
    ]);
    expect(parseInlineElements("see [x](https://ex.com/a|b)")).toEqual([
      { type: "text", text: "see [x](https://ex.com/a|b)" },
    ]);
    expect(parseInlineElements("see [x](https://ex.com/a<b)")).toEqual([
      { type: "text", text: "see [x](https://ex.com/a<b)" },
    ]);
  });

  test("a rejected [label](url) span keeps underscores literal", () => {
    expect(parseInlineElements("see [x](https://ex.com/a_b|c_d)")).toEqual([
      { type: "text", text: "see [x](https://ex.com/a_b|c_d)" },
    ]);
  });

  test("a rejected span with parens, a pipe, and underscores stays literal", () => {
    expect(parseInlineElements("[x](https://ex.com/foo(bar)|my_org/my_repo)")).toEqual([
      { type: "text", text: "[x](https://ex.com/foo(bar)|my_org/my_repo)" },
    ]);
  });

  test("a bare URL keeps underscores literal", () => {
    expect(parseInlineElements("see https://github.com/my_org/my_repo")).toEqual([
      { type: "text", text: "see https://github.com/my_org/my_repo" },
    ]);
  });

  test("formatting next to a literal URL span still parses", () => {
    expect(parseInlineElements("[x](https://ex.com/a>b) and *bold*")).toEqual([
      { type: "text", text: "[x](https://ex.com/a>b) and " },
      { type: "text", text: "bold", style: { bold: true } },
    ]);
  });

  test("[label](url) keeps pipes in the label", () => {
    expect(parseInlineElements("see [a|b](https://example.com)")).toEqual([
      { type: "text", text: "see " },
      { type: "link", url: "https://example.com", text: "a|b" },
    ]);
  });

  test("![alt](url) parses as a literal bang plus a link", () => {
    expect(parseInlineElements("see ![alt](https://example.com/i.png)")).toEqual([
      { type: "text", text: "see !" },
      { type: "link", url: "https://example.com/i.png", text: "alt" },
    ]);
  });

  test(":emoji: shortcode is parsed as an emoji element", () => {
    expect(parseInlineElements("Launch :rocket: now")).toEqual([
      { type: "text", text: "Launch " },
      { type: "emoji", name: "rocket" },
      { type: "text", text: " now" },
    ]);
  });

  test("emoji names with underscores are not parsed as italic text", () => {
    expect(parseInlineElements(":white_check_mark: all clear")).toEqual([
      { type: "emoji", name: "white_check_mark" },
      { type: "text", text: " all clear" },
    ]);
  });

  test("time-like colon text is not parsed as an emoji element", () => {
    expect(parseInlineElements("Time 12:30:00")).toEqual([{ type: "text", text: "Time 12:30:00" }]);
  });

  test("<url|label> is parsed as link with text", () => {
    expect(parseInlineElements("Visit <https://example.com|Example>")).toEqual([
      { type: "text", text: "Visit " },
      { type: "link", url: "https://example.com", text: "Example" },
    ]);
  });

  test("<url> is parsed as link without text", () => {
    expect(parseInlineElements("See <https://example.com>")).toEqual([
      { type: "text", text: "See " },
      { type: "link", url: "https://example.com" },
    ]);
  });

  test("<mailto|label> is parsed as link with text", () => {
    expect(parseInlineElements("Email <mailto:bob@example.com|Bob>")).toEqual([
      { type: "text", text: "Email " },
      { type: "link", url: "mailto:bob@example.com", text: "Bob" },
    ]);
  });

  test("non-url angle bracket text is preserved as text", () => {
    expect(parseInlineElements("Use <fix>")).toEqual([
      { type: "text", text: "Use " },
      { type: "text", text: "<fix>" },
    ]);
  });

  test("non-url labeled angle bracket text is preserved as text", () => {
    expect(parseInlineElements("Use <fix|label>")).toEqual([
      { type: "text", text: "Use " },
      { type: "text", text: "<fix|label>" },
    ]);
  });

  test("channel mention tokens are parsed as channel elements", () => {
    expect(parseInlineElements("See <#C12345678|general>")).toEqual([
      { type: "text", text: "See " },
      { type: "channel", channel_id: "C12345678" },
    ]);
  });

  test("bare channel mention tokens are parsed as channel elements", () => {
    expect(parseInlineElements("See <#C12345678>")).toEqual([
      { type: "text", text: "See " },
      { type: "channel", channel_id: "C12345678" },
    ]);
  });

  test("usergroup mention tokens are parsed as usergroup elements", () => {
    expect(parseInlineElements("Ping <!subteam^S12345678|@team>")).toEqual([
      { type: "text", text: "Ping " },
      { type: "usergroup", usergroup_id: "S12345678" },
    ]);
  });
});

describe("textToRichTextBlocks", () => {
  test("plain text returns null", () => {
    expect(textToRichTextBlocks("Hello world")).toBeNull();
  });

  test("inline-only formatting returns null by default", () => {
    expect(textToRichTextBlocks("Visit <https://example.com|Example>")).toBeNull();
  });

  test("non-url angle bracket text does not trigger rich text blocks", () => {
    expect(textToRichTextBlocks("Use <fix>", { includeInlineFormatting: true })).toBeNull();
    expect(textToRichTextBlocks("Use <fix|label>", { includeInlineFormatting: true })).toBeNull();
  });

  test("mixed non-url angle bracket text and formatting preserves brackets", () => {
    const result = textToRichTextBlocks("Use <fix|label> and *bold*", {
      includeInlineFormatting: true,
    })!;
    expect(result[0]!.elements).toEqual([
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "Use " },
          { type: "text", text: "<fix|label>" },
          { type: "text", text: " and " },
          { type: "text", text: "bold", style: { bold: true } },
          { type: "text", text: "\n" },
        ],
      },
    ]);
  });

  test("inline-only formatting can produce rich text blocks", () => {
    const result = textToRichTextBlocks("Visit <https://example.com|Example>", {
      includeInlineFormatting: true,
    })!;
    expect(result).not.toBeNull();
    expect(result[0]!.elements).toEqual([
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "Visit " },
          { type: "link", url: "https://example.com", text: "Example" },
          { type: "text", text: "\n" },
        ],
      },
    ]);
  });

  test("mailto links can produce rich text blocks when inline formatting is included", () => {
    const result = textToRichTextBlocks("Email <mailto:bob@example.com|Bob>", {
      includeInlineFormatting: true,
    })!;
    expect(result).not.toBeNull();
    expect(result[0]!.elements).toEqual([
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "Email " },
          { type: "link", url: "mailto:bob@example.com", text: "Bob" },
          { type: "text", text: "\n" },
        ],
      },
    ]);
  });

  test("channel mentions can produce rich text blocks when inline formatting is included", () => {
    const result = textToRichTextBlocks("See <#C12345678|general>", {
      includeInlineFormatting: true,
    })!;
    expect(result).not.toBeNull();
    expect(result[0]!.elements).toEqual([
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "See " },
          { type: "channel", channel_id: "C12345678" },
          { type: "text", text: "\n" },
        ],
      },
    ]);
  });

  test("bullet list with - prefix", () => {
    const result = textToRichTextBlocks("- Item 1\n- Item 2\n- Item 3")!;
    expect(result).not.toBeNull();
    const lists = result[0]!.elements.filter((e) => e.type === "rich_text_list");
    expect(lists).toHaveLength(1);
    const list = lists[0]!;
    expect(list.type === "rich_text_list" && list.elements).toHaveLength(3);
  });

  test("bullet list with bullet character", () => {
    expect(textToRichTextBlocks("• Item 1\n• Item 2")).not.toBeNull();
  });

  test("sub-bullets with indentation", () => {
    const result = textToRichTextBlocks("- Main 1\n- Main 2\n  - Sub 2a\n  - Sub 2b\n- Main 3")!;
    expect(result).not.toBeNull();
    const lists = result[0]!.elements.filter((e) => e.type === "rich_text_list");
    expect(lists).toHaveLength(3); // main, sub, main
    expect((lists[1] as { indent?: number }).indent).toBe(1);
  });

  test("sub-bullets nest one level per two spaces", () => {
    const result = textToRichTextBlocks("- A\n  - B\n    - C\n- D")!;
    const lists = result[0]!.elements.filter(
      (e): e is Extract<typeof e, { type: "rich_text_list" }> => e.type === "rich_text_list",
    );
    expect(lists.map((list) => list.indent ?? 0)).toEqual([0, 1, 2, 0]);
  });

  test("white bullet sub-bullets under bullet", () => {
    const result = textToRichTextBlocks("• Top level\n  ◦ Sub-bullet\n  ◦ Another sub")!;
    expect(result).not.toBeNull();
    const lists = result[0]!.elements.filter((e) => e.type === "rich_text_list");
    expect(lists).toHaveLength(2);
    expect((lists[1] as { indent?: number }).indent).toBe(1);
  });

  test("mixed text and bullets", () => {
    const result = textToRichTextBlocks("Here is a list:\n- Item 1\n- Item 2")!;
    expect(result).not.toBeNull();
    expect(result[0]!.elements[0]!.type).toBe("rich_text_section");
    expect(result[0]!.elements[1]!.type).toBe("rich_text_list");
  });

  test("numbered list", () => {
    const result = textToRichTextBlocks("1. First\n2. Second\n3. Third")!;
    expect(result).not.toBeNull();
    const list = result[0]!.elements.find((e) => e.type === "rich_text_list")!;
    expect((list as { style: string }).style).toBe("ordered");
  });

  test("keeps ordered numbering across nested sub-bullets", () => {
    const result = textToRichTextBlocks(
      "Intro line\n\n1. Point one?\n   • sub a\n   • sub b\n2. Point two?\n   - sub c",
    )!;
    const lists = result[0]!.elements.filter((e) => e.type === "rich_text_list");
    expect(lists).toEqual([
      {
        type: "rich_text_list",
        style: "ordered",
        elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "Point one?" }] }],
      },
      {
        type: "rich_text_list",
        style: "bullet",
        indent: 1,
        elements: [
          { type: "rich_text_section", elements: [{ type: "text", text: "sub a" }] },
          { type: "rich_text_section", elements: [{ type: "text", text: "sub b" }] },
        ],
      },
      {
        type: "rich_text_list",
        style: "ordered",
        offset: 1,
        elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "Point two?" }] }],
      },
      {
        type: "rich_text_list",
        style: "bullet",
        indent: 1,
        elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "sub c" }] }],
      },
    ]);
  });

  test("nests a third list level with indent 2", () => {
    const result = textToRichTextBlocks("1. top\n  - mid\n    - deep\n2. top2")!;
    const lists = result[0]!.elements.filter(
      (e): e is Extract<typeof e, { type: "rich_text_list" }> => e.type === "rich_text_list",
    );
    expect(lists.map((l) => [l.style, l.indent ?? 0, l.offset ?? 0])).toEqual([
      ["ordered", 0, 0],
      ["bullet", 1, 0],
      ["bullet", 2, 0],
      ["ordered", 0, 1],
    ]);
  });

  test("nests depths 0 through 6 and clamps deeper indentation at 6", () => {
    const input = [
      "- d0",
      "  - d1",
      "    - d2",
      "      - d3",
      "        - d4",
      "          - d5",
      "            - d6",
      "              1. d7",
      "                - d8",
    ].join("\n");
    const result = textToRichTextBlocks(input)!;
    const lists = result[0]!.elements.filter(
      (e): e is Extract<typeof e, { type: "rich_text_list" }> => e.type === "rich_text_list",
    );
    expect(lists.map((l) => [l.style, l.indent ?? 0, l.elements.length])).toEqual([
      ["bullet", 0, 1],
      ["bullet", 1, 1],
      ["bullet", 2, 1],
      ["bullet", 3, 1],
      ["bullet", 4, 1],
      ["bullet", 5, 1],
      ["bullet", 6, 1],
      ["ordered", 6, 1],
      ["bullet", 6, 1],
    ]);
  });

  test("computes two-space nesting relative to baseIndent and floors odd spaces", () => {
    const result = textToRichTextBlocks("  1. base\n     - plus3\n       1. plus5\n  2. base2")!;
    const lists = result[0]!.elements.filter(
      (e): e is Extract<typeof e, { type: "rich_text_list" }> => e.type === "rich_text_list",
    );
    expect(lists.map((l) => [l.style, l.indent ?? 0, l.offset ?? 0])).toEqual([
      ["ordered", 0, 0],
      ["bullet", 1, 0],
      ["ordered", 2, 0],
      ["ordered", 0, 1],
    ]);
  });

  test("flat ordered lists do not add an offset", () => {
    const result = textToRichTextBlocks("1. First\n2. Second\n3. Third")!;
    expect(result[0]!.elements).toEqual([
      {
        type: "rich_text_list",
        style: "ordered",
        elements: [
          { type: "rich_text_section", elements: [{ type: "text", text: "First" }] },
          { type: "rich_text_section", elements: [{ type: "text", text: "Second" }] },
          { type: "rich_text_section", elements: [{ type: "text", text: "Third" }] },
        ],
      },
    ]);
  });

  test("ordered lists restart after an intervening paragraph", () => {
    const result = textToRichTextBlocks("1. First\nParagraph\n1. Restart")!;
    const lists = result[0]!.elements.filter((e) => e.type === "rich_text_list");
    expect(lists).toEqual([
      {
        type: "rich_text_list",
        style: "ordered",
        elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "First" }] }],
      },
      {
        type: "rich_text_list",
        style: "ordered",
        elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "Restart" }] }],
      },
    ]);
  });

  test("uses the number the author wrote", () => {
    const offsets = (text: string) =>
      textToRichTextBlocks(text)![0]!
        .elements.filter(
          (e) => e.type === "rich_text_list" && (e as { style: string }).style === "ordered",
        )
        .map((l) => (l as { offset?: number }).offset);
    expect(offsets("1. a\n2. b\n\n1. c")).toEqual([undefined, undefined]);
    // A "1." after a blank line is read as a restart, like the base behavior.
    expect(offsets("1. A\n\n1. B\n\n1. C")).toEqual([undefined, undefined, undefined]);
    expect(offsets("1. A\n\n2. B\n\n3. C")).toEqual([undefined, 1, 2]);
    expect(offsets("3. a\n   - x\n4. b")).toEqual([2, 3]);
    expect(offsets("1. a\n   - x\n1. b")).toEqual([undefined, 1]);
    expect(offsets("1. a\n- b\n1. c")).toEqual([undefined, undefined]);
    expect(offsets("1. A\n\n   1. sub\n\n2. B")).toEqual([undefined, undefined, 1]);
    expect(offsets("1. First\n   - detail\n\n2. Second")).toEqual([undefined, 1]);
    expect(offsets("- Parent one\n  1. One\n  2. Two\n- Parent two\n  1. One")).toEqual([
      undefined,
      undefined,
    ]);
  });

  test("handles lazy 1., offset 3, 9/10/11 transitions, and mixed styles across depths", () => {
    const lazyNested = textToRichTextBlocks("1. top1\n  1. mid1\n    - deep\n  1. mid2\n1. top2")!;
    const lazyLists = lazyNested[0]!.elements.filter(
      (e): e is Extract<typeof e, { type: "rich_text_list" }> => e.type === "rich_text_list",
    );
    expect(lazyLists.map((l) => [l.style, l.indent ?? 0, l.offset ?? 0])).toEqual([
      ["ordered", 0, 0],
      ["ordered", 1, 0],
      ["bullet", 2, 0],
      ["ordered", 1, 1],
      ["ordered", 0, 1],
    ]);

    const offsetThree = textToRichTextBlocks(
      "4. fourth\n  4. nested4\n    - deep\n  5. nested5\n5. fifth",
    )!;
    const offsetThreeLists = offsetThree[0]!.elements.filter(
      (e): e is Extract<typeof e, { type: "rich_text_list" }> => e.type === "rich_text_list",
    );
    expect(offsetThreeLists.map((l) => [l.style, l.indent ?? 0, l.offset ?? 0])).toEqual([
      ["ordered", 0, 3],
      ["ordered", 1, 3],
      ["bullet", 2, 0],
      ["ordered", 1, 4],
      ["ordered", 0, 4],
    ]);

    const multiDigit = textToRichTextBlocks(
      "9. nine\n  - sub9\n    1. deep1\n10. ten\n  * sub10\n11. eleven",
    )!;
    const multiDigitLists = multiDigit[0]!.elements.filter(
      (e): e is Extract<typeof e, { type: "rich_text_list" }> => e.type === "rich_text_list",
    );
    expect(multiDigitLists.map((l) => [l.style, l.indent ?? 0, l.offset ?? 0])).toEqual([
      ["ordered", 0, 8],
      ["bullet", 1, 0],
      ["ordered", 2, 0],
      ["ordered", 0, 9],
      ["bullet", 1, 0],
      ["ordered", 0, 10],
    ]);
  });

  test("parses blank-separated list runs into distinct list blocks for both styles", () => {
    const bulletRuns = textToRichTextBlocks("- first\n  - nested\n\n- second")!;
    const bulletLists = bulletRuns[0]!.elements.filter(
      (e): e is Extract<typeof e, { type: "rich_text_list" }> => e.type === "rich_text_list",
    );
    expect(bulletLists.map((l) => [l.style, l.indent ?? 0, l.offset ?? 0])).toEqual([
      ["bullet", 0, 0],
      ["bullet", 1, 0],
      ["bullet", 0, 0],
    ]);

    const orderedRestartRuns = textToRichTextBlocks("1. first\n  - nested\n\n1. restart")!;
    const orderedRestartLists = orderedRestartRuns[0]!.elements.filter(
      (e): e is Extract<typeof e, { type: "rich_text_list" }> => e.type === "rich_text_list",
    );
    expect(orderedRestartLists.map((l) => [l.style, l.indent ?? 0, l.offset ?? 0])).toEqual([
      ["ordered", 0, 0],
      ["bullet", 1, 0],
      ["ordered", 0, 0],
    ]);

    const orderedContinuedRuns = textToRichTextBlocks("1. first\n  - nested\n\n2. second")!;
    const orderedContinuedLists = orderedContinuedRuns[0]!.elements.filter(
      (e): e is Extract<typeof e, { type: "rich_text_list" }> => e.type === "rich_text_list",
    );
    expect(orderedContinuedLists.map((l) => [l.style, l.indent ?? 0, l.offset ?? 0])).toEqual([
      ["ordered", 0, 0],
      ["bullet", 1, 0],
      ["ordered", 0, 1],
    ]);
  });

  test("resets ordered list counts across paragraph, code block, and blockquote controls", () => {
    const input = [
      "1. alpha",
      "  - sub",
      "    - deep",
      "Paragraph break",
      "1. after-para",
      "  1. nested-one",
      "```",
      "const x = 1;",
      "```",
      "1. after-code",
      "> quoted control",
      "1. after-quote",
    ].join("\n");
    const result = textToRichTextBlocks(input)!;
    expect(result[0]!.elements.map((e) => e.type)).toEqual([
      "rich_text_list",
      "rich_text_list",
      "rich_text_list",
      "rich_text_section",
      "rich_text_list",
      "rich_text_list",
      "rich_text_preformatted",
      "rich_text_list",
      "rich_text_quote",
      "rich_text_list",
    ]);
    const orderedLists = result[0]!.elements.filter(
      (e): e is Extract<typeof e, { type: "rich_text_list" }> =>
        e.type === "rich_text_list" && e.style === "ordered",
    );
    expect(orderedLists.map((l) => [l.indent ?? 0, l.offset ?? 0])).toEqual([
      [0, 0],
      [0, 0],
      [1, 0],
      [0, 0],
      [0, 0],
    ]);
  });

  test("sends identical deeper list semantics through sendMessage, editMessage, and drafts boundaries", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    class StubSlackApiClient extends SlackApiClient {
      constructor() {
        super({ auth_type: "browser", xoxc_token: "xoxc-stub", xoxd_cookie: "xoxd-stub" });
      }
      override async api(
        method: string,
        params: Record<string, unknown> = {},
      ): Promise<Record<string, unknown>> {
        calls.push({ method, params });
        if (method === "chat.postMessage") {
          return { ok: true, channel: String(params.channel), ts: "1770165109.628379" };
        }
        if (method === "drafts.create") {
          return { ok: true, draft: { id: "DrList1", destinations: params.destinations } };
        }
        if (method === "drafts.update") {
          return {
            ok: true,
            draft: { id: String(params.draft_id), destinations: params.destinations },
          };
        }
        if (method === "drafts.list") {
          const lastBlocks = calls.find((c) => c.method === "drafts.update")?.params.blocks;
          return {
            ok: true,
            drafts: [
              {
                id: "DrList1",
                last_updated_ts: "1770165109.6283790",
                destinations: [{ channel_id: "C12345678" }],
                blocks: lastBlocks,
              },
            ],
          };
        }
        return { ok: true };
      }
    }
    const slackClient = new StubSlackApiClient();
    const ctx: CliContext = {
      ...createCliContext(),
      effectiveWorkspaceUrl: (flag?: string) => flag,
      assertWorkspaceSpecifiedForChannelNames: async () => {},
      withAutoRefresh: async <T>(input: {
        workspaceUrl: string | undefined;
        work: () => Promise<T>;
      }) => input.work(),
      getClientForWorkspace: async () => ({
        client: slackClient,
        auth: { auth_type: "standard", token: "xoxb-stub" },
        workspace_url: "https://workspace.slack.com",
      }),
    };

    const text =
      "3. Third\n  - sub a\n    1. deep four\n    2. deep five\n  - sub b\n4. Fourth\n\n1. Restart";
    const expectedBlocks = textToRichTextBlocks(text)!;

    await sendMessage({
      ctx,
      targetInput: "C12345678",
      text,
      options: { workspace: "https://workspace.slack.com" },
    });
    await editMessage({
      ctx,
      targetInput: "C12345678",
      text,
      options: { workspace: "https://workspace.slack.com", ts: "1770165109.628379" },
    });
    await createDraft(slackClient, {
      channelId: "C12345678",
      text,
    });
    await updateDraft(slackClient, {
      draftId: "DrList1",
      clientLastUpdatedTs: "1770165109.628",
      channelId: "C12345678",
      text,
    });
    const listed = await listDrafts(slackClient);

    expect(calls.map((c) => c.method)).toEqual([
      "chat.postMessage",
      "chat.update",
      "drafts.create",
      "drafts.update",
      "drafts.list",
    ]);
    expect(calls[0]?.params.blocks).toEqual(expectedBlocks);
    expect(calls[1]?.params.blocks).toEqual(expectedBlocks);
    expect(calls[2]?.params.blocks).toEqual(expectedBlocks);
    expect(calls[3]?.params.blocks).toEqual(expectedBlocks);
    expect(renderSlackMessageContent({ blocks: calls[0]?.params.blocks })).toBe(text);
    expect(listed.drafts[0]?.text).toBe(text);
  });

  test("bold text in list items is parsed", () => {
    const result = textToRichTextBlocks("- *Bold item*\n- Normal item")!;
    expect(result).not.toBeNull();
    const list = result[0]!.elements.find((e) => e.type === "rich_text_list") as {
      elements: { elements: unknown[] }[];
    };
    expect(list.elements[0]!.elements).toEqual([
      { type: "text", text: "Bold item", style: { bold: true } },
    ]);
  });

  test("emoji and channel references in list items are parsed", () => {
    const result = textToRichTextBlocks(
      "Header:\n- :rocket: launch sequence\n- discuss in <#C0AHR9XAT8B>\n- :white_check_mark: all clear",
    )!;
    expect(result).not.toBeNull();
    const list = result[0]!.elements.find((e) => e.type === "rich_text_list") as {
      elements: { elements: unknown[] }[];
    };
    expect(list.elements[0]!.elements).toEqual([
      { type: "emoji", name: "rocket" },
      { type: "text", text: " launch sequence" },
    ]);
    expect(list.elements[1]!.elements).toEqual([
      { type: "text", text: "discuss in " },
      { type: "channel", channel_id: "C0AHR9XAT8B" },
    ]);
    expect(list.elements[2]!.elements).toEqual([
      { type: "emoji", name: "white_check_mark" },
      { type: "text", text: " all clear" },
    ]);
  });

  test("Slack manual links and CommonMark links both become link elements in list items", () => {
    const result = textToRichTextBlocks(
      "- Review <https://example.com/pull/42|PR #42>\n- Review [PR #43](https://example.com/pull/43)",
    )!;
    const list = result[0]!.elements.find((e) => e.type === "rich_text_list") as {
      elements: { elements: unknown[] }[];
    };
    expect(list.elements[0]!.elements).toEqual([
      { type: "text", text: "Review " },
      { type: "link", url: "https://example.com/pull/42", text: "PR #42" },
    ]);
    expect(list.elements[1]!.elements).toEqual([
      { type: "text", text: "Review " },
      { type: "link", url: "https://example.com/pull/43", text: "PR #43" },
    ]);
  });

  test("code block is preserved", () => {
    const result = textToRichTextBlocks("- Item\n```\ncode here\n```")!;
    expect(result).not.toBeNull();
    expect(result[0]!.elements.find((e) => e.type === "rich_text_preformatted")).toBeDefined();
  });

  test("blockquote is preserved", () => {
    const result = textToRichTextBlocks("- Item\n> quoted text")!;
    expect(result).not.toBeNull();
    expect(result[0]!.elements.find((e) => e.type === "rich_text_quote")).toBeDefined();
  });

  test("one-line fenced code keeps its content", () => {
    const result = textToRichTextBlocks("```hello```", { includeInlineFormatting: true })!;
    expect(result[0]!.elements).toEqual([
      { type: "rich_text_preformatted", elements: [{ type: "text", text: "hello" }] },
    ]);
  });

  test("one-line fenced code does not swallow the next line", () => {
    const result = textToRichTextBlocks("```hello```\nnext line", {
      includeInlineFormatting: true,
    })!;
    expect(result[0]!.elements).toEqual([
      { type: "rich_text_preformatted", elements: [{ type: "text", text: "hello" }] },
      { type: "rich_text_section", elements: [{ type: "text", text: "next line\n" }] },
    ]);
  });

  test("text after a one-line fence stays inline text", () => {
    const result = textToRichTextBlocks("```hello``` - tail", { includeInlineFormatting: true })!;
    expect(result[0]!.elements).toEqual([
      { type: "rich_text_preformatted", elements: [{ type: "text", text: "hello" }] },
      { type: "rich_text_section", elements: [{ type: "text", text: "- tail\n" }] },
    ]);
  });

  test("an existing Slack link with a CommonMark-looking label keeps its label", () => {
    expect(parseInlineElements("see <https://example.com|[label](https://other.example)>")).toEqual(
      [
        { type: "text", text: "see " },
        { type: "link", url: "https://example.com", text: "[label](https://other.example)" },
      ],
    );
  });
});
