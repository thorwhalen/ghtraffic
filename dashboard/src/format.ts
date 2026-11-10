/** Number formatting shared by tiles, axes, tables and tooltips. */

const full = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** 1,284 under 10,000; 12.9K / 4.2M above (the stat-tile auto-compact rule). */
export const fmtNum = (n: number): string => (Math.abs(n) < 10_000 ? full.format(Math.round(n)) : compact.format(n));

/** Always in full: 12,904. */
export const fmtFull = (n: number): string => full.format(Math.round(n));

/** Signed percentage: +12%, −3%, +0.4% for small changes. */
export function fmtPct(p: number): string {
  const abs = Math.abs(p);
  const digits = abs < 10 && abs !== Math.round(abs) ? 1 : 0;
  const s = abs.toFixed(digits);
  return p > 0 ? `+${s}%` : p < 0 ? `−${s}%` : "0%";
}

/** Signed integer: +3, −1, 0. */
export const fmtSigned = (n: number): string => (n > 0 ? `+${fmtNum(n)}` : n < 0 ? `−${fmtNum(-n)}` : "0");
