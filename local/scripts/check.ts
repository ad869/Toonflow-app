/**
 * 用 Toonflow 自己的供应商加载器校验 local/providers：元数据解析（与“添加供应商”相同的规则）+ 在宿主 VM 中执行。
 * 上游修改供应商契约或加载规则时，这里会先失败。不会连接 Magpie 或 ComfyUI。
 *
 *   bun local/scripts/check.ts
 */
import { readdir, readFile } from "@toonflow/file";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// 宿主模块加载时会初始化配置文件，指向临时目录，避免碰到真实数据。
process.env.TOONFLOW_DATA_DIR ??= mkdtempSync(join(tmpdir(), "toonflowCheck"));
const { validateMediaProviderSource, loadMediaProviderSource } = await import("../../apps/server/src/utils/media/provider.ts");

const directory = resolve(import.meta.dirname, "../providers");
let failed = false;
for (const fileName of (await readdir(directory)).filter(name => name.endsWith(".ts")).sort()) {
  try {
    const source = await readFile(join(directory, fileName), "utf8");
    const metadata = validateMediaProviderSource(source);
    if (`${metadata.id}.ts` !== fileName) throw new Error(`供应商 ID ${metadata.id} 与文件名不一致`);
    const provider = await loadMediaProviderSource(source);
    const types = new Set(metadata.models.map(model => model.type));
    for (const [type, method] of [["image", "generateImage"], ["video", "generateVideo"], ["audio", "generateAudio"]] as const) {
      if (types.has(type) && typeof provider[method] !== "function") throw new Error(`声明了 ${type} 模型但缺少 ${method}`);
    }
    console.log(`✓ ${fileName}：${metadata.models.map(model => `${model.id}(${model.type})`).join("、")}`);
  } catch (error) {
    failed = true;
    console.error(`✗ ${fileName}：${error instanceof Error ? error.message : String(error)}`);
  }
}
process.exit(failed ? 1 : 0);
