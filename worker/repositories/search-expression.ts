/**
 * Building a safe FTS5 `MATCH` expression from visitor input.
 *
 * FTS5 has its own query language: bare input containing `"`, `*`, `NEAR`, `-`
 * or an unbalanced quote is either a syntax error (a 500) or a query that means
 * something the visitor did not ask for. So nothing typed by a visitor is ever
 * passed through: the text is normalised, split into tokens, and each token is
 * re-emitted as a quoted string. The only operator we add ourselves is the
 * trailing `*`, which makes the last word a prefix so results appear while the
 * visitor is still typing.
 */

import { SEARCH } from '@shared/constants.js';
import { tokenize } from '@shared/core/text.js';

/**
 * @param raw       The visitor's query, exactly as typed.
 * @param options   `prefixLastToken` powers as-you-type search; turn it off for
 *                  a submitted search where the last word is complete.
 * @returns A `MATCH` expression, or `null` when there is nothing to search for.
 *
 * @example
 * buildMatchExpression('שמן מנוע')            // '"שמנ" AND "מנוע"*'
 * buildMatchExpression('toyota "corolla*"')   // '"toyota" AND "corolla"*'
 */
export function buildMatchExpression(
  raw: string,
  options: { prefixLastToken?: boolean } = {},
): string | null {
  const tokens = tokenize(raw).slice(0, 12);
  if (tokens.length === 0) return null;

  const prefix = options.prefixLastToken ?? true;

  return tokens
    .map((token, index) => {
      const quoted = `"${token.replace(/"/g, '')}"`;
      const isLast = index === tokens.length - 1;
      return prefix && isLast && token.length >= SEARCH.minQueryLength ? `${quoted}*` : quoted;
    })
    .join(' AND ');
}

/**
 * The same expression, widened with synonyms.
 *
 * Each token becomes `("term" OR "synonym" OR ...)`, so a search for "מזגן"
 * also matches videos that only ever say "מיזוג".
 *
 * @param synonyms  Normalised term -> normalised alternatives.
 */
export function buildMatchExpressionWithSynonyms(
  raw: string,
  synonyms: ReadonlyMap<string, readonly string[]>,
  options: { prefixLastToken?: boolean } = {},
): string | null {
  const tokens = tokenize(raw).slice(0, 12);
  if (tokens.length === 0) return null;

  const prefix = options.prefixLastToken ?? true;

  return tokens
    .map((token, index) => {
      const alternatives = [token, ...(synonyms.get(token) ?? [])].map((value) =>
        value.replace(/"/g, ''),
      );
      const isLast = index === tokens.length - 1;

      if (alternatives.length === 1) {
        const quoted = `"${alternatives[0] ?? ''}"`;
        return prefix && isLast ? `${quoted}*` : quoted;
      }

      // A synonym group is never prefix-matched: expanding "מזגן*" to five
      // prefixed alternatives makes the query both slow and imprecise.
      return `(${alternatives.map((value) => `"${value}"`).join(' OR ')})`;
    })
    .join(' AND ');
}
