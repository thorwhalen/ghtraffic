/**
 * The view state a person can bookmark: filters, encodings and the open repo.
 *
 * One Zod schema (`FiltersSchema`) is the source of truth: the TS type, the
 * defaults, and the validation of whatever arrives in the URL hash all come
 * from it. A hand-edited or stale link with a bad value falls back to the
 * default for that field instead of breaking the page.
 */
import * as z from "zod/mini";

export const RANGES = ["7d", "30d", "90d", "1y", "all", "custom"] as const;
export const KINDS = ["views", "clones"] as const;
export const MEASURES = ["count", "uniques"] as const;
export const GRANS = ["auto", "day", "week", "month"] as const;
export const GROUPS = ["owner", "repo"] as const;
export const SORT_KEYS = ["repo", "views", "uniques", "clones", "stars", "growth"] as const;

const isoDate = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/));

/** `z.catch(schema, default)`: an invalid value in a link becomes the default, silently. */
export const FiltersSchema = z.object({
  range: z.catch(z.enum(RANGES), "90d"),
  /** Custom range bounds (used when range = custom). */
  from: z.catch(z.optional(isoDate), undefined),
  to: z.catch(z.optional(isoDate), undefined),
  kind: z.catch(z.enum(KINDS), "views"),
  measure: z.catch(z.enum(MEASURES), "count"),
  gran: z.catch(z.enum(GRANS), "auto"),
  group: z.catch(z.enum(GROUPS), "owner"),
  /** Owners/orgs to include; empty = all. */
  owners: z.catch(z.array(z.string()), []),
  /** Repos to include; empty = all (after the owner and visibility filters). */
  repos: z.catch(z.array(z.string()), []),
  /** Visibility includes: a repo shows when its kind is included. */
  pub: z.catch(z.boolean(), true),
  priv: z.catch(z.boolean(), true),
  forks: z.catch(z.boolean(), true),
  archived: z.catch(z.boolean(), true),
  /** Leaderboard sort. */
  sort: z.catch(z.enum(SORT_KEYS), "views"),
  desc: z.catch(z.boolean(), true),
  /** Leaderboard: show every row (default: the top LEADERBOARD_TOP). */
  lball: z.catch(z.boolean(), false),
  /** Leaderboard: include repos with no views and no clones in the range. */
  lbzero: z.catch(z.boolean(), false),
  /** Referrers/paths: snapshots at or before this day (default: the range end). */
  asof: z.catch(z.optional(isoDate), undefined),
  /** The repo whose detail view is open. */
  detail: z.catch(z.optional(z.string()), undefined),
});

export type Filters = z.infer<typeof FiltersSchema>;
export type FilterKey = keyof Filters;

export const DEFAULT_FILTERS: Filters = FiltersSchema.parse({});

/** Rows the leaderboard shows before "Show all". */
export const LEADERBOARD_TOP = 20;

/** Number of top repos drawn when grouping by repo (the rest fold into "Other"). */
export const TOP_REPOS = 5;
/** Max owners drawn before the tail folds into "Other". */
export const MAX_OWNER_SERIES = 7;

/** How many *scoping* filters differ from the defaults (for the "Filters (n)" badge). */
export function activeFilterCount(f: Filters): number {
  return (
    (f.owners.length ? 1 : 0) +
    (f.repos.length ? 1 : 0) +
    (["pub", "priv", "forks", "archived"] as const).filter((k) => !f[k]).length
  );
}
