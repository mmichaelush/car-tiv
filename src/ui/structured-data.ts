/**
 * schema.org structured data.
 *
 * A catalog of 7,900 videos is exactly the kind of site that lives or dies on
 * search: a `VideoObject` is what lets a result carry a thumbnail, a duration
 * and an upload date instead of a bare blue link. The legacy site emitted none
 * of it, so this is new — but it is the sort of thing that has to be right or
 * it is worse than absent, hence one module rather than a JSON blob per page.
 *
 * Each block is keyed, so a page can publish several (a video and its
 * breadcrumbs) and re-publishing one replaces it rather than stacking copies —
 * which matters because these are written after the data loads, not in the
 * static HTML.
 */

/** A JSON-LD document. Deliberately loose: schema.org shapes vary widely. */
export type StructuredData = Record<string, unknown>;

/**
 * Publish (or replace) one block of structured data.
 *
 * @param key   Identifies the block, e.g. `video` or `breadcrumbs`.
 * @param data  The JSON-LD object. Pass `null` to remove the block.
 */
export function setStructuredData(key: string, data: StructuredData | null): void {
  const selector = `script[type="application/ld+json"][data-ld="${key}"]`;
  const existing = document.head.querySelector(selector);

  if (data == null) {
    existing?.remove();
    return;
  }

  const script = existing ?? document.createElement('script');
  if (existing == null) {
    script.setAttribute('type', 'application/ld+json');
    script.setAttribute('data-ld', key);
    document.head.append(script);
  }

  // `textContent`, never `innerHTML`: this is data, and a title containing
  // `</script>` must not be able to end the element. `<` is escaped as well,
  // so the block stays safe even if the document is serialised and re-parsed.
  script.textContent = JSON.stringify(data).replace(/</g, '\\u003c');
}
