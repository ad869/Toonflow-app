# 本地化改动（fork 专用）

这个 fork 让 Toonflow 只使用本机能力：

| 能力 | 走向 | 实现 |
| --- | --- | --- |
| 文本 / Agent | Magpie 本地网关 `127.0.0.1:3425`，可选 Codex（ChatGPT 订阅）或 Claude 订阅的模型 | 设置里的自定义文本供应商，由 `scripts/install.ts` 写入 |
| 图片 | Magpie → `codex/gpt-image-2` | `providers/magpie.ts` |
| 视频 | 本机 ComfyUI：MiniMax H3 + Pika Flex（标准 / FastH3 VSA 快速） | `providers/comfyui.ts` |
| 配音 / 音乐 | 本机 ComfyUI：Qwen3-TTS、Drama3、MiniMax Music3 | `providers/comfyui.ts` |

## 目录约定：为了能一直合并上游

上游 [HBAI-Ltd/Toonflow-app](https://github.com/HBAI-Ltd/Toonflow-app) 更新很频繁，本 fork 要持续合并它的 `master`。因此：

1. **所有本地化内容放在 `local/`**，以及 `.github/workflows/syncUpstream.yml`。上游没有这些路径，合并时不会冲突。
2. **供应商用 Toonflow 自带的插件机制接入**：`providers/*.ts` 和设置页“添加自定义媒体供应商”导入的文件完全一样，安装到数据目录的 `providers/` 下，不进上游的内置列表，不改前端。
3. **尽量不改上游文件。** 确实要改时，改动必须很小，并登记在下表里，合并冲突时照表恢复。

| 上游文件 | 改动 | 原因 |
| --- | --- | --- |
| `apps/server/src/utils/media/generation.ts` | `referenceOrder` 白名单加入 `"comfyui"` | 宿主只把提示词引用映射（`{{ref N}}` 对应哪个素材）传给白名单内的供应商；没有它，H3 无法把引用转换为 `<Picture N>` / `<Video N>` / `<Audio N>` |
| `apps/web/src/main.ts` | 第一行 `import "../../../local/web/secureContextPolyfill";` | 通过 `http://<IP>` 访问时页面不是安全上下文，浏览器不提供 `crypto.randomUUID`，前端会启动失败；`local/web/secureContextPolyfill.ts` 补齐它 |

## 首次安装

前提：

- [Magpie](https://usemagpie.ai) 已启动（`magpie serve` 或桌面版），并已登录 Codex / Claude；
- ComfyUI 在 `127.0.0.1:8188` 运行，`E:\comfyui\models` 中已有 H3、Pika、Qwen3-TTS、Drama3、Music3 的权重与节点；
- Toonflow 已启动（桌面版或 `bun run dev`）。

```bash
bun local/scripts/install.ts --server http://127.0.0.1:3000
```

它通过 Toonflow 自己的接口安装或更新两个媒体供应商，并把 Magpie 的模型列表（含上下文长度、推理档位）写成文本供应商 `magpie`。修改 `providers/*.ts` 后重新执行即可覆盖。Magpie 新增模型后也重新执行。

## 局域网 / Tailscale 访问

开发模式（`bun run dev`，`NODE_ENV=dev`）只信任 `localhost`：从其他设备打开时，设置、供应商管理等接口会返回 403。多设备访问请使用上游自带的**服务器部署模式**，不需要改代码：

```bash
bun run build:tools && bun run build:ext && bun run build:nodes && bun run --filter '@toonflow/web' build
bun apps/server/src/index.ts        # 不设 NODE_ENV；默认端口 3000，可用 TOONFLOW_SERVER_PORT 修改
```

- 后端直接提供网页，监听所有网卡：本机打开 `http://localhost:3000`，Tailscale 设备打开 `http://<本机 Tailscale IP>:3000`。
- 浏览器在 `http://<IP>` 下会禁用部分接口。`crypto.randomUUID` 已经补齐，可以正常使用；但**复制到剪贴板、语音输入（麦克风）、手机扫码连接**这三项在 http 下不可用。需要它们时改用 HTTPS：在 Tailscale 后台启用 Serve 后执行 `tailscale serve --bg --https=443 http://127.0.0.1:3000`，然后打开 `https://<机器名>.<tailnet>.ts.net`。
- 项目统一放在数据目录的 `workspaces/` 下，所有设备共用；这个模式下不能选择本机的任意文件夹，这是上游的安全边界。
- Magpie、ComfyUI 仍然只监听 `127.0.0.1`。它们由服务端调用，远程设备不需要直接访问。
- 这个模式**没有登录**，能访问这个端口的人都能使用全部功能。请用防火墙把端口限制在 Tailscale 内：Tailscale 网卡是“专用”网络，因此把 bun.exe 的入站规则改为只允许“专用”配置文件即可（需要管理员权限）。如果需要账号隔离，可以使用上游的多租户模式。
- 拉取上游更新或修改前端后，要重新执行上面的构建命令。

## 分支与同步

- `master`：上游 `master` 的纯镜像，不做任何提交。
- `local`：本 fork 的默认分支，等于 `master` + 本地化改动。日常开发从 `local` 拉分支，合回 `local`。

**自动同步**：`.github/workflows/syncUpstream.yml` 每天北京时间 04:00 把上游 `master` 合并进 `local`，然后跑类型检查和 `scripts/check.ts`（用 Toonflow 自己的加载器解析并执行供应商文件），全部通过才推送；冲突或检查失败时不推送，开一个 issue。

需要在 fork 上做一次设置：

1. Actions 页面启用工作流（fork 默认禁用）。
2. 上游修改 `.github/workflows/` 下的文件时，默认的 `GITHUB_TOKEN` 无权推送。请创建一个带 `repo` 和 `workflow` 权限的 Personal Access Token，保存为仓库 secret `SYNC_TOKEN`。

**手动同步**（自动同步报冲突时，或想立刻拿到上游新功能时）：

```bash
bun local/scripts/sync.ts --install http://127.0.0.1:3000
```

它合并上游 `master`，安装依赖，跑类型检查和 `check.ts`，最后把供应商重新装进运行中的 Toonflow。冲突时停在合并状态：按上表处理上游文件后提交，再运行一次。

合并后重点看：`packages/providers/types.d.ts`（供应商契约）、`apps/server/src/utils/media/provider.ts`（加载与沙箱规则）、`apps/server/src/utils/media/generation.ts`（请求组装）。

## 供应商说明

### `magpie.ts`

- 没有参考图时调用 `POST /v1/images/generations`，有参考图时调用 `POST /v1/images/edits`（multipart，`image[]`）。
- 比例映射到 `1536x1024` / `1024x1536` / `1024x1024`，同时把比例写进提示词。
- 在 Magpie 中添加的其他图片模型，可以在设置页里直接新增模型 ID 使用。

### `comfyui.ts`

- **视频**：有首帧或尾帧时走 fl2va，否则走 ref2va（最多 9 张参考图、3 段参考视频、3 段参考音频）。只出 768P，时长 4–15 秒，帧数对齐 17k+5，24 fps。
  - 提示词写 `<Audio 1>: fully_copy` 表示直接用这段音频作对白并对口型。
  - `h3PikaFast` 额外接 FastH3 的 SigmaShift、INT8 注意力和 VSA 稀疏注意力，与 `E:\comfyui\workflows\FastH3-*` 一致。
- **配音**：
  - `qwen3Tts`：选择音色或填写“声音描述”时为声音设计；接入参考音频时为克隆。
  - `drama3`：`library:` 开头的音色来自 ComfyUI 的 Drama3 音色库；克隆时必须填写参考音频的原文。
- **音乐**：`music3`。提示词写风格描述，歌词和最长时长在模型参数中填写；模型可能在达到最长时长之前就结束。
- 素材上传到 ComfyUI 的 `input/toonflow/`，结果以 `/view` 地址返回，由 Toonflow 下载到工作区。任务号保存在任务恢复数据中，Toonflow 重启后会继续等待。
- 模型文件名写在文件顶部的 `h3` / `music3` 常量中；ComfyUI 换了权重时改这里。

## 验证

- `bun local/scripts/check.ts`：解析加 VM 执行，不连接外部服务。
- `./node_modules/.bin/tsc -p local/tsconfig.json`：按 `packages/providers/types.d.ts` 做类型检查。
- 端到端：先启动 Toonflow、Magpie、ComfyUI，然后在画布里分别用图片、视频、音频节点生成一次。
