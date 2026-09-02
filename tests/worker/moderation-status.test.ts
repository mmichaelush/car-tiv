/**
 * The moderation statuses each inbox actually accepts.
 *
 * There was one schema for all four inboxes, accepting the union of the
 * moderation list and the submission list. That union is wider than any of the
 * four tables allows, so marking a report `approved` — or a submission
 * `waiting` — passed validation and was then rejected by SQLite's CHECK
 * constraint. `BaseRepository` turns a driver error into a
 * `ServiceUnavailableError`, so a moderator pressing a button the interface
 * offered them saw "the database is unavailable", and the logs recorded an
 * outage rather than a bad request.
 *
 * The schemas are checked here against the CHECK constraints read out of the
 * live database rather than against a list copied into this file. A test that
 * restated the statuses would pass happily on the day a migration changed one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moderationSchemas } from '@worker/routes/admin-routes.js';
import { createTestDatabase, type TestDatabase } from '../helpers/d1.js';

let db: TestDatabase;

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(() => {
  db.close();
});

/** The statuses a table's own `CHECK (status IN (...))` permits. */
function allowedByTable(table: string): string[] {
  const sql =
    db.queryRaw<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = ?`, table)[0]?.sql ??
    '';

  const clause = /CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)/i.exec(sql)?.[1];
  if (clause == null) throw new Error(`no status CHECK constraint found on ${table}`);

  return [...clause.matchAll(/'([^']*)'/g)]
    .map((match) => match[1] ?? '')
    .sort((a, b) => a.localeCompare(b));
}

/** The statuses a schema accepts, by trying each candidate. */
function acceptedBySchema(
  schema: (typeof moderationSchemas)[keyof typeof moderationSchemas],
  candidates: readonly string[],
): string[] {
  return candidates
    .filter((status) => schema.safeParse({ status }).success)
    .sort((a, b) => a.localeCompare(b));
}

/** Every status either vocabulary contains, so neither can hide a gap. */
const EVERY_STATUS = [
  'new',
  'reviewing',
  'waiting',
  'resolved',
  'closed',
  'approved',
  'rejected',
  'duplicate',
] as const;

describe('each inbox validates against its own table', () => {
  it.each([
    ['video_reports', 'video_reports'],
    ['video_feedback', 'video_reports'],
    ['contact_threads', 'video_reports'],
    ['video_submissions', 'video_submissions'],
  ] as const)('%s', (table, schemaKey) => {
    expect(acceptedBySchema(moderationSchemas[schemaKey], EVERY_STATUS)).toEqual(
      allowedByTable(table),
    );
  });
});

describe('the statuses that used to reach the database and fail', () => {
  it('rejects approving a report', () => {
    // `approved` is a submission status. On a report it passed validation,
    // hit the CHECK constraint, and came back as a 503.
    expect(moderationSchemas.video_reports.safeParse({ status: 'approved' }).success).toBe(false);
  });

  it('rejects putting a submission on hold', () => {
    expect(moderationSchemas.video_submissions.safeParse({ status: 'waiting' }).success).toBe(
      false,
    );
  });

  it('still accepts the statuses both vocabularies share', () => {
    for (const status of ['new', 'reviewing'] as const) {
      expect(moderationSchemas.video_reports.safeParse({ status }).success).toBe(true);
      expect(moderationSchemas.video_submissions.safeParse({ status }).success).toBe(true);
    }
  });

  it('keeps the admin note optional and bounded', () => {
    expect(
      moderationSchemas.video_reports.safeParse({ status: 'closed', adminNote: 'טופל' }).success,
    ).toBe(true);
    expect(
      moderationSchemas.video_reports.safeParse({ status: 'closed', adminNote: 'x'.repeat(2_001) })
        .success,
    ).toBe(false);
  });
});
