/**
 * 内存看门狗：宿主把参考素材整段读成 base64，大参考视频的请求结束后，内存往往要过很久才回收，
 * 连续几次请求会叠加到 1 GB 以上（本机实测 3×92 MB 参考连发两次，峰值 1.28 GB）。
 * 常驻内存超过 TOONFLOW_GC_RSS_MB 时主动做一次完整 GC，让下一次请求不在上一次的残留上叠加。
 * 未设置该变量时不启动，与上游一致；local/scripts/serve.ts 默认设为 512。
 */
const threshold = Number(process.env.TOONFLOW_GC_RSS_MB) * 1024 * 1024;

if (threshold > 0) {
  // ACT: 每 5 秒检查一次 RSS；单次请求内部的放大（约为素材体积的 2–3 倍）不受影响，要根治需改为按路径传递参考素材。
  setInterval(() => {
    if (process.memoryUsage.rss() > threshold) Bun.gc(true);
  }, 5000).unref();
}
