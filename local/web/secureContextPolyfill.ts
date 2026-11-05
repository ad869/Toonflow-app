/**
 * 通过 http://<局域网或 Tailscale IP> 访问时，页面不是安全上下文，浏览器不提供 crypto.randomUUID 与 crypto.subtle：
 * 前者让前端无法启动，后者让 Agent 的画布查询工具（canvasQueries.ts 的 SHA-256 摘要）全部失败。
 * 这里用任何上下文都可用的 getRandomValues 补齐 UUID，并用纯 JS 补齐 subtle.digest("SHA-256")，其他算法和方法仍不可用。
 * 必须在其他模块之前执行，因此是 main.ts 的第一个 import。
 * 剪贴板、麦克风等其他仅限安全上下文的能力无法补齐，需要时请改用 HTTPS（见 local/readme.md）。
 */
const sha256Constants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(input: Uint8Array) {
  const length = input.length;
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(input);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, length * 8 >>> 0);
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  const rotate = (value: number, bits: number) => value >>> bits | value << 32 - bits;
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15]!, b = words[index - 2]!;
      words[index] = words[index - 16]! + (rotate(a, 7) ^ rotate(a, 18) ^ a >>> 3) + words[index - 7]! + (rotate(b, 17) ^ rotate(b, 19) ^ b >>> 10);
    }
    let [a, b, c, d, e, f, g, h] = hash as unknown as number[];
    for (let index = 0; index < 64; index++) {
      const t1 = h! + (rotate(e!, 6) ^ rotate(e!, 11) ^ rotate(e!, 25)) + (e! & f! ^ ~e! & g!) + sha256Constants[index]! + words[index]! >>> 0;
      const t2 = (rotate(a!, 2) ^ rotate(a!, 13) ^ rotate(a!, 22)) + (a! & b! ^ a! & c! ^ b! & c!) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, d! + t1 >>> 0, c, b, a, t1 + t2 >>> 0];
    }
    [a, b, c, d, e, f, g, h].forEach((value, index) => { hash[index] = hash[index]! + value! >>> 0; });
  }
  const output = new DataView(new ArrayBuffer(32));
  hash.forEach((value, index) => output.setUint32(index * 4, value));
  return output.buffer;
}

function bytesOf(data: BufferSource) {
  return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

if (globalThis.crypto && !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis.crypto, "subtle", {
    configurable: true,
    value: {
      async digest(algorithm: AlgorithmIdentifier, data: BufferSource) {
        const name = typeof algorithm === "string" ? algorithm : algorithm.name;
        if (name.toUpperCase() !== "SHA-256") throw new DOMException(`非 HTTPS 访问时只支持 SHA-256：${name}`, "NotSupportedError");
        return sha256(bytesOf(data));
      },
    },
  });
}

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
