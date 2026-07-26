import Link from "next/link";
import { getSectorRelativeStrength } from "@/lib/sectors";
import { fmtPercent } from "@/lib/format";

export const dynamic = "force-dynamic";

type SearchParams = { level?: string; bars?: string; sectors?: string };

const RANGES = [
  { bars: 60, label: "3ヶ月" },
  { bars: 120, label: "6ヶ月" },
  { bars: 240, label: "1年" },
];

/** 折れ線の色 (上位 = 緑寄り / 下位 = 赤寄り) */
const LINE_COLORS = [
  "#3fb950", "#58a6ff", "#d29922", "#a371f7", "#39c5cf",
  "#f85149", "#db6d28", "#bc8cff", "#7ee787", "#ff7b72",
];

export default async function SectorRsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const level = sp.level === "sector17" ? "sector17" : "sector33";
  const bars = RANGES.some((r) => String(r.bars) === sp.bars) ? Number(sp.bars) : 120;

  const { asOf, series } = await getSectorRelativeStrength(bars, level);

  // 既定は RS 変化率の上位 5 / 下位 5。sectors= で明示指定も可
  const picked = sp.sectors
    ? sp.sectors.split(",").filter(Boolean)
    : [...series.slice(0, 5), ...series.slice(-5)].map((s) => s.sector_code);
  const shown = series.filter((s) => picked.includes(s.sector_code));

  // SVG チャート
  const W = 960;
  const H = 360;
  const PAD = { top: 16, right: 12, bottom: 24, left: 48 };
  const allVals = shown.flatMap((s) => s.rs);
  const min = allVals.length ? Math.min(...allVals) : 95;
  const max = allVals.length ? Math.max(...allVals) : 105;
  const span = max - min || 1;
  const n = shown[0]?.dates.length ?? 0;

  const x = (i: number) =>
    PAD.left + (i / Math.max(1, n - 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) =>
    PAD.top + (1 - (v - min) / span) * (H - PAD.top - PAD.bottom);

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    v: min + span * t,
    y: PAD.top + (1 - t) * (H - PAD.top - PAD.bottom),
  }));

  return (
    <>
      <div className="toolbar">
        <strong>業種別 相対強度 (RS)</strong>
        <span className="muted mono">基準日 {asOf ?? "—"}</span>
        <span style={{ flex: 1 }} />
        {RANGES.map((r) => (
          <Link
            key={r.bars}
            href={`/sectors/rs?level=${level}&bars=${r.bars}`}
            className={`btn ${bars === r.bars ? "active" : ""}`}
          >
            {r.label}
          </Link>
        ))}
        <Link href={`/sectors?level=${level}`} className="btn">
          ← ヒートマップ
        </Link>
      </div>

      <p className="muted" style={{ margin: "0 0 12px" }}>
        業種等ウェイト指数 ÷ 全銘柄等ウェイト指数 (期間開始 = 100)。
        100 より上 = 市場平均をアウトパフォーム。既定表示は RS 変化率の上位 5 / 下位 5。
      </p>

      <div className="card" style={{ padding: 12, marginBottom: 16, overflowX: "auto" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img">
          {gridLines.map((g, i) => (
            <g key={i}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
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
          {/* 100 = 市場平均 */}
          {min <= 100 && max >= 100 && (
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(100)}
              y2={y(100)}
              stroke="var(--text-dim)"
              strokeDasharray="4 4"
            />
          )}
          {shown.map((s, si) => (
            <polyline
              key={s.sector_code}
              fill="none"
              stroke={LINE_COLORS[si % LINE_COLORS.length]}
              strokeWidth={1.8}
              points={s.rs.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
            />
          ))}
          {shown[0]?.dates.length ? (
            <>
              <text x={PAD.left} y={H - 6} fill="var(--text-dim)" fontSize={11} fontFamily="monospace">
                {shown[0].dates[0]}
              </text>
              <text
                x={W - PAD.right}
                y={H - 6}
                fill="var(--text-dim)"
                fontSize={11}
                fontFamily="monospace"
                textAnchor="end"
              >
                {shown[0].dates[shown[0].dates.length - 1]}
              </text>
            </>
          ) : null}
        </svg>
        <div className="toolbar" style={{ marginTop: 8, borderTop: "1px solid var(--border-muted)", paddingTop: 8 }}>
          {shown.map((s, si) => (
            <span key={s.sector_code} className="mono" style={{ fontSize: 12 }}>
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
              {s.sector_name}
            </span>
          ))}
        </div>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>業種</th>
              <th className="num">RS 変化率</th>
              <th className="num">期間リターン</th>
              <th className="num">RS (現在)</th>
              <th>表示</th>
            </tr>
          </thead>
          <tbody>
            {series.map((s) => {
              const on = picked.includes(s.sector_code);
              const next = on
                ? picked.filter((c) => c !== s.sector_code)
                : [...picked, s.sector_code];
              const ret = ((s.index[s.index.length - 1] ?? 100) / 100 - 1) * 100;
              return (
                <tr key={s.sector_code} style={on ? { background: "var(--bg-hover)" } : undefined}>
                  <td>
                    <Link href={`/sectors/${encodeURIComponent(s.sector_code)}?level=${level}`}>
                      {s.sector_name}
                    </Link>
                  </td>
                  <td className={`num mono ${s.rsChange > 0 ? "pos" : "neg"}`}>
                    {fmtPercent(s.rsChange)}
                  </td>
                  <td className={`num mono ${ret > 0 ? "pos" : "neg"}`}>{fmtPercent(ret)}</td>
                  <td className="num mono">{(s.rs[s.rs.length - 1] ?? 100).toFixed(1)}</td>
                  <td>
                    <Link
                      href={`/sectors/rs?level=${level}&bars=${bars}&sectors=${next.join(",")}`}
                      className="btn"
                    >
                      {on ? "隠す" : "出す"}
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
