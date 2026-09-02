/**
 * The delimited-file reader.
 *
 * The failure this file exists to prevent is silent: a title containing a
 * comma splits into two columns, every later field shifts by one, and an
 * import writes a thousand videos with the channel in the duration column
 * without anything looking wrong.
 */

import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseDelimited } from '@shared/core/csv.js';

describe('detectDelimiter', () => {
  it('finds the common ones', () => {
    expect(detectDelimiter('a,b,c')).toBe(',');
    expect(detectDelimiter('a;b;c')).toBe(';');
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
    expect(detectDelimiter('a|b|c')).toBe('|');
  });

  it('ignores delimiters inside quotes', () => {
    // Excel in a Hebrew locale writes this file; reading it as comma-separated
    // would split the name in two.
    expect(detectDelimiter('"כהן, מיכאל";42;"עוד"')).toBe(';');
  });

  it('falls back to a comma for a single-column file', () => {
    expect(detectDelimiter('title')).toBe(',');
  });
});

describe('parseDelimited', () => {
  it('reads a plain file', () => {
    const table = parseDelimited('id,title\nabc,שלום\ndef,עולם');

    expect(table.headers).toEqual(['id', 'title']);
    expect(table.rows).toEqual([
      { id: 'abc', title: 'שלום' },
      { id: 'def', title: 'עולם' },
    ]);
  });

  it('keeps a comma inside a quoted field', () => {
    const table = parseDelimited('id,title\nabc,"החלפת שמן, צעד אחר צעד"');
    expect(table.rows[0]?.title).toBe('החלפת שמן, צעד אחר צעד');
  });

  it('keeps a line break inside a quoted field', () => {
    const table = parseDelimited('id,description\nabc,"שורה\nשנייה"');
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.description).toBe('שורה\nשנייה');
  });

  it('reads a doubled quote as one literal quote', () => {
    const table = parseDelimited('id,title\nabc,"מבחן ""דרך"" מלא"');
    expect(table.rows[0]?.title).toBe('מבחן "דרך" מלא');
  });

  it('handles both line endings', () => {
    expect(parseDelimited('a,b\r\n1,2\r\n3,4').rows).toHaveLength(2);
    expect(parseDelimited('a,b\n1,2\n3,4').rows).toHaveLength(2);
  });

  it('drops the byte-order mark Excel writes', () => {
    const table = parseDelimited('\uFEFFid,title\nabc,שלום');
    // Without this the first header would be "\uFEFFid" and never map.
    expect(table.headers[0]).toBe('id');
  });

  it('ignores a trailing blank line', () => {
    expect(parseDelimited('a,b\n1,2\n').rows).toHaveLength(1);
  });

  it('names an unnamed column instead of dropping it', () => {
    const table = parseDelimited('id,,title\n1,2,3');
    expect(table.headers[1]).toBe('עמודה 2');
  });

  it('reports a row whose field count does not match the header', () => {
    const table = parseDelimited('a,b,c\n1,2,3\n4,5');
    expect(table.malformedRows).toEqual([3]);
    // Still readable: the missing field is empty rather than the row being lost.
    expect(table.rows[1]).toEqual({ a: '4', b: '5', c: '' });
  });

  it('accepts an explicit delimiter over the detected one', () => {
    const table = parseDelimited('a;b\n1;2', ';');
    expect(table.headers).toEqual(['a', 'b']);
  });

  it('returns nothing useful for an empty file, without throwing', () => {
    const table = parseDelimited('');
    expect(table.headers).toEqual([]);
    expect(table.rows).toEqual([]);
  });
});
