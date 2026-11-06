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
| `apps/server/src/app.ts` | import 并 `app.use(localMiddleware)`（放在 `cors()` 之前） | 挂载 `local/server/middleware.ts`：可信网络守卫、静态资源 gzip、内存看门狗，各由自己的环境变量开启 |
| `apps/server/src/app.ts` | `autoInstallProviders` 在 `TOONFLOW_SKIP_CLOUD_PROVIDERS=1` 时为空数组 | 上游按内置供应商源码的版本号自动重装云端预置；不加这个开关，每次同步上游后 APIMart 等会被装回来，Agent 又会优先推荐它们 |
| `apps/server/src/utils/workspace/index.ts` | `isLocalHostRequest` 中加 `if (isTrustedNetworkRequest(req)) return true;`；`resolveWorkspace` 的条件改为 `(getRuntimePlatform().local \|\| isTrustedNetworkRequest(req)) && …` | 约 50 个“仅限本机”的接口都经由这两个函数；可信设备因此等同本机，可以打开任意目录 |
| `apps/server/src/utils/mobileLink/index.ts` | `assertMobileLinkControl` 中 `!localSocket \|\| !localHost` 改为 `!(isTrustedNetworkRequest(req) \|\| localSocket && localHost)` | 设备互联有一套独立的本机判断 |
| `apps/server/src/routes/workspaces/list.ts` | `root` 改为 `trustedBrowseRoot(req) ?? await …getWorkspaceRoot(req)` | 可信设备的目录选择器从 `TOONFLOW_BROWSE_ROOT` 开始浏览，而不是服务器工作区 |
| `apps/server/src/routes/channel/community/getAdvertisements.ts` | 整个文件改为直接返回空广告 | 去掉首页页头横幅和侧栏推广，不再请求官方云端 |

可信网络相关的逻辑都在 `local/server/trustedNetwork.ts` 中。上表中这几处上游文件改动只是调用它；未设置 `TOONFLOW_TRUSTED_NETWORKS` 时，行为与上游一致。

不改上游文件、只在安装时替换的内容：

- **workflow 技能**：`scripts/install.ts` 以上游 `packages/skills/workflow` 为底，按原文锚点替换写死 Seedance 的 15 处，替换内容在 `skills/workflow/*.md`。上游改了这些原文时安装会报错并指出是哪一处，按提示更新替换内容即可。上游在其他章节的改进会原样保留。
- **工具插件**：`tools/waitGeneration` 用上游的工具脚手架构建，经插件市场同一个安装接口安装。

## 首次安装

前提：

- [Magpie](https://usemagpie.ai) 已启动（`magpie serve` 或桌面版），并已登录 Codex / Claude；
- ComfyUI 在 `127.0.0.1:8188` 运行，`E:\comfyui\models` 中已有 H3、Pika、Qwen3-TTS、Drama3、Music3 的权重与节点；
- Toonflow 已启动（桌面版或 `bun run dev`）。

```bash
bun local/scripts/install.ts --server http://127.0.0.1:3000
```

它全部通过 Toonflow 自己的接口完成：

1. 安装或更新两个媒体供应商。
2. 卸载上游预装、但未配置密钥的云端供应商（APIMart、秘塔、优云智算；加 `--keep-cloud` 可保留）。
3. 写入本机 H3 版 workflow 技能。
4. 构建并安装 `waitGeneration` 工具。
5. 把 Magpie 的模型列表（含上下文长度、推理档位）写成文本供应商 `magpie`。
6. 关闭向 `api.toonflow.net` 的匿名数据上报。

修改 `providers/*.ts`、`skills/workflow/*.md` 或 `tools/*` 后，重新执行即可覆盖；Magpie 新增模型后也重新执行。同步上游后同样要重新执行，让技能替换建立在新版上游技能上。

## 局域网 / Tailscale 访问

开发模式（`bun run dev`）只信任 `localhost`。多设备访问请先构建，再用本 fork 的启动脚本以服务器部署模式运行：

```bash
bun run build:tools && bun run build:ext && bun run build:nodes && bun run --filter '@toonflow/web' build
bun local/scripts/serve.ts
```

`serve.ts` 会开启**可信网络**模式：

- **本机和 Tailscale 设备等同本机**：设置、插件、技能、MCP、节点、工具、团队管理、设备互联全部可用；可以把这台电脑上的任意文件夹作为工作区。不需要登录。
- **其他来源一律 403**：局域网 192.168.x 等设备访问会被拒绝，不需要再改防火墙。
- 后端直接提供网页，监听所有网卡：本机打开 `http://localhost:3000`，Tailscale 设备打开 `http://<本机 Tailscale IP>:3000`，也可以用 MagicDNS 名（如 `http://pc:3000`）。
- 防 DNS 重绑定：除了检查来源 IP，访问用的主机名也必须是 IP、localhost、不带点的短名或 `*.ts.net`，否则按普通远程请求处理。

可用环境变量调整：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TOONFLOW_TRUSTED_NETWORKS` | `tailscale` | 逗号分隔的 CIDR、IP 或别名 `tailscale`（`100.64.0.0/10`、`fd7a:115c:a1e0::/48`）。本机回环地址始终可信 |
| `TOONFLOW_BROWSE_ROOT` | 仓库所在磁盘的根目录（如 `F:\`） | 可信设备的目录选择器从这里开始浏览。⚠️ 选择器每行都带“删除”和“重命名”按钮，根目录设得越大，误操作的影响越大；建议设成专门放项目的目录 |
| `TOONFLOW_SERVER_PORT` | `3000` | 端口 |
| `TOONFLOW_SKIP_CLOUD_PROVIDERS` | `1` | 不自动重装上游的云端媒体供应商预置 |
| `TOONFLOW_WEB_ROOT` | `build/web` | 前端静态资源 gzip 压缩，`/assets/*` 设为长期缓存。主 JS 包从 9.0 MB 降到 2.3 MB |
| `TOONFLOW_GC_RSS_MB` | `512` | 常驻内存超过该值时主动完整 GC。实测连发两次 3×92 MB 参考视频，峰值从 1.28 GB 降到 741 MB，5 秒内回到约 200 MB |

其他说明：

- 浏览器在 `http://<IP>` 下会禁用部分接口。`crypto.randomUUID` 已经补齐，可以正常使用；但**复制到剪贴板、语音输入（麦克风）、手机扫码连接**这三项在 http 下不可用。需要它们时改用 HTTPS：在 Tailscale 后台启用 Serve 后执行 `tailscale serve --bg --https=443 http://127.0.0.1:3000`，然后打开 `https://<机器名>.<tailnet>.ts.net`（经本机代理转发的请求同样可信）。
- Magpie、ComfyUI 仍然只监听 `127.0.0.1`。它们由服务端调用，远程设备不需要直接访问。
- 拉取上游更新或修改前端后，要重新执行上面的构建命令。

## 分支与同步

- `master`：上游 `master` 的纯镜像，不做任何提交。
- `local`：本 fork 的默认分支，等于 `master` + 本地化改动。日常开发从 `local` 拉分支，合回 `local`。

**自动同步**：`.github/workflows/syncUpstream.yml` 每天北京时间 04:00 把上游 `master` 合并进 `local` 并推送；冲突时不推送，开一个 issue。按 AGENTS.md 的“测试与检查边界”，这里不加自动检查，合并后需要的验证请手动执行（见“验证”）。

需要在 fork 上做一次设置：

1. Actions 页面启用工作流（fork 默认禁用）。
2. 上游修改 `.github/workflows/` 下的文件时，默认的 `GITHUB_TOKEN` 无权推送。请创建一个带 `repo` 和 `workflow` 权限的 Personal Access Token，保存为仓库 secret `SYNC_TOKEN`。

**手动同步**（自动同步报冲突时，或想立刻拿到上游新功能时）：

```bash
bun local/scripts/sync.ts --install http://127.0.0.1:3000
```

它合并上游 `master`、安装依赖，最后把供应商重新装进运行中的 Toonflow；安装接口本身会用上游的规则校验供应商文件。冲突时停在合并状态：按上表处理上游文件后提交，再运行一次。

合并后重点看：`packages/providers/types.d.ts`（供应商契约）、`apps/server/src/utils/media/provider.ts`（加载与沙箱规则）、`apps/server/src/utils/media/generation.ts`（请求组装）。

## 供应商说明

### `magpie.ts`

- 没有参考图时调用 `POST /v1/images/generations`，有参考图时调用 `POST /v1/images/edits`（multipart，`image[]`）。
- 比例映射到 `1536x1024` / `1024x1536` / `1024x1024`，同时把比例写进提示词。
- 在 Magpie 中添加的其他图片模型，可以在设置页里直接新增模型 ID 使用。

### `comfyui.ts`

- **视频**：有首帧或尾帧时走 fl2va，否则走 ref2va（最多 9 张参考图、3 段参考视频、3 段参考音频）。只出 768P，时长 4–15 秒，帧数对齐 17k+5，24 fps。
  - 提示词写 `<Audio 1>: fully_copy` 表示直接用这段音频作对白并对口型。
  - **中途关键帧**：在参考模式下连入全部帧图，提示词中单独成行写 `@首帧 {{ref 1}}`、`@关键帧 1.5s {{ref 2}}`、`@尾帧 {{ref 3}}`。这时改走 fl2va，中途帧用 `MiniMaxH3AddGuide` 锚定（每段最多 7 张），与 hypit 的 `h3:FrameVideo` 做法一致。指令行会从提示词中去掉；每张连入的图都必须被指令用到。上游节点的首尾帧模式只能接 2 张图，所以关键帧走参考模式。
  - `h3PikaFast` 额外接 FastH3 的 SigmaShift、INT8 注意力和 VSA 稀疏注意力，与 `E:\comfyui\workflows\FastH3-*` 一致。
- **配音**：
  - `qwen3Tts`：选择音色或填写“声音描述”时为声音设计；接入参考音频时为克隆。
  - `drama3`：`library:` 开头的音色来自 ComfyUI 的 Drama3 音色库；克隆时必须填写参考音频的原文。
- **音乐**：`music3`。提示词写风格描述，歌词和最长时长在模型参数中填写；模型可能在达到最长时长之前就结束。
- 素材上传到 ComfyUI 的 `input/toonflow/`，结果以 `/view` 地址返回，由 Toonflow 下载到工作区。任务号保存在任务恢复数据中，Toonflow 重启后会继续等待。
- 模型文件名写在文件顶部的 `h3` / `music3` 常量中；ComfyUI 换了权重时改这里。
- 参考素材只解码一次，不再额外复制。宿主读取参考素材时仍会整段转成 base64，单次请求的内存约为素材体积的 2 倍；要根治，需要上游改为按路径传递素材。

## Agent 工具：`waitGeneration`

Agent 启动生成后，用它等待一批节点结束，再回读结果、继续下一批，不需要用户回来说“完成了”。工具每 15 秒查询一次各节点的 `node:getGenerationStatus`，默认最多等 60 分钟（`timeoutMinutes` 最大 180）。超时返回 `finished: false`，可以再次调用继续等。它依赖打开着的画布页面，页面关闭时会报“无法查询节点状态”。

## 验证

需要时手动执行，不绑定到同步或构建：

- `./node_modules/.bin/tsc -p local/tsconfig.json`：按 `packages/providers/types.d.ts` 做类型检查。
- `bun local/scripts/install.ts`：安装时由 Toonflow 按“添加供应商”的规则解析供应商文件，出错会直接报出。
- 端到端：先启动 Toonflow、Magpie、ComfyUI，然后在画布里分别用图片、视频、音频节点生成一次。
