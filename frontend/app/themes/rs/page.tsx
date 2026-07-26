import Link from "next/link";
import { getThemeCatalog, getThemeRelativeStrength } from "@/lib/themes";
import { fmtPercent } from "@/lib/format";
import { byKey, SortTh, type SortDir } from "@/app/_components/SortTh";
import { RsChart } from "@/app/_components/RsChart";

export const dynamic = "force-dynamic";

type SearchParams = {
  bars?: string;
  themes?: string;
  sort?: string;
  dir?: string;
  minmembers?: string;
  cat?: string;
};

const RANGES = [
  { bars: 20, label: "1ヶ月" },
  { bars: 60, label: "3ヶ月" },
  { bars: 120, label: "6ヶ月" },
  { bars: 240, label: "12ヶ月" },
];

/** 構成銘柄が少なすぎるテーマは指数として意味を持たないので既定で除外する */
const DEFAULT_MIN_MEMBERS = 5;

export default async function ThemeRsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const bars = RANGES.some((r) => String(r.bars) === sp.bars) ? Number(sp.bars) : 60;
  const minMembers = sp.minmembers ? Number(sp.minmembers) : DEFAULT_MIN_MEMBERS;

  const [{ asOf, series: all }, catalog] = await Promise.all([
    getThemeRelativeStrength(bars),
    getThemeCatalog(),
  ]);
  const catOf = new Map(catalog.map((c) => [c.theme_code, c.category]));
  const categories = [...new Set(catalog.map((c) => c.category))].filter(Boolean);
  const cat = categories.includes(sp.cat ?? "") ? sp.cat! : "";
  // 構成銘柄が少なすぎるテーマは指数が荒れるので除外する
  const raw = all
    .filter((s) => s.count >= minMembers)
    .filter((s) => !cat || catOf.get(s.group_code) === cat);

  type Row = (typeof raw)[number];
  const PICKS: Record<string, (r: Row) => number | string | null> = {
    category: (r) => catOf.get(r.group_code) ?? "",
    name: (r) => r.group_name,
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
  const keep = {
    bars: String(bars),
    minmembers: String(minMembers),
    themes: sp.themes,
    cat,
  };

  // 既定は並べ替えキーの上位 5 / 下位 5。themes= で明示指定も可
  const picked = sp.themes
    ? sp.themes.split(",").filter(Boolean)
    : [...series.slice(0, 5), ...series.slice(-5)].map((s) => s.group_code);
  const shown = series.filter((s) => picked.includes(s.group_code));

  return (
    <>
      <div className="toolbar">
        <strong>テーマ別 相対強度 (RS)</strong>
        <span className="muted mono">基準日 {asOf ?? "—"}</span>
        <span style={{ flex: 1 }} />
        {RANGES.map((r) => (
          <Link
            key={r.bars}
            href={`/themes/rs?bars=${r.bars}&sort=${sort}&dir=${dir}`}
            className={`btn ${bars === r.bars ? "active" : ""}`}
          >
            {r.label}
          </Link>
        ))}
        <Link href={`/themes`} className="btn">
          ← ヒートマップ
        </Link>
      </div>

      <div className="toolbar" style={{ gap: 4 }}>
        <Link
          href={`/themes/rs?bars=${bars}&sort=${sort}&dir=${dir}`}
          className={`btn ${cat === "" ? "active" : ""}`}
        >
          すべて
        </Link>
        {categories.map((c) => (
          <Link
            key={c}
            href={`/themes/rs?bars=${bars}&sort=${sort}&dir=${dir}&cat=${encodeURIComponent(c)}`}
            className={`btn ${cat === c ? "active" : ""}`}
          >
            {c}
          </Link>
        ))}
      </div>

      <p className="muted" style={{ margin: "0 0 12px" }}>
        テーマ等ウェイト指数 ÷ 全銘柄等ウェイト指数 (期間開始 = 100)。100 より上 = 市場平均をアウトパフォーム。
        既定表示は並べ替えキーの上位 5 / 下位 5。
        <br />
        <strong>先週差</strong>は 5 営業日前 ({weekAgoDate ?? "—"}) と比べた RS の変化率。
        構成銘柄 {minMembers} 未満のテーマは指数が荒れるので非表示 (`?minmembers=0` で全部出る)。
      </p>

      <div className="card" style={{ padding: 12, marginBottom: 16, overflowX: "auto" }}>
        <RsChart
          series={shown.map((s) => ({ key: s.group_code, label: s.group_name, values: s.rs }))}
          dates={shown[0]?.dates ?? []}
        />
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <SortTh label="大分類" sortKey="category" sort={sort} dir={dir} basePath="/themes/rs" keep={keep} />
              <SortTh label="テーマ" sortKey="name" sort={sort} dir={dir} basePath="/themes/rs" keep={keep} />
              <SortTh label="先週差 (RS)" sortKey="week" sort={sort} dir={dir} basePath="/themes/rs" keep={keep} num />
              <SortTh label="先週比リターン" sortKey="retweek" sort={sort} dir={dir} basePath="/themes/rs" keep={keep} num />
              <SortTh label="対市場 超過" sortKey="excess" sort={sort} dir={dir} basePath="/themes/rs" keep={keep} num />
              <SortTh label="期間 RS 変化率" sortKey="period" sort={sort} dir={dir} basePath="/themes/rs" keep={keep} num />
              <SortTh label="期間リターン" sortKey="ret" sort={sort} dir={dir} basePath="/themes/rs" keep={keep} num />
              <SortTh label="RS (現在)" sortKey="rs" sort={sort} dir={dir} basePath="/themes/rs" keep={keep} num />
              <th>表示</th>
            </tr>
          </thead>
          <tbody>
            {series.length === 0 ? (
              <tr>
                <td colSpan={9} className="muted" style={{ textAlign: "center", padding: 40 }}>
                  テーマの割当がまだありません (分類バッチ未実行)
                </td>
              </tr>
            ) : (
              series.map((s) => {
                const on = picked.includes(s.group_code);
                const next = on
                  ? picked.filter((c) => c !== s.group_code)
                  : [...picked, s.group_code];
                const ret = ((s.index[s.index.length - 1] ?? 100) / 100 - 1) * 100;
                return (
                  <tr key={s.group_code} style={on ? { background: "var(--bg-hover)" } : undefined}>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {catOf.get(s.group_code) ?? "—"}
                    </td>
                    <td>
                      <Link href={`/themes/${encodeURIComponent(s.group_code)}`}>
                        {s.group_name}
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
                        href={`/themes/rs?bars=${bars}&sort=${sort}&dir=${dir}&themes=${next.join(",")}`}
                        className="btn"
                      >
                        {on ? "隠す" : "出す"}
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
