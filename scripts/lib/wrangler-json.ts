/**
 * Reading JSON out of a `wrangler --json` run.
 *
 * Split out of `scripts/ci-database.ts` so it can be tested against wrangler's
 * real output without importing a module whose top level deploys a database.
 */

/**
 * A CSI escape sequence: ESC, `[`, parameters, a final letter.
 *
 * The ESC is written as `\u001b` rather than pasted in, so the line survives
 * an editor that strips control characters — and it is part of the pattern on
 * purpose: matching `[33m` alone would also match a `[` belonging to the data,
 * a database named `[beta]` say, and delete it before the parse.
 */
// eslint-disable-next-line no-control-regex -- an escape sequence is precisely what this matches
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/gu;

/**
 * The JSON array in a `--json` run's output, or `null` when there is none.
 *
 * `--json` still prints wrangler's banner and any warnings first, so the
 * payload has to be found rather than parsed from character zero. The obvious
 * way to find it — slice from the first `[` — is wrong, and quietly so: a
 * coloured warning line starts `[33m`, which means the first `[` in the
 * output is usually *inside an escape sequence*, several lines above the data.
 * Colour survives a pipe here (this is not a TTY and wrangler colours anyway),
 * so this is the normal case, not the exotic one.
 *
 * Stripping the escapes first removes the decoys; trying each remaining `[` in
 * turn removes the need to guess which one opens the payload.
 */
export function jsonPayload(out: string): unknown {
  const plain = out.replaceAll(ANSI, '');

  for (let at = plain.indexOf('['); at >= 0; at = plain.indexOf('[', at + 1)) {
    const end = balancedEnd(plain, at);
    if (end < 0) continue;
    try {
      return JSON.parse(plain.slice(at, end));
    } catch {
      // Balanced brackets that are not JSON — a warning's own punctuation,
      // most likely. Try the next opening bracket.
    }
  }
  return null;
}

/**
 * The index just past the `]` that closes the `[` at `from`, or `-1`.
 *
 * Taking everything to the end of the output instead would work only while
 * nothing is printed after the payload, which is not a promise wrangler has
 * made. Counting brackets is a few lines and does not depend on that.
 */
export function balancedEnd(text: string, from: number): number {
  let depth = 0;
  let inString = false;

  for (let at = from; at < text.length; at++) {
    const character = text[at];

    if (inString) {
      // A backslash escapes the next character, so a `\"` does not end the
      // string and a `\\` does not escape the quote after it.
      if (character === '\\') at++;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === '[' || character === '{') depth++;
    else if (character === ']' || character === '}') {
      depth--;
      if (depth === 0) return at + 1;
    }
  }
  return -1;
}
