/**
 * Sending things to the team: a problem report, a note about a video, a
 * suggested video, a contact message.
 *
 * Kept separate from the catalog repository because these are writes with
 * validation errors to surface, not reads with a cache policy.
 */

import type { ReportReason } from '@shared/constants.js';
import { httpClient, type HttpClient } from './http-client.js';

export interface ReportPayload {
  readonly videoId: string;
  readonly reason: ReportReason;
  readonly message?: string;
  readonly email?: string;
}

export interface FeedbackPayload {
  readonly videoId: string;
  readonly message: string;
  readonly email?: string;
}

export interface SubmissionPayload {
  /** A YouTube URL or a bare id — the server accepts either. */
  readonly url: string;
  readonly title?: string;
  readonly category?: string;
  readonly message?: string;
  readonly name?: string;
  readonly email?: string;
}

export interface ContactPayload {
  readonly name: string;
  readonly email: string;
  readonly subject?: string;
  readonly message: string;
  /**
   * Whether the privacy checkbox was ticked. `boolean`, not `true`: the form
   * is `novalidate`, so an unticked box is a real state that has to reach the
   * server, which answers with the Hebrew message for that field.
   */
  readonly acceptedPrivacy: boolean;
}

export class EngagementRepository {
  readonly #http: HttpClient;

  constructor(client: HttpClient = httpClient) {
    this.#http = client;
  }

  report(payload: ReportPayload): Promise<{ id: string }> {
    return this.#http.post<{ id: string }>('/reports', payload);
  }

  feedback(payload: FeedbackPayload): Promise<{ id: string }> {
    return this.#http.post<{ id: string }>('/feedback', payload);
  }

  submitVideo(payload: SubmissionPayload): Promise<{ id: string; youtubeId: string }> {
    return this.#http.post<{ id: string; youtubeId: string }>('/submissions', payload);
  }

  contact(payload: ContactPayload): Promise<{ threadId: string }> {
    return this.#http.post<{ threadId: string }>('/contact', payload);
  }
}

export const engagement = new EngagementRepository();
