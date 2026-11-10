/**
 * The container every chart sits in: title, subtitle, optional legend, and the
 * "Table" toggle that swaps the chart for its table twin (the accessible
 * equivalent, and where every exact value can be read without hovering).
 */
import { useState, type ReactNode } from "react";

export interface LegendItem {
  key: string;
  label: string;
  color: string;
  /** "area" swatches for bands/bars, "line" keys for lines. */
  shape: "area" | "line";
}

export interface TableSpec {
  columns: string[];
  rows: (string | number)[][];
  /** Index of columns holding numbers (right-aligned, tabular figures). */
  numeric?: number[];
}

export function ChartCard({
  title,
  subtitle,
  legend,
  controls,
  table,
  children,
  className = "",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  legend?: LegendItem[];
  controls?: ReactNode;
  table?: TableSpec;
  children: ReactNode;
  className?: string;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <figure className={`card ${className}`}>
      <div className="card-head">
        <div className="card-titles">
          <h2>{title}</h2>
          {subtitle && <p className="card-sub">{subtitle}</p>}
        </div>
        <div className="card-controls">
          {controls}
          {table && (
            <button type="button" className="chip-btn" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
              {asTable ? "Chart" : "Table"}
            </button>
          )}
        </div>
      </div>
      {legend && legend.length >= 2 && !asTable && (
        <ul className="legend">
          {legend.map((l) => (
            <li key={l.key}>
              <span className={`swatch swatch-${l.shape}`} style={{ background: l.color }} />
              {l.label}
            </li>
          ))}
        </ul>
      )}
      {asTable && table ? <DataTable spec={table} /> : children}
    </figure>
  );
}

export function DataTable({ spec }: { spec: TableSpec }) {
  const numeric = new Set(spec.numeric ?? []);
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            {spec.columns.map((c, i) => (
              <th key={i} className={numeric.has(i) ? "num" : ""}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.rows.map((r, j) => (
            <tr key={j}>
              {r.map((v, i) => (
                <td key={i} className={numeric.has(i) ? "num" : ""}>
                  {typeof v === "number" ? v.toLocaleString("en-US") : v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
