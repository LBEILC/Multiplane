# Machine-readable output and rendering job protocol (v1)

English · [简体中文](protocol.zh-CN.md)

This is the authoritative version. The [Chinese version](protocol.zh-CN.md) is a reference translation. If the two differ, the English version takes precedence.

This is the contract shared by the CLI, the JS API, the desktop app and any other reader. Its version is the `schema` value `multiplane/1`: fields are only added; a change in meaning or a removed field moves it to `multiplane/2`.

## 1. General rules

- All commands support `--json`. With `--json`: **stdout contains only NDJSON** (one JSON object per line, UTF-8, terminated by `\n`). All human-readable text, browser logs, and warnings go to stderr. Without `--json`: stdout shows a human-readable result summary; progress goes to stderr.
- Program output (error messages, hints, progress text) is in **English**. Agents use `code` to make decisions, not parsed text.
- Finish writing the last line before the process exits: set `process.exitCode`. Do not call `process.exit()` immediately after writing to stdout (Windows pipes may not flush in time).
- Wall-clock time appears only in event timestamps, elapsed times, and job IDs. It never participates in image calculations.

## 2. Events

Every line includes:

| Field | Meaning |
|---|---|
| `schema` | Always `"multiplane/1"`. Fields may only be added, not changed. Increment to `/2` when changing a field's meaning or removing a field. |
| `type` | Event type; see the table below. |
| `command` | `render` / `stills` / `verify` / `inspect` / `serve` / `lint` / `benchmark` / `doctor` / `status` / `cancel` / `wait` / `config` / `skill`. |
| `ts` | ISO 8601 UTC timestamp. |

(`lint`, `inspect` and `serve` do not create a job directory; their events have no `jobId`.)

| `type` | When | Additional fields |
|---|---|---|
| `start` | First line after successful argument parsing (with `--draft`, or when the shot may declare a default for `alpha`, it is sent after a pre-check that loads the shot without calling `render(t)`, so that `options` carries the final values; it is still the first event) | `version` (package version), `shot` (absolute path, or `null` for commands without a shot), `jobId` (when there is a job), `options` (effective options known before loading the shot, including renderer defaults; see the `shot` event for the shot's own `fps`, `post`, and other declarations, and `result.data` for the final effective values) |
| `environment` | Once after browser launch | `node`, `platform`, `chromium`, `gpu` (`{renderer, hardware}`), `ffmpeg` (`{path, version}`, or `null` when not needed) |
| `shot` | Once after loading the shot | `width`, `height`, `duration`, `fps`, `cuts`, `post` (default post-processing options declared by the shot) |
| `progress` | On progress changes, at most one line per 250 ms | `phase` (`launch` / `load` / `capture` / `encode` / `compare` / `finalize`), `done`, `total`, `unit` (such as `"frame"`), `fps` (measured speed, may be `null`), `etaMs` (may be `null`) |
| `warning` | Nonfatal problem | `code`, `message`, optionally `details` |
| `finding` | Problem found by a check command (`verify` mismatches, `lint` problems) | See section 4 |
| `artifact` | After each artifact file is fully written | `path` (absolute path), `kind` (`video` / `still` / `contact-sheet` / `report` / `diff-image`), `bytes` |
| `listening` | `serve` only, once the server accepts connections | `url`, `root` (absolute resource root), `port` |
| `result` | **Always the last line**, on both success and failure | See section 3 |

When Ctrl+C, a stop file, or `cancel` interrupts the process, it should still try to write a `result` (`ok: false`, `code: "cancelled"`). If it crashes before writing a `result`, readers treat "no `result` line and the process has exited" as `internal_error`.

## 3. Final result `result`

| Field | Meaning |
|---|---|
| `ok` | Boolean. |
| `code` | `null` on success; an error code from section 5 on failure. |
| `message` | Failure reason (English); `null` on success. |
| `hint` | Optional: how to fix it (one English sentence). |
| `details` | Optional: structured error details, such as `option` for `invalid_option` or `t` for `render_threw`. |
| `artifacts` | Artifacts **fully written** during this run, `[{path, kind, bytes}]`. On failure, list only those fully written to disk. |
| `elapsedMs` | Integer. |
| `jobId` | Included when there is a job. |
| `data` | Command-specific result; see below. |

`data` by command:

- `render`: `{ output, frames, fps, from, to, width, height, encoder, post: {motionBlur, maxMotionBlur, shutter, adaptiveBlur, grain}, blurSamples, renderScale, scale, draft, format, alpha, outputCheck, resources }`. `format` is `mp4`, `webm` or `mov`; `alpha` is `true` when the transparent path was used. `draft` is `true` when `--draft` was given (a preset for fast previews: a render scale of at most 0.5, no motion blur, no grain; explicit options win over the preset, and the preset wins over user config and shot defaults; the output size, fps, encoder and workers are not changed; if no valid scale of at most 0.5 exists for the stage size, the command fails with `invalid_scale`). `outputCheck` is what was read back from the encoded file before it was published: `{ verified, frames, durationSeconds, width, height, fps, codec, pixelFormat, audioDurationSeconds }` (`audioDurationSeconds` only when the output has an audio track); `verified` is `false` when the file could not be probed (see `output_unverified`). `pixelFormat` is the format reported when decoding the file, which can differ from the encoder input. The check requires the exact frame count, a duration within one frame, the exact width and height, and a frame rate within a relative 1e-4 of the requested one (containers such as WebM store timestamps with limited precision, so 59.94 may read back as 59.940063). Frame rates are passed to the encoder as exact fractions, for example 29.97 as 30000/1001. For transparent output, the renderer also decodes the first and middle frames (VP9 through `libvpx-vp9`, since the default VP9 decoder drops alpha) and compares their alpha with the source frames; a difference larger than 2/255 in any pixel, or missing alpha, ends with `output_invalid` (transparent output is never published unverified). `resources` is `{ peakMemoryBytes, memorySamples, workers, cpuCount }` for the whole process tree (renderer, browser processes, workers, encoder); a value that could not be measured is `null`. `peakMemoryBytes` is the largest of the periodic samples, not an exact operating-system peak; `memorySamples` counts successful samples; `workers` is the largest number actually in use. `stills` and `verify` results carry `resources` too. `render`, `stills` and `verify` results also carry `staticReuse` (section 12), the effective `post`, and `blurSamples`: `{ min, max, mean, histogram }`, the number of time samples blended into each delivered frame (`histogram` maps the sample count, as a decimal string, to a frame count). A static frame counts as 1; a reused frame counts what the frame it copies used. `verify` counts each requested time once.

**Quality presets.** `render`, `stills` and `verify` take `--quality draft|standard|high` (JS option `quality`); the default is `standard`, and `result.data.quality` reports the one used. The preset sets how motion blur samples are chosen, never whether a shot has motion blur: a shot without motion blur (`motionBlur` 1) gives the same pixels under every preset. `draft` is the same as `--draft` (which remains as its alias; giving both with different values fails with `invalid_option`). With `standard` and `high`, `motionBlur` is the starting number of samples. Each frame is captured at that many evenly spaced times in the shutter window; the image is divided into 8×8-pixel blocks, and adjacent samples are compared block by block, with the difference divided by the block's edge strength so that it approximates how many pixels the content moved between the two samples. If any block moved more than about 2 pixels (`standard`) or 1 pixel (`high`), the number of samples doubles and the frame is captured again on the finer grid, up to 64 (`standard`) or 256 (`high`). If all samples are identical, the frame uses 1 sample. `maxMotionBlur` (`--max-motion-blur`, or `post.maxMotionBlur` in the shot; the command line wins) replaces the preset's limit; a limit no larger than `motionBlur` keeps a fixed `motionBlur`. Each frame is first captured at the two ends and the middle of the shutter window; if the three are identical it uses 1 sample. Sample grids are nested: each count is a symmetric subset of the largest grid, so doubling only adds new times and keeps the captures already made (a shot that reads `SHOT.sampleContext.motionBlur`, such as one using the 3D layer, falls back to recapturing the full grid at each count). Sample times depend only on the frame, the shutter and the count, so the result does not depend on render order or workers. Cuts still limit the window. `--no-post` turns motion blur off. A shot with `blurAt(t)` keeps its own count and is not raised.
- `stills`: `{ stills: [{t, frame, path}], contactSheet, draft, format, alpha }`. `draft` as for `render`; `format` is always `png`; with `alpha`, the stills keep transparency and the contact sheet is composited over a checkerboard.
- `verify`: `{ passed, times, workers, checks: [{name, passed, jitter}] , findings: n, format, alpha }` (`format` is `png`; with `alpha`, all four channels are compared). On a mismatch, `ok: false`, `code: "nondeterministic_output"`; details are in the `finding` events.
- `lint`: `{ files: [...scanned files, relative to the resource root], errors, warnings, suppressed }`. With errors, `ok: false`, `code: "lint_failed"`; with warnings only, `ok: true`. `render` / `stills` / `verify` run lint first by default, with its `finding` events in the same stream. `--no-lint` skips it.
- `inspect`: `{ shot, duration, fps, frames, stage: {width, height}, cuts, post, hasBlurAt, meta }` (section 10.1).
- `serve`: `{}` after the server stops (section 10.2).
- `doctor`: `{ checks: [{name, ok, detail}] }`, checking the Node version, browser, GPU rasterization, FFmpeg and libx264, and optional three.js.
- `status` / `cancel`: job status snapshot (section 6).
- `wait`: the original job's event stream; see section 11.5.

## 4. `finding`

| Field | Meaning |
|---|---|
| `code` | Rule or problem code, such as `nondeterministic_output`. |
| `severity` | `error` / `warning`. |
| `message` | English description. |
| `hint` | Optional suggested fix. |
| `location` | Optional: `{file, line, column}` (source location, used by `lint`) or `{t, frame}` (time location, used by `verify`). |
| `details` | Optional. `verify` provides at least: `check` (`reorder` / `reload` / `workers:<n>` / `range`), `changedPixels`, `maxChannelDiff`, `bbox` (`{x, y, w, h}`, bounding box of the changed region), `images` (`{reference, actual, diff}`: paths to the reference frame, actual frame, and diff image). |

## 4a. Output formats and transparency

- `render --format mp4|webm|mov`. Without `--format`, the format follows the extension of `--out`; without either, `mp4`. A conflicting or unknown extension fails with `invalid_option`. The default job file name uses the format's extension.
- `mp4`: H.264 or HEVC (`--encoder x264|nvenc-h264|nvenc-hevc`), opaque only.
- `webm`: VP9 (`libvpx-vp9`), `yuva420p` with alpha, `yuv420p` without; audio is Opus. Quality settings are fixed in this version.
- `mov`: ProRes 4444 (`prores_ks`), `yuva444p10le` with alpha, `yuv444p10le` without.
- `--encoder` applies to `mp4` only; using it with another format fails with `invalid_option`.
- `--alpha` (for `render`, `stills`, `verify`) keeps the alpha channel. The page background is transparent; anything the shot paints itself, including a background colour on `#stage`, stays opaque. A shot can set the default with `post: { alpha: true }`; command-line options win. `--alpha` with `mp4` fails with `invalid_option`.
- With alpha, motion-blur averaging and scaling are done on premultiplied linear-light colour; alpha is averaged linearly; fully transparent output pixels have colour 0; film grain changes visible colour only. Without `--alpha`, output is identical to earlier versions.
- A required encoder that the FFmpeg build lacks ends with `ffmpeg_unusable`; `doctor` lists `libvpx-vp9` and `prores_ks` as optional checks.

## 5. Error codes and exit codes

Error codes are stable lowercase strings with underscores. **Only add codes; never change them**.

| Exit code | Category | Error codes |
|---|---|---|
| 0 | Success | — |
| 1 | Shot or check failure | `shot_not_found`, `shot_outside_root`, `shot_load_failed` (HTTP or script error), `shot_contract_invalid` (missing `SHOT`, `render` is not a function, invalid `duration`/`fps`/`cuts`, etc.), `stage_size_invalid` (missing `#stage`, dimensions are not positive integers or vary with the viewport), `ready_timeout`, `render_threw` (`render(t)` throws; `details` includes `t`), `resource_failed` (font or asset failed to load), `nondeterministic_output`, `lint_failed`, `cancel_timeout` (the job has not finished when `cancel --wait` expires) |
| 2 | Usage error | `invalid_option` (unknown, repeated, missing value, invalid value; `details.option`), `invalid_scale` (scale produces odd or noninteger dimensions; `hint` lists usable scales), `output_exists` (the explicit output path already has a file and `--overwrite` was not given), `job_not_found` (`status` / `cancel` cannot find the job or the snapshot is corrupt) |
| 3 | Environment problem | `skill_modified`, `skill_blocked`, `skill_changed` (see section 9.2), `config_invalid` (as a command failure of `config`, see section 9.1; elsewhere it is only a warning), `ffmpeg_not_found`, `ffmpeg_unusable` (found but cannot run or lacks an encoder), `browser_not_installed`, `browser_launch_failed`, `three_not_installed`, `unsupported_node`, `wait_timeout` (`wait --timeout` expired; the job itself is not affected), `port_in_use` (`serve --port` names a port that is already taken), `job_dir_unwritable` (the job directory cannot be created or written, for example when running in a read-only directory; `details.path`; the hint points to `--job-dir` and `MULTIPLANE_JOBS_DIR`) |
| 4 | Renderer internal error | `output_invalid` (the encoded file does not match what was rendered: frame count, duration, size or frame rate; `details.expected` and `details.actual`; the file is not published), `worker_crashed`, `browser_crashed` (the browser process or page closed unexpectedly and restarting it did not help; `details.t` when known), `encode_failed`, `internal_error` |
| 130 | Cancelled | `cancelled` |

Warning codes (only in `warning` events; do not affect the exit code): `browser_restarted` (the browser process or page closed unexpectedly; it was relaunched and the affected frame rendered again, which cannot change pixels because `render(t)` depends only on `t`; `details.attempt`), `output_unverified` (the encoded file could not be probed, so it was published without the check; `details.reason`), `gpu_software_fallback` (GPU rasterization was requested but a software renderer is used), `home_unavailable` (user directory read or write failure; see section 8), `config_invalid` (an invalid user config field was ignored; `details.field` is `"$"` when the entire file is corrupt or the top level is not an object), `preview_failed` (preview frame write failure, reported only once per job; preview updates stop, rendering continues), `static_reuse_disabled` (a checked frame did not match its reused copy; reuse is turned off for the rest of the job and the affected frames are captured again, so the output is still correct; `details.frame`, `details.t`).

Lint rule codes (`finding.code`): `wall_clock`, `unseeded_random`, `css_animation`, `web_animations`, `media_playback`, `remote_resource`, `resource_missing`, `stage_missing`, `shot_missing`, `runtime_missing`, and `async_render` are errors; `timer_driven`, `animated_image`, `stage_size_unfixed`, `font_not_awaited`, `lint_directive_invalid`, and `lint_incomplete` (a source section could not be parsed and was skipped, leaving scan coverage incomplete) are warnings. Lint's `location` is `{file, line, column}` (relative to the resource root, 1-based), and `details.snippet` is the source line. Add a comment `multiplane-disable-next-line <rule-code>` on the preceding line to suppress a finding.

## 6. Rendering jobs

Each run of `render`, `stills`, or `verify` is a job.

- `jobId`: `<UTC time yyyyMMdd-HHmmss>-<shot filename>-<4 random hexadecimal digits>`, ensuring concurrent runs do not collide.
- Job directory: defaults to `<cwd>/out/jobs/<jobId>/`; change the parent directory with `--job-dir <dir>` or the environment variable `MULTIPLANE_JOBS_DIR`.
- Artifact locations: without `--out`, artifacts are written in the job directory (video `<jobDir>/<shot-name>.mp4`, stills `<jobDir>/stills/`, check reports and diff images `<jobDir>/verify/`), so runs do not overwrite each other. With `--out`, an existing target causes `output_exists` unless `--overwrite` is given. Replacement writes fully to a temporary location first, then replaces the target (directory artifacts are replaced in full). On failure, the original artifact stays untouched.
- Directory contents:
  - `events.jsonl`: **exactly the same** event stream as stdout with `--json` (written whether or not `--json` is enabled).
  - `status.json`: the latest snapshot, written atomically (write a temporary file, then rename): `{schema, jobId, command, shot, pid, state, phase, done, total, fps, etaMs, previewFrame, memoryBytes, startedAt, updatedAt, result}`. `state` is `queued` / `running` / `succeeded` / `failed` / `cancelled`. `queued` is used only for hosted jobs waiting in the app's queue (section 11); while queued, the app writes the snapshot, `pid` is the app's process, and `queuePosition` (starting at 1, where 1 runs next) is added. Readers that meet a state they do not know show it as in progress. At completion, `result` equals the contents of the `result` event; while running, it is `null`.
  - Stop request: create a `stop` file in the directory. The renderer detects it, cleans up, and ends with `cancelled`.
- `multiplane status <jobId|jobDir> [--json]`: read `status.json`. If the process is gone but `state` is still `running`, report `failed` / `internal_error` (without changing the file). The `ok` value of `status` itself only means the snapshot was read. Check `data.state` and `data.result` for the original job's outcome.
- `multiplane cancel <jobId|jobDir> [--json]`: create the `stop` file, wait for the job to finish (`--wait` seconds, default 30), and output the final status. If the job has already ended, return its original terminal state directly. If it is still running when the wait expires, return `cancel_timeout`.
- `--help` (global or `multiplane <command> --help`) and `--version` output only human-readable text and produce no events.
- Job directories are not cleaned up automatically. The desktop app and other readers depend on these files.

## 7. JS API

- `renderShot` / `stillsShot` / `verifyShot` / `inspectShot` / `lintShot` / `doctor` return an object with the same structure as the `result` event (without `schema`, `type`, or `ts`).
- On failure, throw `MultiplaneError` (extends `Error`), with `code`, `exitCode`, `hint`, `details`, and `result`.
- The optional `onEvent(event)` callback receives the same event objects as NDJSON. The `print` callback is no longer used.

## 8. User directory (for the desktop app and other readers)

The renderer registers jobs and reads user defaults in a user directory. The platform layer determines its location; the environment variable `MULTIPLANE_HOME` overrides it:

| Platform | Default location |
|---|---|
| Windows | `%USERPROFILE%\.multiplane` (until 0.2.0: `%APPDATA%\multiplane`; see below) |
| macOS | `~/Library/Application Support/multiplane` |
| Linux | `$XDG_CONFIG_HOME/multiplane`, or `~/.config/multiplane` when unset |

On Windows the directory is outside `%APPDATA%` because apps packaged with MSIX (some agent hosts among them) have their writes to `%APPDATA%` redirected to a private copy that other programs cannot see. The first time the renderer uses the new directory, it copies `config.json`, `jobs.jsonl` and `jobs.1.jsonl` from the old location when they are missing from the new one; the old files are left in place. Nothing is copied when `MULTIPLANE_HOME` is set.

**Read and write failures in this directory never affect rendering**: a write failure emits only a `warning` (`home_unavailable`), and the job continues normally.

### 8.1 Job index `jobs.jsonl`

Append-only, one JSON object per line. Each job (`render` / `stills` / `verify`) appends one line at the start and one at the end:

```json
{"schema":"multiplane/1","event":"start","jobId":"…","jobDir":"/abs/out/jobs/…","command":"render","shot":"/abs/shot.html","pid":1234,"ts":"…"}
{"schema":"multiplane/1","event":"end","jobId":"…","jobDir":"/abs/out/jobs/…","state":"succeeded","ts":"…"}
```

- Readers treat the job directory's `status.json` as authoritative; the index is only for discovering jobs. Ignore entries whose job directories have been deleted.
- Write each line with one `append` (a single write call, ending with `\n`), so concurrent appends from multiple processes do not interleave.
- Appending and rotation use `jobs.lock` in the same directory for mutual exclusion. The lock file contains the holder's `pid` and time. If the holder process no longer exists, or the lock has existed for more than 10 seconds (normally held only for milliseconds), treat it as stale, delete it, and retry.
- When the file exceeds 10 MiB, the renderer renames it to `jobs.1.jsonl` (overwriting any existing file) and creates a new file before appending. Readers read both files.
- The environment variable `MULTIPLANE_NO_INDEX=1` disables registration (for tests and cases where discovery is unwanted).

### 8.2 User config `config.json`

```json
{"schema":"multiplane/1","ffmpeg":"D:/tools/ffmpeg/bin/ffmpeg.exe","raster":"gpu","encoder":"x264","workers":null,"jobsDir":null,"hosted":null}
```

- All fields are optional. `null` or omission means use built-in defaults. Ignore unknown fields. Invalid values emit a `warning` (`config_invalid`, `details.field`), and the field is ignored.
- Priority: command-line options > environment variables (`MULTIPLANE_FFMPEG`, `MULTIPLANE_JOBS_DIR`, `MULTIPLANE_HOSTED`) > `config.json` > built-in defaults.
- The `start` event's `options` reflects the merged values. The `doctor` result reports the config file path, whether it exists, and which fields take effect.
- Rendering jobs only read this file and never write it. It is written by the `config` command (section 9.1), which the desktop app also uses, or by hand.

### 8.3 Preview frame `preview.png`

While `render` runs, it maintains `preview.png` in the job directory, a thumbnail of the latest completed frame. Its longest edge is at most 480 pixels, it is updated at most once every 2 seconds, and writes are atomic. `status.json` gains `previewFrame` (the thumbnail's frame number, or `null` when unavailable). The preview is only a side output. It must not change any pixel in the finished video or noticeably slow rendering (measure and report the overhead).

### 8.4 Bundled skill

The npm package includes `skills/multiplane/`. Install it into an agent's skill directory with `multiplane skill install` (section 9.2); the desktop app uses the same command. The skill version follows the package version.

## 9. Setup commands

`config` and `skill` let an agent set up a machine without the desktop app. They are not jobs: they create no job directory and no job index entry. With `--json` they emit a `start` and a `result` event, like `doctor`.

### 9.1 `multiplane config`

| Command | Effect |
|---|---|
| `multiplane config get [<key>]` | Read the user config. `data`: `{ file, exists, values: { ffmpeg, raster, encoder, workers, jobsDir }, overrides: { ffmpeg, jobsDir } }`. `values` holds what the file says (`null` when absent); `overrides` holds environment variables that currently take priority (`null` when unset). With `<key>`, `values` contains that key only. |
| `multiplane config set <key> <value>` | Validate, then write (temporary file, then rename). `data` as for `get`, plus `changed: <key>`. |
| `multiplane config unset <key>` | Set the key to `null`. |

- Keys and values: `ffmpeg` (path), `jobsDir` (path), `raster` (`gpu` or `software`), `encoder` (`x264`, `nvenc-h264` or `nvenc-hevc`), `workers` (positive integer; `auto` is the same as `unset`), `hosted` (`true` or `false`; see section 11). An unknown key or invalid value fails with `invalid_option` and leaves the file unchanged. Relative paths are resolved against the current directory before writing.
- Unknown fields already in the file are kept. If the file is not a JSON object, `get` and `set` fail with `config_invalid` (exit code 3) and do not overwrite it. `unset` returns the same `data` as `set`, including `changed`.
- `config set ffmpeg <path>` writes the path and then probes it. `data.check` is `{ usable, version, encoders: { libx264, "libvpx-vp9", prores_ks }, reason }`. `usable` requires that the file reports an FFmpeg version and has `libx264`; the other two encoders are optional. `reason` is `null` when usable, otherwise `not-found`, `cannot-run`, `not-ffmpeg` or `missing-libx264`. An unusable path is still written and the command still succeeds; it adds a `warning` with code `ffmpeg_unusable`.

### 9.2 `multiplane skill`

| Command | Effect |
|---|---|
| `multiplane skill status [--host <h>]` | `data.hosts`: one entry per host, `{ host, target, detected, state, version, availableVersion, signature, blocked, error }`. `state` is `missing`, `latest`, `update`, `modified` or `error`. `--host` defaults to `all`. |
| `multiplane skill install --host <h> [--force] [--expect <signature>]` | Install the bundled skill, or update to it. |
| `multiplane skill remove --host <h> [--force] [--expect <signature>]` | Remove it. |

- `<h>` is `claude`, `codex` or `all`. `install` and `remove` require `--host`.
- Target directories: `<home>/.claude/skills/multiplane` for Claude Code and `<home>/.agents/skills/multiplane` for Codex. The environment variable `MULTIPLANE_AGENT_HOME` replaces `<home>`, for tests and non-standard setups.
- Each installed copy carries a record file, `.multiplane.json`, with the version and content hashes. A copy whose content matches no released version is `modified`.
- A modified skill is never replaced silently. Without `--force`, `install` and `remove` fail with `skill_modified`. With `--force`, the existing directory is first renamed to a sibling `multiplane.bak-<yyyyMMdd-HHmmss>` and the result reports its path in `backup`.
- A target that is a symbolic link or contains unsupported file types is `blocked`; the command fails with `skill_blocked`, with or without `--force`.
- `--expect <signature>` makes the command fail with `skill_changed` if the installed copy no longer has the signature returned by an earlier `status`. A missing copy has the signature `null`; pass `--expect null` to require that it is still missing. Without `--expect`, nothing is checked.
- `--host all` handles each host independently. `data.hosts` has one entry per host, `{ host, action, ok, code, message, target, version, backup }`. If any host fails, the overall result has `ok: false` and the code of the first failure.

## 10. Inspecting and serving shots

### 10.1 `multiplane inspect <shot>`

Loads the shot the same way a render does (lint first unless `--no-lint`, waits for fonts and `setup`) but captures nothing and creates no job. Options: `--root`, `--fps`, `--no-lint`, `--json`.

`result.data` is `{ shot, duration, fps, frames, stage: { width, height }, cuts, post, hasBlurAt, meta }`. `fps` and `frames` follow the same rules as `render`, so they are what a render with the same options would produce. `duration` is the value after `setup`, which may change it. `hasBlurAt` tells whether the shot defines a `blurAt(t)` function. `meta` is whatever the shot passed as `Shot.define({ meta })`, or `null`.

`meta` is free-form data for tools that read shots, such as a list of beats or captions. It must be JSON-serializable and at most 1 MiB, or loading fails with `shot_contract_invalid`. It is available inside the page as `SHOT.meta` and never affects pixels.

### 10.2 `multiplane serve`

Keeps the static server that renders use running, for opening shots in a browser while writing them. It serves the same resource root with the same rules: paths outside the root are refused, and `/multiplane/` is reserved for the runtime libraries.

- `--root <dir>` (default: the current directory), `--port <n>` (default 0: the system picks a free port), `--json`.
- It listens on 127.0.0.1 only.
- With `--json`: a `start` event, then `listening` with `{ url, root, port }` once it accepts connections. Without `--json`, the URL is printed on stdout. On Ctrl+C or a termination signal it closes, emits `result` and exits with 0.
- A port that is already taken fails with `port_in_use` (exit code 3).
- `GET /multiplane/shots.json` returns the relative paths of all `.html` files under the root as a sorted JSON array, skipping hidden directories, `node_modules` and `out`. The server used during renders answers it too.
- There is no player, live reload or file watching.

## 11. Hosted rendering

A render started by an agent is normally a child process of the agent's session and stops when the session ends. When hosting is on, the desktop app starts the render instead, detached from the session. The agent runs the same command and sees the same output.

### 11.1 When a command is hosted

All of these must hold; otherwise the command renders by itself as before:

1. The command is `render`, `stills` or `verify`.
2. `config.json` has `hosted: true` (`multiplane config set hosted true`). The default is off.
3. `--no-hosted` is not given and `MULTIPLANE_HOSTED` is not `0`.
4. `<user directory>/app.json` says the app is running and accepts hosted jobs: `{ schema, pid, createdAt, acceptsHosted: true, version }`. `createdAt` is the operating system's creation time of process `pid` as a UTC ISO string; the renderer checks that the process exists and that the time matches. The app writes this file at startup and removes it, or sets `acceptsHosted: false`, when it exits.

### 11.2 Request and claim

Three parties take part: the **waiter** (the command the agent ran), the **app**, and the **executor** (the render process the app starts). Files live in `<user directory>/hosted/`, named after the job ID.

1. The waiter does the usual preparation first: parse options, read config, lint (a lint failure fails the command and nothing is handed over), create the job ID and job directory. Then it writes `<jobId>.request.json` (temporary file, then rename): `{ schema, jobId, jobDir, command, args, cwd, node, bin, env, at }`. `args` are the shot path and options as given, without the command and `--json`. `node` and `bin` are the waiter's own Node executable and `multiplane` entry, so the job runs with the same renderer the agent called. `env` keeps only what a render needs (`PATH`, `MULTIPLANE_*`, proxy variables without credentials, temporary and home directories, locale); variables whose names suggest secrets are never written.
2. The app checks the request and claims it by renaming `request` to `claimed`. If the checks fail, it renames it to `rejected` and adds a `reason`. The checks: the package that contains `bin` is named `multiplane`; `node` is an existing absolute path named `node` or `node.exe`; `jobDir` exists and matches `jobId`.
3. Claimed jobs wait in the app's queue and run **one at a time**, in claim order. While waiting, the job's `status.json` has `state: "queued"` and `queuePosition`.
4. When its turn comes, the app starts the executor detached from itself, so closing the app does not stop it. The executor renames `claimed` to `running` before it does anything else; if the rename fails, it exits with 0 without writing anything. It uses the job ID and job directory the waiter created.

### 11.3 Fallback

- If the request is not claimed within 5 seconds, the waiter renames it to `withdrawn` and, if that succeeds, renders by itself.
- On `rejected`, the waiter renders by itself at once.
- If the job was claimed but has neither started nor been queued 15 seconds later, the waiter renames `claimed` to `withdrawn` and, if that succeeds, renders by itself.
- The rename decides who owns the job, so the waiter and a late executor can never both run it. When the waiter renders by itself it says why on stderr.

### 11.4 What the waiter prints

- On a successful hand-over, one human-readable line on stderr: the job was handed to Multiplane and closing the session will not interrupt it, with the queue position when queued.
- stdout carries only the events the executor writes to `events.jsonl`, **byte for byte**, with or without `--json`. Nothing is printed while the job waits in the queue.
- After the `result` event the waiter exits with the job's exit code. Killing the waiter does not affect the job.

### 11.5 `multiplane wait <jobId|jobDir>`

Waits for any job, hosted or not, to finish. Options: `--json`, `--timeout <seconds>`, `--job-dir <directory>` (resolved as for `status`).

- With `--json`, it first prints what `events.jsonl` already holds, byte for byte, then follows it until `result`, and exits with the job's exit code. A job that has already finished is printed at once. Without `--json`, it prints the usual human-readable output.
- A queued job is waited for like any other.
- When `--timeout` expires first, it fails with `wait_timeout` (exit code 3); the job is not affected.
- An agent whose session was restarted runs `wait` for jobs it started earlier but has not seen finish.

### 11.6 Stopping

- A running hosted job stops as any other: a `stop` file in the job directory, or `multiplane cancel`.
- A queued job: the app sees the `stop` file, removes the job from the queue, and writes `cancelled` to `status.json`, with `result.code` `cancelled`.

## 12. Static frame reuse

Frames where nothing changes are not captured again: the renderer reuses the previous frame's pixels. It is on by default for `render` and `stills` and off by default for `verify`, whose checks always capture. `--no-static-reuse` turns it off; `--static-reuse` turns it on for `verify`, which then also compares the whole shot with reuse on and off. Output is identical either way.

- **How a frame is judged static.** Before the shot's scripts run, the renderer starts observing the page: DOM changes, attribute and text changes, style and stylesheet changes, canvas and WebGL drawing calls, and load, scroll, resize, focus and font events. If nothing was observed between two consecutive frames, the second frame reuses the first. With motion blur, every sample time in the shutter window must be static as well. Frames next to a cut, the first frame of each worker, and frames requested out of order are always captured.
- **When reuse is never used.** Content whose changes cannot be observed: `video`, `iframe`, `object`, `embed`, `marquee`, shadow DOM created by the shot, running CSS or Web Animations, animated images, worklets, canvases transferred to other threads, unreadable stylesheets, `@import`, external CSS `url(...)` and `paint(...)`. Static images, SVG, form controls and paused animations do not prevent reuse.
- **Checks.** At the first reused frame of each run of static frames, at every reused frame whose number is a multiple of 16, and at the end of each run, the renderer captures the frame for real and compares all four channels with the reused copy. Frames are handed to the encoder only after the next check passes. On a mismatch, reuse is turned off for the rest of the job, the frames since the last passed check are captured again, and a `static_reuse_disabled` warning is emitted once. Check frames are chosen by fixed rules, never by chance or wall-clock time.
- **Result.** `result.data.staticReuse` is `{ enabled, reusedFrames, verifiedFrames, disabledReason }`: whether reuse was on at the end, frames reused, frames checked, and `null` or `"pixel_mismatch"`. A count of 0 is not an error; it means no frame could be reused safely. `observationReasons` explains why frames were not reused: an object whose keys are reasons (`mutation`, `drawing_or_setter`, `unobservable_api`, `hook_replaced`, `dynamic_element`, `editable_focus`, `animation_or_font`, `image`, `external_style`, `stylesheet`) and whose values count how often each was the deciding reason across all workers, including blur sub-samples and checks; only non-zero reasons are listed. It is a diagnostic, not a frame count, and may differ between runs.

## 13. `multiplane benchmark`

Measures rendering speed at several worker counts on this machine, so renders can pick a good count without `--workers`. Options: `--json`, `--raster gpu|software`, `--max-workers <n>`. It creates no job and no job index entry; with `--json` it emits `start`, `progress` and `result`.

- It renders three built-in shots at 1920×1080 without encoding or post-processing: an ordinary DOM page (`dom`), a Canvas 2D shot (`canvas`) and a WebGL shot (`three`). For each, it measures throughput in frames per second at 1, 2, 4, 6, 8, 12, 16 and 24 workers, skipping counts above the number of logical CPUs, the memory limit or `--max-workers`. Each count is measured twice in the same warmed-up browser pool and averaged. The recommended count is the smallest whose throughput is within 95% of the highest. The whole run is kept within about three minutes by using fewer frames per count; no count is skipped. If free memory runs out before the largest count, the measurement of that kind stops there: the recommendation is chosen from the counts already measured, the entry gets `limitedBy: "memory"`, `stoppedWorkers` (the first count not measured) and `detail`, and later kinds do not try larger counts. Each kind must measure at least 1 and 2 workers; otherwise the run fails and the previous file is kept.
- The result is written atomically to `benchmark.json` in the user directory (section 8): `{ schema, testedAt, machine, shots }`. `machine` holds the CPU models, logical CPU count, total memory, GPU, operating system, Chromium version, Multiplane version and raster mode; `shots.dom`, `shots.canvas` and `shots.three` are each `{ workers, fps, points: [{ workers, fps }] }`. An interrupted or failed run keeps the previous file. `result.data` has the same content.
- **How renders use it.** When neither `--workers` nor `config.json` sets the count, and `benchmark.json` exists and its `machine` matches the current one, `render` uses the recommended count for the shot's kind (WebGL or the 3D layer: `three`; Canvas: `canvas`; otherwise `dom`), still limited by free memory. Otherwise the count is estimated from CPU cores, free memory and output size. `start.workersSource` and `result.data.resources.workersSource` report the source: `option`, `config`, `benchmark` or `estimate`. `start.options.workers` is the chosen count; `resources.workers` is the count actually used, which can be lower for short ranges.
- `doctor` adds a non-blocking `benchmark` check that reports a missing or outdated measurement.

## 14. GPU rasterization jitter

With GPU rasterization (the default), the same frame captured after a page reload or in another browser process can differ in a few scattered pixels by a level or two, for example along antialiased text. The renderer does not cause it and a viewer cannot see it. Software rasterization does not have it.

- Comparisons in `verify` and in the checks of static frame reuse (section 12) split the per-channel absolute difference into 8×8-pixel blocks and take each block's mean. With GPU rasterization, a difference whose largest block mean is at most 0.3 levels and whose largest single-channel difference is at most 32 levels counts as **jitter**; anything larger is a real difference. With software rasterization, any difference is a real difference.
- The threshold sits between the largest jitter measured on real shots (0.109) and the weakest real change tested (a gradient start moved by one pixel, 0.875; a 0.25-pixel shift of an object is about 20), and well below the error of the default MP4 encoding (block-mean median 1–2).
- **`verify`**: jitter does not fail the check. The check stays `passed: true` with `jitter: true`, `result.ok` stays `true`, and a `finding` with `severity: "warning"`, `code: "gpu_raster_jitter"` and `details: { check, maxBlockMeanDiff, maxChannelDiff, changedPixels }` is emitted (`location` is `{ t, frame }`; no diff image is written). Real differences fail as before with `nondeterministic_output`.
- **Static frame reuse**: jitter at a check does not turn reuse off; the actually captured frame is delivered and counted in `verifiedFrames`.
