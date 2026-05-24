import "server-only";
import mysql from "mysql2/promise";

declare global {
  var __mysqlPool: mysql.Pool | undefined;
}

export function getPool(): mysql.Pool {
  if (!global.__mysqlPool) {
    const {
      DB_HOST,
      DB_PORT = "3306",
      DB_USER,
      DB_PASSWORD,
      DB_NAME,
    } = process.env;

    if (!DB_HOST || !DB_USER || !DB_PASSWORD || !DB_NAME) {
      throw new Error(
        "DB_HOST / DB_USER / DB_PASSWORD / DB_NAME のいずれかが未設定です。.env を確認してください。",
      );
    }

    global.__mysqlPool = mysql.createPool({
      host: DB_HOST,
      port: Number(DB_PORT),
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
      enableKeepAlive: true,
      charset: "utf8mb4",
      timezone: "+09:00",
      decimalNumbers: true,
    });
  }
  return global.__mysqlPool;
}

export async function query<T = unknown>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const [rows] = await getPool().query(sql, params);
  return rows as T[];
}
