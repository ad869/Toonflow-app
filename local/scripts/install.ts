/**
 * 把 local/providers 下的媒体供应商装进正在运行的 Toonflow，把 Magpie 写成文本模型供应商，
 * 写入本机 H3 版 workflow 技能，并关闭匿名数据上报。
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

// workflow 技能：以上游 packages/skills/workflow/SKILL.md 为底，只把写死 Seedance 的几节换成本机 H3 版本。
// 每处替换用上游原文定位，从 start（含）替换到 end（不含）；上游改了这些原文时安装直接报错，提示重新核对替换内容。
const skillDirectory = resolve(import.meta.dirname, "../skills/workflow");
const skillOverrides: { target?: string; start: string; end: string; content?: string; file?: string }[] = [
  { start: "description: ", end: "metadata:", content: "description: 在 Toonflow 当前画布中把创意、小说或定稿剧本制作成可查看的文本、图片资产和视频片段；视频由本机 ComfyUI 上的 MiniMax H3 生成。支持复用素材、续作与局部修改。用于实际制作或继续已有项目；明确只要对话文字时不操作画布，讨论或编辑技能本身时不启动制作。\n" },
  { start: "  displayName: ", end: "  author: ", content: "  displayName: 视频制作工作流（本机 H3）\n" },
  { start: "| 已定稿剧本 / 时间轴 + 当前目标是制作、生成、继续或修订视频 |", end: "| 已定稿剧本 / 时间轴 + 仅要求资产", content: "| 已定稿剧本 / 时间轴 + 当前目标是制作、生成、继续或修订视频 | 进入下方「本机视频路由」，按 PART A 规划全片，用 A9 的 H3 模板写提示词；**不询问目标模型**。 |\n" },
  { start: "| Seedance 任务中用户未指定模型 |", end: "| 续集或已有制作 |", content: "" },
  { start: "> **Seedance 提示词生成规则已直接嵌入本 workflow", end: "### Seedance 路由锁存", content: "> 视频提示词规则直接嵌入本 workflow（下方 PART A），不调用其他 Skill。PART A 中的 Seedance 规格已由「本机 H3 能力与映射」替换。\n\n" },
  { start: "### Seedance 路由锁存", end: "## Seedance 提示词生成的内嵌执行核心", file: "routing.md" },
  { start: "## Seedance 提示词生成的内嵌执行核心", end: "# PART A — 执行规则", file: "mapping.md" },
  { start: "1. **目标模型** —— 用户说 2.5", end: "2. **总时长要求**", content: "1. **目标模型** —— 固定为本机 H3（`comfyui / h3PikaFast`，画质优先时用 `h3Pika`），单段 4–15 整数秒；不询问用户。\n" },
  { start: "**单段硬上限：**", end: "当用户给出严格总时长时", content: "**单段硬上限：** 本机 H3 每段 4–15 整数秒（下文“Seedance 2.0”的 15s 示例同样适用；所有 30s 上限不适用）。\n\n" },
  { start: "### A1.2.1 Seedance 2.5 参考图片绑定（强制）", end: "### A1.3 ", file: "referenceBinding.md" },
  { start: "## A9. 分段提示词模板（按模型路由）", end: "## A10. 全片输出结构", file: "template.md" },
  { start: "### A12.17.1 参考图片绑定完整性（Seedance 2.5）", end: "### A12.18 统一限制按需添加", file: "referenceCheck.md" },
  { start: "- Seedance 目标模型只按 PART A A0 判定；", end: "- 有对白不等于必须有外部音色样本。", content: "- 视频模型固定为本机 H3，不询问目标模型；画布层只核实 `comfyui` 的 H3 模型与模式是否可执行，用户对分辨率、画幅等配置的回答按 H3 能力换算。\n" },
  { target: "references/canvasExecution.md", start: "## 配置询问不得截断 Seedance", end: "## 生成前准备", file: "canvasConfig.md" },
  { target: "references/canvasExecution.md", start: "完成本轮可执行的独立启动和文字工作后", end: "用户报告完成后用", file: "canvasWait.md" },
];

async function installWorkflowSkill() {
  const upstream = resolve(import.meta.dirname, "../../packages/skills/workflow");
  const sources = new Map<string, string>();
  for (const override of skillOverrides) {
    const target = override.target ?? "SKILL.md";
    const source = sources.get(target) ?? (await readFile(join(upstream, target), "utf8")).replace(/\r\n?/g, "\n");
    const start = source.indexOf(override.start);
    const end = start < 0 ? -1 : source.indexOf(override.end, start + override.start.length);
    if (start < 0 || end < 0 || source.indexOf(override.start, start + 1) >= 0) {
      throw new Error(`上游 workflow 技能 ${target} 已变化，找不到唯一的“${override.start.slice(0, 40)}”…“${override.end.slice(0, 40)}”，请核对 local/skills/workflow 的替换内容`);
    }
    const content = override.file ? `${(await readFile(join(skillDirectory, override.file), "utf8")).replace(/\r\n?/g, "\n").trimEnd()}\n\n` : override.content!;
    sources.set(target, source.slice(0, start) + content + source.slice(end));
  }
  for (const [target, content] of sources) {
    await api("/skills/save", { method: "PUT", body: JSON.stringify({ name: "workflow", ...(target === "SKILL.md" ? {} : { path: target }), content }) });
  }
  console.log(`已写入本机 H3 版 workflow 技能（${sources.size} 个文件，替换 ${skillOverrides.length} 处）`);
}

// local/tools 下的工具插件：用上游脚手架构建为 .tool.js，再走插件市场同一个安装接口。
async function installTools() {
  const root = resolve(import.meta.dirname, "../..");
  for (const name of await readdir(resolve(import.meta.dirname, "../tools"))) {
    const built = Bun.spawnSync([process.execPath, `local/tools/${name}/build.ts`], { cwd: root, stdout: "inherit", stderr: "inherit" });
    if (built.exitCode !== 0) throw new Error(`工具 ${name} 构建失败`);
    const fileName = `${name}.tool.js`;
    const source = await readFile(join(root, "build/tools", fileName), "utf8");
    await api("/tools/install", { method: "POST", body: JSON.stringify({ fileName, source, force: true }) });
    console.log(`已安装工具 ${fileName}`);
  }
}

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
  return { id: "magpie", label: "Magpie", apiUrl: magpie, apiKey: "magpie", protocol: "openai-completions", models };
}

// 设置是整份覆盖保存：读出当前设置，只改 Magpie 文本供应商和遥测开关。
async function installSettings() {
  const { multiTenantEnabled: _, ...saved } = await api<Record<string, unknown>>("/settings/get");
  const provider = args.includes("--skip-text") ? undefined : await installTextProvider();
  const others = (Array.isArray(saved.customProviders) ? saved.customProviders : []).filter(item => item?.id !== "magpie");
  const privacy = saved.privacy && typeof saved.privacy === "object" ? saved.privacy : {};
  await api("/settings/save", { method: "PUT", body: JSON.stringify({ settings: {
    ...saved,
    ...(provider ? { customProviders: [...others, provider] } : {}),
    // 本地化 fork 不向 api.toonflow.net 上报匿名使用数据。
    privacy: { ...privacy, dataCollectionEnabled: false },
  } }) });
  if (provider) console.log(`已写入文本供应商 Magpie（${provider.models.length} 个模型）`);
  console.log("已关闭匿名数据上报");
}

await installMediaProviders();
if (!args.includes("--keep-cloud")) await removeCloudPresets();
await installWorkflowSkill();
await installTools();
await installSettings();
