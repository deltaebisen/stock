import "server-only";
import { query } from "./db";

export type ListedRow = {
  code: string;
  company_name: string | null;
  company_name_english: string | null;
  sector17_code: string | null;
  sector17_name: string | null;
  sector33_code: string | null;
  sector33_name: string | null;
  scale_category: string | null;
  market_code: string | null;
  market_name: string | null;
};

export type ListedRowWithLatest = ListedRow & {
  last_date: string | null;
  last_close: number | null;
  prev_close: number | null;
};

export type ListedSearchParams = {
  q?: string;
  market?: string;
  sector17?: string;
  limit?: number;
  offset?: number;
  sort?: string;
  dir?: string;
};

/**
 * 一覧の並べ替えキー -> ORDER BY 式。
 * SQL に文字列を差し込むので、必ずこの辞書に載っているキーだけを使う (SQL injection 対策)。
 * 前日比は SQL 側で計算した式でソートする (画面の表示値と一致させるため)。
 */
const LISTED_SORTS: Record<string, string> = {
  code: "li.code",
  name: "li.company_name",
  market: "li.market_name",
  sector: "li.sector17_name",
  scale: "li.scale_category",
  close: "latest.last_close",
  change: "(latest.last_close - latest.prev_close) / NULLIF(latest.prev_close, 0)",
  date: "latest.last_date",
};

export type ListedSearchResult = {
  rows: ListedRowWithLatest[];
  total: number;
};

export async function searchListed(
  params: ListedSearchParams,
): Promise<ListedSearchResult> {
  const where: string[] = [];
  const args: unknown[] = [];

  if (params.q) {
    where.push("(li.code LIKE ? OR li.company_name LIKE ? OR li.company_name_english LIKE ?)");
    const pat = `%${params.q}%`;
    args.push(pat, pat, pat);
  }
  if (params.market) {
    where.push("li.market_code = ?");
    args.push(params.market);
  }
  if (params.sector17) {
    where.push("li.sector17_code = ?");
    args.push(params.sector17);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);

  const orderExpr = LISTED_SORTS[params.sort ?? "code"] ?? LISTED_SORTS.code;
  const dir = params.dir?.toLowerCase() === "desc" ? "DESC" : "ASC";

  // 最新の close と、その前営業日の close をサブクエリで取得 (騰落率計算用)
  const rows = await query<ListedRowWithLatest>(
    `
    SELECT
      li.code,
      li.company_name,
      li.company_name_english,
      li.sector17_code,
      li.sector17_name,
      li.sector33_code,
      li.sector33_name,
      li.scale_category,
      li.market_code,
      li.market_name,
      latest.last_date,
      latest.last_close,
      latest.prev_close
    FROM listed_info li
    LEFT JOIN (
      SELECT
        code,
        MAX(trade_date) AS last_date,
        SUBSTRING_INDEX(GROUP_CONCAT(close ORDER BY trade_date DESC), ',', 1) + 0 AS last_close,
        SUBSTRING_INDEX(SUBSTRING_INDEX(GROUP_CONCAT(close ORDER BY trade_date DESC), ',', 2), ',', -1) + 0 AS prev_close
      FROM (
        SELECT code, trade_date, close
        FROM daily_quotes
        WHERE trade_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
      ) recent
      GROUP BY code
    ) latest ON latest.code = li.code
    ${whereSql}
    ORDER BY (${orderExpr}) IS NULL, ${orderExpr} ${dir}${orderExpr === "li.code" ? "" : ", li.code ASC"}
    LIMIT ${limit} OFFSET ${offset}
    `,
    args,
  );

  const totalRows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM listed_info li ${whereSql}`,
    args,
  );

  return { rows, total: Number(totalRows[0]?.n ?? 0) };
}

export async function getListed(code: string): Promise<ListedRow | null> {
  const rows = await query<ListedRow>(
    `SELECT code, company_name, company_name_english,
            sector17_code, sector17_name, sector33_code, sector33_name,
            scale_category, market_code, market_name
       FROM listed_info WHERE code = ? LIMIT 1`,
    [code],
  );
  return rows[0] ?? null;
}

export type Quote = {
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjustment_open: number | null;
  adjustment_high: number | null;
  adjustment_low: number | null;
  adjustment_close: number | null;
  adjustment_volume: number | null;
};

export async function getQuotes(
  code: string,
  fromDate?: string,
): Promise<Quote[]> {
  const args: unknown[] = [code];
  let where = "WHERE code = ?";
  if (fromDate) {
    where += " AND trade_date >= ?";
    args.push(fromDate);
  }
  return query<Quote>(
    `SELECT DATE_FORMAT(trade_date, '%Y-%m-%d') AS trade_date,
            open, high, low, close, volume,
            adjustment_open, adjustment_high, adjustment_low, adjustment_close, adjustment_volume
       FROM daily_quotes ${where}
       ORDER BY trade_date ASC`,
    args,
  );
}

export type FacetOption = { code: string; name: string; count: number };

export async function getFacets(): Promise<{
  markets: FacetOption[];
  sector17: FacetOption[];
}> {
  const markets = await query<FacetOption>(
    `SELECT market_code AS code, COALESCE(market_name, market_code) AS name, COUNT(*) AS count
       FROM listed_info
      WHERE market_code IS NOT NULL
      GROUP BY market_code, market_name
      ORDER BY count DESC`,
  );
  const sector17 = await query<FacetOption>(
    `SELECT sector17_code AS code, COALESCE(sector17_name, sector17_code) AS name, COUNT(*) AS count
       FROM listed_info
      WHERE sector17_code IS NOT NULL
      GROUP BY sector17_code, sector17_name
      ORDER BY count DESC`,
  );
  return { markets, sector17 };
}

export type StockSummary = {
  first_date: string | null;
  last_date: string | null;
  row_count: number;
};

export async function getStockSummary(code: string): Promise<StockSummary> {
  const rows = await query<{
    first_date: string | null;
    last_date: string | null;
    n: number;
  }>(
    `SELECT DATE_FORMAT(MIN(trade_date), '%Y-%m-%d') AS first_date,
            DATE_FORMAT(MAX(trade_date), '%Y-%m-%d') AS last_date,
            COUNT(*) AS n
       FROM daily_quotes WHERE code = ?`,
    [code],
  );
  const r = rows[0];
  return {
    first_date: r?.first_date ?? null,
    last_date: r?.last_date ?? null,
    row_count: Number(r?.n ?? 0),
  };
}
