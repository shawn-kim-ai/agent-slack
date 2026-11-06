const ORDERED_RE = /^(\s*)\d+[.)]\s+(.*)$/;
const BULLET_RE = /^(\s*)[•◦▪▫▸‣●○◆◇\-*]\s+(.*)$/;
const MAX_SAMPLED_DEPTH = 6;
const MAX_CANONICAL_DEPTH = 3;

export type ListEvent =
  | { kind: "ordered"; depth: number; num: number; text: string }
  | { kind: "bullet"; depth: number; text: string }
  | { kind: "para"; text: string };

export type CanonicalListTrace = {
  input: string;
  expected: ListEvent[];
};

export const SAMPLED_LIST_SEEDS = [
  0x101, 0x202, 0x303, 0x404, 0x505, 0x606, 0x707, 0x808, 0x909, 0xa0a, 0xb0b, 0xc0c, 0xd0d, 0xe0e,
  0xf0f, 0x1010,
] as const;

export const SAMPLED_CASES_PER_SEED = 256;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseListEvents(text: string): ListEvent[] {
  const events: ListEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const ordered = line.match(ORDERED_RE);
    if (ordered) {
      events.push({
        kind: "ordered",
        depth: Math.floor(ordered[1]!.length / 2),
        num: Number.parseInt(line.trim(), 10),
        text: ordered[2]!,
      });
      continue;
    }
    const bullet = line.match(BULLET_RE);
    if (bullet) {
      events.push({ kind: "bullet", depth: Math.floor(bullet[1]!.length / 2), text: bullet[2]! });
      continue;
    }
    events.push({ kind: "para", text: line.trim() });
  }
  return events;
}

export function forEachCanonicalListTrace(visit: (trace: CanonicalListTrace) => void): number {
  let count = 0;

  function step(
    total: number,
    idx: number,
    prevDepth: number,
    prevStyle: "bullet" | "ordered" | null,
    counts: Map<number, number>,
    lines: string[],
    expected: ListEvent[],
  ): void {
    if (idx === total) {
      count++;
      visit({ input: lines.join("\n"), expected: expected.slice() });
      return;
    }

    const maxDepth = idx === 0 ? 0 : Math.min(MAX_CANONICAL_DEPTH, prevDepth + 1);
    for (let depth = 0; depth <= maxDepth; depth++) {
      const blankChoices = idx > 0 && depth === 0 ? [false, true] : [false];
      for (const blankBefore of blankChoices) {
        for (const style of ["bullet", "ordered"] as const) {
          const isNewGroup = idx === 0 || blankBefore || depth !== prevDepth || style !== prevStyle;
          const pad = "  ".repeat(depth);
          const prefix = blankBefore ? "\n" : "";
          const itemText = `n${idx}`;

          if (!isNewGroup) {
            const nextCounts = new Map(counts);
            if (style === "ordered") {
              const num = (nextCounts.get(depth) ?? 0) + 1;
              nextCounts.set(depth, num);
              lines.push(`${prefix}${pad}${num}. ${itemText}`);
              expected.push({ kind: "ordered", depth, num, text: itemText });
            } else {
              lines.push(`${prefix}${pad}- ${itemText}`);
              expected.push({ kind: "bullet", depth, text: itemText });
            }
            step(total, idx + 1, depth, style, nextCounts, lines, expected);
            expected.pop();
            lines.pop();
            continue;
          }

          const baseCounts = new Map(counts);
          for (const level of baseCounts.keys()) {
            if (level > depth) {
              baseCounts.delete(level);
            }
          }

          if (style === "bullet") {
            baseCounts.delete(depth);
            lines.push(`${prefix}${pad}- ${itemText}`);
            expected.push({ kind: "bullet", depth, text: itemText });
            step(total, idx + 1, depth, style, baseCounts, lines, expected);
            expected.pop();
            lines.pop();
            continue;
          }

          const prev = baseCounts.get(depth);
          const starts = prev === undefined ? [1, 3] : blankBefore ? [1, prev + 1] : [prev + 1];
          for (const start of starts) {
            const nextCounts = new Map(baseCounts);
            nextCounts.set(depth, start);
            lines.push(`${prefix}${pad}${start}. ${itemText}`);
            expected.push({ kind: "ordered", depth, num: start, text: itemText });
            step(total, idx + 1, depth, style, nextCounts, lines, expected);
            expected.pop();
            lines.pop();
          }
        }
      }
    }
  }

  for (let total = 1; total <= 6; total++) {
    step(total, 0, 0, null, new Map(), [], []);
  }

  return count;
}

export function generateSampledListCase(rand: () => number): CanonicalListTrace {
  const lines: string[] = [];
  const expected: ListEvent[] = [];
  const counts = new Map<number, number>();
  let items = 0;
  let paras = 0;

  if (rand() < 0.15) {
    const text = `para${paras++}`;
    lines.push(text, "");
    expected.push({ kind: "para", text });
    counts.clear();
  }

  const totalItems = 1 + Math.floor(rand() * 18);
  let prevDepth = -1;
  let prevStyle: "bullet" | "ordered" | null = null;

  for (let i = 0; i < totalItems; i++) {
    let blankBefore = false;
    let afterPara = false;
    if (i > 0 && rand() < 0.2) {
      if (rand() < 0.4) {
        const text = `para${paras++}`;
        lines.push("", text, "");
        expected.push({ kind: "para", text });
        counts.clear();
        prevDepth = -1;
        prevStyle = null;
        afterPara = true;
      } else {
        blankBefore = true;
      }
    }

    let depth: number;
    if (i === 0 || prevDepth === -1 || blankBefore) {
      depth = 0;
    } else {
      const up = Math.min(MAX_SAMPLED_DEPTH, prevDepth + 1);
      const step = rand();
      if (step < 0.45) {
        depth = up;
      } else if (step < 0.75) {
        depth = prevDepth;
      } else {
        depth = Math.floor(rand() * (prevDepth + 1));
      }
    }

    const style: "bullet" | "ordered" =
      i > 0 && prevStyle && !blankBefore && rand() < 0.55
        ? prevStyle
        : rand() < 0.5
          ? "ordered"
          : "bullet";

    const isNewGroup =
      i === 0 || blankBefore || afterPara || depth !== prevDepth || style !== prevStyle;
    const pad = "  ".repeat(depth);
    const prefix = blankBefore ? "\n" : "";
    const itemText = `n${items++}`;

    if (!isNewGroup) {
      if (style === "ordered") {
        const num = (counts.get(depth) ?? 0) + 1;
        counts.set(depth, num);
        lines.push(`${prefix}${pad}${num}. ${itemText}`);
        expected.push({ kind: "ordered", depth, num, text: itemText });
      } else {
        lines.push(`${prefix}${pad}- ${itemText}`);
        expected.push({ kind: "bullet", depth, text: itemText });
      }
    } else {
      for (const level of counts.keys()) {
        if (level > depth) {
          counts.delete(level);
        }
      }
      if (style === "bullet") {
        counts.delete(depth);
        lines.push(`${prefix}${pad}- ${itemText}`);
        expected.push({ kind: "bullet", depth, text: itemText });
      } else {
        const prev = counts.get(depth);
        let num: number;
        if (prev === undefined) {
          num = rand() < 0.5 ? 1 : 3;
        } else if (blankBefore) {
          num = rand() < 0.5 ? 1 : prev + 1;
        } else {
          num = prev + 1;
        }
        counts.set(depth, num);
        lines.push(`${prefix}${pad}${num}. ${itemText}`);
        expected.push({ kind: "ordered", depth, num, text: itemText });
      }
    }

    prevDepth = depth;
    prevStyle = style;
  }

  if (rand() < 0.15) {
    const text = `para${paras++}`;
    lines.push("", text);
    expected.push({ kind: "para", text });
  }

  return { input: lines.join("\n"), expected };
}
