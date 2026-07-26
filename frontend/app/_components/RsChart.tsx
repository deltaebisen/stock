/**
 * 相対強度の折れ線 (SVG)。クライアント JS 無しの Server Component。
 *
 * 100 = 市場平均と同じパフォーマンス。上に行くほどアウトパフォーム。
 */
export const LINE_COLORS = [
  "#3fb950", "#58a6ff", "#d29922", "#a371f7", "#39c5cf",
  "#f85149", "#db6d28", "#bc8cff", "#7ee787", "#ff7b72",
];

export type RsChartSeries = { key: string; label: string; values: number[] };

export function RsChart({
  series,
  dates,
  baseline = 100,
  width = 960,
  height = 360,
}: {
  series: RsChartSeries[];
  dates: string[];
  baseline?: number;
  width?: number;
  height?: number;
}) {
  const PAD = { top: 16, right: 12, bottom: 24, left: 48 };
  const allVals = series.flatMap((s) => s.values);
  const min = allVals.length ? Math.min(...allVals) : 95;
  const max = allVals.length ? Math.max(...allVals) : 105;
  const span = max - min || 1;
  const n = series[0]?.values.length ?? 0;

  const x = (i: number) => PAD.left + (i / Math.max(1, n - 1)) * (width - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - min) / span) * (height - PAD.top - PAD.bottom);

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    v: min + span * t,
    y: PAD.top + (1 - t) * (height - PAD.top - PAD.bottom),
  }));

  return (
    <>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img">
        {gridLines.map((g, i) => (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={g.y}
              y2={g.y}
              stroke="var(--border-muted)"
              strokeWidth={1}
            />
            <text x={4} y={g.y + 4} fill="var(--text-dim)" fontSize={11} fontFamily="monospace">
              {g.v.toFixed(1)}
            </text>
          </g>
        ))}
        {min <= baseline && max >= baseline && (
          <line
            x1={PAD.left}
            x2={width - PAD.right}
            y1={y(baseline)}
            y2={y(baseline)}
            stroke="var(--text-dim)"
            strokeDasharray="4 4"
          />
        )}
        {series.map((s, si) => (
          <polyline
            key={s.key}
            fill="none"
            stroke={LINE_COLORS[si % LINE_COLORS.length]}
            strokeWidth={1.8}
            points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
          />
        ))}
        {dates.length ? (
          <>
            <text x={PAD.left} y={height - 6} fill="var(--text-dim)" fontSize={11} fontFamily="monospace">
              {dates[0]}
            </text>
            <text
              x={width - PAD.right}
              y={height - 6}
              fill="var(--text-dim)"
              fontSize={11}
              fontFamily="monospace"
              textAnchor="end"
            >
              {dates[dates.length - 1]}
            </text>
          </>
        ) : null}
      </svg>
      <div
        className="toolbar"
        style={{ marginTop: 8, borderTop: "1px solid var(--border-muted)", paddingTop: 8 }}
      >
        {series.map((s, si) => (
          <span key={s.key} className="mono" style={{ fontSize: 12 }}>
            <span
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                background: LINE_COLORS[si % LINE_COLORS.length],
                marginRight: 6,
                borderRadius: 2,
              }}
            />
            {s.label}
          </span>
        ))}
      </div>
    </>
  );
}
