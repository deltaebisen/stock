import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stock Research",
  description: "J-Quants データの閲覧ビュー",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>
        <div className="appshell">
          <header className="topbar">
            <div className="brand">
              <Link href="/">📈 Stock Research</Link>
            </div>
            <span className="spacer" />
            <span className="crumb mono">J-Quants V2 / local</span>
          </header>
          <main className="content">{children}</main>
        </div>
      </body>
    </html>
  );
}
