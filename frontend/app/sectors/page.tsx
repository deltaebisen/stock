import Link from "next/link";
import { getSectorReturns, PERIODS } from "@/lib/sectors";
import { fmtPercent } from "@/lib/format";

export const dynamic = "force-dynamic";

type SearchParams = { level?: string; sort?: string };

/** リターン % → セル背景色。±5% で飽和させる */
function heatStyle(v: number | null): React.CSSProperties {
  if (v === null || Number.isNaN(v)) return {};
  const t = Math.max(-1, Math.min(1, v / 5));
  const alpha = Math.abs(t) * 0.55;
  const color = t >= 0 ? "63, 185, 80" : "248, 81, 73";
  return { background: `rgba(${color}, ${alpha.toFixed(3)})` };
}

export default async function SectorsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const level = sp.level === "sector17" ? "sector17" : "sector33";
  const sortKey = PERIODS.some((p) => p.key === sp.sort) ? sp.sort! : "1m";

  const { asOf, rows, market } = await getSectorReturns(level);
  const sorted = [...rows].sort(
    (a, b) => (b.returns[sortKey] ?? -9999) - (a.returns[sortKey] ?? -9999),
  );

  return (
    <>
      <div className="toolbar">
        <strong>業種別リターン</strong>
        <span className="muted mono">基準日 {asOf ?? "—"}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <Link href={`/sectors?level=sector33&sort=${sortKey}`} className={`btn ${level === "sector33" ? "active" : ""}`}>
          33業種
        </Link>
        <Link href={`/sectors?level=sector17&sort=${sortKey}`} className={`btn ${level === "sector17" ? "active" : ""}`}>
          17業種
        </Link>
        <Link href={`/sectors/rs?level=${level}`} className="btn">
          相対強度 →
        </Link>
      </div>

      <p className="muted" style={{ margin: "0 0 12px" }}>
        各業種の構成銘柄の単純平均 (等ウェイト) リターン。分割は adjustment_factor で遡及調整済み。
        列見出しをクリックするとその期間で並べ替え。行をクリックすると構成銘柄。
      </p>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>業種</th>
              <th className="num">銘柄数</th>
              {PERIODS.map((p) => (
                <th key={p.key} className="num">
                  <Link
                    href={`/sectors?level=${level}&sort=${p.key}`}
                    style={{ color: p.key === sortKey ? "var(--accent)" : "inherit" }}
                  >
                    {p.label}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: "2px solid var(--border)" }}>
              <td>
                <strong>市場平均 (全銘柄等ウェイト)</strong>
              </td>
              <td className="num muted">—</td>
              {PERIODS.map((p) => {
                const v = market[p.key] ?? null;
                return (
                  <td key={p.key} className={`num mono ${v === null ? "" : v > 0 ? "pos" : "neg"}`}>
                    {fmtPercent(v)}
                  </td>
                );
              })}
            </tr>
            {sorted.map((r) => (
              <tr key={r.sector_code}>
                <td>
                  <Link href={`/sectors/${encodeURIComponent(r.sector_code)}?level=${level}`}>
                    {r.sector_name}
                  </Link>
                </td>
                <td className="num muted mono">{r.count}</td>
                {PERIODS.map((p) => {
                  const v = r.returns[p.key] ?? null;
                  return (
                    <td key={p.key} className="num mono" style={heatStyle(v)}>
                      {fmtPercent(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
