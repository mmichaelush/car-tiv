/**
 * A small, safe wrapper around `localStorage`.
 *
 * Three things it takes care of, none of which are optional in production:
 *
 *  * **It can always throw.** Private windows, "block site data", and a full
 *    quota all make `localStorage` raise. Every access here is guarded, and a
 *    failure degrades to "no stored value" instead of a blank page.
 *  * **Versioning.** Each record carries the schema version it was written
 *    with. Reading a record from an older version returns the default rather
 *    than a half-shaped object, so a shipped change cannot corrupt a visitor's
 *    data.
 *  * **Namespacing.** Every key is prefixed, so the site never collides with
 *    anything else stored on the origin.
 */

const PREFIX = 'cartiv';

/** Bump when a stored shape changes incompatibly. */
export const STORAGE_VERSION = 1;

interface Envelope<T> {
  readonly v: number;
  readonly data: T;
  /** ISO timestamp of the last write, for cleanup and for merge-on-sign-in. */
  readonly at: string;
}

/** `true` when storage is usable at all. Probed once. */
let available: boolean | null = null;

function isAvailable(): boolean {
  if (available != null) return available;
  try {
    const probe = `${PREFIX}:probe`;
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    available = true;
  } catch {
    available = false;
  }
  return available;
}

/**
 * A typed, versioned slot in local storage.
 *
 * ```ts
 * const favorites = new LocalStore<string[]>('favorites', []);
 * favorites.write([...favorites.read(), id]);
 * ```
 */
export class LocalStore<T> {
  readonly #key: string;
  readonly #fallback: T;

  constructor(key: string, fallback: T) {
    this.#key = `${PREFIX}:${key}`;
    this.#fallback = fallback;
  }

  /** The stored value, or the fallback when absent, unreadable or outdated. */
  read(): T {
    if (!isAvailable()) return this.#fallback;
    try {
      const raw = window.localStorage.getItem(this.#key);
      if (raw == null) return this.#fallback;

      const envelope = JSON.parse(raw) as Envelope<T> | null;
      if (envelope?.v !== STORAGE_VERSION) return this.#fallback;
      return envelope.data;
    } catch {
      return this.#fallback;
    }
  }

  /**
   * Store a value.
   * @returns `false` when storage refused the write (quota, private mode), so
   *          a caller can tell the visitor their change will not be remembered.
   */
  write(data: T): boolean {
    if (!isAvailable()) return false;
    try {
      const envelope: Envelope<T> = { v: STORAGE_VERSION, data, at: new Date().toISOString() };
      window.localStorage.setItem(this.#key, JSON.stringify(envelope));
      return true;
    } catch {
      return false;
    }
  }

  /** Read, transform, write — the pattern almost every caller wants. */
  update(transform: (current: T) => T): T {
    const next = transform(this.read());
    this.write(next);
    return next;
  }

  clear(): void {
    if (!isAvailable()) return;
    try {
      window.localStorage.removeItem(this.#key);
    } catch {
      /* Nothing useful to do; the value simply stays. */
    }
  }

  /** When this slot was last written, or `null`. */
  updatedAt(): string | null {
    if (!isAvailable()) return null;
    try {
      const raw = window.localStorage.getItem(this.#key);
      if (raw == null) return null;
      return (JSON.parse(raw) as Envelope<T>).at;
    } catch {
      return null;
    }
  }
}

/** `true` when the browser will remember anything at all. */
export const storageAvailable = (): boolean => isAvailable();
