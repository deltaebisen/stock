"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const isDbError =
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|Access denied|DB_/i.test(error.message);

  return (
    <div className="error">
      <strong>{isDbError ? "DB 接続エラー" : "エラーが発生しました"}</strong>
      <pre style={{ marginTop: 8, whiteSpace: "pre-wrap", fontSize: 12 }}>
        {error.message}
      </pre>
      {isDbError && (
        <p className="muted" style={{ marginTop: 12 }}>
          .env の DB_HOST / DB_USER / DB_PASSWORD / DB_NAME を確認してください。
        </p>
      )}
      <button
        type="button"
        className="btn"
        style={{ marginTop: 16 }}
        onClick={reset}
      >
        再試行
      </button>
    </div>
  );
}
