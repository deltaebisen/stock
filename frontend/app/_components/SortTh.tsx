import Link from "next/link";

/**
 * クリックで並べ替えできる <th>。
 *
 * 並べ替え状態は ?sort=&dir= の query param に持たせて Server Component 側で並べる。
 * 同じ列を再度押すと昇順 <-> 降順。数値列は初回クリックを降順にする (高い順に見たい
 * ことが多いため)。現在のキーは色と ▲▼ で示す。
 */
export type SortDir = "asc" | "desc";

export function SortTh({
  label,
  sortKey,
  sort,
  dir,
  basePath,
  keep,
  num,
}: {
  label: string;
  sortKey: string;
  sort: string;
  dir: SortDir;
  basePath: string;
  /** 並べ替え以外に引き継ぐ query param */
  keep?: Record<string, string | undefined>;
  num?: boolean;
}) {
  const active = sort === sortKey;
  const nextDir: SortDir = active ? (dir === "asc" ? "desc" : "asc") : num ? "desc" : "asc";

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(keep ?? {})) if (v) params.set(k, v);
  params.set("sort", sortKey);
  params.set("dir", nextDir);

  return (
    <th className={num ? "num" : undefined}>
      <Link
        href={`${basePath}?${params.toString()}`}
        style={{ color: active ? "var(--accent)" : "inherit" }}
      >
        {label}
        {active ? (dir === "asc" ? " ▲" : " ▼") : ""}
      </Link>
    </th>
  );
}

/** null / undefined は常に末尾に置く比較関数 */
export function byKey<T>(pick: (row: T) => number | string | null | undefined, dir: SortDir) {
  const sign = dir === "asc" ? 1 : -1;
  return (a: T, b: T) => {
    const va = pick(a);
    const vb = pick(b);
    const na = va === null || va === undefined || (typeof va === "number" && Number.isNaN(va));
    const nb = vb === null || vb === undefined || (typeof vb === "number" && Number.isNaN(vb));
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * sign;
    return String(va).localeCompare(String(vb), "ja") * sign;
  };
}
