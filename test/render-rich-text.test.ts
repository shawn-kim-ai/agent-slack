import { describe, expect, test } from "bun:test";
import { renderSlackMessageContent } from "../src/slack/render.ts";
import { extractMrkdwnFromRichTextBlock } from "../src/slack/render-rich-text.ts";
import { textToRichTextBlocks } from "../src/slack/rich-text.ts";
import {
  SAMPLED_CASES_PER_SEED,
  SAMPLED_LIST_SEEDS,
  forEachCanonicalListTrace,
  generateSampledListCase,
  mulberry32,
  parseListEvents,
} from "./helpers/list-roundtrip.ts";

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

  test("keeps the blank separator before a restarted ordered list", () => {
    const text = "1. First\n  - Detail\n\n1. Restart";
    const rendered = extractMrkdwnFromRichTextBlock(textToRichTextBlocks(text)![0]);
    expect(rendered).toBe(text);
    const renderedAgain = extractMrkdwnFromRichTextBlock(textToRichTextBlocks(rendered)![0]);
    expect(renderedAgain).toBe(text);
  });

  test("preserves a third list level", () => {
    const text = "1. top\n  - mid\n    - deep\n2. top2";
    const blocks = textToRichTextBlocks(text)!;
    expect(extractMrkdwnFromRichTextBlock(blocks[0])).toBe(text);
  });

  test("preserves nested ordered numbering at depth 2", () => {
    const text = "1. A\n  1. a1\n    1. x\n    2. y\n  2. a2\n2. B";
    const blocks = textToRichTextBlocks(text)!;
    expect(extractMrkdwnFromRichTextBlock(blocks[0])).toBe(text);
  });

  test("preserves lazy 1., offset 3, 9/10/11, mixed styles, clamped depths, and controls", () => {
    const lazyInput = "1. First\n  1. sub one\n    - deep\n  1. sub two\n1. Second";
    const lazyExpected = "1. First\n  1. sub one\n    - deep\n  2. sub two\n2. Second";
    expect(renderSlackMessageContent({ blocks: textToRichTextBlocks(lazyInput)! })).toBe(
      lazyExpected,
    );

    const offsetThree = "4. Fourth\n  4. nested four\n    - deep\n  5. nested five\n5. Fifth";
    expect(renderSlackMessageContent({ blocks: textToRichTextBlocks(offsetThree)! })).toBe(
      offsetThree,
    );

    const nineTenEleven = "9. Ninth\n  - sub 9\n    1. deep 9\n10. Tenth\n  - sub 10\n11. Eleventh";
    expect(renderSlackMessageContent({ blocks: textToRichTextBlocks(nineTenEleven)! })).toBe(
      nineTenEleven,
    );

    const clampedInput = [
      "- d0",
      "  - d1",
      "    - d2",
      "      - d3",
      "        - d4",
      "          - d5",
      "            - d6",
      "              - d7",
      "                - d8",
    ].join("\n");
    const clampedExpected = [
      "- d0",
      "  - d1",
      "    - d2",
      "      - d3",
      "        - d4",
      "          - d5",
      "            - d6",
      "            - d7",
      "            - d8",
    ].join("\n");
    expect(renderSlackMessageContent({ blocks: textToRichTextBlocks(clampedInput)! })).toBe(
      clampedExpected,
    );

    const controlsInput = [
      "1. one",
      "  - nested",
      "    - deeper",
      "Paragraph control",
      "1. after-para",
      "```",
      "code()",
      "```",
      "1. after-code",
      "> quote control",
      "1. after-quote",
    ].join("\n");
    const controlsExpected = [
      "1. one",
      "  - nested",
      "    - deeper",
      "",
      "Paragraph control",
      "",
      "",
      "1. after-para",
      "",
      "```code()```",
      "",
      "1. after-code",
      "",
      "> quote control",
      "",
      "1. after-quote",
    ].join("\n");
    expect(renderSlackMessageContent({ blocks: textToRichTextBlocks(controlsInput)! })).toBe(
      controlsExpected,
    );
  });

  test("preserves list events across all 235,914 canonical structural traces (1..6 items, depth 0..3)", () => {
    const failures: {
      input: string;
      rendered: string;
      reparsed: string;
      expected: unknown;
      actual: unknown;
    }[] = [];

    const totalTraces = forEachCanonicalListTrace(({ input, expected }) => {
      if (failures.length >= 3) {
        return;
      }
      const blocks = textToRichTextBlocks(input);
      if (!blocks) {
        failures.push({
          input,
          rendered: "(null blocks)",
          reparsed: "(null blocks)",
          expected,
          actual: [],
        });
        return;
      }
      const rendered = extractMrkdwnFromRichTextBlock(blocks[0]);
      const actual = parseListEvents(rendered);
      const reparsedBlocks = textToRichTextBlocks(rendered);
      const reparsed = reparsedBlocks
        ? extractMrkdwnFromRichTextBlock(reparsedBlocks[0])
        : "(null reparsed)";
      const reparsedEvents = parseListEvents(reparsed);
      if (!listEventsEqual(actual, expected) || !listEventsEqual(reparsedEvents, expected)) {
        failures.push({ input, rendered, reparsed, expected, actual: reparsedEvents });
      }
    });

    expect(totalTraces).toBe(235_914);
    expect(failures).toEqual([]);
  });

  test("preserves list events across 16 fixed seeds x 256 sampled cases (up to 18 items, depth 0..6, not exhaustive)", () => {
    expect(SAMPLED_LIST_SEEDS).toHaveLength(16);
    expect(SAMPLED_CASES_PER_SEED).toBe(256);

    const failures: {
      seed: number;
      caseIdx: number;
      input: string;
      rendered: string;
      reparsed: string;
    }[] = [];
    let totalSampled = 0;
    let maxDepthObserved = 0;
    let maxItemsObserved = 0;

    for (const seed of SAMPLED_LIST_SEEDS) {
      const rand = mulberry32(seed);
      for (let caseIdx = 0; caseIdx < SAMPLED_CASES_PER_SEED; caseIdx++) {
        totalSampled++;
        const { input, expected } = generateSampledListCase(rand);
        const listItems = expected.filter((e) => e.kind !== "para");
        if (listItems.length > maxItemsObserved) {
          maxItemsObserved = listItems.length;
        }
        for (const item of listItems) {
          if (item.depth > maxDepthObserved) {
            maxDepthObserved = item.depth;
          }
        }
        if (failures.length >= 3) {
          continue;
        }
        const blocks = textToRichTextBlocks(input);
        if (!blocks) {
          failures.push({
            seed,
            caseIdx,
            input,
            rendered: "(null blocks)",
            reparsed: "(null blocks)",
          });
          continue;
        }
        const rendered = renderSlackMessageContent({ blocks });
        const actual = parseListEvents(rendered);
        const reparsedBlocks = textToRichTextBlocks(rendered);
        const reparsed = reparsedBlocks
          ? renderSlackMessageContent({ blocks: reparsedBlocks })
          : "(null reparsed)";
        const reparsedEvents = parseListEvents(reparsed);
        if (!listEventsEqual(actual, expected) || !listEventsEqual(reparsedEvents, expected)) {
          failures.push({ seed, caseIdx, input, rendered, reparsed });
        }
      }
    }

    expect(totalSampled).toBe(4_096);
    expect(maxDepthObserved).toBe(6);
    expect(maxItemsObserved).toBe(18);
    expect(failures).toEqual([]);
  });
});

function listEventsEqual(
  a: ReturnType<typeof parseListEvents>,
  b: ReturnType<typeof parseListEvents>,
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (left.kind !== right.kind || left.text !== right.text) {
      return false;
    }
    if (left.kind === "ordered" && right.kind === "ordered") {
      if (left.depth !== right.depth || left.num !== right.num) {
        return false;
      }
    } else if (left.kind === "bullet" && right.kind === "bullet") {
      if (left.depth !== right.depth) {
        return false;
      }
    }
  }
  return true;
}
