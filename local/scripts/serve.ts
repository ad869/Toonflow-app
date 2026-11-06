/**
 * 以服务器部署模式启动 Toonflow，开启可信网络（本机 + Tailscale 等同本机，其他来源拒绝）。
 *
 *   bun local/scripts/serve.ts
 *
 * 可用环境变量覆盖：TOONFLOW_SERVER_PORT（默认 3000）、TOONFLOW_TRUSTED_NETWORKS（默认 tailscale）、
 * TOONFLOW_BROWSE_ROOT（可信设备浏览目录的根，默认仓库所在磁盘的根目录）。启动前需先构建前端，见 local/readme.md。
 *
 */
import { parse, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const env = { ...process.env };
env.TOONFLOW_TRUSTED_NETWORKS ??= "tailscale";
env.TOONFLOW_BROWSE_ROOT ??= parse(root).root;
// 只用本地模型：不让上游在内置供应商更新后把云端预置（APIMart、秘塔、优云智算）装回来。
env.TOONFLOW_SKIP_CLOUD_PROVIDERS ??= "1";
// 前端静态资源 gzip 与长期缓存。
env.TOONFLOW_WEB_ROOT ??= resolve(root, "build/web");
// 常驻内存超过 512 MB 时主动完整 GC，避免大参考素材的请求连续叠加（见 local/server/memoryWatch.ts）。
env.TOONFLOW_GC_RSS_MB ??= "512";
if (env.NODE_ENV === "dev") delete env.NODE_ENV;
console.log(`可信网络：${env.TOONFLOW_TRUSTED_NETWORKS}；目录浏览根：${env.TOONFLOW_BROWSE_ROOT}`);

const server = Bun.spawn([process.execPath, "apps/server/src/index.ts"], { cwd: root, env, stdio: ["inherit", "inherit", "inherit"] });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.kill(signal));
process.exit(await server.exited);
