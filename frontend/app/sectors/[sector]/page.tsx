import Link from "next/link";
import { getSectorConstituents } from "@/lib/sectors";
import { fmtNumber, fmtPercent, fmtPrice } from "@/lib/format";

export const dynamic = "force-dynamic";

const RANGES = [
  { bars: 5, label: "1週" },
  { bars: 20, label: "1ヶ月" },
  { bars: 60, label: "3ヶ月" },
  { bars: 120, label: "6ヶ月" },
  { bars: 240, label: "1年" },
];

export default async function SectorDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ sector: string }>;
  searchParams: Promise<{ level?: string; bars?: string }>;
}) {
  const { sector } = await params;
  const sp = await searchParams;
  const level = sp.level === "sector17" ? "sector17" : "sector33";
  const bars = RANGES.some((r) => String(r.bars) === sp.bars) ? Number(sp.bars) : 20;

  const { asOf, sectorName, rows } = await getSectorConstituents(
    decodeURIComponent(sector),
    bars,
    level,
  );

  const valid = rows.filter((r) => r.ret !== null);
  const avg = valid.length ? valid.reduce((s, r) => s + (r.ret ?? 0), 0) / valid.length : null;
  const up = valid.filter((r) => (r.ret ?? 0) > 0).length;

  return (
    <>
      <div className="toolbar">
        <strong>{sectorName ?? sector}</strong>
        <span className="muted mono">基準日 {asOf ?? "—"}</span>
        <span style={{ flex: 1 }} />
        {RANGES.map((r) => (
          <Link
            key={r.bars}
            href={`/sectors/${encodeURIComponent(sector)}?level=${level}&bars=${r.bars}`}
            className={`btn ${bars === r.bars ? "active" : ""}`}
          >
            {r.label}
          </Link>
        ))}
        <Link href={`/sectors?level=${level}`} className="btn">
          ← 一覧
        </Link>
      </div>

      <div className="toolbar" style={{ gap: 24 }}>
        <span>
          構成銘柄 <strong className="mono">{rows.length}</strong>
        </span>
        <span>
          等ウェイト平均{" "}
          <strong className={`mono ${(avg ?? 0) > 0 ? "pos" : "neg"}`}>{fmtPercent(avg)}</strong>
        </span>
        <span>
          上昇{" "}
          <strong className="mono">
            {up} / {valid.length}
          </strong>
          <span className="muted">
            {" "}
            ({valid.length ? ((up / valid.length) * 100).toFixed(0) : "—"}%)
          </span>
        </span>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>コード</th>
              <th>銘柄名</th>
              <th>市場</th>
              <th>規模</th>
              <th className="num">終値</th>
              <th className="num">期間リターン</th>
              <th className="num">平均売買代金</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted" style={{ textAlign: "center", padding: 40 }}>
                  該当する銘柄はありません
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.code}>
                  <td className="mono">
                    <Link href={`/stocks/${r.code}`}>{r.code}</Link>
                  </td>
                  <td>{r.company_name ?? "—"}</td>
                  <td className="muted">{r.market_name ?? "—"}</td>
                  <td className="muted">{r.scale_category ?? "—"}</td>
                  <td className="num mono">{fmtPrice(r.last_close)}</td>
                  <td
                    className={`num mono ${r.ret === null ? "" : r.ret > 0 ? "pos" : "neg"}`}
                  >
                    {fmtPercent(r.ret)}
                  </td>
                  <td className="num mono muted">
                    {r.avg_turnover === null ? "—" : fmtNumber(Math.round(r.avg_turnover / 1e6)) + "M"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
