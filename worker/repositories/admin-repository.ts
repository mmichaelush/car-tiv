/**
 * Editor-facing reads and writes.
 *
 * The public repositories only ever see published rows; this one sees
 * everything, which is why it is a separate class rather than a flag on the
 * others. A missing `WHERE status = 'published'` in a public query is a leak;
 * here it is the point.
 *
 * Every write records an audit entry with a before/after snapshot, in the same
 * batch as the change itself — so the log cannot drift from reality.
 */

import { PAGINATION, type VideoStatus } from '@shared/constants.js';
import { buildPageMeta, clampLimit, clampPage, offsetFor } from '@shared/core/pagination.js';
import { slugify } from '@shared/core/text.js';
import type { Page } from '@shared/types/api.js';
import { newId } from '../lib/crypto.js';
import {
  BaseRepository,
  ConditionBuilder,
  LIST_SEPARATOR,
  chunkForBindings,
  likePattern,
  placeholders,
  splitList,
  type Binding,
} from './base.js';

/** A row in the admin videos table. */
export interface AdminVideoRow {
  readonly id: string;
  readonly title: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly channelName: string | null;
  readonly durationSeconds: number;
  readonly status: VideoStatus;
  readonly isFeatured: number;
  readonly isHebrew: number;
  readonly addedAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly tagNames: string | null;
  readonly openReports: number;
}

export interface AdminVideoQuery {
  readonly q?: string;
  readonly status?: string;
  readonly category?: string;
  readonly channel?: string;
  /** `true` restricts to videos with at least one open report. */
  readonly hasReports?: boolean;
  /** `true` restricts to rows missing a description or a duration. */
  readonly missingMetadata?: boolean;
  readonly page?: number;
  readonly limit?: number;
}

/** The counters on the dashboard. */
export interface AdminOverview {
  readonly videos: number;
  readonly hidden: number;
  readonly broken: number;
  readonly deleted: number;
  readonly channels: number;
  readonly tags: number;
  readonly addedThisWeek: number;
  readonly addedThisMonth: number;
}

/** A field-level change to apply to one or many videos. */
export interface VideoPatch {
  readonly title?: string;
  readonly description?: string;
  readonly categoryId?: string;
  readonly status?: VideoStatus;
  readonly isFeatured?: boolean;
  readonly isHebrew?: boolean;
  readonly adminNote?: string;
}

export class AdminRepository extends BaseRepository {
  // -------------------------------------------------------------- Reads

  /** Dashboard counters, in one round trip. */
  async overview(): Promise<AdminOverview> {
    const row = await this.first<AdminOverview>(
      `SELECT
         (SELECT COUNT(*) FROM videos WHERE deleted_at IS NULL) AS videos,
         (SELECT COUNT(*) FROM videos WHERE status = 'hidden' AND deleted_at IS NULL) AS hidden,
         (SELECT COUNT(*) FROM videos WHERE status = 'broken' AND deleted_at IS NULL) AS broken,
         (SELECT COUNT(*) FROM videos WHERE deleted_at IS NOT NULL) AS deleted,
         (SELECT COUNT(*) FROM channels) AS channels,
         (SELECT COUNT(*) FROM tags) AS tags,
         (SELECT COUNT(*) FROM videos WHERE added_at >= date('now', '-7 day')) AS addedThisWeek,
         (SELECT COUNT(*) FROM videos WHERE added_at >= date('now', '-30 day')) AS addedThisMonth`,
    );

    return (
      row ?? {
        videos: 0,
        hidden: 0,
        broken: 0,
        deleted: 0,
        channels: 0,
        tags: 0,
        addedThisWeek: 0,
        addedThisMonth: 0,
      }
    );
  }

  /**
   * The videos table.
   * Unlike the public listing this sees every status, including soft-deleted
   * rows, and reports how many open problem reports each video has.
   */
  async listVideos(query: AdminVideoQuery): Promise<Page<AdminVideoRow>> {
    const page = clampPage(query.page ?? 1);
    const limit = clampLimit(query.limit ?? PAGINATION.adminLimit, PAGINATION.adminLimit);

    const conditions = new ConditionBuilder();
    conditions.addIf(
      query.status != null && query.status !== 'all' && query.status !== 'deleted',
      'v.status = ? AND v.deleted_at IS NULL',
      query.status ?? null,
    );
    conditions.addIf(query.status === 'deleted', 'v.deleted_at IS NOT NULL');
    conditions.addIf(query.status == null || query.status === 'all', 'v.deleted_at IS NULL');
    conditions.addIf(
      query.category != null && query.category !== 'all',
      'v.category_id = ?',
      query.category ?? null,
    );
    conditions.addIf(query.channel != null, 'ch.slug = ?', query.channel ?? null);
    conditions.addIf(
      query.missingMetadata === true,
      `(v.description = '' OR v.duration_seconds = 0 OR v.channel_id IS NULL)`,
    );
    conditions.addIf(
      query.hasReports === true,
      `EXISTS (SELECT 1 FROM video_reports r WHERE r.video_id = v.id AND r.status IN ('new','reviewing'))`,
    );

    // The admin search is intentionally a LIKE over title and id rather than
    // FTS: an editor searches for a fragment or a YouTube id, not for prose.
    if (query.q != null && query.q.trim().length > 0) {
      const pattern = likePattern(query.q.trim());
      conditions.add(
        `(v.id LIKE ? ESCAPE ${String.raw`'\'`} OR v.title LIKE ? ESCAPE ${String.raw`'\'`} OR ch.name LIKE ? ESCAPE ${String.raw`'\'`})`,
        pattern,
        pattern,
        pattern,
      );
    }

    const where = conditions.whereClause();
    const bindings: Binding[] = conditions.bindings();

    const rows = await this.all<AdminVideoRow>(
      `SELECT v.id, v.title, v.category_id AS categoryId, cat.name AS categoryName,
              ch.name AS channelName, v.duration_seconds AS durationSeconds,
              v.status, v.is_featured AS isFeatured, v.is_hebrew AS isHebrew,
              v.added_at AS addedAt, v.updated_at AS updatedAt, v.deleted_at AS deletedAt,
              (SELECT group_concat(t.name, '${LIST_SEPARATOR}') FROM video_tags vt
                 JOIN tags t ON t.id = vt.tag_id WHERE vt.video_id = v.id) AS tagNames,
              (SELECT COUNT(*) FROM video_reports r
                 WHERE r.video_id = v.id AND r.status IN ('new','reviewing')) AS openReports
       FROM videos v
       JOIN categories cat ON cat.id = v.category_id
       LEFT JOIN channels ch ON ch.id = v.channel_id
       ${where}
       ORDER BY v.updated_at DESC, v.added_at DESC
       LIMIT ? OFFSET ?`,
      [...bindings, limit, offsetFor(page, limit)],
    );

    const total = await this.count(
      `SELECT COUNT(*) AS value FROM videos v
       LEFT JOIN channels ch ON ch.id = v.channel_id
       ${where}`,
      bindings,
    );

    return { items: rows, meta: buildPageMeta(page, limit, total) };
  }

  /** Tags split back into a list, for the table cell. */
  static tagsOf(row: AdminVideoRow): string[] {
    return splitList(row.tagNames);
  }

  // ------------------------------------------------------------- Writes

  /**
   * Apply a patch to one video and record the change.
   * @returns `false` when the video does not exist.
   */
  async updateVideo(id: string, patch: VideoPatch, userId: string | null): Promise<boolean> {
    const before = await this.first<Record<string, unknown>>(`SELECT * FROM videos WHERE id = ?`, [
      id,
    ]);
    if (before == null) return false;

    const assignments: string[] = [];
    const bindings: Binding[] = [];

    const set = (column: string, value: Binding): void => {
      assignments.push(`${column} = ?`);
      bindings.push(value);
    };

    if (patch.title != null) set('title', patch.title);
    if (patch.description != null) set('description', patch.description);
    if (patch.categoryId != null) set('category_id', patch.categoryId);
    if (patch.status != null) set('status', patch.status);
    if (patch.isFeatured != null) set('is_featured', patch.isFeatured ? 1 : 0);
    if (patch.isHebrew != null) set('is_hebrew', patch.isHebrew ? 1 : 0);
    if (patch.adminNote != null) set('admin_note', patch.adminNote);

    if (assignments.length === 0) return true;
    assignments.push(`updated_at = CURRENT_TIMESTAMP`);

    await this.batch([
      {
        sql: `UPDATE videos SET ${assignments.join(', ')} WHERE id = ?`,
        bindings: [...bindings, id],
      },
      auditStatement({
        userId,
        action: 'video.update',
        entityType: 'video',
        entityId: id,
        before,
        after: patch,
      }),
    ]);

    return true;
  }

  /**
   * Apply the same patch to many videos, as one audited batch.
   * @returns The number of rows changed.
   */
  async bulkUpdate(
    ids: readonly string[],
    patch: VideoPatch,
    userId: string | null,
  ): Promise<number> {
    if (ids.length === 0) return 0;

    const batchId = newId();
    let changed = 0;

    // Every field the patch can carry, not a subset.
    //
    // This used to apply `categoryId`, `status` and `isFeatured` only, while
    // the request schema accepted all seven — so a bulk edit setting `isHebrew`
    // or `adminNote` was validated, written into the audit log's `after_json`,
    // and then silently dropped. The audit trail recorded changes that never
    // happened, which is worse than not recording them.
    const assignments: string[] = [];
    const bindings: Binding[] = [];

    const set = (column: string, value: Binding): void => {
      assignments.push(`${column} = ?`);
      bindings.push(value);
    };

    if (patch.title != null) set('title', patch.title);
    if (patch.description != null) set('description', patch.description);
    if (patch.categoryId != null) set('category_id', patch.categoryId);
    if (patch.status != null) set('status', patch.status);
    if (patch.isFeatured != null) set('is_featured', patch.isFeatured ? 1 : 0);
    if (patch.isHebrew != null) set('is_hebrew', patch.isHebrew ? 1 : 0);
    if (patch.adminNote != null) set('admin_note', patch.adminNote);

    // Checked once, before the loop. Inside it, an empty patch returned 0 after
    // possibly having already updated earlier chunks.
    if (assignments.length === 0) return 0;
    assignments.push('updated_at = CURRENT_TIMESTAMP');

    // Chunked so one statement never carries a thousand bindings. The chunk
    // size accounts for the assignment parameters this statement also binds.
    for (const chunk of chunkForBindings(ids, { fixed: bindings.length })) {
      // The change and its audit row go in one batch, which D1 runs inside a
      // transaction. Written as two calls, a failure between them left the
      // catalog changed with no record of who changed it.
      const [result] = await this.batchWithResults([
        {
          sql: `UPDATE videos SET ${assignments.join(', ')} WHERE id IN (${placeholders(chunk.length)})`,
          bindings: [...bindings, ...chunk],
        },
        {
          sql: `INSERT INTO admin_audit_log
                  (user_id, action, entity_type, entity_id, after_json, batch_id)
                VALUES (?, 'video.bulk-update', 'video', ?, ?, ?)`,
          bindings: [userId, chunk.join(','), JSON.stringify(patch), batchId],
        },
      ]);
      changed += result?.meta.changes ?? 0;
    }

    return changed;
  }

  /**
   * Soft delete. The row stays, so the change is reversible.
   *
   * Chunked like every other list-shaped write here: the bulk endpoints accept
   * a list, and a list of ids bound directly into one statement is how the
   * 100-parameter limit gets hit. It is chunked past `MAX_BULK_IDS` on purpose
   * — a backfill calling this directly is not bounded by a request schema.
   */
  async softDelete(ids: readonly string[], userId: string | null): Promise<number> {
    if (ids.length === 0) return 0;
    const batchId = newId();
    let changed = 0;

    // `deleted_at` only. **Not** `status`.
    //
    // This used to also write `status = 'removed'`, and `restore()` below used
    // to write `status = 'published'` — so delete-then-restore *published* a
    // video that had never been published. A `hidden` video an editor had taken
    // down, a `pending` submission nobody had approved, a `broken` link: delete,
    // restore, and all three are live on the site. Nothing in the interface
    // suggests that undoing a deletion also publishes.
    //
    // Leaving `status` alone makes restore exactly the inverse of delete, which
    // is the only thing an undo is allowed to be. `deleted_at IS NOT NULL`
    // already removes the row from every public query — `LIVE` in
    // `video-repository.ts` requires `deleted_at IS NULL` — so the status write
    // was never doing the hiding in the first place.
    //
    // Change and audit row together; see `batchWithResults`. One audit row per
    // chunk, sharing a batch id, so the whole operation is still one entry to
    // the reader of the log.
    for (const chunk of chunkForBindings(ids)) {
      const [result] = await this.batchWithResults([
        {
          sql: `UPDATE videos SET deleted_at = CURRENT_TIMESTAMP,
                                  updated_at = CURRENT_TIMESTAMP
                WHERE id IN (${placeholders(chunk.length)}) AND deleted_at IS NULL`,
          bindings: [...chunk],
        },
        {
          sql: `INSERT INTO admin_audit_log (user_id, action, entity_type, entity_id, batch_id)
                VALUES (?, 'video.delete', 'video', ?, ?)`,
          bindings: [userId, chunk.join(','), batchId],
        },
      ]);
      changed += result?.meta.changes ?? 0;
    }

    return changed;
  }

  /** Undo a soft delete. */
  async restore(ids: readonly string[], userId: string | null): Promise<number> {
    if (ids.length === 0) return 0;
    const batchId = newId();
    let changed = 0;

    for (const chunk of chunkForBindings(ids)) {
      const [result] = await this.batchWithResults([
        {
          // `status` is untouched, so a video comes back exactly as it went
          // in — see the note on `softDelete`. `AND deleted_at IS NOT NULL` so
          // the row count reports videos actually restored rather than every
          // id that was passed.
          sql: `UPDATE videos SET deleted_at = NULL,
                                  updated_at = CURRENT_TIMESTAMP
                WHERE id IN (${placeholders(chunk.length)}) AND deleted_at IS NOT NULL`,
          bindings: [...chunk],
        },
        {
          sql: `INSERT INTO admin_audit_log (user_id, action, entity_type, entity_id, batch_id)
                VALUES (?, 'video.restore', 'video', ?, ?)`,
          bindings: [userId, chunk.join(','), batchId],
        },
      ]);
      changed += result?.meta.changes ?? 0;
    }

    return changed;
  }

  /** Add a tag to many videos, creating the tag if it is new. */
  async addTag(ids: readonly string[], tagName: string, userId: string | null): Promise<number> {
    const name = tagName.trim();
    if (ids.length === 0 || name.length === 0) return 0;

    const slug = slugify(name);
    await this.run(`INSERT OR IGNORE INTO tags (slug, name) VALUES (?, ?)`, [slug, name]);

    const tag = await this.first<{ id: number }>(`SELECT id FROM tags WHERE slug = ?`, [slug]);
    if (tag == null) return 0;

    let added = 0;
    // Two bindings a row, so the chunk is half the usual size.
    for (const chunk of chunkForBindings(ids, { perItem: 2 })) {
      const values = chunk.map(() => '(?, ?)').join(', ');
      const [result] = await this.batchWithResults([
        {
          sql: `INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES ${values}`,
          bindings: chunk.flatMap((id) => [id, tag.id]),
        },
        {
          sql: `INSERT INTO admin_audit_log
                  (user_id, action, entity_type, entity_id, after_json)
                VALUES (?, 'video.tag-add', 'video', ?, ?)`,
          bindings: [userId, chunk.join(','), JSON.stringify({ tag: name })],
        },
      ]);
      added += result?.meta.changes ?? 0;
    }

    return added;
  }

  /** Remove a tag from many videos. */
  async removeTag(ids: readonly string[], tagSlug: string, userId: string | null): Promise<number> {
    if (ids.length === 0) return 0;
    let removed = 0;

    // `fixed: 1` for the slug this statement also binds.
    for (const chunk of chunkForBindings(ids, { fixed: 1 })) {
      const [result] = await this.batchWithResults([
        {
          sql: `DELETE FROM video_tags
              WHERE video_id IN (${placeholders(chunk.length)})
                AND tag_id = (SELECT id FROM tags WHERE slug = ?)`,
          // `slugify`, the same function `addTag` and the importer use to create
          // the slug. This used to be `indexText(...).replace(/\s+/g, '-')`, which
          // is a *different* normalisation: `indexText` folds final Hebrew letters
          // for search, so "מצתים" became "מצתימ" and matched no tag that had ever
          // been stored. Removing a tag ending in ם, ן, ץ, ף or ך — a large share
          // of Hebrew words — silently did nothing.
          bindings: [...chunk, slugify(tagSlug)],
        },
        {
          sql: `INSERT INTO admin_audit_log (user_id, action, entity_type, entity_id, after_json)
              VALUES (?, 'video.tag-remove', 'video', ?, ?)`,
          bindings: [userId, chunk.join(','), JSON.stringify({ tag: tagSlug })],
        },
      ]);
      removed += result?.meta.changes ?? 0;
    }

    return removed;
  }

  /** Recent audit entries, for the "what changed" panel. */
  async recentActivity(
    limit = 30,
  ): Promise<{ action: string; entityType: string; entityId: string; createdAt: string }[]> {
    return this.all(
      `SELECT action, entity_type AS entityType, entity_id AS entityId, created_at AS createdAt
       FROM admin_audit_log
       ORDER BY created_at DESC
       LIMIT ?`,
      [limit],
    );
  }
}

/** Build the audit statement that accompanies a write. */
function auditStatement(entry: {
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
}): { sql: string; bindings: Binding[] } {
  return {
    sql: `INSERT INTO admin_audit_log (user_id, action, entity_type, entity_id, before_json, after_json)
          VALUES (?, ?, ?, ?, ?, ?)`,
    bindings: [
      entry.userId,
      entry.action,
      entry.entityType,
      entry.entityId,
      JSON.stringify(entry.before),
      JSON.stringify(entry.after),
    ],
  };
}
