/**
 * 把 local/providers 下的媒体供应商装进正在运行的 Toonflow，并把 Magpie 写成文本模型供应商。
 *
 *   bun local/scripts/install.ts                      # 默认 http://127.0.0.1:3000
 *   bun local/scripts/install.ts --server http://127.0.0.1:3311 --magpie http://127.0.0.1:3425/v1
 *   bun local/scripts/install.ts --skip-text          # 只装媒体供应商
 *   bun local/scripts/install.ts --keep-cloud         # 保留上游预装的云端媒体供应商（默认卸载未配置的）
 *
 * 只走 Toonflow 自己的接口（与设置页相同的校验与写入），不直接改数据目录，桌面版和源码版都适用。
 * 已安装的同名供应商会被覆盖为本目录中的版本；其他供应商与设置保持不变。
 */
import { readdir, readFile } from "@toonflow/file";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};
const server = option("server", process.env.TOONFLOW_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const magpie = option("magpie", "http://127.0.0.1:3425/v1").replace(/\/+$/, "");
const providersDirectory = resolve(import.meta.dirname, "../providers");
// 设置与供应商源码接口只接受 Toonflow 页面发起的请求。
const appHeaders = { Origin: server, "x-toonflow-workspace": "1", "Content-Type": "application/json" };

async function api<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`${server}/api${path}`, { ...init, headers: { ...appHeaders, ...init.headers } });
  const body = await response.json().catch(() => ({})) as { data?: T; message?: string };
  if (!response.ok) throw Object.assign(new Error(`${path}：HTTP ${response.status} ${body.message ?? ""}`), { status: response.status });
  return body.data as T;
}

// 上游首次启动时预装的云端媒体供应商。未配置密钥时本来就不可用，但会让 Agent 优先推荐“同款”云端模型，因此卸载。
const cloudPresets = ["apiMart.ts", "compshare.ts", "metaso.ts"];

async function removeCloudPresets() {
  const installed = await api<{ fileName: string; revision: string }[]>("/providers/media/list");
  const settings = await api<{ mediaProviderConfigs?: Record<string, Record<string, unknown>> }>("/settings/get");
  for (const provider of installed.filter(item => cloudPresets.includes(item.fileName))) {
    const config = settings.mediaProviderConfigs?.[provider.fileName.slice(0, -3)] ?? {};
    if (Object.values(config).some(value => typeof value === "string" ? value.trim() : value != null)) {
      console.log(`保留云端供应商 ${provider.fileName}：已填写配置`);
      continue;
    }
    await api("/providers/media/delete", { method: "DELETE", body: JSON.stringify({ fileName: provider.fileName, revision: provider.revision }) });
    console.log(`已卸载未配置的云端供应商 ${provider.fileName}（源文件在 packages/providers/src/media，可随时重新导入）`);
  }
}

async function installMediaProviders() {
  const installed = await api<{ fileName: string; revision: string }[]>("/providers/media/list");
  for (const fileName of (await readdir(providersDirectory)).filter(name => name.endsWith(".ts")).sort()) {
    const source = await readFile(join(providersDirectory, fileName), "utf8");
    const current = installed.find(item => item.fileName === fileName);
    if (!current) await api("/providers/media/add", { method: "POST", body: JSON.stringify({ source }) });
    else await api("/providers/media/save", { method: "PUT", body: JSON.stringify({ fileName, source, revision: current.revision }) });
    console.log(`${current ? "已更新" : "已安装"}媒体供应商 ${fileName}`);
  }
}

type MagpieModel = { id: string; display_name?: string; magpie_label?: string; context_window?: number; max_output_tokens?: number;
  reasoning?: boolean; reasoning_levels?: string[]; modalities?: { output?: string[] } };

async function installTextProvider() {
  const response = await fetch(`${magpie}/models`, { headers: { Authorization: "Bearer magpie" } }).catch(cause => {
    throw new Error(`无法连接 Magpie（${magpie}），请先启动 magpie serve`, { cause });
  });
  if (!response.ok) throw new Error(`Magpie 模型列表 HTTP ${response.status}`);
  const levels = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const models = ((await response.json()) as { data: MagpieModel[] }).data
    .filter(model => !model.modalities?.output || model.modalities.output.includes("text"))
    .map(model => {
      const supported = model.reasoning ? (model.reasoning_levels ?? []).filter(level => levels.includes(level)) : [];
      return {
        id: model.id, label: model.magpie_label ?? model.display_name ?? model.id,
        ...(model.context_window ? { contextWindow: model.context_window } : {}),
        ...(model.max_output_tokens ? { maxOutputTokens: model.max_output_tokens } : {}),
        reasoningEfforts: supported.length ? Object.fromEntries(supported.map(level => [level, level])) : false as const,
      };
    });
  const settings = await api<Record<string, unknown>>("/settings/get");
  const { multiTenantEnabled: _, ...saved } = settings;
  const provider = { id: "magpie", label: "Magpie", apiUrl: magpie, apiKey: "magpie", protocol: "openai-completions", models };
  const others = (Array.isArray(saved.customProviders) ? saved.customProviders : []).filter(item => item?.id !== "magpie");
  await api("/settings/save", { method: "PUT", body: JSON.stringify({ settings: { ...saved, customProviders: [...others, provider] } }) });
  console.log(`已写入文本供应商 Magpie（${models.length} 个模型）`);
}

await installMediaProviders();
if (!args.includes("--keep-cloud")) await removeCloudPresets();
if (!args.includes("--skip-text")) await installTextProvider();
