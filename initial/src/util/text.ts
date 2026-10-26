// Line breaks of every kind, other control characters and bidirectional overrides.
const BREAKS_AND_CONTROLS = /[\s\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\u200E\u200F]+/gu;

/**
 * Text from a mail header as one plain line: no line breaks (including U+0085, U+2028, U+2029),
 * control characters or direction overrides, at most max characters. A display name or subject
 * can then never start a new line in a reply, a prompt or a note.
 */
export function headerText(value: string, max = 200): string {
  const one = value.replace(BREAKS_AND_CONTROLS, " ").trim();
  return one.length > max ? `${[...one].slice(0, max).join("").trimEnd()}…` : one;
}
