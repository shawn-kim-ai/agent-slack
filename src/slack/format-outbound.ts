/**
 * Prepare user-authored text for Slack's `chat.postMessage` / `chat.update`.
 *
 * Slack's mrkdwn contract requires:
 *  - literal `&`, `<`, `>` escaped as `&amp;`, `&lt;`, `&gt;`
 *  - user mentions wrapped as `<@U123>`, channel mentions as `<#C123>`,
 *    usergroup mentions as `<!subteam^S123>`, and broadcast mentions as
 *    `<!here>` / `<!channel>` / `<!everyone>`
 *
 * Humans (and LLMs piping text into the CLI) commonly write `@U123`,
 * CommonMark `[label](url)` links and raw `&`/`<`/`>` — this helper
 * normalizes that to what Slack expects, while leaving already-well-formed
 * Slack tokens intact.
 */
import { COMMONMARK_LINK_SOURCE } from "./markdown-links.ts";

const CODE_OR_LINK_PATTERN = new RegExp(
  ["```[\\s\\S]*?```", "`[^`\\n]+`", COMMONMARK_LINK_SOURCE].join("|"),
  "g",
);

const SLACK_TOKEN_PATTERN =
  /<(?:@[UWB][A-Z0-9]+(?:\|[^>]*)?|#[CG][A-Z0-9]+(?:\|[^>]*)?|!subteam\^[A-Z0-9]+(?:\|[^>]*)?|![a-zA-Z]+(?:\|[^>]*)?|(?:https?:\/\/|mailto:)[^>]+)>/g;

export function formatOutboundSlackText(text: string): string {
  if (!text) {
    return "";
  }

  // Protect already-formatted Slack tokens first, so the CommonMark rewrite
  // below cannot match inside them.
  const stash: string[] = [];
  const stashToken = (m: string): string => {
    stash.push(m);
    return `\u0000${stash.length - 1}\u0000`;
  };
  let out = text.replace(SLACK_TOKEN_PATTERN, stashToken);

  // Rewrite CommonMark links as Slack manual links, leaving code untouched.
  // A placeholder in the URL means the original held a `<...>` token there,
  // which the matcher forbids, so that span stays literal.
  out = out.replace(CODE_OR_LINK_PATTERN, (m, label?: string, url?: string) =>
    label != null && url != null && !url.includes("\u0000") ? `<${url}|${escapeMrkdwn(label)}>` : m,
  );

  // Protect the rewritten tokens so `<`/`>` inside them aren't escaped.
  out = out.replace(SLACK_TOKEN_PATTERN, stashToken);

  // Escape literal HTML-ish characters per Slack's mrkdwn rules.
  out = escapeMrkdwn(out);

  // Promote bare user IDs (`@U05BRPTKL6A`) to real mentions.
  out = out.replace(/(^|[^A-Za-z0-9_])@([UWB][A-Z0-9]{6,})\b/g, (_m, pre, id) => `${pre}<@${id}>`);

  // Promote broadcast mentions.
  out = out.replace(
    /(^|[^A-Za-z0-9_])@(here|channel|everyone)\b/g,
    (_m, pre, name) => `${pre}<!${name}>`,
  );

  // Restore protected tokens twice: a rewritten token can nest a placeholder
  // for a token stashed before the rewrite.
  for (let pass = 0; pass < 2; pass++) {
    out = out.replace(/\u0000(\d+)\u0000/g, (_m, idx) => stash[Number(idx)]!);
  }

  return out;
}

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
