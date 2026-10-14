<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/LBEILC/Multiplane/main/app/design/icons/readme-dark.svg">
  <img src="https://raw.githubusercontent.com/LBEILC/Multiplane/main/app/design/icons/readme-light.svg" width="72" height="72" alt="">
</picture>

# Multiplane

English · [简体中文](README.zh-CN.md)

A local, headless HTML video renderer for AI agents. **A shot is an ordinary web page**: the page implements `render(t)`, and the image depends only on time `t`. Multiplane captures frames with headless Chromium, applies post-processing such as supersampling, motion blur, and film grain, encodes video with FFmpeg, and checks whether a shot is deterministic.

> Version `0.2.1`. The full test suite passes in CI on Windows, macOS and Linux; Windows has also been verified on a real machine. Interfaces may still change before 1.0.

The name comes from Disney's multiplane camera: flat artwork placed at different depths, photographed frame by frame with real depth of field. Here, this corresponds to layered web content, a 3D card layer, and accumulated depth of field.

## Features

- **No new framework to learn**. Shots use HTML, CSS, and JavaScript, which agents are well suited to write.
- **Lint before rendering**. `lint` runs without a browser in under a second. It flags wall-clock time, random numbers, CSS animations, remote resources, and other patterns that break determinism, with file, line, and column locations. Rendering commands run it automatically before starting.
- **Verifiable**. `verify` renders the same frames out of order, after page reloads, and with single and multiple processes, then compares them pixel by pixel. Mismatches include the affected times, regions, and diff images.
- **Motion blur respects hard cuts**. Each frame uses multiple time samples within the shutter interval, blended in linear light. Images on opposite sides of the shot's declared hard cut times, `cuts`, are never blurred together.
- **3D layer and accumulated depth of field** (optional, `multiplane/three`): place image cards in 3D space and accumulate multiple samples for real out-of-focus blur, combined with motion blur.
- **Machine-readable**. All commands support `--json` and emit an event stream with stable error codes. Each run has its own job directory, supports progress queries, and can be cancelled.
- **Deterministic**. The renderer itself introduces no wall-clock time or unseeded random numbers. The same input in the same environment produces identical pixels, backed by tests.

## Quick start

Requires Node.js 24 or later and FFmpeg with libx264 support.

```sh
npm install multiplane
npx playwright install chromium
npx multiplane doctor
npx multiplane render node_modules/multiplane/examples/animation.html
```

Recent npm versions do not run install scripts of dependencies, so the second command downloads the Chromium build that Playwright uses. To work from a clone of this repository instead, run `npm install` in it and render `examples/animation.html` directly.

Give your agent the usage skill with `npx multiplane skill install --host all` (Claude Code: `~/.claude/skills/multiplane`, Codex: `~/.agents/skills/multiplane`), or let the desktop app install it. Start a new agent session afterwards.

In a clone of this repository, `npm install` downloads that Chromium build itself, reusing it if already installed; in an offline environment, set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` to skip the download, then run `npx playwright install chromium` later. On Linux, Chromium also needs system libraries: run `npx playwright install-deps chromium` once (`doctor` tells you when they are missing).

### FFmpeg

Multiplane does not bundle FFmpeg. Install one that supports libx264:

| System | One way to get it |
|---|---|
| Windows | a build from the [official FFmpeg download page](https://ffmpeg.org/download.html) |
| macOS | `brew install ffmpeg` |
| Linux | your distribution's package, for example `sudo apt-get install ffmpeg` |

The licence of FFmpeg depends on the build you install. Then tell Multiplane where to find it using one of these methods, in priority order:

1. The command-line option `--ffmpeg <path>`;
2. The environment variable `MULTIPLANE_FFMPEG`;
3. `ffmpeg` in the user config file (see "User config and job index" below);
4. The system PATH.

To save the path once for every project, run `npx multiplane config set ffmpeg <path>`; it also checks the file and reports whether it is usable.

The default is software encoding with `x264`. With an NVIDIA GPU, use `--encoder nvenc-h264` or `--encoder nvenc-hevc`. `doctor` checks whether FFmpeg can run and supports the required encoders.

## Write a shot

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

There are only three requirements:

- Draw everything inside `#stage`, with fixed CSS width and height defining the frame dimensions;
- Make `render(t)` synchronous. The same `t` must always produce the same image;
- Use local files for fonts, images, and other assets, and finish loading them in `setup()` / `ready`.

For the full contract, patterns that break determinism, and 3D layer usage, see the agent instructions in [`skills/multiplane/SKILL.md`](skills/multiplane/SKILL.md). This file is also a skill that agents can load.

## Commands

| Command | Purpose |
|---|---|
| `multiplane lint <shot>` | Static code checks without a browser |
| `multiplane render <shot>` | Render to MP4 |
| `multiplane stills <shot>` | Capture stills and generate a contact sheet |
| `multiplane verify <shot>` | Run a determinism check |
| `multiplane doctor` | Check Node, the browser, GPU rasterization, FFmpeg, and optional three.js |
| `multiplane status <job>` | View job status |
| `multiplane cancel <job>` | Stop a job |
| `multiplane config get\|set\|unset` | Read or change the user config |
| `multiplane skill status\|install\|remove` | Install, update or remove the agent skill for Claude Code and Codex |

Shot paths are relative to the resource root `--root` (the current directory by default). Each run has its own job directory, `out/jobs/<jobId>/`. Without `--out`, artifacts are written there (video, `stills/`, `verify/`), so runs do not overwrite each other. See `artifacts` in the result for the final paths. `--out` sets the output location. An existing target is rejected unless `--overwrite` is given. `render`, `stills`, and `verify` automatically run `lint` before starting and stop on errors. Use `--no-lint` to skip it. `npx multiplane <command> --help` lists all options for that command.

Common `render` options:

| Option | Meaning |
|---|---|
| `--from` / `--to` | Render a range only (seconds, end time excluded) |
| `--fps` | Override the shot's frame rate |
| `--scale` | Output scale; for example, `2` outputs a 1920×1080 shot at 3840×2160 |
| `--draft` | Fast preview preset: capture at a scale of at most 0.5 and upscale, no motion blur, no grain. Lower quality by design; explicit options override it. Also available for `stills` |
| `--render-scale`, `--upscale` | Capture at a lower scale, then upscale (`lanczos` / `neighbor`); the capture scale must not exceed `--scale` |
| `--motion-blur`, `--shutter`, `--adaptive-blur` | Time samples per frame, shutter fraction, adaptive sampling |
| `--grain` | Film grain intensity |
| `--no-post` | Disable all post-processing |
| `--workers` | Number of parallel browser processes; estimated from CPU, memory, and resolution by default |
| `--raster` | `gpu` (default) or `software` |
| `--format`, `--alpha` | Output format `mp4` (default), `webm` (VP9) or `mov` (ProRes 4444); `--alpha` keeps transparency (WebM and MOV only, also for `stills` and `verify`). See "Transparent video" below |
| `--encoder`, `--max-bitrate` | Encoder, bitrate limit (Mbps) |
| `--audio`, `--audio-offset` | Mix in one audio track with an offset (seconds) |

The shot's `post` values are defaults. Command-line options override them.

## Machine-readable output

With `--json`, stdout contains one JSON event per line (NDJSON). The last line is always the final result:

```json
{"schema":"multiplane/1","type":"result","command":"render","ts":"2026-10-11T09:30:09.120Z","ok":true,"code":null,"message":null,"artifacts":[{"path":"/abs/out/jobs/20261011-093000-animation-3f2a/animation.mp4","kind":"video","bytes":81234}],"elapsedMs":3120,"jobId":"20261011-093000-animation-3f2a","data":{"frames":24}}
```

- On failure, `ok` is `false`, `code` is a stable error code, and `hint` suggests a fix. Human-readable messages go to stderr.
- Exit codes: `0` success, `1` shot or check failure, `2` invalid arguments, `3` environment problem, `4` renderer internal error, `130` cancelled.
- Each run writes `events.jsonl` (the same event stream) and `status.json` (the latest snapshot) under `out/jobs/<jobId>/`, allowing other programs to show progress. Rendering also maintains a preview thumbnail, `preview.png`.

See [`docs/protocol.md`](https://github.com/LBEILC/Multiplane/blob/main/docs/protocol.md) for event types, fields, and all error codes.

## User config and job index

The renderer reads config and registers jobs in a user directory: `%USERPROFILE%\.multiplane` on Windows (`%APPDATA%\multiplane` up to 0.2.0; files there are copied over on first use), `~/Library/Application Support/multiplane` on macOS, and `~/.config/multiplane` on Linux. Override it with the environment variable `MULTIPLANE_HOME`.

- `config.json`: user defaults, with optional fields `ffmpeg`, `raster`, `encoder`, `workers`, and `jobsDir`. Priority: command-line options > environment variables > `config.json` > built-in defaults. Rendering never writes this file; `multiplane config` and the desktop app do. `doctor` and `config get` report its location and which fields take effect.
- `jobs.jsonl`: one line appended at the start and end of each job, allowing other programs to discover jobs across projects. The job directory's `status.json` is the authority for job status. Set `MULTIPLANE_NO_INDEX=1` to disable registration.

Read or write failures in this directory do not affect rendering; they only produce a warning. See section 8 of [`docs/protocol.md`](https://github.com/LBEILC/Multiplane/blob/main/docs/protocol.md) for the format.

## JS API

```js
import { lintShot, renderShot, stillsShot, verifyShot } from 'multiplane';

const result = await renderShot('examples/animation.html', {
  workers: 2,
  out: 'out/demo.mp4',
  onEvent: event => { if (event.type === 'progress') console.error(event.done, event.total); },
});
```

The return value has the same structure as the `result` event, without `schema`, `type` and `ts`. Failures throw a `MultiplaneError` with a `code`.

## Transparent video

Render a shot with a transparent background to lay it over other footage:

```sh
npx multiplane render examples/alpha.html --format webm --alpha
npx multiplane render examples/alpha.html --format mov --alpha
npx multiplane stills examples/alpha.html --alpha --at 0,1
```

The page background becomes transparent; anything the shot paints itself, including a background colour on `#stage`, stays opaque, so leave `#stage` without a background for a fully transparent layer. A shot can make transparency its default with `post: { alpha: true }`.

- `webm` uses VP9 with alpha. Many players ignore VP9 alpha; to check it with FFmpeg, decode with `-c:v libvpx-vp9`, since the default VP9 decoder drops alpha.
- `mov` uses ProRes 4444, which most video editors read with alpha.
- Motion blur and scaling are computed on premultiplied colour, so moving edges do not pick up dark or coloured fringes. Before publishing, the renderer decodes the first and middle frames and checks that alpha survived encoding (at most 2/255 off per pixel).
- Your FFmpeg build needs `libvpx-vp9` for WebM and `prores_ks` for MOV; `doctor` reports both.

## 3D layer

```sh
npm install three@0.180.0
```

`multiplane/three` adds a transparent WebGL canvas to the stage, providing image cards, surface annotations, and accumulated depth of field. It can be layered with ordinary HTML elements. Shots that do not use 3D do not load it. See [`examples/three-cards.html`](examples/three-cards.html) for an example and the skill's "3D layer" section for usage.

## Desktop app

`app/` contains the companion Multiplane desktop app (Electron), intended for people rather than agents:

- **Jobs**: list render, stills, and check jobs across projects, show progress and preview frames in real time, view finished videos, contact sheets, and diff images from failed checks, and stop running jobs.
- **Environment**: check whether the browser, GPU rasterization, FFmpeg, and other requirements are ready. Install and update the Multiplane skill for Claude Code (`~/.claude/skills/`) and Codex (`~/.agents/skills/`), without directly overwriting user modifications.
- **Settings**: write the user config `config.json` described above.
- The interface is in English and Simplified Chinese. It follows the system language and can be switched in Settings.

It communicates with the renderer only through the files and commands in [`docs/protocol.md`](https://github.com/LBEILC/Multiplane/blob/main/docs/protocol.md). It is not required for rendering: agents can render from the command line without it.

Download an installer from the [Releases page](https://github.com/LBEILC/Multiplane/releases). The installers bundle a renderer of the same version, so the app works without a separate Node.js install. That renderer is also available as a command: `multiplane.cmd` in the install directory on Windows, `Multiplane.app/Contents/Resources/bin/multiplane` on macOS, and `Multiplane-<version>-x86_64.AppImage --multiplane-cli` on Linux. The Environment page shows the exact path when `multiplane` is not on PATH. FFmpeg is not bundled (see above), and Chromium is downloaded on first use from the Environment page.

| System | Package | First launch (the packages are not code-signed) |
|---|---|---|
| Windows | NSIS installer (`.exe`) | SmartScreen shows a warning: choose "More info", then "Run anyway". |
| macOS | `.dmg`, one for Apple silicon and one for Intel | Gatekeeper blocks the first launch: right-click the app and choose "Open", or allow it under System Settings → Privacy & Security. |
| Linux | AppImage | Make it executable (`chmod +x`), then run it. It needs FUSE; without FUSE, run it with `--appimage-extract-and-run`. On systems where unprivileged user namespaces are unavailable, the AppImage launcher starts the app with the Chromium sandbox turned off. |

To build a package for the system you are on, or to run the app during development:

```sh
npm --prefix app install
npm --prefix app run dist
npm --prefix app start
```

`dist` writes the package to `app/release/`. `npm --prefix app start` uses separate development directories for the renderer config, job index and app data; add `-- --use-user-home` to use your real ones.

## Examples

| File | Content |
|---|---|
| [`examples/animation.html`](examples/animation.html) | 2D geometric animation with one hard cut in the middle, demonstrating motion blur that respects cuts |
| [`examples/typography.html`](examples/typography.html) | Typography with a local font (Roboto, OFL) |
| [`examples/three-cards.html`](examples/three-cards.html) | 3D cards and accumulated depth of field |

## Determinism and limitations

- Pixel equality is guaranteed only on **the same machine, with the same browser version, fonts, and assets**. Different GPUs, drivers, or browser versions may produce small differences.
- `lint` is a static check. It cannot detect indirect calls (such as `const now = Date.now; now()`) or accumulated state. `verify` is the final check.
- `verify` uses sampling: by default, it checks frames near 0%, 25%, 50%, and 75% of the duration, plus consecutive frames from the first second. Passing does not mean every time has been checked.
- Adaptive motion blur estimates the sample count from image changes. It is an approximation.
- Output is currently limited to opaque video (H.264 / HEVC, MP4).
- The renderer and desktop app pass the same test suite in CI on Windows, macOS (Apple silicon) and Linux (x64, X11 under Xvfb). Windows 10/11 has also been verified on a real machine; macOS and Linux have not yet been tried on real machines, and Wayland has not been tested. CI on Linux has no GPU, so it covers software rasterization there; GPU rasterization on Linux is untested.

## Related projects

Multiplane did not invent the combination of HTML, a time function, a headless browser, and FFmpeg. Related projects include [HyperFrames](https://github.com/heygen-com/hyperframes), [Remotion](https://www.remotion.dev/), [Revideo](https://github.com/redotvideo/revideo), and [Motion Canvas](https://motioncanvas.io/), each with its own focus. Multiplane focuses on shots written as ordinary web pages without a framework dependency, verifiable determinism, motion blur that respects hard cuts, and accumulated depth of field in the 3D layer.

## License

[Apache-2.0](LICENSE). See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for third-party component and example font licenses. FFmpeg is not distributed with this package; its license depends on the build you use.
