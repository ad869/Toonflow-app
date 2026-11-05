/**
 * Magpie 本地网关图片适配器
 *
 * Magpie（https://usemagpie.ai）在本机 127.0.0.1:3425 提供 OpenAI 兼容网关，可直接使用 ChatGPT（Codex）订阅出图：
 * - 文生图：POST /v1/images/generations，返回 b64_json
 * - 参考图编辑：POST /v1/images/edits（multipart，image[] 可多张），返回 b64_json
 * 模型名使用 Magpie 的 provider/model 写法，例如 codex/gpt-image-2；Magpie 中添加的其他图片模型可在界面里直接新增。
 */

const rules = [
  {
    type: "input",
    field: "baseUrl" as const,
    title: "Magpie 地址",
    value: "http://127.0.0.1:3425/v1",
    props: { placeholder: "http://127.0.0.1:3425/v1" },
  },
  {
    type: "input",
    field: "apiKey" as const,
    title: "网关密钥",
    value: "magpie",
    props: { type: "password", showPassword: true, autocomplete: "off", placeholder: "本机访问可填任意值；远程访问填 Magpie 网关密钥" },
  },
] as const;

const version = "1.0.0";

const sizes: Record<string, string> = { landscape: "1536x1024", portrait: "1024x1536", square: "1024x1024" };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Magpie 响应格式错误");
  return value as Record<string, unknown>;
}

function apiUrl(baseUrl: string | undefined) {
  const url = new URL(baseUrl?.trim() || "http://127.0.0.1:3425/v1");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/v1";
  if (url.pathname === "/") url.pathname = "/v1";
  return url.href.replace(/\/+$/, "");
}

/** gpt-image 只接受三种画布；比例写进提示词，由模型按比例构图。 */
function imageSize(request: ImageRequest) {
  if (request.size && /^\d+x\d+$/.test(request.size)) return request.size;
  const match = request.ratio?.match(/^(\d+):(\d+)$/);
  if (!match) return "auto";
  const ratio = Number(match[1]) / Number(match[2]);
  return sizes[ratio > 1.1 ? "landscape" : ratio < 0.9 ? "portrait" : "square"]!;
}

function imagePrompt(request: ImageRequest) {
  const prompt = request.prompt.replace(/\{\{ref (\d+)\}\}/g, (_marker, number: string) => `图${number}`);
  return request.ratio ? `${prompt}\n\n画面比例：${request.ratio}` : prompt;
}

async function bytesOf(context: ProviderContext, input: MediaInput) {
  if (input.type === "binary") return input.data;
  if (input.type === "base64") return new Uint8Array(Buffer.from(input.data.replace(/^data:[^;]+;base64,/, ""), "base64"));
  const response = await context.tool.fetch(input.url);
  if (!response.ok) throw new Error(`读取参考图失败：HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function imageAssets(result: Record<string, unknown>): MediaAsset[] {
  const items = Array.isArray(result.data) ? result.data.map(object) : [];
  const assets = items.flatMap((item): MediaAsset[] => {
    if (typeof item.b64_json === "string" && item.b64_json) return [{ mediaType: "image", type: "base64", data: item.b64_json, mimeType: "image/png" }];
    if (typeof item.url === "string" && item.url) return [{ mediaType: "image", type: "url", url: item.url }];
    return [];
  });
  if (!assets.length) throw new Error("Magpie 未返回图片");
  return assets;
}

export default {
  id: "magpie",
  label: "Magpie（本地网关）",
  version,
  readme: `## Magpie 本地网关

通过本机 [Magpie](https://usemagpie.ai) 网关出图，默认使用 ChatGPT 订阅中的 \`codex/gpt-image-2\`，不需要 OpenAI API Key。

1. 安装并启动 Magpie（\`magpie serve\` 或桌面版），确认已登录 Codex / ChatGPT。
2. 默认地址 \`http://127.0.0.1:3425/v1\`，本机访问密钥可填任意值。
3. 有参考图时自动走 \`/images/edits\`，参考图按顺序对应提示词中的 图1、图2……`,
  rules,
  models: [
    {
      id: "codex/gpt-image-2",
      label: "GPT Image 2（Codex 订阅）",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"],
    },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const baseUrl = apiUrl(this.config.baseUrl);
    const headers = { Authorization: `Bearer ${this.config.apiKey?.trim() || "magpie"}` };
    // ACT: Codex 出图通常 15–90 秒；单次最多等待 10 分钟。
    const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const fields = { model: request.model, prompt: imagePrompt(request), size: imageSize(request), n: String(request.n ?? 1) };
    let response: Response;
    if (request.images?.length) {
      const boundary = `----toonflow${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
      const parts: BlobPart[] = Object.entries(fields).map(([name, value]) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
      for (const [index, image] of request.images.entries()) {
        const mimeType = image.mimeType ?? "image/png";
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="reference${index + 1}.${mimeType.split("/")[1] || "png"}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
          new Uint8Array(await bytesOf(this, image)), "\r\n");
      }
      parts.push(`--${boundary}--\r\n`);
      response = await this.tool.fetch(`${baseUrl}/images/edits`, {
        method: "POST", headers: { ...headers, "Content-Type": `multipart/form-data; boundary=${boundary}` }, body: new Blob(parts), signal,
      });
    } else {
      response = await this.tool.fetch(`${baseUrl}/images/generations`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, n: request.n ?? 1 }), signal,
      });
    }
    if (!response.ok) throw new Error(`Magpie 出图失败：HTTP ${response.status}`);
    return imageAssets(object(await response.json()));
  },
} satisfies ProviderDefinition<typeof rules>;
