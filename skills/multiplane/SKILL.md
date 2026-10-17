---
name: multiplane
description: 'Use Multiplane to render HTML shots to video: write shot pages that follow the contract (`#stage` + `render(t)`), capture stills for inspection, run determinism checks, render MP4, and read machine-readable results. Use when asked to "make a video shot from a web page", "render HTML to video", "check whether a shot is deterministic", or "render / stills / verify with Multiplane". This skill covers usage and determinism constraints only, not visual design.'
---

# Multiplane

Multiplane is a local headless renderer: a shot is an ordinary HTML page whose image depends only on time `t`. Multiplane captures frames with headless Chromium, applies post-processing such as supersampling, motion blur, and film grain, and encodes video with FFmpeg.

Your job has two parts: **write a page that follows the contract**, then **check and render it with the CLI**.

## Workflow

1. Write the shot page (see "Shot contract" below).
2. Run `multiplane lint shot.html --json`: it runs without a browser in under a second and flags patterns that break determinism or the contract, with line and column locations. Fix errors first.
3. Run `multiplane stills shot.html --at 0,1,2.5 --json`: capture a few stills to inspect the images.
4. Run `multiplane verify shot.html --json`: run a determinism check. **Do not render if it fails** (`ok: false`, code `nondeterministic_output`); fix the issues reported by `finding` first. A `gpu_raster_jitter` warning with `ok: true` is not a failure: GPU rasterization made a few scattered pixels differ by a level or two, which is invisible and not caused by the shot. Render as usual and mention it only if the user asks about determinism.
5. Run `multiplane render shot.html --json`: produce the video.

`stills`, `verify`, and `render` automatically run lint before starting. Errors end the command with `lint_failed`, avoiding wasted rendering time.

For environment problems (missing browser or FFmpeg), run `multiplane doctor --json` first. Each entry in `data.checks` has `ok` and a `detail`; when the command fails, the `result` also carries `code` and `hint`. Fix the failing checks before rendering.

## Set up a machine

Use these commands when the user asks you to set up Multiplane, or approves a fix that `doctor` suggests. They change the user's machine-wide settings, so do not run `set`, `unset`, `install` or `remove` on your own initiative.

- `multiplane config get --json` reads the user config; `data.overrides` shows environment variables that currently take priority.
- `multiplane config set ffmpeg <path> --json` saves the FFmpeg path and checks it at once: read `data.check.usable` and `data.check.reason`. An unusable path is still saved and produces a `warning`. Other keys: `raster` (`gpu` / `software`), `encoder` (`x264` / `nvenc-h264` / `nvenc-hevc`), `workers` (a positive integer, or `auto`), `jobsDir`. `multiplane config unset <key>` restores the default.
- `multiplane skill status --json` reports this skill for Claude Code and Codex; `multiplane skill install --host claude|codex|all --json` installs or updates it. A copy the user has edited is reported as `modified` and is not replaced unless you pass `--force`, which backs it up first; ask the user before using `--force`.
- When only the desktop app is installed, `multiplane` may not be on PATH. The app ships its own command: on Windows `<install directory>\multiplane.cmd`, on macOS `/Applications/Multiplane.app/Contents/Resources/bin/multiplane`, and on Linux `<path to the AppImage> --multiplane-cli`. The app's Environment page shows the exact path.

## Shot contract

Minimal shot:

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
  duration: 4,                 // seconds
  fps: 30,                     // optional, default 30
  render(t) {                  // draw the frame at time t; nothing else may influence it
    const k = Shot.ease.inOutCubic(Shot.ease.prog(t, 0.5, 3));
    box.style.transform = `translateX(${Shot.ease.lerp(0, 1820, k)}px)`;
  },
});
</script></html>
```

### Stage

- Include `#stage` in the page and draw everything inside it. Define the frame dimensions with **fixed CSS pixel width and height**. Do not let them vary with the viewport, time, or content.
- Use only the width and height of `#stage` to define the frame dimensions; there are no separate width and height options. Common sizes: 1920×1080 (16:9), 1080×1920 (9:16), 1080×1080 (1:1), 1080×1350 (4:5).
- Output pixels = logical dimensions × `--scale`, and must be positive even integers. For example, do not use `--scale 0.5` with 1080×1350 (it produces 675 rows).
- `--scale` sets the browser's `devicePixelRatio`. DOM, SVG and text redraw at that resolution; a `<canvas>` does not. Size every canvas by `devicePixelRatio` (`canvas.width = cssWidth * devicePixelRatio`, then `ctx.scale(devicePixelRatio, devicePixelRatio)`, CSS size unchanged), or it is only enlarged and looks soft at `--scale 2`.

### `Shot.define(spec)`

| Field | Required | Meaning |
|---|---|---|
| `duration` | Yes | Duration in seconds. |
| `render(t)` | Yes | Draw the image at second `t`. Use a **synchronous function**; do not return a Promise. |
| `fps` | No | Frame rate, default 30. |
| `fonts` | No | Fonts to wait for: `[['48px MyFont', 'text used'], ...]`. |
| `setup()` | No | One-time preparation (load images, create a 3D scene, etc.). May return a Promise; the renderer waits for it before starting. |
| `cuts` | No | Array of hard cut times (seconds). Motion blur time samples do not cross these times. **Declare every hard cut in the image**, or frames on either side of the cut will blur together. |
| `post` | No | Post-processing defaults: `motionBlur` (time samples per frame; 1 disables it), `maxMotionBlur` (upper limit for adding samples where motion is fast; see below), `shutter` (shutter fraction of a frame; 0.5 means 180°), `grain` (film grain intensity; 0 disables it). Command-line options override these. |
| `blurAt(t)` | No | Return the required number of time samples (a positive integer) at this time, using fewer samples for static sections and more for fast motion. |
| `meta` | No | Any JSON data for tools that read the shot (beats, captions, notes), at most 1 MiB. Readable as `SHOT.meta`; returned by `inspect`; never affects pixels. |

Use `Shot.ease` for `clamp`, `lerp`, `prog(t, start, dur)`, and several easing curves; use `Shot.size` for the stage's logical dimensions. You may also skip `Shot.define` and define `window.SHOT = { duration, fps, ready, render, cuts, post }` directly, where `ready` is a Promise that resolves when assets are ready.

### Resources

- Keep the shot file inside the resource root (`--root`, the current directory by default). Relative paths in the page resolve from the shot file's location and must not point outside the root.
- Treat paths starting with `/multiplane/` as reserved for the renderer's runtime libraries.
- **Use local files for all resources**: point `@font-face` to local font files and list them in `fonts`. Do not reference remote fonts, CDN scripts, or remote images.
- Finish loading images, fonts, and other assets in `setup()` / `ready`. Do not start loading in `render(t)`.

## Determinism constraints (most important)

Multiplane calls `render(t)` out of order, repeatedly, and in parallel across multiple browser processes, then compares the pixels of each frame. **The same `t` must produce identical pixels, regardless of earlier calls or their count.**

Do not use the following in `render(t)` or the code it calls:

| Do not use | Reason | Use instead |
|---|---|---|
| `Date.now()`, `new Date()`, `performance.now()` | Wall-clock time changes on every call | Use only the parameter `t` |
| `Math.random()`, `crypto.getRandomValues()` | Results change on every call | Use a fixed-seed pseudorandom generator (such as mulberry32), precompute in `setup()`, or derive values from `t` and the element index |
| CSS `animation`, `transition`, `@keyframes`, Web Animations API | The browser advances them by wall-clock time | Set styles directly in `render(t)` |
| `requestAnimationFrame`, `setTimeout`, `setInterval` driving the image | Same as above | Same as above; let the runtime handle preview playback, and do not write your own playback loop |
| `<video>`, `<audio>` playback, animated images such as GIFs | Playback position is not controlled by `t` | Extract individual frames in advance and select a frame by `t` |
| State that depends on the previous call (accumulated positions, per-frame particle integration, "if the previous frame was...") | With out-of-order or parallel calls, the previous call is not the previous frame | Write a closed-form function of `t`; for simulations, precompute the full result with fixed time steps in `setup()` and only look up values in `render(t)` |
| An `async` `render`, waiting for loading in `render` | The image may be incomplete when captured | Put all loading in `setup()` / `ready` |

The runtime uses wall-clock time for its own preview playback. You do not write that part, and it does not affect rendering.

`lint` detects most direct patterns in the table above, but not indirect calls (such as `const now = Date.now; now()`) or accumulated state (such as `x += 1`). So **only a passing `verify` counts** (a pass with `gpu_raster_jitter` warnings still counts).

If a prohibited pattern is necessary and you have confirmed that it cannot affect the image (for example, a log only in `setup()`), suppress it with a comment on the line **immediately above** it. Include the rule code:

```js
// multiplane-disable-next-line wall_clock
console.log('setup took', performance.now() - started);
```

Use `/* multiplane-disable-next-line css_animation */` in CSS and `<!-- multiplane-disable-next-line media_playback -->` in HTML. Do not use suppression to bypass issues that actually affect the image. Also, pixel equality holds only on the same machine, with the same browser version, fonts, and assets. Changing the GPU or browser version may produce small differences.

## 3D layer (optional)

Use `multiplane/three` when you need 3D cards or depth of field. When the renderer is the desktop app's bundled command, three.js 0.180.0 is already included. With the npm package, install `three@0.180.0` in the project (`npm install three@0.180.0`). `multiplane doctor` reports whether three.js is available, its version and where it comes from.

```html
<script type="importmap">{"imports":{
  "three": "/multiplane/vendor/three/build/three.module.js",
  "three/addons/": "/multiplane/vendor/three/examples/jsm/"
}}</script>
<link rel="stylesheet" href="/multiplane/runtime/shot.css">
<style>#stage { width: 1920px; height: 1080px; }</style>
<div id="stage"></div>
<script src="/multiplane/runtime/shot.js"></script>
<script type="module">
import { createThreeLayer } from '/multiplane/three.js';
const layer = createThreeLayer({ aperture: 0.12, focusDistance: 10 });
const card = layer.card({ src: './assets/card.png', width: 2.5, height: 2.5, position: [0, 0, 0] }); // your own local image
Shot.define({
  duration: 3,
  setup: () => layer.ready,                       // wait for textures
  render(t) {
    card.rotation.y = 0.3 * t;
    layer.render({ t, focusDistance: 10 - t });   // always pass t
  },
});
</script>
```

- Use `createThreeLayer(options)` to add a transparent WebGL canvas inside `#stage`, layered with ordinary HTML elements (`zIndex` controls stacking). Common options: `fov`, `focusDistance`, `aperture` (0 keeps everything sharp), `samples` / `maxSamples` (depth-of-field sample count, adaptive to the amount of blur by default), `quality` (`'final'` uses accumulated depth of field and is the default; `'preview'` is a fast approximation for drafts only).
- Use `style` on `createThreeLayer` for layer-wide defaults, or on a card to override them: `annotationFontFamily`, `annotationColor` (lines), `annotationTextColor`, `textureBackground`, `browserFrameColor`, `browserFrameFontFamily`. Font options take a single family name; the renderer waits for it to load and fails with `resource_failed` instead of falling back. A layer-wide `textureBackground` only fills cards that have `annotations` or `browserFrame`; plain cards keep their image's transparency unless the card's own `style` sets `textureBackground`.
- Use `layer.card({ src, width, height, position, rotation, radius, border, shadow, annotations, style, lodBias })` to get a three.js `Group`. Change its position and rotation in `render(t)`.
- `lodBias` (default 0) sharpens a card that is shown smaller than its texture, such as small text on a card facing the camera at about 0.6× size: try `-1`. Leave it at 0 for cards seen at a steep angle with fine repeating patterns, where a negative bias causes moiré.
- Call `layer.render({ t, ... })` inside every `render(t)` call and pass the same `t`. The renderer handles motion blur subsamples automatically.
- Use `layer.scene` and `layer.camera` as ordinary three.js objects and add your own meshes. Their state must likewise depend only on `t`.
- Use `apertureForBlurRadius({ radiusPixels, depth, focusDistance })` to convert a desired blur radius in pixels at a given depth into an aperture.

## Commands

Use `--json` with any command. Resolve shot paths relative to `--root` (the current directory by default).

| Command | Purpose | Common options |
|---|---|---|
| `multiplane lint <shot>` | Static code checks without a browser | `--root` |
| `multiplane stills <shot>` | PNG stills at given times and a contact sheet; also for final images | `--at 0,1.5,3` (seconds) or `--every 0.5`; `--out` |
| `multiplane verify <shot>` | Determinism check: pixel comparisons out of order, after reload, and with single/multiple processes | `--at` (must fall on frames), `--workers` (default 2) |
| `multiplane render <shot>` | Render video | `--out`, `--from` / `--to` (seconds, end excluded), `--fps`, `--scale`, `--workers`, `--quality`, `--motion-blur`, `--max-motion-blur`, `--shutter`, `--grain`, `--no-post`, `--draft`, `--encoder`, `--audio`, `--no-static-reuse` |
| `multiplane inspect <shot>` | Read duration, frames, stage size, cuts and `meta` without rendering | `--fps`, `--root` |
| `multiplane serve` | Serve shots on 127.0.0.1 so the user can open them in a browser; stop it when done | `--root`, `--port` |
| `multiplane benchmark` | Measure the fastest worker count on this machine (2–3 minutes); renders then use it automatically | `--raster` |
| `multiplane doctor` | Check the environment | — |
| `multiplane config get\|set\|unset` | Read or change the user config | see "Set up a machine" |
| `multiplane skill status\|install\|remove` | Manage this skill for Claude Code and Codex | `--host`, `--force` |
| `multiplane status <job>` | View job status | — |
| `multiplane cancel <job>` | Stop a job | `--wait` (seconds) |
| `multiplane wait <job>` | Wait for a job started earlier and print its events | `--timeout` (seconds) |
| `multiplane resume <job>` | Continue an interrupted render; already encoded segments are reused | `--workers` |

Use `--out`, `--overwrite`, and `--no-lint` (skip automatic lint) with `stills`, `verify`, or `render`. Run `multiplane <command> --help` to list all options for that command.

Each run has its own job directory, `out/jobs/<jobId>/`. Without `--out`, artifacts are written there; use `artifacts` in the result for the paths. If `--out` points to an existing file, the command fails with `output_exists`. Add `--overwrite` when you intend to replace it (replacement happens only after the new artifact is fully written; on failure, the old file stays untouched).

FFmpeg is not bundled. It is found in this order: `--ffmpeg <path>`, the environment variable `MULTIPLANE_FFMPEG`, `ffmpeg` in the user config `config.json`, then the system PATH. It must support libx264. To save a path for every project, use `multiplane config set ffmpeg <path>` with the user's approval (see "Set up a machine").

Motion blur quality: the shot decides whether there is motion blur (`post.motionBlur` above 1, the starting number of samples); `--quality` decides how many samples fast frames get. The default `standard` compares adjacent samples block by block and starts at `motionBlur` but at most 4 (an explicit `--motion-blur` still sets the start; a limit no larger than the start keeps the count fixed), and doubles the count wherever something moved more than about 2 pixels, up to 32; `fast` is the same with a limit of 16; `high` starts at `motionBlur`, uses about 1 pixel and goes up to 256. Static frames drop to 1 sample. Use the default `standard` for iterating and for the final render: on real shots `high` takes several times longer for a difference visible only when zoomed in. Use `fast` when the user asks for speed over quality (quick reviews of long shots, renders that are not the final deliverable); it renders sooner and very fast motion shows slightly more visible steps. Use `high` only when the user asks, for stills that will be viewed up close, or when very fast thin motion still strobes under `standard`. Do not raise `motionBlur` for the whole shot to fix strobing; use `high`, or `--max-motion-blur` for a custom limit. `result.data.blurSamples` (`{ min, max, mean, histogram }`) shows the counts used. A shot with its own `blurAt(t)` keeps full control of the count.

When the user wants an image rather than a video (a cover, poster, thumbnail or illustration), write a shot and use `stills` for the final output: each PNG gets the same supersampling (`--scale 2`), motion blur, depth of field and `--alpha` as video. Pick a time during motion if the still should show motion blur. Hand over the `t-<seconds>.png` file from `result.data.stills`, not the contact sheet.

Use `--draft` with `render` or `stills` while iterating: it captures at a scale of at most 0.5 and upscales, with no motion blur and no grain, so it is faster and visibly lower in quality. Options you pass explicitly override the preset. Render the final video without `--draft`; `result.data.draft` is `true` when a draft was produced, so do not hand a draft over as the final result.

## Transparent output

When the result must be laid over other footage, render with `--alpha` and `--format webm` (VP9) or `--format mov` (ProRes 4444); MP4 cannot carry alpha and `--alpha` with MP4 fails with `invalid_option`. The page background is transparent; do not give `#stage` (or a full-size element) a background colour if the layer should be transparent. Declare `post: { alpha: true }` in the shot when transparency is its normal output. Check transparent shots with `verify --alpha` and `stills --alpha`. Do not judge alpha by playing the WebM in a browser or a generic player; the renderer has already decoded and checked it.

## Read results

With `--json`, stdout contains one JSON event per line. **The last line is always `type: "result"`**. Use that line to determine success or failure:

```json
{"schema":"multiplane/1","type":"result","command":"render","ts":"2026-10-11T09:30:09.120Z","ok":true,"code":null,"message":null,"artifacts":[{"path":"/abs/out/jobs/20261011-093000-shot-3f2a/shot.mp4","kind":"video","bytes":812345}],"elapsedMs":9120,"jobId":"20261011-093000-shot-3f2a","data":{"output":"/abs/out/jobs/20261011-093000-shot-3f2a/shot.mp4","frames":120,"fps":30,"width":1920,"height":1080}}
```

- When `ok: false`, use `code` to decide what to do next and `hint` for a suggested fix. Do not parse `message` to make decisions.
- Interpret exit codes as follows: 0 success; 1 shot or check failure (fix the shot); 2 invalid arguments (fix the command); 3 environment problem (run `doctor`); 4 renderer internal error (retry once, then report if it still fails); 130 cancelled.
- Before a video is published, the renderer reads the encoded file back and compares frame count, duration, size and frame rate with what it rendered (`result.data.outputCheck`). On a mismatch the command ends with `output_invalid` (exit code 4) and nothing is published; an existing file at the output path is left untouched. Retry once and report it if it repeats. A `warning` with `code: "output_unverified"` means the file was published without this check; inspect it before relying on it.
- `result.data.resources.peakMemoryBytes` is the sampled peak memory of the whole process tree. If jobs fail with `browser_crashed` or `worker_crashed` and this value is close to the machine's memory, lower `--workers` or `--scale`.
- If the browser process closes unexpectedly, the renderer relaunches it and renders the affected frame again. You will see a `warning` event with `code: "browser_restarted"`; pixels are unaffected, so no action is needed. If it keeps failing, the command ends with `browser_crashed` (exit code 4): this is not a problem in the shot. Retry once, then try `--raster software`, and report it if it still fails.
- Read each `lint` issue as a `finding`: `code` is the rule code (corresponding to the constraints above, such as `wall_clock`, `css_animation`, `remote_resource`), `location` provides `file`, `line`, and `column`, `details.snippet` is the source line, and `hint` explains what to use instead. Fix every `severity: "error"`. A `"warning"` (such as `timer_driven` or `font_not_awaited`) does not block rendering but usually indicates a problem.
- When `verify` fails, `code` is `nondeterministic_output`. Read the preceding `finding` events for the failed check (`reorder` for out-of-order calls / `reload` for page reloads / `workers:<n>` for parallel processes / `range` for consecutive frames), time `t`, changed pixel count, changed region `bbox`, and paths to the reference frame, actual frame, and diff image. Inspect the diff image and `bbox` to locate the element, then use the constraint table above to find the cause. Common patterns:
  - Only `reorder` or `workers` fails: `render(t)` depends on state from the previous call.
  - `reload` fails: random numbers or wall-clock time are used, or assets did not finish loading before `ready`.
  - Only text regions fail: fonts are missing from `fonts`, or remote fonts are used.
- With `--json`, human-readable messages go to stderr. Do not merge them with stdout when parsing.

## Long renders

Rendering may take a long time, often longer than the timeout of your shell or command tool. When the tool lets you, give `render` a timeout long enough for the whole render or run it in the background; if the command is cut off, the job's process usually dies with it, so do not start the same render again: check it with `multiplane status <jobId> --json` and continue it with `multiplane resume` (see below). Each run creates a job directory, `out/jobs/<jobId>/` (`jobId` appears in both the `start` event and the `result`). Read `status.json` for the latest progress snapshot and `events.jsonl` for the full event stream. To stop a job, run `multiplane cancel <jobId>` or create a file named `stop` in its job directory.

If the user turned on hosting in the desktop app, the app runs the render and it keeps going after your session ends. Nothing changes in how you call the command; stderr says the job was handed over, and `status.json` may show `queued` while another hosted job runs. When a session resumes and you started a job earlier but never saw its `result`, run `multiplane wait <jobId> --json` to get its events and exit code instead of starting it again. Use `--no-hosted` only when the user asks for a render that should not go through the app.

A `render` that ended without succeeding (`failed` or `cancelled`, or a job whose process disappeared, for example after a crash or reboot) can usually be continued instead of rendered again: run `multiplane resume <jobId> --json`. It reuses the segments already encoded (about 10 seconds each), renders the rest with the original options and output path, and produces the same frames as an uninterrupted render. It is a new job; its `result` carries `resumedFrom` and `resume.framesReused`. `multiplane status <jobId> --json` shows `data.resume.available` and how many frames are done. If it fails with `resume_unavailable`, read `details.reason`: `inputs_changed` or `environment_changed` means start a fresh `render` (do this deliberately, for example after you edited the shot); `running` means the job, or another resume, is still going, so `wait` for it; `missing_manifest` means the job predates segments. Only `--workers` can change on resume. A `resume_renderer_changed` warning (a different GPU or driver) needs no action.
