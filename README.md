<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/LBEILC/Multiplane/main/app/design/icons/readme-dark.svg">
  <img src="https://raw.githubusercontent.com/LBEILC/Multiplane/main/app/design/icons/readme-light.svg" width="72" height="72" alt="">
</picture>

# Multiplane

[English](README.en.md) · 简体中文

给 AI agent 用的本地无头 HTML 视频渲染器。**镜头就是普通网页**：页面实现 `render(t)`，画面只由时间 `t` 决定；Multiplane 用无头 Chromium 逐帧截图，做超采样、运动模糊、胶片颗粒等后期，用 FFmpeg 合成视频，并能检查镜头是否确定。

<img src="https://raw.githubusercontent.com/LBEILC/Multiplane/main/docs/images/hero.webp" width="720" alt="Multiplane 渲染的三维卡片：景深虚化与运动模糊">

> 当前版本 `0.3.0`。完整测试在 Windows、macOS、Linux 三个平台的 CI 上全部通过；Windows 另在真机上验证过。1.0 之前接口仍可能调整。

名字来自迪士尼的多层摄影台（multiplane camera）：一层层平面画稿放在不同深度、逐帧拍摄、带真实景深。对应这里的多层网页画面、三维卡片层和累积景深。

## 特点

- **不用学新框架**。镜头是 HTML、CSS 和一段 JavaScript，agent 最擅长写的东西。
- **渲染前检查**。`lint` 不开浏览器、不到一秒，指出墙钟时间、随机数、CSS 动画、网络资源等会破坏确定性的写法，定位到文件、行、列；渲染命令启动前会自动先跑。
- **可验证**。`verify` 会乱序、重载页面、单进程和多进程分别渲染同一批帧，逐像素比较；不一致时给出出问题的时刻、区域和差异图。
- **运动模糊不跨硬切**。每帧在快门时间内多次采样、按线性光混合；镜头声明的硬切时刻 `cuts` 两侧的画面不会糊在一起。
- **三维层与累积景深**（可选，`multiplane/three`）：图片卡片进三维空间，多次采样累积出真实的焦外虚化，与运动模糊配合。
- **机器可读**。所有命令支持 `--json`，输出带稳定错误码的事件流；每次运行有独立的作业目录，可查询进度、可取消。
- **也能出静帧**。`stills` 按指定时刻输出 PNG，和视频走同一套超采样、运动模糊、景深和透明通道。可以用来抽帧检查，也可以直接出封面、海报、配图这类高质量静帧。
- **确定性**。渲染器自身不引入墙钟时间和未设种子的随机数；同一输入在同一环境下逐像素一致，并由测试保证。

## 效果

**运动模糊**：左边不开运动模糊；中间固定 8 个采样，快速转动的轮辐变成一条条分开的残影；右边按移动距离自动加采样，连成顺滑的拖尾。下排是局部放大。

<img src="https://raw.githubusercontent.com/LBEILC/Multiplane/main/docs/images/motion-blur.png" width="800" alt="运动模糊对比：不开模糊、固定 8 采样、自动加采样">

**硬切不糊在一起**：切点后的第一帧。左边没有声明硬切，运动模糊把切点前一个画面的颜色和圆形混了进来；右边在镜头里声明了 `cuts`，切得干净。

<img src="https://raw.githubusercontent.com/LBEILC/Multiplane/main/docs/images/hard-cut.png" width="800" alt="硬切对比：未声明与声明 cuts">

**三维景深**：同一组卡片，焦点分别在前景和背景。焦外虚化是多次采样累积出来的，不是按深度图做的后期模糊，所以前景边缘不会溢出、背景也不会渗进前景的轮廓。下排是前景卡片的局部放大。

<img src="https://raw.githubusercontent.com/LBEILC/Multiplane/main/docs/images/depth-of-field.png" width="800" alt="景深对比：焦点在前景与焦点在背景">

## 快速开始

需要 Node.js 24 或更新版本，以及支持 libx264 的 FFmpeg。

```sh
npm install multiplane
npx playwright install chromium
npx multiplane doctor
npx multiplane render examples/animation.html --root node_modules/multiplane
```

示例在安装好的包里，所以用 `--root` 把资源根指向包目录；出于安全，渲染时不会提供 `node_modules` 下的文件。

新版 npm 默认不运行依赖包的安装脚本，所以第二条命令用来下载 Playwright 使用的 Chromium。如果是克隆了本仓库，在仓库里运行 `npm install`，直接渲染 `examples/animation.html` 即可。

把使用说明 skill 交给你的 agent：运行 `npx multiplane skill install --host all`（Claude Code 装到 `~/.claude/skills/multiplane`，Codex 装到 `~/.agents/skills/multiplane`），或者让桌面软件来安装。装好后新开一个 agent 会话。

在克隆的仓库里，`npm install` 会自己下载这个 Chromium（已安装则复用）。离线环境可设 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 跳过，之后再运行 `npx playwright install chromium`。Linux 上 Chromium 还需要系统库：运行一次 `npx playwright install-deps chromium`（缺的时候 `doctor` 会提示）。

### FFmpeg

Multiplane 不随包分发 FFmpeg。需要自己安装一个支持 libx264 的：

| 系统 | 一种获取方式 |
|---|---|
| Windows | 从 [FFmpeg 官方下载页](https://ffmpeg.org/download.html) 获取构建 |
| macOS | `brew install ffmpeg` |
| Linux | 发行版的软件包，例如 `sudo apt-get install ffmpeg` |

FFmpeg 的许可取决于你安装的构建。然后用以下任一方式告诉 Multiplane（按优先级）：

1. 命令行参数 `--ffmpeg <path>`；
2. 环境变量 `MULTIPLANE_FFMPEG`；
3. 用户配置文件里的 `ffmpeg`（见下文“用户配置”）；
4. 放进系统 PATH。

想一次设好、所有项目都生效，运行 `npx multiplane config set ffmpeg <path>`，它会顺便检查这个文件能不能用。

默认用软件编码 `x264`；有 NVIDIA 显卡时可用 `--encoder nvenc-h264` 或 `--encoder nvenc-hevc`。`doctor` 会检查 FFmpeg 能否运行、是否支持所需编码器。

## 写一个镜头

```html
<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Example</title>
<link rel="stylesheet" href="/multiplane/runtime/shot.css">
<style>
  #stage { width: 1920px; height: 1080px; background: #111; }
  #box { position: absolute; left: 0; top: 490px; width: 100px; height: 100px; background: #eee; }
</style>
<div id="stage"><div id="box"></div></div>
<script src="/multiplane/runtime/shot.js"></script>
<script>
const box = document.querySelector('#box');
Shot.define({
  duration: 4,
  fps: 30,
  render(t) {
    box.style.transform = `translateX(${Math.min(t / 3, 1) * 1820}px)`;
  },
});
</script></html>
```

约定只有三条：

- 画面都画在 `#stage` 里，用固定的 CSS 宽高声明画幅；
- `render(t)` 是同步函数，同一个 `t` 永远画出同样的画面；
- 字体、图片等素材用本地文件，在 `setup()` / `ready` 里加载完。

完整约定、哪些写法会破坏确定性、三维层用法，见 agent 使用说明 [`skills/multiplane/SKILL.md`](skills/multiplane/SKILL.md)。它同时是给 agent 加载的 skill。

## 命令

| 命令 | 用途 |
|---|---|
| `multiplane lint <shot>` | 静态代码检查，不开浏览器 |
| `multiplane render <shot>` | 渲染成 MP4 |
| `multiplane stills <shot>` | 按时刻输出静帧（PNG）并生成联系表；可用于检查，也可直接出高质量静帧 |
| `multiplane verify <shot>` | 确定性检查 |
| `multiplane inspect <shot>` | 不渲染，输出镜头的时长、帧数、舞台尺寸、硬切和 `meta` |
| `multiplane serve` | 在 127.0.0.1 上提供镜头，写镜头时用浏览器打开 |
| `multiplane benchmark` | 在本机实测不同进程数的渲染速度，之后渲染自动用最快的进程数 |
| `multiplane doctor` | 检查 Node、浏览器、GPU 光栅、FFmpeg、可选的 three.js |
| `multiplane status <job>` | 查看作业状态 |
| `multiplane cancel <job>` | 停止作业 |
| `multiplane wait <job>` | 等一个作业结束并输出它的事件，例如 agent 会话重启之后 |
| `multiplane config get\|set\|unset` | 读取或修改用户配置 |
| `multiplane skill status\|install\|remove` | 给 Claude Code 和 Codex 安装、更新、移除 agent skill |

镜头路径相对资源根 `--root`（默认当前目录）。每次运行都有自己的作业目录 `out/jobs/<jobId>/`，不给 `--out` 时产物就写在里面（视频、`stills/`、`verify/`），多次运行互不覆盖；最终路径见结果里的 `artifacts`。`--out` 指定输出位置，目标已存在时会拒绝覆盖，加 `--overwrite` 才替换。`render`、`stills`、`verify` 启动前自动跑 `lint`，有 error 就停下，`--no-lint` 跳过。`npx multiplane <command> --help` 列出该命令的全部参数。

`render` 的常用参数：

| 参数 | 含义 |
|---|---|
| `--from` / `--to` | 只渲染一段（秒，不含结束时刻） |
| `--fps` | 覆盖镜头帧率 |
| `--scale` | 输出倍率，如 `2` 把 1920×1080 的镜头输出为 3840×2160 |
| `--draft` | 快速预览的预设：以不超过 0.5 的倍率截图再放大，不做运动模糊、不加颗粒。画质有意降低；显式给出的参数会覆盖它。`stills` 也支持 |
| `--render-scale`、`--upscale` | 以较低倍率截图再放大（`lanczos` / `neighbor`），不得高于 `--scale` |
| `--motion-blur`、`--shutter`、`--adaptive-blur` | 每帧时间采样数、快门占比、自适应采样 |
| `--quality` | 画质预设：`draft`（同 `--draft`）、`standard`（默认）、`high`（一般用不着，见下文）。镜头开了运动模糊时，按画面里局部移动的距离自动加采样，`standard` 最多 64、`high` 最多 256，见下文 |
| `--max-motion-blur` | 自定义自动加采样的上限，覆盖预设；设成和 `--motion-blur` 一样就是固定采样数 |
| `--grain` | 胶片颗粒强度 |
| `--no-post` | 关闭全部后期 |
| `--workers` | 并行浏览器进程数；默认用 `multiplane benchmark` 在本机实测的值，没测过时按 CPU、内存和分辨率估算，见下文“并发数” |
| `--raster` | `gpu`（默认）或 `software` |
| `--format`、`--alpha` | 输出格式 `mp4`（默认）、`webm`（VP9）或 `mov`（ProRes 4444）；`--alpha` 保留透明（只限 WebM 和 MOV，`stills`、`verify` 也支持）。见下文“透明视频” |
| `--encoder`、`--max-bitrate` | 编码器、码率上限（Mbps） |
| `--audio`、`--audio-offset` | 混入一条音轨及其偏移（秒） |

镜头里 `post` 声明的后期参数是默认值，命令行参数覆盖它。

## 机器可读输出

加 `--json` 后，stdout 每行一个 JSON 事件（NDJSON），最后一行一定是最终结果：

```json
{"schema":"multiplane/1","type":"result","command":"render","ts":"2026-10-11T09:30:09.120Z","ok":true,"code":null,"message":null,"artifacts":[{"path":"/abs/out/jobs/20261011-093000-animation-3f2a/animation.mp4","kind":"video","bytes":81234}],"elapsedMs":3120,"jobId":"20261011-093000-animation-3f2a","data":{"frames":24}}
```

- 失败时 `ok` 为 `false`，`code` 是稳定的错误码，`hint` 给修复建议；人类可读的信息走 stderr。
- 退出码：`0` 成功，`1` 镜头或检查不通过，`2` 参数错误，`3` 环境问题，`4` 渲染器内部错误，`130` 被取消。
- 每次运行在 `out/jobs/<jobId>/` 下写 `events.jsonl`（同一事件流）和 `status.json`（最新快照），其他程序可以据此展示进度；渲染时还会维护一张预览缩略图 `preview.png`。

事件类型、字段和全部错误码见 [`docs/protocol.zh-CN.md`](https://github.com/LBEILC/Multiplane/blob/main/docs/protocol.zh-CN.md)。

## 用户配置与作业索引

渲染器在用户级目录里读配置、登记作业：Windows 为 `%USERPROFILE%\.multiplane`（0.2.0 及以前是 `%APPDATA%\multiplane`，首次使用时会把那里的文件复制过来），macOS 为 `~/Library/Application Support/multiplane`，Linux 为 `~/.config/multiplane`；环境变量 `MULTIPLANE_HOME` 可改。

- `config.json`：用户默认值，字段 `ffmpeg`、`raster`、`encoder`、`workers`、`jobsDir`，都可省略。优先级为命令行参数 > 环境变量 > `config.json` > 内置默认值。渲染时从不写它，由 `multiplane config` 命令或桌面软件写；`doctor` 和 `config get` 会报告它的位置和哪些字段生效。
- `jobs.jsonl`：每个作业开始、结束各追加一行，供其他程序发现各项目里的作业；作业状态以作业目录里的 `status.json` 为准。`MULTIPLANE_NO_INDEX=1` 关闭登记。

这个目录读写失败不影响渲染，只会给出一条警告。格式见 [`docs/protocol.zh-CN.md`](https://github.com/LBEILC/Multiplane/blob/main/docs/protocol.zh-CN.md) 第 8 节。

## JS API

```js
import { inspectShot, lintShot, renderShot, stillsShot, verifyShot } from 'multiplane';

const result = await renderShot('examples/animation.html', {
  workers: 2,
  out: 'out/demo.mp4',
  onEvent: event => { if (event.type === 'progress') console.error(event.done, event.total); },
});
```

返回值与 `result` 事件结构相同（不含 `schema`、`type`、`ts`）；失败时抛出带 `code` 的 `MultiplaneError`。

## 透明视频

渲染背景透明的镜头，用来叠在别的画面上：

```sh
npx multiplane render examples/alpha.html --format webm --alpha
npx multiplane render examples/alpha.html --format mov --alpha
npx multiplane stills examples/alpha.html --alpha --at 0,1
```

页面背景会变成透明；镜头自己画的东西，包括 `#stage` 的背景色，照样不透明。想要整层透明，就别给 `#stage` 设背景。镜头可以用 `post: { alpha: true }` 把透明设为默认。

- `webm` 用带 alpha 的 VP9。不少播放器会忽略 VP9 的 alpha；用 FFmpeg 检查时要加 `-c:v libvpx-vp9` 解码，默认的 VP9 解码器会丢掉 alpha。
- `mov` 用 ProRes 4444，大多数剪辑软件能读出 alpha。
- 运动模糊和缩放都按预乘颜色计算，移动的边缘不会出现暗边或色边。发布前渲染器会解码首帧和中间帧，确认 alpha 编码后仍在（每个像素误差不超过 2/255）。
- FFmpeg 构建需要带 `libvpx-vp9`（WebM）和 `prores_ks`（MOV），`doctor` 会报告这两项。

## 画质与运动模糊

运动模糊是每帧在快门时间内截多张图再平均。采样太少时，动得快的东西会变成一条条分开的残影；全片都用很多采样又太慢。Multiplane 按画面里局部移动的距离给每一帧定采样数：

- 镜头决定**要不要**运动模糊：`post.motionBlur` 大于 1 就开启，它的值是起步采样数；快门 `shutter` 和颗粒也由镜头定。
- `--quality` 决定**画质**：先按起步数截，把画面分成小块逐块比较相邻两个采样，哪一块移动超过约 2 像素（`standard`）或 1 像素（`high`）就把采样数加倍，最多到 64 或 256。静止的帧只用 1 个采样，慢的帧保持起步数，只有动得快的帧才多花时间。
- 迭代和最终成片都用默认的 `standard` 就够了。`high` 在真实镜头上要多花几倍时间，提升要放大才看得出，只在静帧要放大看细节、或画面里有极快极细的运动时才用；只看构图用 `--draft`。
- 想完全自己控制：`--max-motion-blur` 改上限，设成和 `--motion-blur` 一样就是固定采样数。镜头定义了 `blurAt(t)` 时按它的返回值来，不会自动加。
- 结果里的 `blurSamples` 列出每帧实际用了多少采样。

## 并发数

`render` 和 `verify` 会同时开几个浏览器进程分担帧（`--workers`）。进程多了不一定更快：开 GPU 光栅时所有进程共用一块显卡，开得太多反而变慢。

- **在本机实测一次**：`multiplane benchmark`（约 2–3 分钟）用普通网页、Canvas、三维三类镜头，分别测 1、2、4、6、8、12、16、24 个进程的速度，每类记下最快速度 95% 以内的最小进程数。之后渲染时没给 `--workers`、配置里也没设，就按镜头类型自动用这个值。
- 测的时候内存不够，就只测到能开的进程数为止，用已经测到的点给出推荐值，`doctor` 会注明“受内存限制”。
- 没测过时用估算值：按 CPU 核数、空闲内存和输出分辨率算，最多 12 个。
- 换了电脑、显卡、浏览器或 Multiplane 版本后，`doctor` 会提示测试已过期，重跑一次即可。结果存在用户级目录的 `benchmark.json`。
- 结果里的 `resources.workersSource` 说明这次的进程数从哪来：`option`（命令行）、`config`（用户配置）、`benchmark`（本机实测）或 `estimate`（估算）。
- 进程数只影响速度，不影响画面：同一个镜头用几个进程渲染，像素都一样。

## 静帧

`stills` 不只是抽帧检查用的。它输出的每张 PNG 和视频里同一帧走的是同一套后期，所以也可以拿来出最终交付的静帧：封面、海报、文章配图、社交平台的图片。

```sh
# 在 0、1.5、3 秒各出一张
npx multiplane stills shot.html --at 0,1.5,3 --out out/stills

# 封面：2 倍超采样（1920×1080 的镜头输出 3840×2160），带运动模糊
npx multiplane stills shot.html --at 2.4 --scale 2 --motion-blur 16 --out out/cover

# 透明背景的 PNG，用来叠在别的画面上
npx multiplane stills shot.html --at 1 --alpha --out out/overlay

# 每 0.5 秒出一张，用来快速浏览整个镜头
npx multiplane stills shot.html --every 0.5
```

- 文件名是 `t-<秒>.png`（例如 `t-2.40.png`），同一目录里还有一张所有静帧拼在一起的联系表 `_sheet.png`。
- `--quality`、`--scale`、`--motion-blur`、`--max-motion-blur`、`--shutter`、`--grain`、`--alpha` 都和 `render` 一样生效；三维层的景深也一样。镜头在 `post` 里声明的默认值同样适用。
- 想要某一刻画面里有动态模糊，时刻要选在运动当中；静止的时刻采样数会自动降到 1，画面和不开模糊一样清晰。
- 静帧要放大看细节时可以加 `--quality high`；`--draft` 只适合检查构图，不要用来出交付的图。

## 三维层

```sh
npm install three@0.180.0
```

`multiplane/three` 在舞台里加一层透明 WebGL 画布，提供图片卡片、表面标注和累积景深，可以和普通 HTML 元素叠放。不用三维的镜头不会加载它。示例见 [`examples/three-cards.html`](examples/three-cards.html)，用法见 skill 的“三维层”一节。

## 桌面软件

`app/` 下是配套的桌面软件 Multiplane（Electron），给人看、不给 agent 用：

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/LBEILC/Multiplane/main/docs/images/app-jobs-zh-dark.png">
  <img src="https://raw.githubusercontent.com/LBEILC/Multiplane/main/docs/images/app-jobs-zh-light.png" width="800" alt="Multiplane 桌面软件的作业页：进行中的作业、排队中的作业和实时预览帧">
</picture>


- **作业**：列出各项目里的渲染、抽帧、检查作业，实时显示进度和预览帧，查看成片、联系表和检查不通过时的差异图，可以停止进行中的作业。
- **环境**：检查浏览器、GPU 光栅、FFmpeg 等是否就绪；给 Claude Code（`~/.claude/skills/`）和 Codex（`~/.agents/skills/`）安装、更新 Multiplane 的 skill，自己改过的不会被直接覆盖。
- **设置**：写入上文的用户配置 `config.json`。
- **托管渲染**（默认关闭）：在设置里开启后，agent 发起的渲染改由软件执行，不再挂在 agent 的会话上，会话结束也会照常做完。一次只执行一个托管渲染，其余排队。agent 的命令和输出不变；会话重启后用 `multiplane wait <job>` 接上之前的作业。开启托管后，关闭窗口时软件留在系统托盘。见协议第 11 节。
- **更新**：启动时和之后每天检查一次 GitHub 上的新版本（可以关闭）。Windows 上在软件里下载并安装；macOS 和 Linux 上打开下载页。
- 界面有英文和简体中文，默认跟随系统语言，也可以在设置里切换。

它只通过 [`docs/protocol.zh-CN.md`](https://github.com/LBEILC/Multiplane/blob/main/docs/protocol.zh-CN.md) 的文件和命令行与渲染器打交道，不是渲染的必需品：不装它，agent 照样可以用命令行渲染。

从 [Releases 页面](https://github.com/LBEILC/Multiplane/releases) 下载安装包。安装包里带一份同版本的渲染器，不需要另装 Node.js。这份渲染器也可以当命令用：Windows 为安装目录下的 `multiplane.cmd`，macOS 为 `Multiplane.app/Contents/Resources/bin/multiplane`，Linux 为 `Multiplane-<版本>-x86_64.AppImage --multiplane-cli`。PATH 里找不到 `multiplane` 时，环境页会显示完整路径。FFmpeg 不随包提供（见上文），Chromium 在环境页首次使用时下载。

| 系统 | 安装包 | 首次打开（安装包没有代码签名） |
|---|---|---|
| Windows | NSIS 安装程序（`.exe`） | SmartScreen 会提示：点“更多信息”，再点“仍要运行”。 |
| macOS | `.dmg`，Apple 芯片和 Intel 各一个 | 首次打开会被拦下：右键点应用选“打开”，或在“系统设置 → 隐私与安全性”里放行。 |
| Linux | AppImage | 先加可执行权限（`chmod +x`）再运行；需要 FUSE。没有 FUSE 时，先运行一次 `--appimage-extract` 解压，以后运行解压出来的 `squashfs-root/AppRun`（不要用 `--appimage-extract-and-run` 同时开两个：后退出的那个会删掉共用的临时目录，让另一个出错）。在不支持非特权用户命名空间的系统上，AppImage 的启动入口会关闭 Chromium 沙箱来启动软件。 |

在当前系统上构建安装包，或在开发时启动：

```sh
npm --prefix app install
npm --prefix app run dist
npm --prefix app start
```

`dist` 把安装包写到 `app/release/`。`npm --prefix app start` 用的是单独的开发目录（渲染器配置、作业索引、软件数据都不碰真实的），加 `-- --use-user-home` 才使用真实目录。

## 示例

| 文件 | 内容 |
|---|---|
| [`examples/animation.html`](examples/animation.html) | 二维几何动画，中间一次硬切，演示运动模糊不跨切 |
| [`examples/typography.html`](examples/typography.html) | 本地字体排版（Roboto，OFL） |
| [`examples/three-cards.html`](examples/three-cards.html) | 三维卡片与累积景深 |

## 确定性与限制

- 像素一致的保证限于**同一台机器、同一浏览器版本、同一字体和素材**。不同 GPU、驱动或浏览器版本之间可能有细小差异。
- `lint` 是静态检查，抓不到间接调用（如 `const now = Date.now; now()`）和状态累积，最终以 `verify` 为准。
- `verify` 是抽样检查：默认取时长 0%、25%、50%、75% 附近的帧和开头一秒的连续帧，通过不代表穷尽了所有时刻。
- 自适应运动模糊按画面变化估算采样数，是近似。
- 用 GPU 光栅（默认）时，同一帧在重载或换进程后可能有零星像素差一两级（显卡造成，肉眼看不出）。`verify` 会把它报告为 `gpu_raster_jitter` 警告，不算失败；软件光栅（`--raster software`）下仍要求逐像素一致。
- 画面没变的帧直接复用、不重新截图，并定期逐像素核验；用 `--no-static-reuse` 关闭后成品完全相同。含视频、iframe 或正在运行的 CSS 动画的镜头总是逐帧截图。见协议第 12 节。
- 渲染器和桌面软件在 Windows、macOS（Apple 芯片）、Linux（x64，Xvfb 下的 X11）三个平台的 CI 上跑同一套测试，全部通过。Windows 10/11 另在真机上验证过；macOS 和 Linux 还没在真机上试过，Wayland 没有测试。Linux 的 CI 没有 GPU，覆盖的是软件光栅；Linux 上的 GPU 光栅尚未测试。

## 同类项目

HTML 加时间函数、无头浏览器、FFmpeg 这条路不是 Multiplane 首创。同类项目有 [HyperFrames](https://github.com/heygen-com/hyperframes)、[Remotion](https://www.remotion.dev/)、[Revideo](https://github.com/redotvideo/revideo)、[Motion Canvas](https://motioncanvas.io/) 等，各有侧重。Multiplane 的侧重是：镜头写成不依赖框架的普通网页，可验证的确定性，不跨硬切的运动模糊，以及三维层的累积景深。

## 许可

[Apache-2.0](LICENSE)。第三方组件和示例字体的许可见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。FFmpeg 不随本包分发，其许可取决于你使用的构建。
