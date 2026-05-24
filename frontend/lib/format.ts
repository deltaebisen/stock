export function fmtNumber(
  v: number | null | undefined,
  digits: number = 0,
): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toLocaleString("ja-JP", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtPercent(
  v: number | null | undefined,
  digits: number = 2,
): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

export function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toLocaleString("ja-JP", {
    minimumFractionDigits: v < 100 ? 2 : 0,
    maximumFractionDigits: v < 100 ? 2 : 0,
  });
}

export function changePct(
  current: number | null,
  prev: number | null,
): number | null {
  if (current === null || prev === null || prev === 0) return null;
  return ((current - prev) / prev) * 100;
}
