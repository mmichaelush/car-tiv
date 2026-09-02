/**
 * A small typed router.
 *
 * Roughly 90 lines instead of a dependency, because the Worker's needs are
 * modest: match a method and a path pattern, extract `:params`, and run a
 * handler. Patterns are compiled once at module load, not per request.
 *
 * Routes are matched in registration order, so a specific pattern must be
 * registered before a general one (`/api/videos/exists` before
 * `/api/videos/:id`).
 */

import type { RequestContext } from './context.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Path parameters extracted from the pattern, e.g. `{ id: 'dQw4w9WgXcQ' }`. */
export type RouteParams = Readonly<Record<string, string>>;

export type RouteHandler = (
  context: RequestContext,
  params: RouteParams,
) => Response | Promise<Response>;

interface CompiledRoute {
  readonly method: HttpMethod;
  readonly pattern: string;
  readonly regex: RegExp;
  readonly paramNames: readonly string[];
  readonly handler: RouteHandler;
}

export interface RouteDefinition {
  readonly method: HttpMethod;
  /** `/api/videos/:id/related`. A `:name` segment matches one path segment. */
  readonly path: string;
  readonly handler: RouteHandler;
}

export class Router {
  readonly #routes: CompiledRoute[] = [];

  /** Register routes. Returns `this` so definitions can be chained. */
  add(...definitions: readonly RouteDefinition[]): this {
    for (const definition of definitions) {
      this.#routes.push(compile(definition));
    }
    return this;
  }

  /**
   * Find the handler for a request.
   *
   * @returns The matched route, or `{ pathMatched: true }` when the path exists
   *          but not for this method — which is a 405, not a 404.
   */
  match(
    method: string,
    pathname: string,
  ): { handler: RouteHandler; params: RouteParams } | { pathMatched: boolean } {
    let pathMatched = false;

    for (const route of this.#routes) {
      const match = route.regex.exec(pathname);
      if (match == null) continue;
      if (route.method !== method) {
        pathMatched = true;
        continue;
      }

      const params: Record<string, string> = {};
      route.paramNames.forEach((name, index) => {
        const value = match[index + 1];
        if (value != null) params[name] = decodeURIComponent(value);
      });
      return { handler: route.handler, params };
    }

    return { pathMatched };
  }

  /** Registered patterns, for the `/api` index endpoint and for tests. */
  list(): { method: HttpMethod; path: string }[] {
    return this.#routes.map((route) => ({ method: route.method, path: route.pattern }));
  }
}

/**
 * A `:name` parameter anywhere inside a path segment.
 *
 * Matching only a segment that *starts* with `:` was a real bug rather than a
 * limitation: `/sitemap-videos-:page.xml` was escaped whole, so the pattern
 * only ever matched the literal text `sitemap-videos-:page.xml` and every
 * video sitemap the index advertises returned the 404 page. Search engines were
 * being handed a list of broken URLs for all 7,876 videos.
 *
 * A parameter still matches within one segment — `[^/]+` — so a slash can never
 * be swallowed into one.
 */
const PARAM = /:([A-Za-z_][A-Za-z0-9_]*)/g;

function compile(definition: RouteDefinition): CompiledRoute {
  const paramNames: string[] = [];
  const source = definition.path
    .split('/')
    .map((segment) => {
      // Escape the literal text around each parameter, and replace the
      // parameter itself with a capture group. `.xml` after `:page` is escaped
      // like any other literal, so it cannot act as a regex wildcard.
      let compiled = '';
      let lastIndex = 0;

      for (const match of segment.matchAll(PARAM)) {
        const name = match[1];
        // The pattern has one capture group, so this is always present; the
        // check is what lets the compiler agree without an assertion.
        if (name == null) continue;

        compiled += escapeRegex(segment.slice(lastIndex, match.index));
        paramNames.push(name);
        compiled += '([^/]+?)';
        lastIndex = match.index + match[0].length;
      }

      // A segment with no parameter is escaped whole, exactly as before.
      if (lastIndex === 0) return escapeRegex(segment);
      return compiled + escapeRegex(segment.slice(lastIndex));
    })
    .join('/');

  return {
    method: definition.method,
    pattern: definition.path,
    // A trailing slash is accepted so `/api/channels` and `/api/channels/` agree.
    regex: new RegExp(`^${source}/?$`),
    paramNames,
    handler: definition.handler,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Shorthand constructors, so route tables read as a list. */
export const get = (path: string, handler: RouteHandler): RouteDefinition => ({
  method: 'GET',
  path,
  handler,
});
export const post = (path: string, handler: RouteHandler): RouteDefinition => ({
  method: 'POST',
  path,
  handler,
});
export const put = (path: string, handler: RouteHandler): RouteDefinition => ({
  method: 'PUT',
  path,
  handler,
});
export const patch = (path: string, handler: RouteHandler): RouteDefinition => ({
  method: 'PATCH',
  path,
  handler,
});
export const remove = (path: string, handler: RouteHandler): RouteDefinition => ({
  method: 'DELETE',
  path,
  handler,
});
