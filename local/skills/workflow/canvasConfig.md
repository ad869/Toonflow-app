## 本机 H3 的执行配置

- 视频模型固定为 `comfyui / h3PikaFast`（画质优先用 `h3Pika`），不询问目标模型。
- 视频节点配置：`resolution` 只能是 `768P`；`duration` 取 4–15 的整数；`ratio` 取 16:9、9:16、1:1、4:3、3:4、21:9；`mode` 按实际连接的参考选择，关键帧方式使用参考模式（`imageReference`）。
- 旧节点指向不存在的模型（如 `tfRouter`、`apiMart`）时直接改为本机 H3 并换算参数，在汇报中说明，不让用户挑选供应商。
- 若宿主必须向用户确认画幅、是否生成声音等执行参数，回答后继续使用 PART A 已定稿的提示词，不重新进入通用工作流。
- 配音节点使用 `comfyui / qwen3Tts`（声音设计或克隆）或 `drama3`（含本地音色库）；配乐使用 `comfyui / music3`；图片使用 `magpie / codex/gpt-image-2`。
