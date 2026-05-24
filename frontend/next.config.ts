import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // 上位ディレクトリに stray yarn.lock / package-lock.json があると Next.js が
  // workspace root を誤検出して node_modules 解決・file watching・asset path が
  // 全部ズレるので、明示的にこの frontend/ 配下を root と宣言する。
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
