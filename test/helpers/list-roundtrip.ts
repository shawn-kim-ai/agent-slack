const ORDERED_RE = /^(\s*)\d+[.)]\s+(.*)$/;
const BULLET_RE = /^(\s*)[•◦▪▫▸‣●○◆◇\-*]\s+(.*)$/;

export type ListEvent =
  | { kind: "ordered"; depth: number; num: number; text: string }
  | { kind: "bullet"; depth: number; text: string }
  | { kind: "para"; text: string };

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

export function generateListCase(rand: () => number): string {
  const lines: string[] = [];
  const counts = new Map<number, number>();
  let items = 0;
  let paras = 0;
  if (rand() < 0.15) {
    lines.push(`para${paras++}`, "");
    counts.clear();
  }
  const runs = 1 + Math.floor(rand() * 3);
  for (let run = 0; run < runs; run++) {
    if (run > 0) {
      const sep = rand();
      if (sep < 0.4) {
        lines.push("");
      } else if (sep < 0.6) {
        lines.push("", "");
      } else if (sep < 0.8) {
        lines.push(`para${paras++}`);
        counts.clear();
      } else {
        lines.push("", `para${paras++}`, "");
        counts.clear();
      }
    }
    const total = 1 + Math.floor(rand() * 6);
    let prevDepth = -1;
    let prevStyle: "ordered" | "bullet" | null = null;
    let groupStart = 1;
    let groupPos = 0;
    for (let i = 0; i < total; i++) {
      let depth: number;
      if (i === 0) {
        depth = 0;
      } else {
        const up = Math.min(prevDepth + 1, 2);
        const step = rand();
        if (step < 0.5) {
          depth = prevDepth;
        } else if (step < 0.75) {
          depth = up;
        } else {
          depth = Math.floor(rand() * (prevDepth + 1));
        }
      }
      let style: "ordered" | "bullet";
      if (i > 0 && prevStyle && rand() < 0.6) {
        style = prevStyle;
      } else {
        style = rand() < 0.5 ? "ordered" : "bullet";
      }
      if (prevStyle !== style || prevDepth !== depth) {
        for (const level of counts.keys()) {
          if (level > depth) {
            counts.delete(level);
          }
        }
        if (style === "ordered") {
          const prev = counts.get(depth);
          groupStart = prev === undefined ? 1 + Math.floor(rand() * 4) : prev + 1;
        } else {
          counts.delete(depth);
          groupStart = 1;
        }
        groupPos = 0;
      }
      const num = groupStart + groupPos;
      groupPos++;
      const pad = "  ".repeat(depth);
      lines.push(style === "ordered" ? `${pad}${num}. n${items++}` : `${pad}- n${items++}`);
      if (style === "ordered") {
        counts.set(depth, num);
      }
      prevStyle = style;
      prevDepth = depth;
    }
  }
  if (rand() < 0.15) {
    lines.push("", `para${paras++}`);
  }
  return lines.join("\n");
}
