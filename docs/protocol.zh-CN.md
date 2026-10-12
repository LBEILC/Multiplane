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
| `command` | `render` / `stills` / `verify` / `lint` / `doctor` / `status` / `cancel`。 |
| `ts` | ISO 8601 UTC 时间戳。 |

（`lint` 不建作业目录，事件里没有 `jobId`。）

| `type` | 何时 | 额外字段 |
|---|---|---|
| `start` | 参数解析成功后第一行（给了 `--draft`、或镜头可能声明 `alpha` 默认值时，在预检之后发出：预检会加载镜头但不调用 `render(t)`，这样 `options` 里才是最终值；它仍是第一条事件） | `version`（包版本）、`shot`（绝对路径，无镜头的命令为 `null`）、`jobId`（有作业时）、`options`（加载镜头前就能确定的生效参数，含渲染器默认值；镜头自己声明的 `fps`、`post` 等见 `shot` 事件，最终生效值见 `result.data`） |
| `environment` | 浏览器启动后一次 | `node`、`platform`、`chromium`、`gpu`（`{renderer, hardware}`）、`ffmpeg`（`{path, version}`，不需要时为 `null`） |
| `shot` | 镜头加载完一次 | `width`、`height`、`duration`、`fps`、`cuts`、`post`（镜头声明的默认后期参数） |
| `progress` | 进度变化时，最多每 250 ms 一行 | `phase`（`launch` / `load` / `capture` / `encode` / `compare` / `finalize`）、`done`、`total`、`unit`（`"frame"` 等）、`fps`（实测速度，可为 `null`）、`etaMs`（可为 `null`） |
| `warning` | 不致命的问题 | `code`、`message`，可带 `details` |
| `finding` | 检查类命令发现的问题（`verify` 不一致、`lint` 发现的问题） | 见第 4 节 |
| `artifact` | 每写完一个产物文件 | `path`（绝对路径）、`kind`（`video` / `still` / `contact-sheet` / `report` / `diff-image`）、`bytes` |
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

- `render`：`{ output, frames, fps, from, to, width, height, encoder, post: {motionBlur, shutter, adaptiveBlur, grain}, renderScale, scale, draft, format, alpha, outputCheck, resources }`。`format` 为 `mp4`、`webm` 或 `mov`；走透明路径时 `alpha` 为 `true`。给了 `--draft` 时 `draft` 为 `true`（快速预览的预设：渲染倍率不超过 0.5、不做运动模糊、不加颗粒；显式给出的参数优先于预设，预设优先于用户配置和镜头默认值；输出尺寸、帧率、编码器、并行数不变；舞台尺寸找不到不超过 0.5 的合法倍率时以 `invalid_scale` 失败）。`outputCheck` 是成品发布前从编码后的文件里读回来的信息：`{ verified, frames, durationSeconds, width, height, fps, codec, pixelFormat, audioDurationSeconds }`（`audioDurationSeconds` 只在成品有音轨时出现）；无法探测文件时 `verified` 为 `false`（见 `output_unverified`）。`pixelFormat` 是解码文件时报告的格式，可能与编码输入不同。核对要求：帧数完全相等，时长差不超过一帧，宽高完全相等，帧率与要求值的相对差不超过 1e-4（WebM 等容器的时间戳精度有限，59.94 读回来可能是 59.940063）。帧率以精确分数传给编码器，例如 29.97 传为 30000/1001。透明输出另外解码首帧和中间帧（VP9 用 `libvpx-vp9` 解码，默认的 VP9 解码器会丢掉 alpha），与源帧的 alpha 比较；任一像素差超过 2/255 或 alpha 丢失，以 `output_invalid` 结束（透明输出不会未经核对就发布）。`resources` 为整个进程树（渲染器、浏览器进程、worker、编码器）的 `{ peakMemoryBytes, memorySamples, workers, cpuCount }`；测不到的值为 `null`。`peakMemoryBytes` 是周期采样中的最大值，不是操作系统的精确峰值；`memorySamples` 只计成功的采样；`workers` 是实际用到的最大数量。`stills` 和 `verify` 的结果同样带 `resources`。
- `stills`：`{ stills: [{t, frame, path}], contactSheet, draft, format, alpha }`。`draft` 含义同 `render`；`format` 恒为 `png`；带 `alpha` 时抽帧保留透明，联系表合成在棋盘格底上。
- `verify`：`{ passed, times, workers, checks: [{name, passed}] , findings: n, format, alpha }`（`format` 为 `png`；带 `alpha` 时四个通道都比较）。不一致时 `ok: false`、`code: "nondeterministic_output"`，`finding` 事件里有细节。
- `lint`：`{ files: [...扫描过的文件，相对资源根], errors, warnings, suppressed }`。有 error 时 `ok: false`、`code: "lint_failed"`；只有 warning 时 `ok: true`。`render` / `stills` / `verify` 默认先跑 lint，它的 `finding` 进入同一事件流；`--no-lint` 跳过。
- `doctor`：`{ checks: [{name, ok, detail}] }`，检查 Node 版本、浏览器、GPU 光栅、FFmpeg 和 libx264、可选 three.js。
- `status` / `cancel`：作业状态快照（第 6 节）。

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
| 2 | 用法错误 | `invalid_option`（未知、重复、缺值、取值非法；`details.option`）、`invalid_scale`（倍率导致奇数或非整数尺寸，`hint` 给可用倍率）、`output_exists`（显式输出路径已有文件且没给 `--overwrite`）、`job_not_found`（`status` / `cancel` 找不到作业或快照损坏） |
| 3 | 环境问题 | `ffmpeg_not_found`、`ffmpeg_unusable`（能找到但不能运行或缺编码器）、`browser_not_installed`、`browser_launch_failed`、`three_not_installed`、`unsupported_node`、`job_dir_unwritable`（作业目录无法创建或写入，例如在只读目录里运行；`details.path`；`hint` 指向 `--job-dir` 和 `MULTIPLANE_JOBS_DIR`） |
| 4 | 渲染器内部 | `output_invalid`（编码后的文件与渲染内容不符：帧数、时长、尺寸或帧率；`details.expected` 与 `details.actual`；文件不会发布）、`worker_crashed`、`browser_crashed`（浏览器进程或页面意外关闭，重启后仍然失败；已知时带 `details.t`）、`encode_failed`、`internal_error` |
| 130 | 被取消 | `cancelled` |

警告码（只出现在 `warning` 事件，不影响退出码）：`browser_restarted`（浏览器进程或页面意外关闭，已重新启动并重渲受影响的帧；`render(t)` 只由 `t` 决定，所以不会改变像素；`details.attempt`）、`output_unverified`（无法探测编码后的文件，未经核对就发布了；`details.reason`）、`gpu_software_fallback`（要求 GPU 光栅但实际落到软件渲染器）、`home_unavailable`（用户级目录读写失败，见第 8 节）、`config_invalid`（用户配置某字段非法，已忽略；整份文件损坏或顶层不是对象时 `details.field` 为 `"$"`）、`preview_failed`（预览帧写入失败，每个作业只报一次，此后不再更新预览，渲染照常）。

lint 规则码（`finding.code`）：`wall_clock`、`unseeded_random`、`css_animation`、`web_animations`、`media_playback`、`remote_resource`、`resource_missing`、`stage_missing`、`shot_missing`、`runtime_missing`、`async_render` 为 error；`timer_driven`、`animated_image`、`stage_size_unfixed`、`font_not_awaited`、`lint_directive_invalid`、`lint_incomplete`（某段源码无法解析、被跳过，扫描覆盖不完整）为 warning。lint 的 `location` 为 `{file, line, column}`（相对资源根，从 1 开始），`details.snippet` 为该行源码。问题行的上一行写注释 `multiplane-disable-next-line <规则码>` 可豁免。

## 6. 渲染作业

`render`、`stills`、`verify` 每次运行都是一个作业。

- `jobId`：`<UTC 时间 yyyyMMdd-HHmmss>-<镜头文件名>-<4 位十六进制随机>`，保证并发运行不撞名。
- 作业目录：默认 `<cwd>/out/jobs/<jobId>/`；`--job-dir <dir>` 或环境变量 `MULTIPLANE_JOBS_DIR` 改父目录。
- 产物位置：不给 `--out` 时产物写在作业目录里（视频 `<jobDir>/<镜头名>.mp4`，抽帧 `<jobDir>/stills/`，检查报告和差异图 `<jobDir>/verify/`），每次运行互不覆盖。给了 `--out` 而目标已存在时以 `output_exists` 失败，加 `--overwrite` 才覆盖：先完整写到临时位置再替换（目录产物整个替换），失败时原产物不动。
- 目录内容：
  - `events.jsonl`：与 `--json` 的 stdout **完全相同**的事件流（不管开没开 `--json` 都写）。
  - `status.json`：最新快照，原子写入（写临时文件再改名）：`{schema, jobId, command, shot, pid, state, phase, done, total, fps, etaMs, previewFrame, memoryBytes, startedAt, updatedAt, result}`；`state` 为 `running` / `succeeded` / `failed` / `cancelled`；`result` 结束时等于 `result` 事件的内容，运行中为 `null`。
  - 停止请求：在目录里创建 `stop` 文件。渲染器检测到后清理并以 `cancelled` 结束。
- `multiplane status <jobId|jobDir> [--json]`：读 `status.json`；进程已不在而 `state` 仍是 `running` 时报告为 `failed` / `internal_error`（不改文件）。`status` 本身的 `ok` 只表示读到了快照，原作业的成败看 `data.state` 和 `data.result`。
- `multiplane cancel <jobId|jobDir> [--json]`：创建 `stop` 文件，等待作业结束（`--wait` 秒，默认 30），输出最终状态；作业已经结束时直接返回原终态；到时仍未结束返回 `cancel_timeout`。
- `--help`（全局或 `multiplane <command> --help`）和 `--version` 只输出人类可读文字，不产生事件。
- 作业目录不自动清理；桌面软件和其他读取方依赖这套文件。

## 7. JS API

- `renderShot` / `stillsShot` / `verifyShot` / `lintShot` / `doctor` 返回与 `result` 事件相同结构的对象（不含 `schema`、`type`、`ts`）。
- 失败时抛出 `MultiplaneError`（继承 `Error`），带 `code`、`exitCode`、`hint`、`details`、`result`。
- 可选 `onEvent(event)` 回调，收到与 NDJSON 相同的事件对象；不再用 `print` 回调。

## 8. 用户级目录（给配套软件和其他读取方）

渲染器在用户级目录里登记作业、读取用户默认配置。目录位置由平台层决定，环境变量 `MULTIPLANE_HOME` 可覆盖：

| 平台 | 默认位置 |
|---|---|
| Windows | `%APPDATA%\multiplane` |
| macOS | `~/Library/Application Support/multiplane` |
| Linux | `$XDG_CONFIG_HOME/multiplane`，未设时 `~/.config/multiplane` |

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
{"schema":"multiplane/1","ffmpeg":"D:/tools/ffmpeg/bin/ffmpeg.exe","raster":"gpu","encoder":"x264","workers":null,"jobsDir":null}
```

- 所有字段可选，`null` 或缺省表示用内置默认值。未知字段忽略，取值非法时发 `warning`（`config_invalid`，`details.field`）并忽略该字段。
- 优先级：命令行参数 > 环境变量（`MULTIPLANE_FFMPEG`、`MULTIPLANE_JOBS_DIR`）> `config.json` > 内置默认值。
- `start` 事件的 `options` 反映合并后的值；`doctor` 的结果里报告配置文件路径、是否存在、哪些字段生效。
- 渲染器只读这个文件，从不写；由用户或配套软件写（写时先写临时文件再改名）。

### 8.3 预览帧 `preview.png`

`render` 运行时，在作业目录里维护一张最新完成帧的缩略图 `preview.png`：长边不超过 480 像素，最多每 2 秒更新一次，原子写入。`status.json` 增加 `previewFrame`（缩略图对应的帧号，没有时为 `null`）。预览只是旁路输出，不得改变成片的任何像素，也不得明显拖慢渲染（实测说明开销）。

### 8.4 随包的 skill

npm 包带上 `skills/multiplane/`。安装方（配套软件 `app/` 或用户自己）把这个目录复制到各 agent 的 skill 目录。skill 版本跟随包版本。
