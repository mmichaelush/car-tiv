/**
 * Typed DOM helpers.
 *
 * Two things this module is responsible for:
 *
 *  1. **Safety.** The `html` tagged template escapes every interpolated value.
 *     Catalog titles, tags and channel names come from a database and from
 *     visitor submissions; the old site pushed them straight into `innerHTML`.
 *     Nothing in `src/` writes markup any other way — an unescaped value is a
 *     cross-site-scripting bug, not a style preference.
 *
 *  2. **Types.** `select` and `selectAll` return the element type you ask for
 *     and throw a useful error when a required element is missing, instead of
 *     letting `null` travel three call frames and fail as
 *     "cannot read property of null".
 */

/** Values a template may interpolate. `null` and `undefined` render as ''. */
export type Renderable = string | number | boolean | null | undefined | SafeHtml | Renderable[];

/** Markup that is already trusted. The only way to produce one is `html`. */
export class SafeHtml {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString(): string {
    return this.value;
  }
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape a value for insertion into HTML text or an attribute. */
export function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

function render(value: Renderable): string {
  if (value == null || value === false) return '';
  if (value === true) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escape(String(value));
}

/**
 * Build escaped markup.
 *
 * ```ts
 * html`<h3>${video.title}</h3>`            // title is escaped
 * html`<ul>${items.map(renderItem)}</ul>`  // arrays are joined
 * html`${raw(trustedSvg)}`                 // opt out, deliberately
 * ```
 */
export function html(strings: TemplateStringsArray, ...values: Renderable[]): SafeHtml {
  let result = strings[0] ?? '';
  for (const [index, value] of values.entries()) {
    result += render(value) + (strings[index + 1] ?? '');
  }
  return new SafeHtml(result);
}

/**
 * Mark a string as already-safe markup.
 *
 * Every call is a decision to trust the input. Use it for icons and other
 * literals defined in this code base — never for anything that came from the
 * API, from a URL or from a form.
 */
export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

/** Replace an element's children with rendered markup. */
export function setHtml(element: Element, content: SafeHtml): void {
  element.innerHTML = content.value;
}

/** Append rendered markup to an element. */
export function appendHtml(element: Element, content: SafeHtml): void {
  element.insertAdjacentHTML('beforeend', content.value);
}

/* -------------------------------------------------------------- Queries */

/** Find one element, or `null`. */
export function find<T extends Element = HTMLElement>(
  selector: string,
  scope: ParentNode = document,
): T | null {
  return scope.querySelector<T>(selector);
}

/**
 * Find one element that must exist.
 * @throws Error naming the selector, so a renamed class fails loudly at boot
 *         rather than silently doing nothing on click.
 */
export function select<T extends Element = HTMLElement>(
  selector: string,
  scope: ParentNode = document,
): T {
  const element = scope.querySelector<T>(selector);
  if (element == null) throw new Error(`Required element not found: ${selector}`);
  return element;
}

/** Find every matching element as a real array. */
export function selectAll<T extends Element = HTMLElement>(
  selector: string,
  scope: ParentNode = document,
): T[] {
  return [...scope.querySelectorAll<T>(selector)];
}

/** Shorthand for a `data-*` hook, the only selector kind used for behaviour. */
export const byData = <T extends Element = HTMLElement>(
  name: string,
  scope?: ParentNode,
): T | null => find<T>(`[data-${name}]`, scope);

/* --------------------------------------------------------------- Events */

/** Add a listener and get back a function that removes it. */
export function on<K extends keyof HTMLElementEventMap>(
  target: EventTarget,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void;
export function on(
  target: EventTarget,
  type: string,
  handler: (event: Event) => void,
  options?: AddEventListenerOptions,
): () => void;
export function on(
  target: EventTarget,
  type: string,
  handler: (event: never) => void,
  options?: AddEventListenerOptions,
): () => void {
  const listener = handler as EventListener;
  target.addEventListener(type, listener, options);
  return () => {
    target.removeEventListener(type, listener, options);
  };
}

/**
 * Delegated event handling.
 *
 * One listener on a container instead of one per card. This is what makes a
 * 60-card grid cheap to render and re-render: replacing the grid's HTML does
 * not orphan or duplicate any listeners.
 */
export function delegate<K extends keyof HTMLElementEventMap>(
  container: Element,
  type: K,
  selector: string,
  handler: (event: HTMLElementEventMap[K], match: HTMLElement) => void,
): () => void {
  const listener = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const match = target.closest<HTMLElement>(selector);
    if (match != null && container.contains(match)) {
      handler(event as HTMLElementEventMap[K], match);
    }
  };
  container.addEventListener(type, listener);
  return () => {
    container.removeEventListener(type, listener);
  };
}

/* ------------------------------------------------------------- Utilities */

/**
 * Delay a function until it stops being called for `waitMs`.
 * Used for the search box, so typing does not produce a request per keystroke.
 */
export function debounce<TArgs extends unknown[]>(
  callback: (...args: TArgs) => void,
  waitMs: number,
): ((...args: TArgs) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const debounced = (...args: TArgs): void => {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      callback(...args);
    }, waitMs);
  };

  debounced.cancel = (): void => {
    if (timer != null) clearTimeout(timer);
  };

  return debounced;
}

/** Toggle a class from a boolean, so call sites read as state, not commands. */
export function toggleClass(element: Element, className: string, active: boolean): void {
  element.classList.toggle(className, active);
}

/** Set or remove an attribute from a nullable value. */
export function setAttribute(element: Element, name: string, value: string | null): void {
  if (value == null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

/** Format a number with Hebrew digit grouping. */
export function formatCount(value: number): string {
  return value.toLocaleString('he-IL');
}

/**
 * A count with its noun, in Hebrew rather than in template-literal Hebrew.
 *
 * `${count} סרטונים` produces "1 סרטונים" — plural agreement with a singular
 * number, which every Hebrew reader notices immediately and which appeared on
 * channel cards, channel pages, playlists and the results bar. Hebrew also
 * prefers the noun before the numeral in the singular ("סרטון אחד", not
 * "1 סרטון"), so this is not something a plain `n === 1 ? singular : plural`
 * on the noun alone can get right.
 *
 * Zero takes the plural, which is correct in Hebrew: "אין סרטונים".
 *
 *     countLabel(1, 'סרטון', 'סרטונים')   // סרטון אחד
 *     countLabel(0, 'סרטון', 'סרטונים')   // 0 סרטונים
 *     countLabel(257, 'סרטון', 'סרטונים') // 257 סרטונים
 *
 * @param one   The singular noun, e.g. `סרטון`.
 * @param many  The plural noun, e.g. `סרטונים`.
 */
export function countLabel(value: number, one: string, many: string): string {
  if (value === 1) return `${one} אחד`;
  return `${formatCount(value)} ${many}`;
}

/** `true` when the visitor asked the system to reduce motion. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * A `mailto:` URL with an optional pre-filled subject and body.
 *
 * `URLSearchParams` is deliberately not used: it encodes a space as `+`, which
 * mail clients show literally in the subject line.
 */
export function mailtoUrl(
  address: string,
  parts: { subject?: string; body?: string } = {},
): string {
  const query: string[] = [];
  if (parts.subject != null && parts.subject.length > 0) {
    query.push(`subject=${encodeURIComponent(parts.subject)}`);
  }
  if (parts.body != null && parts.body.length > 0) {
    query.push(`body=${encodeURIComponent(parts.body)}`);
  }
  return query.length === 0 ? `mailto:${address}` : `mailto:${address}?${query.join('&')}`;
}
