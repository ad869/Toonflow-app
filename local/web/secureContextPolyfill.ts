/**
 * 通过 http://<局域网或 Tailscale IP> 访问时，页面不是安全上下文，浏览器不提供 crypto.randomUUID，前端会启动失败。
 * 用任何上下文都可用的 getRandomValues 补齐 RFC 4122 v4 UUID。必须在其他模块之前执行，因此是 main.ts 的第一个 import。
 * 剪贴板、麦克风等其他仅限安全上下文的能力无法补齐，需要时请改用 HTTPS（见 local/readme.md）。
 */
if (typeof globalThis.crypto?.randomUUID !== "function" && typeof globalThis.crypto?.getRandomValues === "function") {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    writable: true,
    value() {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = bytes[6]! & 0x0f | 0x40;
      bytes[8] = bytes[8]! & 0x3f | 0x80;
      const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  });
}

export {};
