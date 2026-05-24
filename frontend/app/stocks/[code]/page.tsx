import Link from "next/link";
import { notFound } from "next/navigation";
import { getListed, getQuotes, getStockSummary } from "@/lib/queries";
import { changePct, fmtNumber, fmtPercent, fmtPrice } from "@/lib/format";
import PriceChart from "./PriceChart";

export const dynamic = "force-dynamic";

export default async function StockDetailPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  if (!/^[0-9A-Z]{4}$/.test(code)) notFound();

  const [listed, quotes, summary] = await Promise.all([
    getListed(code),
    getQuotes(code),
    getStockSummary(code),
  ]);

  if (!listed) notFound();

  const latest = quotes[quotes.length - 1] ?? null;
  const prev = quotes[quotes.length - 2] ?? null;
  const chg = changePct(latest?.close ?? null, prev?.close ?? null);
  const chgCls = chg === null ? "" : chg > 0 ? "pos" : chg < 0 ? "neg" : "";

  return (
    <>
      <div className="crumb" style={{ marginBottom: 12 }}>
        <Link href="/">← 銘柄一覧</Link>
      </div>

      <div className="card">
        <div className="stock-header">
          <span className="code mono">{listed.code}</span>
          <h1>{listed.company_name ?? "—"}</h1>
          <div className="tags">
            {listed.market_name && <span className="tag">{listed.market_name}</span>}
            {listed.sector17_name && <span className="tag">{listed.sector17_name}</span>}
            {listed.scale_category && <span className="tag">{listed.scale_category}</span>}
          </div>
        </div>

        <div className="metric-row">
          <div className="metric">
            <span className="label">終値</span>
            <span className="value">{fmtPrice(latest?.close ?? null)}</span>
          </div>
          <div className="metric">
            <span className="label">前日比</span>
            <span className={`value ${chgCls}`}>{fmtPercent(chg)}</span>
          </div>
          <div className="metric">
            <span className="label">出来高</span>
            <span className="value">{fmtNumber(latest?.volume ?? null)}</span>
          </div>
          <div className="metric">
            <span className="label">最終取引日</span>
            <span className="value">{summary.last_date ?? "—"}</span>
          </div>
          <div className="metric">
            <span className="label">期間</span>
            <span className="value" style={{ fontSize: 14 }}>
              {summary.first_date ?? "—"} 〜
            </span>
          </div>
          <div className="metric">
            <span className="label">日足本数</span>
            <span className="value">{fmtNumber(summary.row_count)}</span>
          </div>
        </div>
      </div>

      {quotes.length === 0 ? (
        <div className="empty" style={{ marginTop: 16 }}>
          この銘柄の日足データはまだ取得されていません。
          <br />
          <code>./run.sh prices-diff</code> を流すと最新まで取れます。
        </div>
      ) : (
        <PriceChart quotes={quotes} />
      )}
    </>
  );
}
