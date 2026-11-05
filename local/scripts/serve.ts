/**
 * 以服务器部署模式启动 Toonflow，开启可信网络（本机 + Tailscale 等同本机，其他来源拒绝）。
 *
 *   bun local/scripts/serve.ts
 *
 * 可用环境变量覆盖：TOONFLOW_SERVER_PORT（默认 3000）、TOONFLOW_TRUSTED_NETWORKS（默认 tailscale）、
 * TOONFLOW_BROWSE_ROOT（可信设备浏览目录的根，默认仓库所在磁盘的根目录）。启动前需先构建前端，见 local/readme.md。
 */
import { parse, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
process.env.TOONFLOW_TRUSTED_NETWORKS ??= "tailscale";
process.env.TOONFLOW_BROWSE_ROOT ??= parse(root).root;
// 只用本地模型：不让上游在内置供应商更新后把云端预置（APIMart、秘塔、优云智算）装回来。
process.env.TOONFLOW_SKIP_CLOUD_PROVIDERS ??= "1";
if (process.env.NODE_ENV === "dev") delete process.env.NODE_ENV;
console.log(`可信网络：${process.env.TOONFLOW_TRUSTED_NETWORKS}；目录浏览根：${process.env.TOONFLOW_BROWSE_ROOT}`);
await import("../../apps/server/src/index.ts");
