# 机器可读输出与渲染作业协议（v1）

[English](protocol.md) · 简体中文

这是 CLI、JS API、桌面软件和其他读取方共同遵守的契约。版本即 `schema` 的值 `multiplane/1`：字段只增不改；改含义或删字段时升到 `multiplane/2`。

## 1. 总则

- 所有命令都支持 `--json`。开了 `--json`：**stdout 只输出 NDJSON**（一行一个 JSON 对象，UTF-8，`\n` 结尾），人类可读的文字、浏览器日志、警告一律走 stderr。没开 `--json`：stdout 打印人类可读的结果摘要，进度写 stderr。
- 程序输出的文字（错误信息、提示、进度文字）用**英文**。agent 靠 `code` 判断，不靠解析文字。
- 写完最后一行再结束进程：设置 `process.exitCode`，不在写 stdout 后立刻 `process.exit()`（Windows 管道可能来不及冲刷）。
- 墙钟时间只出现在事件时间戳、耗时、作业编号里，不参与任何画面计算。

## 2. 事件

每行都有：

| 字段 | 含义 |
|---|---|
| `schema` | 固定 `"multiplane/1"`。字段只增不改；改含义或删字段时升到 `/2`。 |
| `type` | 事件类型，见下表。 |
| `command` | `render` / `stills` / `verify` / `inspect` / `serve` / `lint` / `benchmark` / `doctor` / `status` / `cancel` / `wait` / `resume` / `config` / `skill`。续传的渲染作业事件里写的是 `render`；只有在新作业建立之前就失败时才出现 `resume`（第 6.1 节）。 |
| `ts` | ISO 8601 UTC 时间戳。 |

（`lint`、`inspect`、`serve` 不建作业目录，事件里没有 `jobId`。）

| `type` | 何时 | 额外字段 |
|---|---|---|
| `start` | 参数解析成功后第一行（给了 `--draft`、或镜头可能声明 `alpha` 默认值时，在预检之后发出：预检会加载镜头但不调用 `render(t)`，这样 `options` 里才是最终值；它仍是第一条事件） | `version`（包版本）、`shot`（绝对路径，无镜头的命令为 `null`）、`jobId`（有作业时）、`options`（加载镜头前就能确定的生效参数，含渲染器默认值；镜头自己声明的 `fps`、`post` 等见 `shot` 事件，最终生效值见 `result.data`）；续传的渲染另有 `resumedFrom` 和 `resume`（第 6.1 节） |
| `environment` | 浏览器启动后一次 | `node`、`platform`、`chromium`、`gpu`（`{renderer, hardware}`）、`ffmpeg`（`{path, version}`，不需要时为 `null`） |
| `shot` | 镜头加载完一次 | `width`、`height`、`duration`、`fps`、`cuts`、`post`（镜头声明的默认后期参数） |
| `progress` | 进度变化时，最多每 250 ms 一行 | `phase`（`launch` / `load` / `capture` / `encode` / `compare` / `finalize`）、`done`、`total`、`unit`（`"frame"` 等）、`fps`（实测速度，可为 `null`）、`etaMs`（可为 `null`）。`render` 在 `capture` 阶段的 `done` 是已截好的不同帧数（含复用的帧）；截好的帧可能还在等核验点，未必已交付或编码。预览帧总是已交付的帧 |
| `warning` | 不致命的问题 | `code`、`message`，可带 `details` |
| `finding` | 检查类命令发现的问题（`verify` 不一致、`lint` 发现的问题） | 见第 4 节 |
| `artifact` | 每写完一个产物文件 | `path`（绝对路径）、`kind`（`video` / `still` / `contact-sheet` / `report` / `diff-image`）、`bytes` |
| `listening` | 只有 `serve`：服务器开始接受连接时一次 | `url`、`root`（资源根的绝对路径）、`port` |
| `result` | **永远是最后一行**，成功失败都有 | 见第 3 节 |

进程被 Ctrl+C、停止文件或 `cancel` 中止时，也要尽量写出 `result`（`ok: false`、`code: "cancelled"`）。崩溃到来不及写 `result` 的情况，读取方以“没有 `result` 行且进程已退出”判定为 `internal_error`。

## 3. 最终结果 `result`

| 字段 | 含义 |
|---|---|
| `ok` | 布尔。 |
| `code` | 成功为 `null`，失败为第 5 节的错误码。 |
| `message` | 失败原因（英文）；成功为 `null`。 |
| `hint` | 可选：怎么修（英文一句话）。 |
| `details` | 可选：错误的结构化细节，如 `invalid_option` 的 `option`、`render_threw` 的 `t`。 |
| `artifacts` | 本次**完整写成**的产物，`[{path, kind, bytes}]`。失败时只列已经完整落盘的。 |
| `elapsedMs` | 整数。 |
| `jobId` | 有作业时给出。 |
| `data` | 命令专属的结果，见下。 |

`data` 按命令：

- `render`：`{ output, frames, fps, from, to, width, height, encoder, post: {motionBlur, maxMotionBlur, shutter, adaptiveBlur, grain}, blurSamples, renderScale, scale, draft, format, alpha, outputCheck, resources }`。`format` 为 `mp4`、`webm` 或 `mov`；走透明路径时 `alpha` 为 `true`。给了 `--draft` 时 `draft` 为 `true`（快速预览的预设：渲染倍率不超过 0.5、不做运动模糊、不加颗粒；显式给出的参数优先于预设，预设优先于用户配置和镜头默认值；输出尺寸、帧率、编码器、并行数不变；舞台尺寸找不到不超过 0.5 的合法倍率时以 `invalid_scale` 失败）。`outputCheck` 是成品发布前从编码后的文件里读回来的信息：`{ verified, frames, durationSeconds, width, height, fps, codec, pixelFormat, audioDurationSeconds }`（`audioDurationSeconds` 只在成品有音轨时出现）；无法探测文件时 `verified` 为 `false`（见 `output_unverified`）。`pixelFormat` 是解码文件时报告的格式，可能与编码输入不同。核对要求：帧数完全相等，时长差不超过一帧，宽高完全相等，帧率与要求值的相对差不超过 1e-4（WebM 等容器的时间戳精度有限，59.94 读回来可能是 59.940063）。帧率以精确分数传给编码器，例如 29.97 传为 30000/1001。透明输出另外解码首帧和中间帧（VP9 用 `libvpx-vp9` 解码，默认的 VP9 解码器会丢掉 alpha），与源帧的 alpha 比较；任一像素差超过 2/255 或 alpha 丢失，以 `output_invalid` 结束（透明输出不会未经核对就发布）。`resources` 为整个进程树（渲染器、浏览器进程、worker、编码器）的 `{ peakMemoryBytes, memorySamples, workers, cpuCount }`；测不到的值为 `null`。`peakMemoryBytes` 是周期采样中的最大值，不是操作系统的精确峰值；`memorySamples` 只计成功的采样；`workers` 是实际用到的最大数量。`stills` 和 `verify` 的结果同样带 `resources`。`render`、`stills`、`verify` 的结果还带 `staticReuse`（第 12 节）、生效的 `post`，以及 `blurSamples`：`{ min, max, mean, histogram }`，即每个交付帧实际混合了多少个时间采样（`histogram` 的键是采样数的十进制字符串，值是帧数）。静止帧计 1；复用帧沿用被复用那一帧的采样数。`verify` 每个请求时刻只计一次。`dofSamples` 结构相同，统计每个交付帧最终合成图里三维层的景深累积次数（多个三维层相加；没有三维层为 0；探测图和重试不计）。

**画质预设。** `render`、`stills`、`verify` 接受 `--quality draft|fast|standard|high`（JS 选项 `quality`），默认 `standard`，`result.data.quality` 报告实际用的档。预设只决定运动模糊的采样数怎么定，不决定镜头有没有运动模糊：没开运动模糊（`motionBlur` 为 1）的镜头在任何一档下像素都相同。`draft` 等同于 `--draft`（`--draft` 保留为别名，两者同时给且不一致时以 `invalid_option` 失败）。`fast` 就是上限更低的 `standard`，用于要速度、对快速运动的顺滑程度没那么挑的场合；正式成片用 `standard`。`fast`、`standard` 和 `high` 下，`motionBlur` 是起步采样数（`fast` 和 `standard` 起步最多 4：`motionBlur` 更大时按 4 起步，上限不大于 `motionBlur` 的固定采样情况除外，见下文）：每帧先在快门窗口里按这个数均匀取时刻截图，把画面分成 8×8 像素的小块，逐块比较相邻两个采样，差异除以这一块的边缘强度，近似得到内容在两个采样之间移动了多少像素。任何一块移动超过约 2 像素（`fast`、`standard`）或约 1 像素（`high`），就把采样数加倍、按更密的网格重新截，最多到 16（`fast`）、32（`standard`）或 256（`high`）。所有采样完全相同时这一帧只用 1 个采样。`maxMotionBlur`（`--max-motion-blur`，或镜头的 `post.maxMotionBlur`，命令行优先）替换预设的上限；上限不大于 `motionBlur` 时采样数固定为 `motionBlur`。每帧先截快门窗口两端和中间 3 张，三张完全相同就只用 1 个采样。采样网格是嵌套的：每一档都是最大网格里对称取出的子集，加倍时只补新的时刻，已截的图保留（镜头读取 `SHOT.sampleContext.motionBlur` 时，每一档仍按完整网格重截；自带的三维层改读 `SHOT.sampleContext.motionBlurBase`，即起步采样数，加倍过程中不变，所以三维层也保留已截的图。景深采样不和运动采样相乘：先用镜头相位固定的探测图定下运动采样数 N，再把这一帧三维层的景深预算（含虚焦大时自动加的量）分到 N 张最终截图上，每张 `max(2, ceil(预算 / N))`：这一帧只用一套总点数为这么多的镜头采样图案，第 k 张截图取第 k、k + N、k + 2N……个点（k 是这张截图在这一帧采样时刻里的次序），N 张合起来正好把整套图案的每个点用一次，合成后覆盖整个光圈。镜头采样怎么分配不算运动：判断要不要加倍时，三维层另截图案相位固定的图来比较，景深噪点不会把采样数推到上限）。采样时刻只由帧、快门和采样数决定，结果与渲染顺序和 worker 数无关。硬切照样限制窗口。`--no-post` 关闭运动模糊。镜头定义了 `blurAt(t)` 时沿用它自己的采样数，不再往上加。
- `stills`：`{ stills: [{t, frame, path}], contactSheet, draft, format, alpha }`。`draft` 含义同 `render`；`format` 恒为 `png`；带 `alpha` 时抽帧保留透明，联系表合成在棋盘格底上。
- `verify`：`{ passed, times, workers, checks: [{name, passed, jitter}] , findings: n, format, alpha }`（`format` 为 `png`；带 `alpha` 时四个通道都比较）。不一致时 `ok: false`、`code: "nondeterministic_output"`，`finding` 事件里有细节。
- `lint`：`{ files: [...扫描过的文件，相对资源根], errors, warnings, suppressed }`。有 error 时 `ok: false`、`code: "lint_failed"`；只有 warning 时 `ok: true`。`render` / `stills` / `verify` 默认先跑 lint，它的 `finding` 进入同一事件流；`--no-lint` 跳过。
- `inspect`：`{ shot, duration, fps, frames, stage: {width, height}, cuts, post, hasBlurAt, meta }`（第 10.1 节）。
- `serve`：服务器停止后为 `{}`（第 10.2 节）。
- `doctor`：`{ checks: [{name, ok, detail}] }`，检查 Node 版本、浏览器、GPU 光栅、FFmpeg 和 libx264、可选 three.js。
- 由 `resume` 发起的 `render` 另有 `resumedFrom` 和 `resume`（第 6.1 节）。
- `status` / `cancel`：作业状态快照（第 6 节）；`render` 作业的 `status` 另有 `resume`（第 6.1 节）。
- `wait`：原作业的事件流，见第 11.5 节。

## 4. `finding`

| 字段 | 含义 |
|---|---|
| `code` | 规则或问题码，如 `nondeterministic_output`。 |
| `severity` | `error` / `warning`。 |
| `message` | 英文说明。 |
| `hint` | 可选，修复建议。 |
| `location` | 可选：`{file, line, column}`（源码位置，`lint` 用）或 `{t, frame}`（时间位置，`verify` 用）。 |
| `details` | 可选。`verify` 至少给：`check`（`reorder` / `reload` / `workers:<n>` / `range`）、`changedPixels`、`maxChannelDiff`、`bbox`（`{x, y, w, h}`，变化区域外接框）、`images`（`{reference, actual, diff}`：参考帧、实际帧、差异图的路径）。 |

## 4a. 输出格式与透明

- `render --format mp4|webm|mov`。不给 `--format` 时按 `--out` 的扩展名决定，两者都没有时为 `mp4`；扩展名矛盾或未知时以 `invalid_option` 失败。默认作业文件名用该格式的扩展名。
- `mp4`：H.264 或 HEVC（`--encoder x264|nvenc-h264|nvenc-hevc`），只能不透明。
- `webm`：VP9（`libvpx-vp9`），透明为 `yuva420p`，不透明为 `yuv420p`；音频为 Opus。这一版的质量参数固定。
- `mov`：ProRes 4444（`prores_ks`），透明为 `yuva444p10le`，不透明为 `yuv444p10le`。
- `--encoder` 只对 `mp4` 有效；和其他格式一起用以 `invalid_option` 失败。
- `--alpha`（`render`、`stills`、`verify` 都支持）保留透明通道。页面背景是透明的；镜头自己画的东西，包括 `#stage` 的背景色，照样不透明。镜头可以用 `post: { alpha: true }` 声明默认值，命令行优先。`--alpha` 配 `mp4` 以 `invalid_option` 失败。
- 透明路径里，运动模糊的平均和缩放都在预乘后的线性光里做；alpha 线性平均；全透明输出像素的颜色为 0；颗粒只改变可见颜色。不带 `--alpha` 时输出与以前的版本完全相同。
- FFmpeg 构建缺少所需编码器时以 `ffmpeg_unusable` 结束；`doctor` 把 `libvpx-vp9`、`prores_ks` 列为可选检查。

## 5. 错误码与退出码

错误码是稳定的小写下划线字符串，**只增不改**。

| 退出码 | 类别 | 错误码 |
|---|---|---|
| 0 | 成功 | — |
| 1 | 镜头或检查不通过 | `shot_not_found`、`shot_outside_root`、`shot_load_failed`（HTTP 或脚本错误）、`shot_contract_invalid`（缺 `SHOT`、`render` 不是函数、`duration`/`fps`/`cuts` 不合法等）、`stage_size_invalid`（缺 `#stage`、尺寸不是正整数或随视口变化）、`ready_timeout`、`render_threw`（`render(t)` 抛错，`details` 带 `t`）、`resource_failed`（字体或素材加载失败）、`nondeterministic_output`、`lint_failed`、`cancel_timeout`（`cancel --wait` 到时作业仍未结束） |
| 2 | 用法错误 | `invalid_option`（未知、重复、缺值、取值非法；`details.option`）、`invalid_scale`（倍率导致奇数或非整数尺寸，`hint` 给可用倍率）、`output_exists`（显式输出路径已有文件且没给 `--overwrite`）、`job_not_found`（`status` / `cancel` / `resume` 找不到作业或快照损坏）、`resume_unavailable`（作业不能续传；`details.reason`，见第 6.1 节） |
| 3 | 环境问题 | `skill_modified`、`skill_blocked`、`skill_changed`（见 9.2）、`config_invalid`（作为 `config` 命令的失败，见 9.1；在其他地方只是警告）、`ffmpeg_not_found`、`ffmpeg_unusable`（能找到但不能运行或缺编码器）、`browser_not_installed`、`browser_launch_failed`、`three_not_installed`、`unsupported_node`、`wait_timeout`（`wait --timeout` 到时，作业本身不受影响）、`port_in_use`（`serve --port` 指定的端口已被占用）、`job_dir_unwritable`（作业目录无法创建或写入，例如在只读目录里运行；`details.path`；`hint` 指向 `--job-dir` 和 `MULTIPLANE_JOBS_DIR`） |
| 4 | 渲染器内部 | `output_invalid`（编码后的文件与渲染内容不符：帧数、时长、尺寸或帧率；`details.expected` 与 `details.actual`；文件不会发布）、`worker_crashed`、`browser_crashed`（浏览器进程或页面意外关闭，重启后仍然失败，或者同一帧第三次卡住，见 `worker_stalled`；已知时带 `details.t`）、`encode_failed`、`internal_error` |
| 130 | 被取消 | `cancelled` |

警告码（只出现在 `warning` 事件，不影响退出码）：`browser_restarted`（浏览器进程或页面意外关闭，已重新启动并重渲受影响的帧；`render(t)` 只由 `t` 决定，所以不会改变像素；`details.attempt`）、`worker_stalled`（某个 worker 手上有帧，却在 `max(120 秒, 本次作业已完成帧最长耗时 × 10)` 内一帧都没交出；已关闭并重启它的浏览器，整帧重做，像素不变；每帧最多重试两次，第三次卡住以 `browser_crashed` 结束；`details: { worker, frame, waitedSeconds }`，`worker` 和 `frame` 从 0 数起）、`output_unverified`（无法探测编码后的文件，未经核对就发布了；`details.reason`）、`gpu_software_fallback`（要求 GPU 光栅但实际落到软件渲染器）、`home_unavailable`（用户级目录读写失败，见第 8 节）、`config_invalid`（用户配置某字段非法，已忽略；整份文件损坏或顶层不是对象时 `details.field` 为 `"$"`）、`preview_failed`（预览帧写入失败，每个作业只报一次，此后不再更新预览，渲染照常）、`static_reuse_disabled`（核验帧与复用的那份不一致：本作业余下部分关闭复用，受影响的帧重新截图，成品仍然正确；`details.frame`、`details.t`）、`resume_renderer_changed`（续传时的显卡或驱动与原作业不同；`details.before`、`details.after`；见第 6.1 节）。

lint 规则码（`finding.code`）：`wall_clock`、`unseeded_random`、`css_animation`、`web_animations`、`media_playback`、`remote_resource`、`resource_missing`、`stage_missing`、`shot_missing`、`runtime_missing`、`async_render` 为 error；`timer_driven`、`animated_image`、`stage_size_unfixed`、`font_not_awaited`、`lint_directive_invalid`、`lint_incomplete`（某段源码无法解析、被跳过，扫描覆盖不完整）为 warning。lint 的 `location` 为 `{file, line, column}`（相对资源根，从 1 开始），`details.snippet` 为该行源码。问题行的上一行写注释 `multiplane-disable-next-line <规则码>` 可豁免。

## 6. 渲染作业

`render`、`stills`、`verify` 每次运行都是一个作业。

- `jobId`：`<UTC 时间 yyyyMMdd-HHmmss>-<镜头文件名>-<4 位十六进制随机>`，保证并发运行不撞名。
- 作业目录：默认 `<cwd>/out/jobs/<jobId>/`；`--job-dir <dir>` 或环境变量 `MULTIPLANE_JOBS_DIR` 改父目录。
- 产物位置：不给 `--out` 时产物写在作业目录里（视频 `<jobDir>/<镜头名>.mp4`，抽帧 `<jobDir>/stills/`，检查报告和差异图 `<jobDir>/verify/`），每次运行互不覆盖。给了 `--out` 而目标已存在时以 `output_exists` 失败，加 `--overwrite` 才覆盖：先完整写到临时位置再替换（目录产物整个替换），失败时原产物不动。
- 目录内容：
  - `events.jsonl`：与 `--json` 的 stdout **完全相同**的事件流（不管开没开 `--json` 都写）。
  - `status.json`：最新快照，原子写入（写临时文件再改名）：`{schema, jobId, command, shot, pid, state, phase, done, total, fps, etaMs, previewFrame, memoryBytes, startedAt, updatedAt, result}`；`state` 为 `queued` / `running` / `succeeded` / `failed` / `cancelled`。`queued` 只用于在软件队列里等待的托管作业（第 11 节）：排队期间由软件写快照，`pid` 是软件的进程，并加字段 `queuePosition`（从 1 起，1 表示下一个执行）。读取方遇到不认识的状态按“进行中”显示。`result` 结束时等于 `result` 事件的内容，运行中为 `null`。
  - `stderr.log`：由桌面软件启动的渲染进程（托管执行者、在软件里发起的接续）的标准错误输出，进程结束后保留。agent 直接运行命令时没有这个文件。
  - 停止请求：在目录里创建 `stop` 文件。渲染器检测到后清理并以 `cancelled` 结束。
  - `segments/`（仅 `render`）：编好的分段及其记录，见第 6.1 节；渲染成功后删除。续传作业没有自己的 `segments/`，而是有 `resume.json`（`{ directory }`），指向它接着写的那个 `segments/` 目录。
- `multiplane status <jobId|jobDir> [--json]`：读 `status.json`；进程已不在而 `state` 仍是 `running` 时报告为 `failed` / `internal_error`（不改文件）。`status` 本身的 `ok` 只表示读到了快照，原作业的成败看 `data.state` 和 `data.result`。
- `multiplane cancel <jobId|jobDir> [--json]`：创建 `stop` 文件，等待作业结束（`--wait` 秒，默认 30），输出最终状态；作业已经结束时直接返回原终态；到时仍未结束返回 `cancel_timeout`。
- `--help`（全局或 `multiplane <command> --help`）和 `--version` 只输出人类可读文字，不产生事件。
- 作业目录不自动清理；桌面软件和其他读取方依赖这套文件。

### 6.1 分段与 `multiplane resume`

渲染中途停下（进程被杀、死机或睡眠、浏览器反复崩溃、用户停止）后，可以从停下的地方接着渲，不用从头再来。

- **分段**：每个 `render` 都按约 10 秒一段编码（`round(fps × 10)` 帧，从本次范围的第一帧起算），每段用独立的编码器、不含音轨。一段的帧数核对无误并改名到位之后才算保留；在那之前中断的段不算。所有段齐了以后不重新编码、直接拼接，按原来的规则裁剪并混入音轨，拼好的文件照常做成品核对（第 3 节）。只有一段时不拼接。成功后删除 `segments/`，失败或取消时保留。
- **记录**：`segments/manifest.json`（schema 为 `multiplane-segments/1`，原子写入）保存镜头、生效参数、环境、帧范围、段长、镜头经渲染器本地服务器加载过的每个文件（以及 `--audio` 文件）的 SHA-256，以及每个已保留段的范围、文件名、大小和 SHA-256。`segments/render.lock` 由正在写段的进程持有，持有者进程已不在时视为过期。这份记录是内部格式，读取方应使用 `status`。
- **命令**：`multiplane resume <jobId|jobDir> [--json] [--job-dir <dir>] [--workers <n>] [--no-hosted]`；JS API 为 `resumeRender(jobIdOrDir, options)`，返回结构与 `renderShot` 相同。只接受这几个参数，给别的以 `invalid_option` 失败。渲染使用原作业的生效参数和输出路径，不读当前的用户配置和镜头默认值。
- **新作业**：续传会新建一个 `render` 作业，有自己的 ID 和目录；原作业的文件和终态不变。已保留的段直接复用，丢失或损坏（大小或 SHA-256 不符）的段重新渲染；新段写进原来的 `segments/`，所以续传的作业还可以再续。`start` 事件和 `result.data` 加 `resumedFrom`（原作业的 `jobId`）和 `resume: { segmentsReused, framesReused }`。进度把复用的帧算作已完成。
- **拒绝续传的情况**（`resume_unavailable`，退出码 2，`details.reason`）：
  - `running`：原作业还在运行，或另一个续传正持有分段锁；
  - `succeeded`：已经没有要渲的部分；
  - `not_render`：作业是 `stills` 或 `verify`；
  - `missing_manifest`：作业没有可用的记录（由不分段的旧版本生成，或在开始渲染之前就失败了）；
  - `inputs_changed`：镜头加载过的某个文件或音轨文件被改动或删除；`details.changes` 列出路径；
  - `environment_changed`：Multiplane 版本、Chromium 版本、光栅方式、FFmpeg 版本或编码器不同；`details.changes` 列出哪几项。
  `state` 为 `running` 但进程已不在的作业按 `failed` 处理，可以续传。显卡或驱动不同不会拒绝续传，只发警告 `resume_renderer_changed` 后继续，因为 GPU 光栅的差别最多是第 14 节所说的抖动。
- **状态**：`render` 作业的 `status` 加 `resume: { available, reason, framesDone, framesTotal }`。`available` 和 `reason` 只看作业状态和记录，输入和环境在运行 `resume` 时才核对。

## 7. JS API

- `renderShot` / `stillsShot` / `verifyShot` / `inspectShot` / `lintShot` / `doctor` 返回与 `result` 事件相同结构的对象（不含 `schema`、`type`、`ts`）。
- 失败时抛出 `MultiplaneError`（继承 `Error`），带 `code`、`exitCode`、`hint`、`details`、`result`。
- 可选 `onEvent(event)` 回调，收到与 NDJSON 相同的事件对象；不再用 `print` 回调。

## 8. 用户级目录（给配套软件和其他读取方）

渲染器在用户级目录里登记作业、读取用户默认配置。目录位置由平台层决定，环境变量 `MULTIPLANE_HOME` 可覆盖：

| 平台 | 默认位置 |
|---|---|
| Windows | `%USERPROFILE%\.multiplane`（0.2.0 及以前是 `%APPDATA%\multiplane`，见下） |
| macOS | `~/Library/Application Support/multiplane` |
| Linux | `$XDG_CONFIG_HOME/multiplane`，未设时 `~/.config/multiplane` |

Windows 上放在 `%APPDATA%` 之外，是因为 MSIX 打包的应用（其中包括一些 agent 宿主）对 `%APPDATA%` 的写入会被重定向到一份私有副本，其他程序看不到。渲染器第一次用到新目录时，新目录里缺 `config.json`、`jobs.jsonl`、`jobs.1.jsonl` 的，从旧位置复制过来，旧文件保留。设置了 `MULTIPLANE_HOME` 时不复制。

**这个目录里的读写失败一律不影响渲染**：写不进去只发一条 `warning`（`home_unavailable`），作业照常进行。

### 8.1 作业索引 `jobs.jsonl`

只追加，一行一个 JSON。每个作业（`render` / `stills` / `verify`）开始和结束各追加一行：

```json
{"schema":"multiplane/1","event":"start","jobId":"…","jobDir":"/abs/out/jobs/…","command":"render","shot":"/abs/shot.html","pid":1234,"ts":"…"}
{"schema":"multiplane/1","event":"end","jobId":"…","jobDir":"/abs/out/jobs/…","state":"succeeded","ts":"…"}
```

- 读取方以作业目录里的 `status.json` 为准，索引只用来发现作业。作业目录被删掉的条目，读取方直接忽略。
- 每行一次 `append` 写入（单次写调用、以 `\n` 结尾），多个进程并发追加不交错。
- 追加和轮转用同目录的 `jobs.lock` 互斥。锁文件里写持有者的 `pid` 和时间；持有者进程已不存在、或锁已存在超过 10 秒（正常只占用毫秒级），视为失效，删除后重试。
- 文件超过 10 MiB 时，渲染器在追加前把它改名为 `jobs.1.jsonl`（覆盖已有的）再新建；读取方两份都读。
- 环境变量 `MULTIPLANE_NO_INDEX=1` 关闭登记（测试和不想被发现的场合）。

### 8.2 用户配置 `config.json`

```json
{"schema":"multiplane/1","ffmpeg":"D:/tools/ffmpeg/bin/ffmpeg.exe","raster":"gpu","encoder":"x264","workers":null,"jobsDir":null,"hosted":null}
```

- 所有字段可选，`null` 或缺省表示用内置默认值。未知字段忽略，取值非法时发 `warning`（`config_invalid`，`details.field`）并忽略该字段。
- 优先级：命令行参数 > 环境变量（`MULTIPLANE_FFMPEG`、`MULTIPLANE_JOBS_DIR`、`MULTIPLANE_HOSTED`）> `config.json` > 内置默认值。
- `start` 事件的 `options` 反映合并后的值；`doctor` 的结果里报告配置文件路径、是否存在、哪些字段生效。
- 渲染作业只读这个文件，从不写。写它的是 `config` 命令（9.1，配套软件也用它），或者用户手动编辑。

### 8.3 预览帧 `preview.png`

`render` 运行时，在作业目录里维护一张最新完成帧的缩略图 `preview.png`：长边不超过 480 像素，最多每 2 秒更新一次，原子写入。`status.json` 增加 `previewFrame`（缩略图对应的帧号，没有时为 `null`）。预览只是旁路输出，不得改变成片的任何像素，也不得明显拖慢渲染（实测说明开销）。

### 8.4 随包的 skill

npm 包带上 `skills/multiplane/`。用 `multiplane skill install`（9.2）把它装进 agent 的 skill 目录，配套软件用的是同一个命令。skill 版本跟随包版本。

## 9. 配置命令

`config` 和 `skill` 让 agent 不靠配套软件也能把一台机器配好。它们不是作业：不建作业目录，不进作业索引。带 `--json` 时输出 `start` 和 `result` 两个事件，和 `doctor` 一样。

### 9.1 `multiplane config`

| 命令 | 作用 |
|---|---|
| `multiplane config get [<key>]` | 读用户配置。`data`：`{ file, exists, values: { ffmpeg, raster, encoder, workers, jobsDir }, overrides: { ffmpeg, jobsDir } }`。`values` 是文件里的值（没有的为 `null`）；`overrides` 是当前会盖过它的环境变量（没设为 `null`）。给了 `<key>` 时 `values` 只含那一项。 |
| `multiplane config set <key> <value>` | 校验后写入（先写临时文件再改名）。`data` 同 `get`，另加 `changed: <key>`。 |
| `multiplane config unset <key>` | 把该项置为 `null`。 |

- 键和取值：`ffmpeg`（路径）、`jobsDir`（路径）、`raster`（`gpu` 或 `software`）、`encoder`（`x264`、`nvenc-h264` 或 `nvenc-hevc`）、`workers`（正整数；`auto` 等同于 `unset`）、`hosted`（`true` 或 `false`，见第 11 节）。未知的键或非法的值以 `invalid_option` 失败，不改文件。相对路径先按当前目录解析成绝对路径再写。
- 文件里已有的未知字段原样保留。文件不是 JSON 对象时，`get` 和 `set` 以 `config_invalid` 失败（退出码 3），不覆盖它。`unset` 返回的 `data` 和 `set` 一样，也带 `changed`。
- `config set ffmpeg <path>` 写入路径后立刻探测。`data.check` 为 `{ usable, version, encoders: { libx264, "libvpx-vp9", prores_ks }, reason }`。`usable` 要求文件报出 FFmpeg 版本并带 `libx264`，另外两个编码器是可选的。可用时 `reason` 为 `null`，否则为 `not-found`、`cannot-run`、`not-ffmpeg` 或 `missing-libx264`。路径不可用时照样写入、命令照样成功，另发一条 `warning`（码 `ffmpeg_unusable`）。

### 9.2 `multiplane skill`

| 命令 | 作用 |
|---|---|
| `multiplane skill status [--host <h>]` | `data.hosts`：每个宿主一项，`{ host, target, detected, state, version, availableVersion, signature, blocked, error }`。`state` 为 `missing`、`latest`、`update`、`modified` 或 `error`。`--host` 缺省为 `all`。 |
| `multiplane skill install --host <h> [--force] [--expect <signature>]` | 安装随包的 skill，或更新到随包版本。 |
| `multiplane skill remove --host <h> [--force] [--expect <signature>]` | 移除。 |

- `<h>` 为 `claude`、`codex` 或 `all`。`install` 和 `remove` 必须给 `--host`。
- 目标目录：Claude Code 是 `<主目录>/.claude/skills/multiplane`，Codex 是 `<主目录>/.agents/skills/multiplane`。环境变量 `MULTIPLANE_AGENT_HOME` 可以替换 `<主目录>`，给测试和非标准安装用。
- 每份装好的 skill 带一个记录文件 `.multiplane.json`，里面是版本和内容哈希。内容和任何发行版本都对不上的，状态是 `modified`。
- 改过的 skill 不会被默默替换。不带 `--force` 时 `install` 和 `remove` 以 `skill_modified` 失败；带 `--force` 时先把原目录改名为同级的 `multiplane.bak-<yyyyMMdd-HHmmss>`，结果里的 `backup` 给出它的路径。
- 目标是符号链接、或含不支持的文件类型时为 `blocked`，命令以 `skill_blocked` 失败，带不带 `--force` 都一样。
- `--expect <signature>`：装好的那份已经不是先前 `status` 返回的签名时，以 `skill_changed` 失败。还没装的那份签名是 `null`，传 `--expect null` 表示要求它仍然没装。不给 `--expect` 就不检查。
- `--host all` 逐个宿主处理，互不影响。`data.hosts` 每个宿主一项，`{ host, action, ok, code, message, target, version, backup }`。有任何一个失败，整体 `ok: false`，`code` 取第一个失败的码。

## 10. 查看与预览镜头

### 10.1 `multiplane inspect <shot>`

和渲染一样加载镜头（默认先 lint，可用 `--no-lint` 跳过；等字体和 `setup` 完成），但不截图、不建作业。参数：`--root`、`--fps`、`--no-lint`、`--json`。

`result.data` 为 `{ shot, duration, fps, frames, stage: { width, height }, cuts, post, hasBlurAt, meta }`。`fps` 和 `frames` 按 `render` 的同一规则计算，就是同样参数下渲染会得到的值。`duration` 是 `setup` 之后的值（`setup` 可以改它）。`hasBlurAt` 表示镜头是否定义了 `blurAt(t)`。`meta` 是镜头在 `Shot.define({ meta })` 里给的内容，没给为 `null`。

`meta` 是给读取镜头的工具用的任意数据，例如节拍或字幕列表。必须能 JSON 序列化且不超过 1 MiB，否则加载以 `shot_contract_invalid` 失败。页面里可以通过 `SHOT.meta` 读到，不影响像素。

### 10.2 `multiplane serve`

把渲染时用的静态服务器常驻开着，用来在写镜头时用浏览器打开。资源根和规则与渲染时相同：越出资源根的路径被拒绝，`/multiplane/` 保留给运行时库。

- `--root <dir>`（默认当前目录）、`--port <n>`（默认 0，由系统分配空闲端口）、`--json`。
- 只监听 127.0.0.1。
- 带 `--json` 时先发 `start`，开始接受连接后发 `listening`：`{ url, root, port }`。不带 `--json` 时在 stdout 打印地址。收到 Ctrl+C 或终止信号后关闭，发 `result` 并以 0 退出。
- 端口已被占用时以 `port_in_use` 失败（退出码 3）。
- `GET /multiplane/shots.json` 返回资源根下所有 `.html` 文件的相对路径（按字典序排好的 JSON 数组），跳过隐藏目录、`node_modules` 和 `out`。渲染时的服务器也提供这个路由。
- 不做播放器、热重载和文件监视。

## 11. 托管渲染

agent 发起的渲染本来是会话的子进程，会话一结束就被连带中断。开启托管后，渲染改由桌面软件启动、脱离会话。agent 运行的命令和看到的输出都不变。

### 11.1 什么时候托管

同时满足才托管，否则照旧自己渲染：

1. 命令是 `render`、`stills`、`verify` 或 `resume`。续传请求的 `command` 为 `"resume"`；不认这种请求的软件版本会拒绝或不认领，等待者照第 11.3 节自己渲染。
2. `config.json` 的 `hosted` 为 `true`（`multiplane config set hosted true`），默认关闭。
3. 没有给 `--no-hosted`，`MULTIPLANE_HOSTED` 不是 `0`。
4. `<用户级目录>/app.json` 表明软件在运行并接受托管：`{ schema, pid, createdAt, acceptsHosted: true, version }`。`createdAt` 是操作系统记录的 `pid` 进程创建时间（UTC ISO 字符串）；渲染器核对进程存在且时间一致。软件启动时写这个文件，退出时删除或把 `acceptsHosted` 改为 `false`。

### 11.2 请求与认领

三方：**等待者**（agent 运行的那条命令）、**软件**、**执行者**（软件启动的渲染进程）。文件在 `<用户级目录>/hosted/`，以作业 ID 命名。

1. 等待者先做完正常的准备：解析参数、读配置、lint（lint 失败照常失败，不交出去）、生成作业 ID、建好作业目录。然后写 `<jobId>.request.json`（先写临时文件再改名）：`{ schema, jobId, jobDir, command, args, cwd, node, bin, env, at }`。`args` 是原样的镜头路径和参数，不含命令名和 `--json`。`node` 和 `bin` 是等待者自己的 Node 可执行文件和 `multiplane` 入口，保证用的是 agent 调用的那一份渲染器。`env` 只保留渲染需要的变量（`PATH`、`MULTIPLANE_*`、不含凭据的代理变量、临时目录和主目录、语言区域；等待者是桌面软件自带的命令行入口时，还有把软件可执行文件当 Node 运行的 `ELECTRON_RUN_AS_NODE`），名字像机密的变量一律不写。软件只认领 `node` 为 `node` / `node.exe`、或者就是软件自己的可执行文件且 `ELECTRON_RUN_AS_NODE` 为 `1` 的请求，其他可执行文件一律拒绝。
2. 软件核对后把 `request` 改名为 `claimed` 来认领；核对不过改名为 `rejected` 并写 `reason`。核对内容：`bin` 所在包的名字是 `multiplane`；`node` 是存在的绝对路径，文件名是 `node` 或 `node.exe`；`jobDir` 存在且与 `jobId` 对应。
3. 认领后作业进入软件的队列，**一次只执行一个**，按认领顺序。排队期间作业的 `status.json` 为 `state: "queued"`，带 `queuePosition`。
4. 轮到它时，软件以脱离自身的方式启动执行者，关掉软件也不会中断它。执行者先把 `claimed` 改名为 `running`，改名失败就以 0 退出、不写任何东西。它沿用等待者建好的作业 ID 和作业目录。

### 11.3 收回

- 5 秒内没被认领：等待者把请求改名为 `withdrawn`，改名成功就自己渲染。
- 看到 `rejected`：等待者立即自己渲染。
- 已认领但 15 秒后既没开始也没进入排队：等待者把 `claimed` 改名为 `withdrawn`，改名成功就自己渲染。
- 谁拿到作业由改名决定，等待者和迟到的执行者不会同时执行同一个作业。等待者自己渲染时在 stderr 说明原因。

### 11.4 等待者的输出

- 交接成功时在 stderr 打印一行人能读的说明：作业已交给 Multiplane，关掉会话也不会中断；排队时说明位置。
- stdout 只转发执行者写进 `events.jsonl` 的事件，**逐字节相同**，带不带 `--json` 都一样。排队期间没有输出。
- 读到 `result` 后以作业的退出码退出。等待者被结束不影响作业。

### 11.5 `multiplane wait <jobId|jobDir>`

等一个作业结束，托管与否都能用。参数：`--json`、`--timeout <秒>`、`--job-dir <目录>`（解析方式与 `status` 相同）。

- 带 `--json` 时先原样输出 `events.jsonl` 已有的内容，再跟随到 `result`，退出码与作业相同；作业已经结束时立即输出。不带 `--json` 时照常输出人读的结果。
- 作业还在排队时照样等。
- `--timeout` 先到时以 `wait_timeout` 失败（退出码 3），作业本身不受影响。
- 会话重启后，agent 对之前发起、还没看到结果的作业运行 `wait`。

### 11.6 停止

- 运行中的托管作业和普通作业一样停：在作业目录放 `stop` 文件，或 `multiplane cancel`。
- 排队中的作业：软件看到 `stop` 文件就把它移出队列，`status.json` 写 `cancelled`，`result.code` 为 `cancelled`。

## 12. 静止帧复用

画面没变的帧不再重新截图，直接复用上一帧的像素。`render` 和 `stills` 默认开启；`verify` 默认关闭，它的检查总是真截。`--no-static-reuse` 关闭；`--static-reuse` 在 `verify` 里开启，并额外把整个镜头开关复用的结果逐帧比较。开不开复用，输出都一样。

- **怎么判断静止。** 镜头脚本运行之前，渲染器就开始观测页面：DOM 增删、属性和文本变化、样式和样式表变化、Canvas 与 WebGL 的绘制调用，以及加载、滚动、尺寸、焦点和字体事件。两个相邻帧之间什么都没观测到，后一帧就复用前一帧。开运动模糊时，快门窗口里每个采样时刻也都必须静止。硬切旁边的帧、每个 worker 的第一帧、乱序请求的帧总是真截。
- **不复用的情况。** 变化观测不到的内容：`video`、`iframe`、`object`、`embed`、`marquee`、镜头自己创建的 Shadow DOM、正在运行的 CSS 或 Web Animations 动画、动图、Worklet、转交其他线程的 Canvas、读不到的样式表、`@import`、外部 CSS `url(...)` 和 `paint(...)`。静态图片、SVG、表单控件和暂停的动画不妨碍复用。
- **核验。** 每段连续静止帧的第一个复用帧、帧号是 16 的倍数的复用帧、以及每段的末尾，渲染器会真截一次，与复用的那份逐像素（四个通道）比较。帧要等下一个核验点通过后才交给编码器。不一致时，本作业余下部分关闭复用，自上一个通过的核验点以来的帧全部重截，并发一次 `static_reuse_disabled` 警告。核验帧按固定规则选，不用随机数或墙钟时间。
- **结果。** `result.data.staticReuse` 为 `{ enabled, reusedFrames, verifiedFrames, disabledReason }`：结束时是否仍开启、复用的帧数、核验的帧数、`null` 或 `"pixel_mismatch"`。复用数为 0 不是错误，只说明没有能安全复用的帧。`observationReasons` 说明为什么没能复用：键是原因（`mutation`、`drawing_or_setter`、`unobservable_api`、`hook_replaced`、`dynamic_element`、`editable_focus`、`animation_or_font`、`image`、`external_style`、`stylesheet`），值是所有 worker 累计以它为决定原因的次数，含运动模糊的子采样和核验，只列非零项。它是诊断信息，不是帧数，每次运行可能不同。

## 13. `multiplane benchmark`

在本机测几种并发数下的渲染速度，让渲染不给 `--workers` 时也能选到合适的并发数。参数：`--json`、`--raster gpu|software`、`--max-workers <n>`。不建作业、不写作业索引；带 `--json` 时发 `start`、`progress`、`result`。

- 用三个内置镜头以 1920×1080 渲染（不编码、不做后期）：普通 DOM 页面（`dom`）、Canvas 2D（`canvas`）、WebGL（`three`）。每个镜头测 1、2、4、6、8、12、16、24 个 worker 的吞吐量（帧/秒），超过逻辑 CPU 数、内存上限或 `--max-workers` 的跳过。每个并发数在同一个预热过的浏览器池里测两次取平均。推荐值是吞吐量达到最高值 95% 的最小并发数。整个过程控制在三分钟左右，靠减少每个点的帧数，不跳点。测到某个并发数时空闲内存不够，这一类就停在那里：推荐值从已测的点里选，条目加上 `limitedBy: "memory"`、`stoppedWorkers`（第一个没测的并发数）和 `detail`，后面几类也不再试更大的并发数。每一类至少要测完 1 和 2 个 worker，否则整次失败并保留原来的文件。
- 结果原子写入用户级目录（第 8 节）的 `benchmark.json`：`{ schema, testedAt, machine, shots }`。`machine` 包括 CPU 型号、逻辑 CPU 数、总内存、GPU、操作系统、Chromium 版本、Multiplane 版本和光栅方式；`shots.dom`、`shots.canvas`、`shots.three` 各为 `{ workers, fps, points: [{ workers, fps }] }`。被中断或失败时保留原来的文件。`result.data` 内容相同。
- **渲染怎么用它。** `--workers` 和 `config.json` 都没指定并发数、`benchmark.json` 存在且 `machine` 与当前一致时，`render` 按镜头类型用推荐值（用了 WebGL 或三维层算 `three`，用了 Canvas 算 `canvas`，其余算 `dom`），仍受空闲内存限制；否则按 CPU 核数、空闲内存和输出尺寸估算；`three` 类镜头的估算值最多 4 个，因为每个 WebGL 浏览器共用一块显卡、各自占着很大的渲染缓冲（想要更合适的数，运行 `multiplane benchmark` 实测）。`start.workersSource` 和 `result.data.resources.workersSource` 报告来源：`option`、`config`、`benchmark`、`estimate`。`start.options.workers` 是选定的值，`resources.workers` 是实际用到的数量，片段很短时可能更少。
- `doctor` 增加一项不阻止渲染的 `benchmark` 检查，报告还没测或测试已过期。

## 14. GPU 光栅抖动

用 GPU 光栅（默认）时，同一帧在重载页面后或在另一个浏览器进程里截出来，可能有零星几个像素差一两级，例如文字抗锯齿的边缘。这不是渲染器造成的，肉眼也看不出来。软件光栅没有这种情况。

- `verify` 和静止帧复用的核验（第 12 节）比较时，把逐通道绝对差分成 8×8 像素的小块，算每块的平均值。GPU 光栅下，最大的小块平均差不超过 0.3 级、最大单通道差不超过 32 级，算**抖动**；超过就是真正的不一致。软件光栅下任何差异都是真正的不一致。
- 这个阈值位于真实镜头实测抖动的最大值（0.109）和测试过的最弱真实变化（渐变起点移动 1 像素为 0.875；物体移动 0.25 像素约为 20）之间，并远低于默认 MP4 编码本身的误差（小块平均的中位数 1–2）。
- **`verify`**：抖动不算失败。该项检查仍为 `passed: true`，并带 `jitter: true`；`result.ok` 仍为 `true`；另发一条 `finding`：`severity: "warning"`、`code: "gpu_raster_jitter"`、`details: { check, maxBlockMeanDiff, maxChannelDiff, changedPixels }`（`location` 为 `{ t, frame }`，不写差异图）。真正的不一致照旧以 `nondeterministic_output` 失败。
- **静止帧复用**：核验时遇到抖动不关闭复用；交付实际截到的那一帧，计入 `verifiedFrames`。
