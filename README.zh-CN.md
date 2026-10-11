<picture>
  <source media="(prefers-color-scheme: dark)" srcset="app/design/icons/readme-dark.svg">
  <img src="app/design/icons/readme-light.svg" width="72" height="72" alt="">
</picture>

# Multiplane

[English](README.md) · 简体中文

给 AI agent 用的本地无头 HTML 视频渲染器。**镜头就是普通网页**：页面实现 `render(t)`，画面只由时间 `t` 决定；Multiplane 用无头 Chromium 逐帧截图，做超采样、运动模糊、胶片颗粒等后期，用 FFmpeg 合成视频，并能检查镜头是否确定。

> 当前为预发布版本 `0.0.0`，尚未发布到 npm，接口在 v0.1 前可能调整。完整测试在 Windows、macOS、Linux 三个平台的 CI 上全部通过；Windows 另在真机上验证过。

名字来自迪士尼的多层摄影台（multiplane camera）：一层层平面画稿放在不同深度、逐帧拍摄、带真实景深。对应这里的多层网页画面、三维卡片层和累积景深。

## 特点

- **不用学新框架**。镜头是 HTML、CSS 和一段 JavaScript，agent 最擅长写的东西。
- **渲染前检查**。`lint` 不开浏览器、不到一秒，指出墙钟时间、随机数、CSS 动画、网络资源等会破坏确定性的写法，定位到文件、行、列；渲染命令启动前会自动先跑。
- **可验证**。`verify` 会乱序、重载页面、单进程和多进程分别渲染同一批帧，逐像素比较；不一致时给出出问题的时刻、区域和差异图。
- **运动模糊不跨硬切**。每帧在快门时间内多次采样、按线性光混合；镜头声明的硬切时刻 `cuts` 两侧的画面不会糊在一起。
- **三维层与累积景深**（可选，`multiplane/three`）：图片卡片进三维空间，多次采样累积出真实的焦外虚化，与运动模糊配合。
- **机器可读**。所有命令支持 `--json`，输出带稳定错误码的事件流；每次运行有独立的作业目录，可查询进度、可取消。
- **确定性**。渲染器自身不引入墙钟时间和未设种子的随机数；同一输入在同一环境下逐像素一致，并由测试保证。

## 快速开始

需要 Node.js 24 或更新版本，以及支持 libx264 的 FFmpeg。

```sh
npm install
npx multiplane doctor
npx multiplane render examples/animation.html
```

`npm install` 会下载 Playwright 对应版本的 Chromium（已安装则复用）。离线环境可设 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 跳过，之后再运行 `npx playwright install chromium`。Linux 上 Chromium 还需要系统库：运行一次 `npx playwright install-deps chromium`（缺的时候 `doctor` 会提示）。

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
| `multiplane stills <shot>` | 抽帧并生成联系表 |
| `multiplane verify <shot>` | 确定性检查 |
| `multiplane doctor` | 检查 Node、浏览器、GPU 光栅、FFmpeg、可选的 three.js |
| `multiplane status <job>` | 查看作业状态 |
| `multiplane cancel <job>` | 停止作业 |

镜头路径相对资源根 `--root`（默认当前目录）。每次运行都有自己的作业目录 `out/jobs/<jobId>/`，不给 `--out` 时产物就写在里面（视频、`stills/`、`verify/`），多次运行互不覆盖；最终路径见结果里的 `artifacts`。`--out` 指定输出位置，目标已存在时会拒绝覆盖，加 `--overwrite` 才替换。`render`、`stills`、`verify` 启动前自动跑 `lint`，有 error 就停下，`--no-lint` 跳过。`npx multiplane <command> --help` 列出该命令的全部参数。

`render` 的常用参数：

| 参数 | 含义 |
|---|---|
| `--from` / `--to` | 只渲染一段（秒，不含结束时刻） |
| `--fps` | 覆盖镜头帧率 |
| `--scale` | 输出倍率，如 `2` 把 1920×1080 的镜头输出为 3840×2160 |
| `--render-scale`、`--upscale` | 以较低倍率截图再放大（`lanczos` / `neighbor`），不得高于 `--scale` |
| `--motion-blur`、`--shutter`、`--adaptive-blur` | 每帧时间采样数、快门占比、自适应采样 |
| `--grain` | 胶片颗粒强度 |
| `--no-post` | 关闭全部后期 |
| `--workers` | 并行浏览器进程数，默认按 CPU、内存和分辨率估算 |
| `--raster` | `gpu`（默认）或 `software` |
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

事件类型、字段和全部错误码见 [`docs/protocol.zh-CN.md`](docs/protocol.zh-CN.md)。

## 用户配置与作业索引

渲染器在用户级目录里读配置、登记作业：Windows 为 `%APPDATA%\multiplane`，macOS 为 `~/Library/Application Support/multiplane`，Linux 为 `~/.config/multiplane`；环境变量 `MULTIPLANE_HOME` 可改。

- `config.json`：用户默认值，字段 `ffmpeg`、`raster`、`encoder`、`workers`、`jobsDir`，都可省略。优先级为命令行参数 > 环境变量 > `config.json` > 内置默认值。渲染器只读不写；`doctor` 会报告它的位置和哪些字段生效。
- `jobs.jsonl`：每个作业开始、结束各追加一行，供其他程序发现各项目里的作业；作业状态以作业目录里的 `status.json` 为准。`MULTIPLANE_NO_INDEX=1` 关闭登记。

这个目录读写失败不影响渲染，只会给出一条警告。格式见 [`docs/protocol.zh-CN.md`](docs/protocol.zh-CN.md) 第 8 节。

## JS API

```js
import { lintShot, renderShot, stillsShot, verifyShot } from 'multiplane';

const result = await renderShot('examples/animation.html', {
  workers: 2,
  out: 'out/demo.mp4',
  onEvent: event => { if (event.type === 'progress') console.error(event.done, event.total); },
});
```

返回值与 `result` 事件结构相同（不含 `schema`、`type`、`ts`）；失败时抛出带 `code` 的 `MultiplaneError`。

## 三维层

```sh
npm install three@0.180.0
```

`multiplane/three` 在舞台里加一层透明 WebGL 画布，提供图片卡片、表面标注和累积景深，可以和普通 HTML 元素叠放。不用三维的镜头不会加载它。示例见 [`examples/three-cards.html`](examples/three-cards.html)，用法见 skill 的“三维层”一节。

## 桌面软件

`app/` 下是配套的桌面软件 Multiplane（Electron），给人看、不给 agent 用：

- **作业**：列出各项目里的渲染、抽帧、检查作业，实时显示进度和预览帧，查看成片、联系表和检查不通过时的差异图，可以停止进行中的作业。
- **环境**：检查浏览器、GPU 光栅、FFmpeg 等是否就绪；给 Claude Code（`~/.claude/skills/`）和 Codex（`~/.agents/skills/`）安装、更新 Multiplane 的 skill，自己改过的不会被直接覆盖。
- **设置**：写入上文的用户配置 `config.json`。

它只通过 [`docs/protocol.zh-CN.md`](docs/protocol.zh-CN.md) 的文件和命令行与渲染器打交道，不是渲染的必需品：不装它，agent 照样可以用命令行渲染。

安装包里带一份同版本的渲染器，不需要另装 Node.js。FFmpeg 不随包提供（见上文），Chromium 在环境页首次使用时下载。

| 系统 | 安装包 | 首次打开（安装包没有代码签名） |
|---|---|---|
| Windows | NSIS 安装程序（`.exe`） | SmartScreen 会提示：点“更多信息”，再点“仍要运行”。 |
| macOS | `.dmg`，Apple 芯片和 Intel 各一个 | 首次打开会被拦下：右键点应用选“打开”，或在“系统设置 → 隐私与安全性”里放行。 |
| Linux | AppImage | 先加可执行权限（`chmod +x`）再运行；需要 FUSE，没有 FUSE 时加 `--appimage-extract-and-run` 运行。在不支持非特权用户命名空间的系统上，AppImage 的启动入口会关闭 Chromium 沙箱来启动软件。 |

在当前系统上构建安装包，或在开发时启动：

```sh
npm --prefix app install
npm --prefix app run dist
npm --prefix app start
```

`dist` 把安装包写到 `app/release/`。

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
- 当前只输出不透明视频（H.264 / HEVC，MP4）。
- 渲染器和桌面软件在 Windows、macOS（Apple 芯片）、Linux（x64，Xvfb 下的 X11）三个平台的 CI 上跑同一套测试，全部通过。Windows 10/11 另在真机上验证过；macOS 和 Linux 还没在真机上试过，Wayland 没有测试。Linux 的 CI 没有 GPU，覆盖的是软件光栅；Linux 上的 GPU 光栅尚未测试。

## 同类项目

HTML 加时间函数、无头浏览器、FFmpeg 这条路不是 Multiplane 首创。同类项目有 [HyperFrames](https://github.com/heygen-com/hyperframes)、[Remotion](https://www.remotion.dev/)、[Revideo](https://github.com/redotvideo/revideo)、[Motion Canvas](https://motioncanvas.io/) 等，各有侧重。Multiplane 的侧重是：镜头写成不依赖框架的普通网页，可验证的确定性，不跨硬切的运动模糊，以及三维层的累积景深。

## 许可

[Apache-2.0](LICENSE)。第三方组件和示例字体的许可见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。FFmpeg 不随本包分发，其许可取决于你使用的构建。
