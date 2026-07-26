/**
 * リターン % → セル背景色。
 * saturate で飽和する幅を変えられる (業種は ±5%、値動きの大きいテーマは広めに)。
 */
export function heatStyle(v: number | null, saturate = 5): React.CSSProperties {
  if (v === null || Number.isNaN(v)) return {};
  const t = Math.max(-1, Math.min(1, v / saturate));
  const alpha = Math.abs(t) * 0.55;
  const color = t >= 0 ? "63, 185, 80" : "248, 81, 73";
  return { background: `rgba(${color}, ${alpha.toFixed(3)})` };
}
