/**
 * One CommonMark `[label](url)` link, shared by the `text` formatter and the
 * rich_text parser so both paths agree on what counts as a link.
 *
 * Capture groups: 1 = label, 2 = url. Keep that order: both call sites read
 * the groups positionally.
 *
 * The URL must start with `http(s)://` or `mailto:`, may hold one level of
 * balanced parentheses, and must not contain `<`, `>`, `|` or whitespace:
 * those characters cannot survive inside a `<url|label>` token, so a URL
 * holding them stays literal text instead of converting to a broken token.
 */
export const COMMONMARK_LINK_SOURCE = String.raw`\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)(?:\([^()\s<>|]*\)|[^()\s<>|])*)\)`;
