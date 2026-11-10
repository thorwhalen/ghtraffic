/**
 * Ranked horizontal bars ("meter list"): a name, a bar and a figure per row,
 * largest first, one hue. Bars grow from a square baseline to a 4px rounded
 * end. Every value is printed, so nothing hides behind a hover. On a narrow
 * screen the bar drops under the name (CSS grid in styles.css).
 */
import { fmtNum } from "../format";

export interface BarItem {
  key: string;
  label: string;
  value: number;
  /** Secondary text under the name (e.g. the repos it came from). */
  note?: string;
}

export function RankedBars({ items, color = "var(--series-1)" }: { items: BarItem[]; color?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ol className="ranked">
      {items.map((it) => (
        <li key={it.key}>
          <span className="ranked-name" title={it.label}>
            {it.label}
            {it.note && <span className="ranked-note">{it.note}</span>}
          </span>
          <span className="ranked-track" aria-hidden="true">
            <span className="ranked-bar" style={{ width: `${Math.max(1, (it.value / max) * 100)}%`, background: color }} />
          </span>
          <span className="ranked-value">{fmtNum(it.value)}</span>
        </li>
      ))}
    </ol>
  );
}
