/**
 * Manufacturer and model detection.
 *
 * A visitor thinks in cars ("Hyundai i40 2012"), not in tags, so the catalog
 * needs to know which vehicles a video is about. The reference list lives in
 * `data/reference/vehicles.json`; this module turns it into a lookup index and
 * finds mentions in a video's title and tags.
 *
 * Matching is deliberately conservative: a model is only accepted when its
 * manufacturer was also mentioned, so "Ford Focus" matches but the English word
 * "focus" on its own does not.
 */

import { indexText } from './text.js';

/** A model as written in the reference file, after parsing. */
export interface ModelReference {
  readonly slug: string;
  readonly name: string;
  readonly nameHe: string | null;
  /** Normalised strings that identify this model. */
  readonly aliases: readonly string[];
}

/** A manufacturer as written in the reference file, after parsing. */
export interface ManufacturerReference {
  readonly slug: string;
  readonly name: string;
  readonly nameHe: string | null;
  readonly aliases: readonly string[];
  readonly models: readonly ModelReference[];
}

/** The raw JSON shape of `data/reference/vehicles.json`. */
export interface RawVehicleReference {
  readonly manufacturers: readonly {
    readonly slug: string;
    readonly name: string;
    readonly nameHe?: string;
    readonly aliases?: readonly string[];
    /** `"Corolla:קורולה|corola"` — display name, then `|`-separated aliases. */
    readonly models?: readonly string[];
  }[];
}

/** One detected vehicle mention. */
export interface VehicleMatch {
  readonly manufacturerSlug: string;
  readonly modelSlug: string | null;
}

/** Pre-computed lookup structures. Build once, reuse for every video. */
export interface VehicleIndex {
  readonly manufacturers: readonly ManufacturerReference[];
  /** Normalised alias -> manufacturer slug. */
  readonly byAlias: ReadonlyMap<string, string>;
  /** Manufacturer slug -> its models. */
  readonly modelsByManufacturer: ReadonlyMap<string, readonly ModelReference[]>;
}

/** Parse the reference JSON into typed objects, expanding the model shorthand. */
export function parseVehicleReference(raw: RawVehicleReference): ManufacturerReference[] {
  return raw.manufacturers.map((entry) => ({
    slug: entry.slug,
    name: entry.name,
    nameHe: entry.nameHe ?? null,
    aliases: uniqueNormalized([entry.name, entry.nameHe ?? '', ...(entry.aliases ?? [])]),
    models: (entry.models ?? []).map(parseModelShorthand),
  }));
}

/** `"RAV4:ראב4|rav 4"` -> `{ slug: 'rav4', name: 'RAV4', aliases: [...] }`. */
function parseModelShorthand(shorthand: string): ModelReference {
  const separator = shorthand.indexOf(':');
  const name = (separator === -1 ? shorthand : shorthand.slice(0, separator)).trim();
  const rest = separator === -1 ? '' : shorthand.slice(separator + 1);
  const extras = rest.split('|').filter((value) => value.trim().length > 0);
  const hebrew = extras.find((value) => /[\u05D0-\u05EA]/.test(value)) ?? null;

  return {
    slug: indexText(name).replace(/\s+/g, '-'),
    name,
    nameHe: hebrew?.trim() ?? null,
    aliases: uniqueNormalized([name, ...extras]),
  };
}

/** Build the lookup index. Cheap enough to do once per process. */
export function buildVehicleIndex(manufacturers: readonly ManufacturerReference[]): VehicleIndex {
  const byAlias = new Map<string, string>();
  const modelsByManufacturer = new Map<string, readonly ModelReference[]>();

  for (const manufacturer of manufacturers) {
    for (const alias of manufacturer.aliases) {
      // First writer wins, so an earlier (more common) manufacturer keeps an
      // ambiguous alias rather than a later one stealing it.
      if (!byAlias.has(alias)) byAlias.set(alias, manufacturer.slug);
    }
    modelsByManufacturer.set(manufacturer.slug, manufacturer.models);
  }

  return { manufacturers, byAlias, modelsByManufacturer };
}

/**
 * Find every manufacturer (and, where possible, model) mentioned in the text.
 *
 * @param text  Title, tags and description joined by spaces.
 * @returns One entry per manufacturer found, with the best model match or `null`.
 */
export function detectVehicles(text: string, index: VehicleIndex): VehicleMatch[] {
  const haystack = ` ${indexText(text)} `;
  const matches: VehicleMatch[] = [];

  for (const manufacturer of index.manufacturers) {
    if (!manufacturer.aliases.some((alias) => containsPhrase(haystack, alias))) continue;

    const models = index.modelsByManufacturer.get(manufacturer.slug) ?? [];
    // Longest alias first: "Range Rover Sport" should win over "Range Rover".
    const model = models
      .flatMap((candidate) => candidate.aliases.map((alias) => ({ candidate, alias })))
      .filter((entry) => containsPhrase(haystack, entry.alias))
      .sort((a, b) => b.alias.length - a.alias.length)[0]?.candidate;

    matches.push({ manufacturerSlug: manufacturer.slug, modelSlug: model?.slug ?? null });
  }

  return matches;
}

/**
 * Model years mentioned in the text, restricted to a plausible range so that
 * "300 hp" or a price does not become a year.
 */
export function detectYears(text: string, maxYear = new Date().getFullYear() + 2): number[] {
  const years = new Set<number>();
  for (const match of text.matchAll(/\b(19[5-9]\d|20[0-4]\d)\b/g)) {
    const year = Number(match[1]);
    if (year >= 1950 && year <= maxYear) years.add(year);
  }
  return [...years].sort((a, b) => a - b);
}

/** Word-boundary containment on already-normalised text. */
function containsPhrase(paddedHaystack: string, alias: string): boolean {
  if (alias.length === 0) return false;
  return paddedHaystack.includes(` ${alias} `);
}

function uniqueNormalized(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = indexText(value);
    if (normalized.length > 1) seen.add(normalized);
  }
  return [...seen];
}
