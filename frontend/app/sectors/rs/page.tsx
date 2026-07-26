import Link from "next/link";
import { getSectorRelativeStrength } from "@/lib/sectors";
import { fmtPercent } from "@/lib/format";
import { byKey, SortTh, type SortDir } from "@/app/_components/SortTh";
import { RsChart } from "@/app/_components/RsChart";

export const dynamic = "force-dynamic";

type SearchParams = {
  level?: string;
  bars?: string;
  sectors?: string;
  sort?: string;
  dir?: string;
};

const RANGES = [
  { bars: 60, label: "3ヶ月" },
  { bars: 120, label: "6ヶ月" },
  { bars: 240, label: "1年" },
];

export default async function SectorRsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const level = sp.level === "sector17" ? "sector17" : "sector33";
  const bars = RANGES.some((r) => String(r.bars) === sp.bars) ? Number(sp.bars) : 120;
  const { asOf, series: raw } = await getSectorRelativeStrength(bars, level);

  type Row = (typeof raw)[number];
  const PICKS: Record<string, (r: Row) => number | string | null> = {
    name: (r) => r.sector_name,
    week: (r) => r.rsChangeWeek,
    retweek: (r) => r.retWeek,
    excess: (r) => r.excessWeek,
    period: (r) => r.rsChange,
    ret: (r) => (r.index[r.index.length - 1] ?? 100) / 100 - 1,
    rs: (r) => r.rs[r.rs.length - 1] ?? 100,
  };
  const sort = sp.sort && PICKS[sp.sort] ? sp.sort : "week";
  const dir: SortDir = sp.dir === "asc" ? "asc" : "desc";
  const series = [...raw].sort(byKey(PICKS[sort], dir));
  const weekAgoDate = series[0]?.weekAgoDate ?? null;
  const keep = { level, bars: String(bars), sectors: sp.sectors };

  // 既定は並べ替えキーの上位 5 / 下位 5。sectors= で明示指定も可
  const picked = sp.sectors
    ? sp.sectors.split(",").filter(Boolean)
    : [...series.slice(0, 5), ...series.slice(-5)].map((s) => s.sector_code);
  const shown = series.filter((s) => picked.includes(s.sector_code));

  return (
    <>
      <div className="toolbar">
        <strong>業種別 相対強度 (RS)</strong>
        <span className="muted mono">基準日 {asOf ?? "—"}</span>
        <span style={{ flex: 1 }} />
        {RANGES.map((r) => (
          <Link
            key={r.bars}
            href={`/sectors/rs?level=${level}&bars=${r.bars}&sort=${sort}&dir=${dir}`}
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
        100 より上 = 市場平均をアウトパフォーム。既定表示は並べ替えキーの上位 5 / 下位 5。
        <br />
        <strong>先週差</strong>は 5 営業日前 ({weekAgoDate ?? "—"}) と比べた RS の変化率で、
        直近 1 週間でどの業種に資金が回ってきたかを見るための列。
      </p>

      <div className="card" style={{ padding: 12, marginBottom: 16, overflowX: "auto" }}>
        <RsChart
          series={shown.map((s) => ({
            key: s.sector_code,
            label: s.sector_name,
            values: s.rs,
          }))}
          dates={shown[0]?.dates ?? []}
        />
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <SortTh label="業種" sortKey="name" sort={sort} dir={dir} basePath="/sectors/rs" keep={keep} />
              <SortTh label="先週差 (RS)" sortKey="week" sort={sort} dir={dir} basePath="/sectors/rs" keep={keep} num />
              <SortTh label="先週比リターン" sortKey="retweek" sort={sort} dir={dir} basePath="/sectors/rs" keep={keep} num />
              <SortTh label="対市場 超過" sortKey="excess" sort={sort} dir={dir} basePath="/sectors/rs" keep={keep} num />
              <SortTh label="期間 RS 変化率" sortKey="period" sort={sort} dir={dir} basePath="/sectors/rs" keep={keep} num />
              <SortTh label="期間リターン" sortKey="ret" sort={sort} dir={dir} basePath="/sectors/rs" keep={keep} num />
              <SortTh label="RS (現在)" sortKey="rs" sort={sort} dir={dir} basePath="/sectors/rs" keep={keep} num />
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
                  <td className={`num mono ${s.rsChangeWeek > 0 ? "pos" : "neg"}`}>
                    <strong>{fmtPercent(s.rsChangeWeek)}</strong>
                  </td>
                  <td className={`num mono ${s.retWeek > 0 ? "pos" : "neg"}`}>
                    {fmtPercent(s.retWeek)}
                  </td>
                  <td className={`num mono ${s.excessWeek > 0 ? "pos" : "neg"}`}>
                    {fmtPercent(s.excessWeek)}
                  </td>
                  <td className={`num mono ${s.rsChange > 0 ? "pos" : "neg"}`}>
                    {fmtPercent(s.rsChange)}
                  </td>
                  <td className={`num mono ${ret > 0 ? "pos" : "neg"}`}>{fmtPercent(ret)}</td>
                  <td className="num mono">{(s.rs[s.rs.length - 1] ?? 100).toFixed(1)}</td>
                  <td>
                    <Link
                      href={`/sectors/rs?level=${level}&bars=${bars}&sort=${sort}&dir=${dir}&sectors=${next.join(",")}`}
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
