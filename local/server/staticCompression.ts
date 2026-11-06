/**
 * 前端静态资源 gzip：上游的 express.static 不压缩，首页约 11 MB 原样传输，Tailscale 远程首次打开明显慢。
 * 由 TOONFLOW_WEB_ROOT 开启（local/scripts/serve.ts 设置），未设置时直接放行，与上游一致。
 * 带哈希文件名的 /assets/* 设为长期缓存，省去每次加载上百个重新验证请求。
 */
import type { NextFunction, Request, Response } from "express";
import { readFile, stat } from "@toonflow/file";
import { extname, resolve, sep } from "node:path";

const webRoot = process.env.TOONFLOW_WEB_ROOT ? resolve(process.env.TOONFLOW_WEB_ROOT) : undefined;
const compressible = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".map", ".txt", ".wasm"]);
// ACT: 压缩结果按“路径 + 修改时间”缓存在内存里，前端全部 JS/CSS 压缩后约 8 MB；重新构建后按新修改时间重新压缩，旧条目在下次访问同一路径时替换。
const cache = new Map<string, { mtime: number; body: Uint8Array }>();

export async function staticCompression(req: Request, res: Response, next: NextFunction) {
  if (!webRoot || (req.method !== "GET" && req.method !== "HEAD") || req.path.startsWith("/api/") || !/\bgzip\b/.test(req.get("accept-encoding") ?? "")) return next();
  const path = req.path === "/" ? "/index.html" : req.path;
  if (!compressible.has(extname(path).toLowerCase())) return next();
  let file: string;
  try { file = resolve(webRoot, `.${decodeURIComponent(path)}`); } catch { return next(); }
  if (!file.startsWith(webRoot + sep)) return next();
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return next();
  let entry = cache.get(file);
  if (!entry || entry.mtime !== info.mtimeMs) {
    entry = { mtime: info.mtimeMs, body: Bun.gzipSync(await readFile(file)) };
    cache.set(file, entry);
  }
  res.type(extname(file));
  res.set({
    "Content-Encoding": "gzip",
    Vary: "Accept-Encoding",
    "Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    "Content-Length": String(entry.body.byteLength),
  });
  if (req.method === "HEAD") return res.end();
  res.end(entry.body);
}
