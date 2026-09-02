/**
 * Everything a visitor sends us: reports, notes, video suggestions and contact
 * messages, plus the admin-side reads of the same tables.
 */

import { PAGINATION } from '@shared/constants.js';
import { buildPageMeta, clampLimit, clampPage, offsetFor } from '@shared/core/pagination.js';
import type { Page } from '@shared/types/api.js';
import type { ModerationStatus, ReportReason, SubmissionStatus } from '@shared/constants.js';
import { newId } from '../lib/crypto.js';
import { BaseRepository, ConditionBuilder } from './base.js';

export interface NewReport {
  readonly videoId: string;
  readonly reason: ReportReason;
  readonly message: string;
  readonly contactEmail: string | null;
  readonly senderHash: string;
}

export interface NewFeedback {
  readonly videoId: string;
  readonly message: string;
  readonly contactEmail: string | null;
  readonly senderHash: string;
}

export interface NewSubmission {
  readonly youtubeId: string;
  readonly youtubeUrl: string;
  readonly title: string;
  readonly suggestedCategory: string | null;
  readonly message: string;
  readonly submitterName: string;
  readonly submitterEmail: string | null;
  readonly senderHash: string;
}

export interface NewContactMessage {
  readonly name: string;
  readonly email: string | null;
  readonly subject: string;
  readonly message: string;
  readonly senderHash: string;
}

/** Row shape shared by the admin inbox views. */
export interface InboxRow {
  readonly id: string;
  readonly status: ModerationStatus | SubmissionStatus;
  readonly createdAt: string;
  readonly title: string;
  readonly detail: string;
  readonly videoId: string | null;
  readonly contactEmail: string | null;
  readonly adminNote: string;
}

export class EngagementRepository extends BaseRepository {
  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async createReport(input: NewReport): Promise<string> {
    const id = newId();
    await this.run(
      `INSERT INTO video_reports (id, video_id, reason, message, contact_email, reporter_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.videoId, input.reason, input.message, input.contactEmail, input.senderHash],
    );
    return id;
  }

  async createFeedback(input: NewFeedback): Promise<string> {
    const id = newId();
    await this.run(
      `INSERT INTO video_feedback (id, video_id, message, contact_email, sender_hash)
       VALUES (?, ?, ?, ?, ?)`,
      [id, input.videoId, input.message, input.contactEmail, input.senderHash],
    );
    return id;
  }

  /**
   * Store a suggested video.
   * A partial unique index makes a second pending submission of the same video
   * impossible; the caller turns the resulting UNIQUE violation into a 409.
   */
  async createSubmission(input: NewSubmission): Promise<string> {
    const id = newId();
    await this.run(
      `INSERT INTO video_submissions
         (id, youtube_id, youtube_url, title, suggested_category, message,
          submitter_name, submitter_email, submitter_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.youtubeId,
        input.youtubeUrl,
        input.title,
        input.suggestedCategory,
        input.message,
        input.submitterName,
        input.submitterEmail,
        input.senderHash,
      ],
    );
    return id;
  }

  /** Open a contact thread with its first message, as one atomic batch. */
  async createContactThread(input: NewContactMessage): Promise<string> {
    const threadId = newId();
    await this.batch([
      {
        sql: `INSERT INTO contact_threads (id, name, email, subject, sender_hash)
              VALUES (?, ?, ?, ?, ?)`,
        bindings: [threadId, input.name, input.email, input.subject, input.senderHash],
      },
      {
        sql: `INSERT INTO contact_messages (id, thread_id, sender_type, message)
              VALUES (?, ?, 'visitor', ?)`,
        bindings: [newId(), threadId, input.message],
      },
    ]);
    return threadId;
  }

  // -------------------------------------------------------------------------
  // Admin reads
  // -------------------------------------------------------------------------

  async listReports(options: {
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<Page<InboxRow>> {
    return this.#listInbox({
      table: 'video_reports',
      titleSql: `r.reason`,
      detailSql: `r.message`,
      videoSql: `r.video_id`,
      ...options,
    });
  }

  async listFeedback(options: {
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<Page<InboxRow>> {
    return this.#listInbox({
      table: 'video_feedback',
      titleSql: `'הערה על סרטון'`,
      detailSql: `r.message`,
      videoSql: `r.video_id`,
      ...options,
    });
  }

  async listSubmissions(options: {
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<Page<InboxRow>> {
    return this.#listInbox({
      table: 'video_submissions',
      titleSql: `COALESCE(NULLIF(r.title, ''), r.youtube_url)`,
      detailSql: `r.message`,
      videoSql: `r.youtube_id`,
      emailColumn: 'submitter_email',
      ...options,
    });
  }

  async listContactThreads(options: {
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<Page<InboxRow>> {
    return this.#listInbox({
      table: 'contact_threads',
      titleSql: `COALESCE(NULLIF(r.subject, ''), r.name)`,
      detailSql: `(SELECT message FROM contact_messages m WHERE m.thread_id = r.id ORDER BY m.created_at LIMIT 1)`,
      videoSql: `NULL`,
      emailColumn: 'email',
      ...options,
    });
  }

  /** Counters for the admin dashboard: how much is waiting for a human. */
  async openCounts(): Promise<{
    reports: number;
    feedback: number;
    submissions: number;
    contact: number;
  }> {
    const row = await this.first<{
      reports: number;
      feedback: number;
      submissions: number;
      contact: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM video_reports     WHERE status IN ('new', 'reviewing')) AS reports,
         (SELECT COUNT(*) FROM video_feedback    WHERE status IN ('new', 'reviewing')) AS feedback,
         (SELECT COUNT(*) FROM video_submissions WHERE status IN ('new', 'reviewing')) AS submissions,
         (SELECT COUNT(*) FROM contact_threads   WHERE status IN ('new', 'reviewing')) AS contact`,
    );
    return {
      reports: row?.reports ?? 0,
      feedback: row?.feedback ?? 0,
      submissions: row?.submissions ?? 0,
      contact: row?.contact ?? 0,
    };
  }

  /** Move an inbox item to a new status and stamp who handled it. */
  async updateStatus(
    table: 'video_reports' | 'video_feedback' | 'video_submissions' | 'contact_threads',
    id: string,
    status: string,
    adminNote: string,
    userId: string | null,
  ): Promise<boolean> {
    // `table` comes from a closed union, never from a request.
    const handledColumns =
      table === 'contact_threads'
        ? `status = ?, admin_note = ?, updated_at = CURRENT_TIMESTAMP`
        : `status = ?, admin_note = ?, handled_at = CURRENT_TIMESTAMP, handled_by = ?`;

    const bindings =
      table === 'contact_threads' ? [status, adminNote, id] : [status, adminNote, userId, id];

    const result = await this.run(`UPDATE ${table} SET ${handledColumns} WHERE id = ?`, bindings);
    return result.meta.changes > 0;
  }

  // -------------------------------------------------------------------------

  async #listInbox(options: {
    table: string;
    titleSql: string;
    detailSql: string;
    videoSql: string;
    emailColumn?: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<Page<InboxRow>> {
    const page = clampPage(options.page ?? 1);
    const limit = clampLimit(options.limit ?? PAGINATION.adminLimit, PAGINATION.adminLimit);
    const email = options.emailColumn ?? 'contact_email';

    const conditions = new ConditionBuilder();
    conditions.addIf(
      options.status != null && options.status !== 'all',
      'r.status = ?',
      options.status ?? null,
    );
    const where = conditions.whereClause();

    const rows = await this.all<InboxRow>(
      `SELECT r.id, r.status, r.created_at AS createdAt,
              ${options.titleSql} AS title,
              ${options.detailSql} AS detail,
              ${options.videoSql} AS videoId,
              r.${email} AS contactEmail,
              r.admin_note AS adminNote
       FROM ${options.table} r
       ${where}
       ORDER BY r.created_at DESC
       LIMIT ? OFFSET ?`,
      [...conditions.bindings(), limit, offsetFor(page, limit)],
    );

    const total = await this.count(
      `SELECT COUNT(*) AS value FROM ${options.table} r ${where}`,
      conditions.bindings(),
    );

    return { items: rows, meta: buildPageMeta(page, limit, total) };
  }
}
