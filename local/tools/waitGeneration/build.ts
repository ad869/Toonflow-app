import { createToolConfig } from "../../../packages/toolScaffold/index.ts";

await createToolConfig({
  name: "waitGeneration",
  displayName: "等待生成完成",
  description: "等待画布生成节点结束并返回结果，让 Agent 启动生成后可以自己继续推进，不需要用户回来说“完成了”。",
  author: "Toonflow 本地化",
  github: "https://github.com/ad869/Toonflow-app",
  prompt: `启动图片、视频或音频生成后，用 waitGeneration 传入这批节点 ID 等待结果，等待期间不要反复调用 getGenerationStatus。
返回 finished=false 表示等待超时，任务仍在进行，可再次调用继续等待；节点 failed 时读取 error 处理，不自动重复提交收费或耗时的任务。
等待只代表生成结束，采用前仍要按工作流核对输出。依赖上一段结果的节点，等上一段采用后再启动。`,
  configRules: [],
}, import.meta.url, { outDir: "../../../build/tools", syncToData: false });
