import { describe, expect, test } from "bun:test";
import { renderSlackMessageContent } from "../src/slack/render.ts";
import { extractMrkdwnFromRichTextBlock } from "../src/slack/render-rich-text.ts";
import { textToRichTextBlocks } from "../src/slack/rich-text.ts";
import { generateListCase, mulberry32, parseListEvents } from "./helpers/list-roundtrip.ts";

describe("extractMrkdwnFromRichTextBlock", () => {
  test("continues ordered numbering from the list offset", () => {
    const block = {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_list",
          style: "ordered",
          offset: 2,
          elements: [
            { type: "rich_text_section", elements: [{ type: "text", text: "Third" }] },
            { type: "rich_text_section", elements: [{ type: "text", text: "Fourth" }] },
          ],
        },
      ],
    };
    expect(extractMrkdwnFromRichTextBlock(block)).toBe("3. Third\n4. Fourth");
  });

  test("indents nested bullet lists", () => {
    const block = {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_list",
          style: "bullet",
          indent: 1,
          elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "Detail" }] }],
        },
      ],
    };
    expect(extractMrkdwnFromRichTextBlock(block)).toBe("  - Detail");
  });

  test("round-trips ordered numbering and nested indentation", () => {
    const text = "1. First\n  - Detail\n2. Second";
    const blocks = textToRichTextBlocks(text)!;
    expect(extractMrkdwnFromRichTextBlock(blocks[0])).toBe(text);
  });

  test("round-trips a third list level", () => {
    const text = "1. top\n  - mid\n    - deep\n2. top2";
    const blocks = textToRichTextBlocks(text)!;
    expect(extractMrkdwnFromRichTextBlock(blocks[0])).toBe(text);
  });

  test("round-trips nested ordered numbering at depth 2", () => {
    const text = "1. A\n  1. a1\n    1. x\n    2. y\n  2. a2\n2. B";
    const blocks = textToRichTextBlocks(text)!;
    expect(extractMrkdwnFromRichTextBlock(blocks[0])).toBe(text);
  });

  test("round-trips generated lists through renderSlackMessageContent", () => {
    const failures: { seed: number; input: string; rendered: string }[] = [];
    for (let seed = 0; seed < 300; seed++) {
      const input = generateListCase(mulberry32(1000 + seed));
      const blocks = textToRichTextBlocks(input);
      if (!blocks) {
        failures.push({ seed, input, rendered: "(null blocks)" });
        continue;
      }
      const rendered = renderSlackMessageContent({ blocks });
      if (JSON.stringify(parseListEvents(input)) !== JSON.stringify(parseListEvents(rendered))) {
        failures.push({ seed, input, rendered });
      }
      if (failures.length >= 3) {
        break;
      }
    }
    expect(failures).toEqual([]);
  });
});
