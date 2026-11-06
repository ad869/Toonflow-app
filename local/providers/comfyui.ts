/**
 * 本机 ComfyUI 媒体适配器：视频、配音、音乐都提交给 ComfyUI 的 /prompt，在本机 GPU 上生成。
 *
 * - 视频：MiniMax H3 + Pika Flex LoRA。参考生视频用 ref2va（MiniMaxH3ReferenceToVideo），首尾帧用 fl2va（MiniMaxH3ImageToVideo）；
 *   “快速”档额外接 FastH3 的 VSA 稀疏注意力。只出 768P、4–15 秒、24 fps，可同时生成同步声音。
 * - 配音：Qwen3-TTS（Qwen3TTSLocal，声音设计 / 克隆）与 Drama3（Drama3LocalGGUF，声音设计 / 克隆 / 本地音色库）。
 * - 音乐：MiniMax Music3。
 * 参考素材经 /upload/image 上传到 ComfyUI 的 input/toonflow；结果通过 /view 地址返回，由宿主下载到工作区。
 * ComfyUI 一次只执行一个任务，排队期间持续等待；任务号保存在恢复数据中，Toonflow 重启后可继续等待。
 */

const rules = [
  {
    type: "input",
    field: "baseUrl" as const,
    title: "ComfyUI 地址",
    value: "http://127.0.0.1:8188",
    props: { placeholder: "http://127.0.0.1:8188" },
  },
] as const;

const version = "1.0.0";

const h3 = {
  ref: { unet: "minimax_h3_ref2va_pruned_bf16.safetensors", lora: "pika_h3_flex_ref2va_v1_bf16.safetensors" },
  frames: { unet: "minimax_h3_fl2va_pruned_bf16.safetensors", lora: "pika_h3_flex_fl2va_v1_bf16.safetensors" },
  clip: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
  videoVae: "minimax_h3_video_vae_fp16.safetensors",
  audioVae: "minimax_h3_audio_vae_fp32.safetensors",
  sigmas: "1.0, 0.972973, 0.923077, 0.8, 0.571429, 0.333333, 0.0",
  fps: 24,
};

const music3 = {
  clip: "minimax_music3_text_encoder_pruned_int8_convrot.safetensors",
  unet: "minimax_music3_dit_fp16.safetensors",
  vae: "minimax_music3_dav.safetensors",
};

// H3 以 768 短边出图；Toonflow 的比例映射到 Pika H3 Flex 支持的画布。
const canvases: Record<string, [number, number]> = {
  "16:9": [1344, 768], "9:16": [768, 1344], "1:1": [1024, 1024],
  "4:3": [1024, 768], "3:4": [768, 1024], "21:9": [1792, 768],
};

const extensions: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
  "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/wave": ".wav", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/flac": ".flac", "audio/ogg": ".ogg",
  "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
};

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

type ComfyTaskData = { kind: "comfy"; promptId: string; mediaType: "video" | "audio"; deadline: number };

type ReferencedVideoRequest = VideoRequest & {
  referenceOrder?: ({ type: "image" | "video" | "audio"; index: number } | { type: "firstFrame" | "lastFrame" | "text" })[];
};

function serverUrl(context: ProviderContext) {
  const url = new URL(String(context.config.baseUrl ?? "").trim() || "http://127.0.0.1:8188");
  return url.href.replace(/\/+$/, "");
}

function wait(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function comfy(context: ProviderContext, path: string, signal: AbortSignal, init: RequestInit = {}) {
  const base = serverUrl(context);
  let response: Response;
  try { response = await context.tool.fetch(`${base}${path}`, { ...init, signal }); }
  catch (error) {
    if (signal.aborted) throw error;
    throw new Error(`无法连接 ComfyUI（${base}），请确认 ComfyUI 已启动`, { cause: error });
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`ComfyUI ${path} 返回 HTTP ${response.status}：${text.slice(0, 1500)}`);
  return JSON.parse(text) as Record<string, any>;
}

// ACT: 宿主传入的参考素材是整段 base64，几十 MB 的视频会在内存里放大数倍；这里不再额外复制字符串或字节，只解码一次。
async function bytesOf(context: ProviderContext, input: MediaInput): Promise<Uint8Array<ArrayBuffer>> {
  if (input.type === "binary") return input.data as Uint8Array<ArrayBuffer>;
  if (input.type === "base64") {
    const data = input.data.startsWith("data:") ? input.data.slice(input.data.indexOf(",") + 1) : input.data;
    return Buffer.from(data, "base64") as Uint8Array<ArrayBuffer>;
  }
  const response = await context.tool.fetch(input.url);
  if (!response.ok) throw new Error(`读取参考素材失败：HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** 上传到 ComfyUI input/toonflow，文件名取内容哈希，同一素材重复使用时直接覆盖。 */
async function upload(context: ProviderContext, input: MediaInput, signal: AbortSignal) {
  const bytes = await bytesOf(context, input);
  const mimeType = input.mimeType ?? "application/octet-stream";
  const name = `${context.tool.hash(bytes).toString(16)}${extensions[mimeType] ?? ""}`;
  const boundary = `----toonflow${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const field = (key: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
  const body = new Blob([
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${name}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    bytes, "\r\n",
    field("type", "input"), field("subfolder", "toonflow"), field("overwrite", "true"),
    `--${boundary}--\r\n`,
  ]);
  const result = await comfy(context, "/upload/image", signal, {
    method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body,
  });
  return [result.subfolder, result.name].filter(Boolean).join("/");
}

function seedOf(request: MediaRequest) {
  const seed = Number(request.other?.seed);
  return Number.isSafeInteger(seed) && seed >= 0 ? seed % 2 ** 31 : Math.floor(Math.random() * 2 ** 31);
}

async function submit(context: ProviderContext, graph: Graph, mediaType: ComfyTaskData["mediaType"], minutes: number, signal: AbortSignal) {
  const submitted = await comfy(context, "/prompt", signal, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: "toonflow" }),
  });
  if (typeof submitted.prompt_id !== "string" || submitted.node_errors && Object.keys(submitted.node_errors).length) {
    throw new Error(`ComfyUI 拒绝了工作流：${JSON.stringify(submitted.node_errors ?? submitted).slice(0, 2000)}`);
  }
  const task: ComfyTaskData = { kind: "comfy", promptId: submitted.prompt_id, mediaType, deadline: Date.now() + minutes * 60_000 };
  await context.saveTaskData?.(task);
  return collect(context, task, signal);
}

/** 轮询 /history；排队和执行都继续等待，ComfyUI 重启后任务丢失则报错。 */
async function collect(context: ProviderContext, task: ComfyTaskData, signal: AbortSignal): Promise<MediaAsset[]> {
  const id = task.promptId;
  const wanted = task.mediaType === "video" ? /\.(mp4|webm|mov)$/i : /\.(mp3|flac|wav|ogg|opus)$/i;
  while (true) {
    const item = (await comfy(context, `/history/${encodeURIComponent(id)}`, signal))[id];
    const status = item?.status ?? {};
    if (status.status_str === "error") {
      const failure = (status.messages ?? []).filter((message: unknown[]) => message[0] === "execution_error").at(-1)?.[1];
      throw Object.assign(new Error(`ComfyUI 执行失败：${failure?.exception_message ?? JSON.stringify(status).slice(0, 800)}`), { code: "MEDIA_TASK_FAILED" });
    }
    if (status.completed) {
      for (const output of Object.values(item.outputs ?? {}) as Record<string, unknown>[]) {
        for (const files of Object.values(output)) {
          for (const file of Array.isArray(files) ? files : []) {
            if (typeof file?.filename !== "string" || !wanted.test(file.filename)) continue;
            const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? "", type: file.type ?? "output" });
            const extension = file.filename.slice(file.filename.lastIndexOf(".") + 1).toLowerCase();
            const mimeType = task.mediaType === "video" ? `video/${extension === "mov" ? "quicktime" : extension}` : `audio/${extension === "mp3" ? "mpeg" : extension}`;
            return [{ mediaType: task.mediaType, type: "url", url: `${serverUrl(context)}/view?${query}`, mimeType }];
          }
        }
      }
      throw Object.assign(new Error("ComfyUI 任务已完成，但没有输出文件"), { code: "MEDIA_TASK_FAILED" });
    }
    if (!item) {
      const queue = await comfy(context, "/queue", signal);
      const queued = [...queue.queue_running ?? [], ...queue.queue_pending ?? []].some((entry: unknown[]) => entry[1] === id);
      if (!queued) throw Object.assign(new Error("ComfyUI 中找不到该任务，可能已重启，请重新生成"), { code: "MEDIA_TASK_FAILED" });
    }
    await wait(signal, task.mediaType === "video" ? 10_000 : 3_000);
  }
}

function deadlineSignal(context: ProviderContext, minutes: number) {
  return AbortSignal.any([AbortSignal.timeout(minutes * 60_000), ...(context.signal ? [context.signal] : [])]);
}

/** 帧数取 17k+5 网格，与 H3 训练长度一致。 */
function framesFor(seconds: number) {
  let frames = Math.max(5, Math.round(seconds * h3.fps));
  while (frames % 17 !== 5) frames += 1;
  return frames;
}

function closestCanvas(width: number, height: number) {
  const ratio = width / height;
  return Object.values(canvases).reduce((best, canvas) =>
    Math.abs(Math.log(canvas[0] / canvas[1] / ratio)) < Math.abs(Math.log(best[0] / best[1] / ratio)) ? canvas : best);
}

/** {{ref N}} 按 referenceOrder 转为 H3 的 <Picture N>/<Video N>/<Audio N>；@image1 写法同样转换。 */
function videoPrompt(request: ReferencedVideoRequest, frameMode: boolean) {
  const labels = { image: "Picture", video: "Video", audio: "Audio" };
  return request.prompt
    .replace(/\{\{ref (\d+)\}\}/g, (_marker, number: string) => {
      const reference = request.referenceOrder?.[Number(number) - 1];
      if (!reference) return frameMode ? `Picture ${number}` : `<Picture ${number}>`;
      if (!("index" in reference)) {
        if (reference.type === "firstFrame") return "Picture 1";
        if (reference.type === "lastFrame") return `Picture ${request.firstFrame ? 2 : 1}`;
        return `参考 ${number}`;
      }
      return `<${labels[reference.type]} ${reference.index + 1}>`;
    })
    .replace(/@image\s?(\d+)/gi, "<Picture $1>")
    .replace(/@video\s?(\d+)/gi, "<Video $1>")
    .replace(/@audio\s?(\d+)/gi, "<Audio $1>");
}

type KeyframePlan = { first?: MediaInput; last?: MediaInput; keys: { image: MediaInput; seconds: number }[]; prompt: string };

const keyframeLine = /^[ \t]*[@＠](首帧|尾帧|关键帧)[ \t]*(?:(\d+(?:\.\d+)?)[ \t]*(?:s|秒))?[ \t]*[:：]?[ \t]*\{\{ref (\d+)\}\}[ \t]*$/gm;

/**
 * 提示词中单独成行的 @首帧 / @关键帧 1.5s / @尾帧 {{ref N}} 指令：把参考模式连入的图片分配为首尾帧和中途关键帧。
 * 中途关键帧走 MiniMaxH3AddGuide，文本编码器看不到它们，所以正文里的引用改写成“关键姿态”，不称作 Picture。
 */
function keyframePlan(request: ReferencedVideoRequest, duration: number): KeyframePlan | undefined {
  const matches = [...request.prompt.matchAll(keyframeLine)];
  if (!matches.length) return;
  if (request.videos?.length || request.audios?.length) throw new Error("关键帧方式只使用图片，请去掉参考视频和参考音频");
  const images = request.images ?? [];
  const plan: KeyframePlan = { keys: [], prompt: "" };
  const roles = new Map<number, "first" | "last" | "key">();
  for (const [, role, time, ref] of matches) {
    const reference = request.referenceOrder?.[Number(ref) - 1];
    const index = reference ? reference.type === "image" && "index" in reference ? reference.index : -1 : Number(ref) - 1;
    const image = images[index];
    if (!image) throw new Error(`关键帧指令中的 {{ref ${ref}}} 不是已连接的图片`);
    if (roles.has(index)) throw new Error(`第 ${index + 1} 张图片被多条关键帧指令重复使用`);
    if (role === "关键帧") {
      const seconds = Number(time);
      if (!time || !(seconds > 0 && seconds < duration)) throw new Error(`@关键帧 需要写 0–${duration} 秒之间的时间，例如 @关键帧 1.5s {{ref 2}}`);
      plan.keys.push({ image, seconds });
      roles.set(index, "key");
      continue;
    }
    const slot = role === "首帧" ? "first" : "last";
    if (plan[slot]) throw new Error(`只能有一条 @${role}`);
    plan[slot] = image;
    roles.set(index, slot);
  }
  const unused = images.map((_, index) => index).filter(index => !roles.has(index));
  if (unused.length) throw new Error(`关键帧方式下每张连接的图片都要用指令指定用途，第 ${unused.map(index => index + 1).join("、")} 张未使用`);
  if (plan.keys.length > 7) throw new Error("每段最多 7 张中途关键帧");
  plan.keys.sort((left, right) => left.seconds - right.seconds);
  const label = { first: "Picture 1", last: plan.first ? "Picture 2" : "Picture 1", key: "关键姿态" };
  plan.prompt = request.prompt.replace(keyframeLine, "").replace(/\{\{ref (\d+)\}\}/g, (marker, number: string) => {
    const reference = request.referenceOrder?.[Number(number) - 1];
    const role = roles.get(reference ? "index" in reference ? reference.index : -1 : Number(number) - 1);
    return role ? label[role] : marker;
  }).replace(/\n{3,}/g, "\n\n").trim();
  return plan;
}

async function videoGraph(context: ProviderContext, request: ReferencedVideoRequest, signal: AbortSignal) {
  const duration = request.duration ?? 5;
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new Error("本地 H3 只支持 4–15 秒的整数时长");
  if (request.resolution && request.resolution.toUpperCase() !== "768P") throw new Error("本地 H3 只支持 768P");
  const fast = request.model.endsWith("Fast");
  const plan = keyframePlan(request, duration);
  const firstFrame = plan ? plan.first : request.firstFrame;
  const lastFrame = plan ? plan.last : request.lastFrame;
  const frameMode = !!(firstFrame || lastFrame || plan);
  const length = framesFor(duration);
  const withAudio = request.generateAudio !== false;
  const recipe = frameMode ? h3.frames : h3.ref;
  let prompt = plan ? plan.prompt : videoPrompt(request, frameMode);
  const graph: Graph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: recipe.unet, weight_dtype: "default" } },
    "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: recipe.lora, strength_model: 1.0 } },
    "3": { class_type: "CLIPLoader", inputs: { clip_name: h3.clip, type: "minimax", device: "default" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: h3.videoVae } },
    "5": { class_type: "VAELoader", inputs: { vae_name: h3.audioVae } },
  };
  let model: [string, number] = ["2", 0];
  if (fast) {
    // FastH3：与 workflows/FastH3-* 相同的 SigmaShift + INT8 注意力 + VSA 稀疏注意力。
    graph["6"] = { class_type: "MiniMaxH3SigmaShift", inputs: { model, shift_video: 12.0, shift_audio: 3.0 } };
    graph["7"] = { class_type: "ModelAttentionBackend", inputs: { model: ["6", 0], attention: "comfy kitchen attention" } };
    graph["8"] = { class_type: "BlockSparseAttention", inputs: {
      model: ["7", 0], selection: "vsa", "selection.keep_percent": 10.0, start_percent: 0.0, end_percent: 1.0,
      dense_blocks: "", min_tokens: 12288, extra_tokens: 256, sink_conditioning: "exact_kv_and_rows", verbose: false,
    } };
    model = ["8", 0];
  }
  let conditioning: [string, number] = ["20", 0];

  if (frameMode) {
    const [width, height] = closestCanvas(...await context.tool.media.inspectImage((firstFrame ?? lastFrame ?? plan!.keys[0]!.image))
      .then(info => [info.width, info.height] as const));
    const inputs: Record<string, unknown> = { clip: ["3", 0], vae: ["4", 0], width, height, length };
    const align: string[] = [];
    if (firstFrame) {
      graph["10"] = { class_type: "LoadImage", inputs: { image: await upload(context, firstFrame, signal) } };
      inputs.first_frame = ["10", 0];
      align.push(`Picture ${align.length + 1} (from Shot 1) aligns with the 0.00-second mark of the target video`);
    }
    if (lastFrame) {
      graph["11"] = { class_type: "LoadImage", inputs: { image: await upload(context, lastFrame, signal) } };
      inputs.last_frame = ["11", 0];
      align.push(`Picture ${align.length + 1} (from Shot 1) aligns with the ${((length - 1) / h3.fps).toFixed(2)}-second mark of the target video`);
    }
    inputs.prompt = align.length ? `How the reference pictures align with the target video — ${align.join("; ")}.\n\n${prompt}` : prompt;
    graph["20"] = { class_type: "MiniMaxH3ImageToVideo", inputs };
    // 中途关键帧逐个串联 AddGuide；latent 始终取 ImageToVideo 的输出，与 hypit 本机验证过的图一致。
    for (const [index, key] of (plan?.keys ?? []).entries()) {
      graph[`${12 + index}`] = { class_type: "LoadImage", inputs: { image: await upload(context, key.image, signal) } };
      graph[`${50 + index}`] = { class_type: "MiniMaxH3AddGuide", inputs: {
        positive: conditioning, latent: ["20", 1], vae: ["4", 0], image: [`${12 + index}`, 0],
        frame_idx: Math.min(length - 2, Math.max(1, Math.round(key.seconds * h3.fps))),
      } };
      conditioning = [`${50 + index}`, 0];
    }
  } else {
    const images = request.images ?? [], videos = request.videos ?? [], audios = request.audios ?? [];
    if (images.length > 9 || videos.length > 3 || audios.length > 3) throw new Error("本地 H3 最多 9 张参考图、3 段参考视频、3 段参考音频");
    let canvas = request.ratio ? canvases[request.ratio] : undefined;
    if (!canvas && images[0]) {
      const info = await context.tool.media.inspectImage(images[0]);
      canvas = closestCanvas(info.width, info.height);
    }
    const [width, height] = canvas ?? canvases["16:9"]!;
    // 提示词中写 “<Audio N>: fully_copy” 表示该音频就是成片对白：用 AddGuide 锚定以对口型，不再作为音色参考。
    const copied = new Set([...prompt.matchAll(/<Audio (\d+)>\s*:\s*fully_copy/gi)].map(match => Number(match[1]) - 1));
    const guideOnly = audios.length === 1 && copied.has(0);
    if (guideOnly) {
      // ACT: 文本中保留 fully_copy 会让 H3 重读并重复台词（本机实测）。
      prompt = prompt.replace(/^.*<Audio 1>\s*:\s*fully_copy.*$/gim, "").replace(/<Audio 1>/g, "the supplied dialogue soundtrack");
    }
    const inputs: Record<string, unknown> = {
      clip: ["3", 0], vae: ["4", 0], audio_vae: ["5", 0], prompt, width, height, length, ref_image_size: "match",
    };
    for (const [index, image] of images.entries()) {
      graph[`${100 + index}`] = { class_type: "LoadImage", inputs: { image: await upload(context, image, signal) } };
      inputs[`ref_images.ref_image_${index}`] = [`${100 + index}`, 0];
    }
    for (const [index, video] of videos.entries()) {
      graph[`${200 + index}`] = { class_type: "LoadVideo", inputs: { file: await upload(context, video, signal) } };
      graph[`${210 + index}`] = { class_type: "GetVideoComponents", inputs: { video: [`${200 + index}`, 0] } };
      inputs[`ref_videos.ref_video_${index}`] = [`${210 + index}`, 0];
    }
    for (const [index, audio] of audios.entries()) {
      graph[`${300 + index}`] = { class_type: "LoadAudio", inputs: { audio: await upload(context, audio, signal) } };
      if (!guideOnly) inputs[`ref_audios.ref_audio_${index}`] = [`${300 + index}`, 0];
    }
    graph["20"] = { class_type: "MiniMaxH3ReferenceToVideo", inputs };
    const guided = [...copied].find(index => index < audios.length);
    if (guided !== undefined) {
      graph["21"] = { class_type: "MiniMaxH3AddGuide", inputs: {
        positive: ["20", 0], latent: ["20", 1], audio_vae: ["5", 0], audio: [`${300 + guided}`, 0], frame_idx: 0 } };
      conditioning = ["21", 0];
    }
  }

  Object.assign(graph, {
    "30": { class_type: "RandomNoise", inputs: { noise_seed: seedOf(request) } },
    "31": { class_type: "BasicGuider", inputs: { model, conditioning } },
    "32": { class_type: "KSamplerSelect", inputs: { sampler_name: "lcm" } },
    "33": { class_type: "ManualSigmas", inputs: { sigmas: h3.sigmas } },
    "34": { class_type: "SamplerCustomAdvanced", inputs: {
      noise: ["30", 0], guider: ["31", 0], sampler: ["32", 0], sigmas: ["33", 0], latent_image: ["20", 1] } },
    "40": { class_type: "VAEDecodeTiled", inputs: {
      samples: ["34", 0], vae: ["4", 0], tile_size: 512, overlap: 64, temporal_size: 32, temporal_overlap: 8 } },
    "42": { class_type: "CreateVideo", inputs: { images: ["40", 0], fps: h3.fps, ...(withAudio ? { audio: ["41", 0] } : {}) } },
    "43": { class_type: "SaveVideo", inputs: {
      video: ["42", 0], filename_prefix: `toonflow/${frameMode ? "fl2va" : "ref2va"}`, format: "mp4", "format.codec": "auto", codec: "auto" } },
  } satisfies Graph);
  if (withAudio) graph["41"] = { class_type: "VAEDecodeAudio", inputs: { samples: ["34", 0], vae: ["5", 0] } };
  return graph;
}

/** Drama3 按台词长度估算 token：中日韩字约 0.3 秒，其他单词约 0.45 秒。 */
function drama3Tokens(text: string) {
  const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) ?? []).length;
  const words = text.replace(/[぀-ヿ㐀-鿿가-힯]/g, " ").split(/\s+/).filter(Boolean).length;
  const seconds = cjk * 0.3 + words * 0.45 + 2;
  return Math.min(1500, Math.max(300, Math.ceil(seconds * 21.5 * 1.8 / 50) * 50));
}

function oneLine(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

async function audioGraph(context: ProviderContext, request: AudioRequest, signal: AbortSignal): Promise<Graph> {
  const text = request.text?.trim() ?? "";
  const reference = request.audios?.[0];
  const referenceText = oneLine(request.audios?.[0]?.text) || oneLine(request.other?.referenceText);
  const seed = seedOf(request);
  const save = (audio: [string, number], name: string) => ({ class_type: "SaveAudioMP3", inputs: { audio, filename_prefix: `toonflow/${name}`, quality: "V0" } });

  if (request.model === "music3") {
    const seconds = Math.min(360, Math.max(5, Number(request.other?.seconds) || 30));
    return {
      "1": { class_type: "CLIPLoader", inputs: { clip_name: music3.clip, type: "minimax", device: "default" } },
      "2": { class_type: "UNETLoader", inputs: { unet_name: music3.unet, weight_dtype: "default" } },
      "3": { class_type: "VAELoader", inputs: { vae_name: music3.vae } },
      "4": { class_type: "MiniMaxMusic3TextEncode", inputs: {
        clip: ["1", 0], caption: text || oneLine(request.prompt), lyrics: String(request.other?.lyrics ?? ""), seed, max_duration: seconds, cfg_scale: 1.7, top_k: 50 } },
      "5": { class_type: "EmptyMiniMaxMusic3LatentAudio", inputs: { seconds: ["4", 1], batch_size: 1 } },
      "6": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
      "7": { class_type: "KSampler", inputs: {
        model: ["2", 0], seed, steps: 30, cfg: 1.7, sampler_name: "euler", scheduler: "simple", positive: ["4", 0], negative: ["6", 0], latent_image: ["5", 0], denoise: 1 } },
      "8": { class_type: "VAEDecodeAudioTiled", inputs: { samples: ["7", 0], vae: ["3", 0], tile_size: 1536, overlap: 64 } },
      "9": save(["8", 0], "music3"),
    };
  }
  if (!text) throw new Error("请填写要朗读的台词");
  const voice = oneLine(request.voice);
  const graph: Graph = {};
  if (reference) graph["1"] = { class_type: "LoadAudio", inputs: { audio: await upload(context, reference, signal) } };

  if (request.model === "drama3") {
    const library = !reference && voice.startsWith("library:") ? voice.slice("library:".length) : "";
    if (library) graph["1"] = { class_type: "Drama3LoadVoice", inputs: { voice: library } };
    const clone = !!reference || !!library;
    if (reference && !referenceText) throw new Error("Drama3 克隆需要参考录音的原文，请在模型参数中填写“参考音频原文”");
    // Drama3 没有单独的声音设计接口：台词前的 [描述] 不会被读出，但会决定音色。
    const steer = clone ? oneLine(request.other?.instruct) : oneLine(request.other?.instruct) || voice;
    const spoken = steer ? `[${steer}] ${text}` : text;
    graph["2"] = { class_type: "Drama3LocalGGUF", inputs: {
      text: spoken, mode: clone ? "参考声音克隆" : "文字生成", reference_text: library ? ["1", 1] : referenceText, seed,
      temperature: 0.8, max_tokens: drama3Tokens(text), cpu_expert_layers: 8, ...(clone ? { reference_audio: ["1", 0] } : {}) } };
    graph["3"] = save(["2", 0], "drama3");
    return graph;
  }

  const language = (request.language ?? "zh").toLowerCase().split(/[-_]/)[0]!;
  graph["2"] = { class_type: "Qwen3TTSLocal", inputs: {
    text, mode: reference ? "clone" : "design", instruct: reference ? "" : oneLine(request.other?.instruct) || voice || "自然清晰的普通话声音，语速适中",
    language, seed, temperature: 0.9, top_p: 1.0, top_k: 50, repetition_penalty: 1.05, max_tokens: 2048,
    ...(reference ? { voice: ["1", 0], reference_text: referenceText } : {}) } };
  graph["3"] = save(["2", 0], "qwen3tts");
  return graph;
}

export default {
  id: "comfyui",
  label: "ComfyUI（本机）",
  version,
  readme: `## 本机 ComfyUI

视频、配音、音乐全部在本机 ComfyUI 上生成，不需要密钥。默认地址 \`http://127.0.0.1:8188\`。

- **视频**：MiniMax H3 + Pika Flex。参考图/视频/音频生视频，或首尾帧生视频；768P、4–15 秒，可同时生成声音。提示词中的引用按 <Picture N>、<Video N>、<Audio N> 计数；写 “<Audio 1>: fully_copy” 表示直接用这段音频做对白并对口型。“快速”档使用 FastH3 VSA 稀疏注意力。
- **配音**：Qwen3-TTS 和 Drama3。选音色或在“声音描述”里写描述为声音设计；接入参考音频为克隆，需填写参考音频原文（Qwen3 可不填）。Drama3 的 library: 音色来自 ComfyUI 本地音色库。
- **音乐**：MiniMax Music3，提示词写风格描述，歌词和时长在模型参数中填写。

ComfyUI 一次只执行一个任务，多个任务会排队；15 秒视频约需 20 分钟以上。`,
  rules,
  models: [
    {
      id: "h3Pika",
      label: "MiniMax H3 · Pika Flex（本机）",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768P"] }],
      rules: [{ type: "inputNumber", field: "seed", title: "种子（-1 为随机）", value: -1, props: { min: -1, precision: 0 } }],
    },
    {
      id: "h3PikaFast",
      label: "MiniMax H3 · Pika Flex 快速（本机 VSA）",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768P"] }],
      rules: [{ type: "inputNumber", field: "seed", title: "种子（-1 为随机）", value: -1, props: { min: -1, precision: 0 } }],
    },
    {
      id: "qwen3Tts",
      label: "Qwen3-TTS 配音（本机）",
      type: "audio",
      voices: [
        { title: "温柔女声", voice: "年轻女性，声音温柔甜美，语速适中，带一点笑意" },
        { title: "清冷女声", voice: "年轻女性，声音清冷克制，吐字清晰，语速偏慢" },
        { title: "少年音", voice: "十几岁的少年，声音明亮有朝气，语速稍快" },
        { title: "沉稳男声", voice: "成年男性，声音低沉稳重，有磁性，语速适中" },
        { title: "旁白", voice: "专业纪录片旁白，男声，浑厚平稳，咬字标准" },
        { title: "老人", voice: "七十岁左右的老爷爷，声音沙哑慈祥，语速缓慢" },
      ],
      rules: [
        { type: "input", field: "instruct", title: "声音描述（覆盖所选音色）", value: "", props: { type: "textarea", rows: 2 } },
        { type: "input", field: "referenceText", title: "参考音频原文（克隆时可选）", value: "", props: { type: "textarea", rows: 2 } },
        { type: "inputNumber", field: "seed", title: "种子（-1 为随机）", value: -1, props: { min: -1, precision: 0 } },
      ],
    },
    {
      id: "drama3",
      label: "Drama3 配音（本机）",
      type: "audio",
      voices: [
        { title: "音色库：a_候选01", voice: "library:a_候选01" },
        { title: "音色库：AnnaSu_A", voice: "library:AnnaSu_A" },
        { title: "音色库：AnnaSu_B", voice: "library:AnnaSu_B" },
        { title: "设计：温柔女声", voice: "年轻女性，温柔甜美" },
        { title: "设计：沉稳男声", voice: "成年男性，低沉稳重" },
      ],
      rules: [
        { type: "input", field: "instruct", title: "声音描述 / 演绎指示", value: "", props: { type: "textarea", rows: 2 } },
        { type: "input", field: "referenceText", title: "参考音频原文（克隆时必填）", value: "", props: { type: "textarea", rows: 2 } },
        { type: "inputNumber", field: "seed", title: "种子（-1 为随机）", value: -1, props: { min: -1, precision: 0 } },
      ],
    },
    {
      id: "music3",
      label: "MiniMax Music3 音乐（本机）",
      type: "audio",
      rules: [
        { type: "input", field: "lyrics", title: "歌词（留空为纯音乐）", value: "", props: { type: "textarea", rows: 4 } },
        { type: "inputNumber", field: "seconds", title: "最长时长（秒）", value: 30, props: { min: 5, max: 360, precision: 0 } },
        { type: "inputNumber", field: "seed", title: "种子（-1 为随机）", value: -1, props: { min: -1, precision: 0 } },
      ],
    },
  ] satisfies ProviderModel[],
  async generateVideo(request: ReferencedVideoRequest): Promise<MediaAsset[]> {
    // ACT: 15 秒片段单独约 24 分钟，另需等待队列中的其他任务，最多等待 3 小时。
    const signal = deadlineSignal(this, 180);
    return submit(this, await videoGraph(this, request, signal), "video", 180, signal);
  },
  async generateAudio(request: AudioRequest): Promise<MediaAsset[]> {
    const signal = deadlineSignal(this, 60);
    return submit(this, await audioGraph(this, request, signal), "audio", 60, signal);
  },
  async resumeTask(data: ProviderTaskData): Promise<MediaAsset[]> {
    if (data.kind !== "comfy" || typeof data.promptId !== "string" || !data.promptId
      || (data.mediaType !== "video" && data.mediaType !== "audio") || typeof data.deadline !== "number") {
      throw new Error("ComfyUI 任务恢复数据无效");
    }
    const minutes = Math.max(1, Math.ceil((data.deadline - Date.now()) / 60_000));
    return collect(this, data as ComfyTaskData, deadlineSignal(this, minutes));
  },
} satisfies ProviderDefinition<typeof rules>;
