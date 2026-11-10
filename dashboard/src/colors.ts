/**
 * Which series gets which colour.
 *
 * The hex values live in styles.css as `--series-1..8` (light and dark steps of
 * the dataviz reference palette, validated with its six-checks script); here we
 * only decide the SLOT, by these rules:
 *
 * - Colour follows the entity, never its rank in the current view: a slot comes
 *   from the entity's all-time rank in the whole dataset, so filtering never
 *   repaints a survivor.
 * - Hues are never generated or cycled past 8: an entity whose all-time rank
 *   has no slot borrows a slot nobody on screen is using; "Other" is grey.
 */
export const SLOT_COUNT = 8;

/** CSS colour of a slot (1-based custom properties defined in styles.css). */
export const slotColor = (slot: number): string => `var(--series-${slot + 1})`;
export const OTHER_COLOR = "var(--series-other)";

/**
 * Map each visible key to a slot (0..7). `rank` is the stable, all-time order
 * (owner or repo rank). Keys absent from `rank` sort after ranked ones.
 */
export function assignSlots(keys: string[], rank: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Set<number>();
  const unplaced: string[] = [];
  for (const k of keys) {
    const r = rank.get(k);
    if (r !== undefined && r < SLOT_COUNT && !used.has(r)) {
      out.set(k, r);
      used.add(r);
    } else unplaced.push(k);
  }
  let next = 0;
  for (const k of unplaced) {
    while (next < SLOT_COUNT && used.has(next)) next++;
    if (next >= SLOT_COUNT) break; // more than 8 visible: callers fold the tail into "Other" first
    out.set(k, next);
    used.add(next);
  }
  return out;
}
