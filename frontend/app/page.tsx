import Link from "next/link";
import { getFacets, searchListed } from "@/lib/queries";
import { changePct, fmtNumber, fmtPercent, fmtPrice } from "@/lib/format";

export const dynamic = "force-dynamic";

type SearchParams = {
  q?: string;
  market?: string;
  sector17?: string;
  page?: string;
};

const PAGE_SIZE = 50;

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? "1") || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const [facets, result] = await Promise.all([
    getFacets(),
    searchListed({
      q: sp.q?.trim() || undefined,
      market: sp.market || undefined,
      sector17: sp.sector17 || undefined,
      limit: PAGE_SIZE,
      offset,
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));

  return (
    <>
      <form className="toolbar" method="GET" action="/">
        <input
          type="search"
          name="q"
          placeholder="コード / 銘柄名で検索 (例: 7203, トヨタ)"
          defaultValue={sp.q ?? ""}
          className="grow"
        />
        <select name="market" defaultValue={sp.market ?? ""}>
          <option value="">市場: すべて</option>
          {facets.markets.map((m) => (
            <option key={m.code} value={m.code}>
              {m.name} ({m.count})
            </option>
          ))}
        </select>
        <select name="sector17" defaultValue={sp.sector17 ?? ""}>
          <option value="">業種: すべて</option>
          {facets.sector17.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name} ({s.count})
            </option>
          ))}
        </select>
        <button type="submit" className="btn primary">
          検索
        </button>
        {(sp.q || sp.market || sp.sector17) && (
          <Link href="/" className="btn">
            リセット
          </Link>
        )}
      </form>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>コード</th>
              <th>銘柄名</th>
              <th>市場</th>
              <th>業種</th>
              <th>規模</th>
              <th className="num">終値</th>
              <th className="num">前日比</th>
              <th>最終日</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="muted" style={{ textAlign: "center", padding: 40 }}>
                  該当する銘柄はありません
                </td>
              </tr>
            ) : (
              result.rows.map((r) => {
                const chg = changePct(r.last_close, r.prev_close);
                const cls = chg === null ? "" : chg > 0 ? "pos" : chg < 0 ? "neg" : "";
                return (
                  <tr key={r.code}>
                    <td className="mono">
                      <Link href={`/stocks/${r.code}`}>{r.code}</Link>
                    </td>
                    <td>{r.company_name ?? "—"}</td>
                    <td className="muted">{r.market_name ?? "—"}</td>
                    <td className="muted">{r.sector17_name ?? "—"}</td>
                    <td className="muted">{r.scale_category ?? "—"}</td>
                    <td className="num mono">{fmtPrice(r.last_close)}</td>
                    <td className={`num mono ${cls}`}>{fmtPercent(chg)}</td>
                    <td className="muted mono">{r.last_date ?? "—"}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <span>
          {fmtNumber(result.total)} 件中 {fmtNumber(offset + 1)}–
          {fmtNumber(Math.min(offset + PAGE_SIZE, result.total))} を表示
        </span>
        <span className="pages">
          <PageLink sp={sp} page={page - 1} disabled={page <= 1} label="← 前" />
          <span className="muted" style={{ padding: "6px 8px" }}>
            {page} / {totalPages}
          </span>
          <PageLink
            sp={sp}
            page={page + 1}
            disabled={page >= totalPages}
            label="次 →"
          />
        </span>
      </div>
    </>
  );
}

function PageLink({
  sp,
  page,
  disabled,
  label,
}: {
  sp: SearchParams;
  page: number;
  disabled: boolean;
  label: string;
}) {
  if (disabled) {
    return (
      <span className="btn" style={{ opacity: 0.4, pointerEvents: "none" }}>
        {label}
      </span>
    );
  }
  const params = new URLSearchParams();
  if (sp.q) params.set("q", sp.q);
  if (sp.market) params.set("market", sp.market);
  if (sp.sector17) params.set("sector17", sp.sector17);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return (
    <Link href={qs ? `/?${qs}` : "/"} className="btn">
      {label}
    </Link>
  );
}
