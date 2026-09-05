import { describe, expect, it } from 'vitest';
import { balancedEnd, jsonPayload } from '../../scripts/lib/wrangler-json.js';

/**
 * Verbatim from `wrangler d1 execute … --json`, escapes and all.
 *
 * The escapes are the entire reason this module exists: the first `[` in this
 * string is not the payload's, it is the one in `\u001b[33m` on the warning
 * line, twelve lines earlier. Anything that finds the payload by looking for
 * the first bracket parses that instead and reports "no rows" for a database
 * that answered perfectly well.
 */
const REAL_OUTPUT =
  '\u001b[33m▲ \u001b[43;33m[\u001b[43;30mWARNING\u001b[43;33m]\u001b[0m ' +
  "\u001b[1mProxy environment variables detected. We'll use your proxy for fetch requests.\u001b[0m\n" +
  '\n\n[\n  {\n    "results": [\n      {\n        "n": 7876\n      }\n    ],\n' +
  '    "success": true,\n    "meta": {\n      "duration": 1\n    }\n  }\n]\n';

describe('jsonPayload', () => {
  it('finds the payload past a coloured warning', () => {
    expect(jsonPayload(REAL_OUTPUT)).toEqual([
      { results: [{ n: 7876 }], success: true, meta: { duration: 1 } },
    ]);
  });

  it('reads a zero as a zero rather than as an absence', () => {
    // The distinction the caller is built on: an empty table asks to be
    // filled, an unreadable answer does not.
    const zero = REAL_OUTPUT.replace('7876', '0');
    expect(jsonPayload(zero)).toEqual([
      { results: [{ n: 0 }], success: true, meta: { duration: 1 } },
    ]);
  });

  it('ignores brackets that belong to prose', () => {
    const noisy = 'Note [see the docs] before running.\n[{"uuid":"a","name":"car-tiv"}]\n';
    expect(jsonPayload(noisy)).toEqual([{ uuid: 'a', name: 'car-tiv' }]);
  });

  it('stops at the closing bracket, so trailing output is harmless', () => {
    const trailing = '[{"n":1}]\n\u001b[32m✔ Done\u001b[0m\nTotal: 1\n';
    expect(jsonPayload(trailing)).toEqual([{ n: 1 }]);
  });

  it('is not fooled by a bracket inside a string', () => {
    const tricky = '[{"name":"car-tiv [beta]","note":"a \\" quote"}]';
    expect(jsonPayload(tricky)).toEqual([{ name: 'car-tiv [beta]', note: 'a " quote' }]);
  });

  it('keeps a bracket that is part of the data', () => {
    // The ESC is required by the pattern, so `[beta]` survives stripping.
    expect(jsonPayload('[{"name":"[beta]"}]')).toEqual([{ name: '[beta]' }]);
  });

  it('returns null when there is no JSON at all', () => {
    expect(jsonPayload('✘ [ERROR] Authentication error [code: 10000]\n')).toBeNull();
  });

  it('returns null for an unterminated array', () => {
    expect(jsonPayload('[{"n":1}')).toBeNull();
  });
});

describe('balancedEnd', () => {
  it('returns the index past the closing bracket', () => {
    const text = '[1, 2]tail';
    expect(balancedEnd(text, 0)).toBe(6);
    expect(text.slice(0, balancedEnd(text, 0))).toBe('[1, 2]');
  });

  it('counts nesting rather than stopping at the first close', () => {
    expect(balancedEnd('[[1], [2]]', 0)).toBe(10);
  });

  it('does not count brackets inside strings', () => {
    expect(balancedEnd('["]"]', 0)).toBe(5);
  });

  it('treats a backslash as escaping the next character', () => {
    // `"\\"` is a string holding one backslash; the `]` after it closes the
    // array. A scanner that mistook the second quote for an escaped one would
    // run to the end and report -1.
    expect(balancedEnd('["\\\\"]', 0)).toBe(6);
  });

  it('reports -1 when nothing closes it', () => {
    expect(balancedEnd('[1, 2', 0)).toBe(-1);
  });
});
