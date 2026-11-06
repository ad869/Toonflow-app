import { z } from "zod";
import type { ToolPlugin } from "@toonflow/tools-scaffold/runtime";

const parameters = z.strictObject({
  nodeIds: z.array(z.string().min(1)).min(1).max(50).describe("要等待的生成节点 ID"),
  timeoutMinutes: z.number().int().min(1).max(180).optional().describe("最长等待分钟数，默认 60；本机 H3 15 秒片段约需 30 分钟，排队时更久"),
});

type NodeStatus = { status?: string; outputs?: unknown; error?: string; task?: { state?: string } };

// 节点停止运行且没有待复查的任务，才算结束；idle 但任务仍在进行（如页面刚刷新、正在恢复）时继续等待。
function settled(value: NodeStatus) {
  if (value.status === "succeeded" || value.status === "failed") return true;
  return value.status === "idle" && (!value.task || ["succeeded", "failed", "cancelled"].includes(value.task.state ?? ""));
}

function wait(signal: AbortSignal | undefined, ms: number) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

const plugin: ToolPlugin = {
  validateConfig(config) {
    if (Object.keys(config).length) throw new Error("等待生成工具没有配置项");
    return {};
  },
  createTools({ canvas }) {
    if (!canvas) return [];
    return [{
      name: "waitGeneration",
      label: "等待生成完成",
      description: "等待画布上一个或多个生成节点（图片、视频、音频）结束，返回每个节点的最终状态、输出与错误。用于启动生成之后，代替结束本轮或反复查询 getGenerationStatus。",
      promptSnippet: "启动生成后调用 waitGeneration 等待结果，再核对输出。",
      parameters: z.toJSONSchema(parameters, { io: "input", target: "draft-07" }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const { nodeIds, timeoutMinutes = 60 } = parameters.parse(params);
        const deadline = Date.now() + timeoutMinutes * 60_000;
        const results = new Map<string, NodeStatus>();
        while (true) {
          for (const nodeId of nodeIds) {
            if (results.has(nodeId) && settled(results.get(nodeId)!)) continue;
            try {
              const value = await canvas.call({ name: "nodeTools", args: { nodeId, name: "node:getGenerationStatus", args: {} } }, signal) as NodeStatus;
              results.set(nodeId, value ?? {});
            } catch (error) {
              if (signal?.aborted) throw error;
              results.set(nodeId, { status: "failed", error: `无法查询节点状态：${error instanceof Error ? error.message : String(error)}` });
            }
          }
          const pending = nodeIds.filter(nodeId => !settled(results.get(nodeId) ?? {}));
          const timedOut = pending.length > 0 && Date.now() >= deadline;
          if (!pending.length || timedOut) {
            const nodes = nodeIds.map(nodeId => ({ nodeId, ...results.get(nodeId) }));
            const summary = { finished: !timedOut, ...(timedOut ? { stillRunning: pending, note: `已等待 ${timeoutMinutes} 分钟仍未结束，可再次调用继续等待` } : {}), nodes };
            return { content: [{ type: "text", text: JSON.stringify(summary) }], details: summary };
          }
          // ACT: 每 15 秒查询一次；H3 片段以分钟计，更密的轮询只会占用画布通道。
          await wait(signal, 15_000);
        }
      },
    }];
  },
};

export default plugin;
