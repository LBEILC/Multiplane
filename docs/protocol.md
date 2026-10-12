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
| `command` | `render` / `stills` / `verify` / `lint` / `doctor` / `status` / `cancel`. |
| `ts` | ISO 8601 UTC timestamp. |

(`lint` does not create a job directory; its events have no `jobId`.)

| `type` | When | Additional fields |
|---|---|---|
| `start` | First line after successful argument parsing (with `--draft`, or when the shot may declare a default for `alpha`, it is sent after a pre-check that loads the shot without calling `render(t)`, so that `options` carries the final values; it is still the first event) | `version` (package version), `shot` (absolute path, or `null` for commands without a shot), `jobId` (when there is a job), `options` (effective options known before loading the shot, including renderer defaults; see the `shot` event for the shot's own `fps`, `post`, and other declarations, and `result.data` for the final effective values) |
| `environment` | Once after browser launch | `node`, `platform`, `chromium`, `gpu` (`{renderer, hardware}`), `ffmpeg` (`{path, version}`, or `null` when not needed) |
| `shot` | Once after loading the shot | `width`, `height`, `duration`, `fps`, `cuts`, `post` (default post-processing options declared by the shot) |
| `progress` | On progress changes, at most one line per 250 ms | `phase` (`launch` / `load` / `capture` / `encode` / `compare` / `finalize`), `done`, `total`, `unit` (such as `"frame"`), `fps` (measured speed, may be `null`), `etaMs` (may be `null`) |
| `warning` | Nonfatal problem | `code`, `message`, optionally `details` |
| `finding` | Problem found by a check command (`verify` mismatches, `lint` problems) | See section 4 |
| `artifact` | After each artifact file is fully written | `path` (absolute path), `kind` (`video` / `still` / `contact-sheet` / `report` / `diff-image`), `bytes` |
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

- `render`: `{ output, frames, fps, from, to, width, height, encoder, post: {motionBlur, shutter, adaptiveBlur, grain}, renderScale, scale, draft, format, alpha, outputCheck, resources }`. `format` is `mp4`, `webm` or `mov`; `alpha` is `true` when the transparent path was used. `draft` is `true` when `--draft` was given (a preset for fast previews: a render scale of at most 0.5, no motion blur, no grain; explicit options win over the preset, and the preset wins over user config and shot defaults; the output size, fps, encoder and workers are not changed; if no valid scale of at most 0.5 exists for the stage size, the command fails with `invalid_scale`). `outputCheck` is what was read back from the encoded file before it was published: `{ verified, frames, durationSeconds, width, height, fps, codec, pixelFormat, audioDurationSeconds }` (`audioDurationSeconds` only when the output has an audio track); `verified` is `false` when the file could not be probed (see `output_unverified`). `pixelFormat` is the format reported when decoding the file, which can differ from the encoder input. The check requires the exact frame count, a duration within one frame, the exact width and height, and a frame rate within a relative 1e-4 of the requested one (containers such as WebM store timestamps with limited precision, so 59.94 may read back as 59.940063). Frame rates are passed to the encoder as exact fractions, for example 29.97 as 30000/1001. For transparent output, the renderer also decodes the first and middle frames (VP9 through `libvpx-vp9`, since the default VP9 decoder drops alpha) and compares their alpha with the source frames; a difference larger than 2/255 in any pixel, or missing alpha, ends with `output_invalid` (transparent output is never published unverified). `resources` is `{ peakMemoryBytes, memorySamples, workers, cpuCount }` for the whole process tree (renderer, browser processes, workers, encoder); a value that could not be measured is `null`. `peakMemoryBytes` is the largest of the periodic samples, not an exact operating-system peak; `memorySamples` counts successful samples; `workers` is the largest number actually in use. `stills` and `verify` results carry `resources` too.
- `stills`: `{ stills: [{t, frame, path}], contactSheet, draft, format, alpha }`. `draft` as for `render`; `format` is always `png`; with `alpha`, the stills keep transparency and the contact sheet is composited over a checkerboard.
- `verify`: `{ passed, times, workers, checks: [{name, passed}] , findings: n, format, alpha }` (`format` is `png`; with `alpha`, all four channels are compared). On a mismatch, `ok: false`, `code: "nondeterministic_output"`; details are in the `finding` events.
- `lint`: `{ files: [...scanned files, relative to the resource root], errors, warnings, suppressed }`. With errors, `ok: false`, `code: "lint_failed"`; with warnings only, `ok: true`. `render` / `stills` / `verify` run lint first by default, with its `finding` events in the same stream. `--no-lint` skips it.
- `doctor`: `{ checks: [{name, ok, detail}] }`, checking the Node version, browser, GPU rasterization, FFmpeg and libx264, and optional three.js.
- `status` / `cancel`: job status snapshot (section 6).

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
| 3 | Environment problem | `ffmpeg_not_found`, `ffmpeg_unusable` (found but cannot run or lacks an encoder), `browser_not_installed`, `browser_launch_failed`, `three_not_installed`, `unsupported_node`, `job_dir_unwritable` (the job directory cannot be created or written, for example when running in a read-only directory; `details.path`; the hint points to `--job-dir` and `MULTIPLANE_JOBS_DIR`) |
| 4 | Renderer internal error | `output_invalid` (the encoded file does not match what was rendered: frame count, duration, size or frame rate; `details.expected` and `details.actual`; the file is not published), `worker_crashed`, `browser_crashed` (the browser process or page closed unexpectedly and restarting it did not help; `details.t` when known), `encode_failed`, `internal_error` |
| 130 | Cancelled | `cancelled` |

Warning codes (only in `warning` events; do not affect the exit code): `browser_restarted` (the browser process or page closed unexpectedly; it was relaunched and the affected frame rendered again, which cannot change pixels because `render(t)` depends only on `t`; `details.attempt`), `output_unverified` (the encoded file could not be probed, so it was published without the check; `details.reason`), `gpu_software_fallback` (GPU rasterization was requested but a software renderer is used), `home_unavailable` (user directory read or write failure; see section 8), `config_invalid` (an invalid user config field was ignored; `details.field` is `"$"` when the entire file is corrupt or the top level is not an object), `preview_failed` (preview frame write failure, reported only once per job; preview updates stop, rendering continues).

Lint rule codes (`finding.code`): `wall_clock`, `unseeded_random`, `css_animation`, `web_animations`, `media_playback`, `remote_resource`, `resource_missing`, `stage_missing`, `shot_missing`, `runtime_missing`, and `async_render` are errors; `timer_driven`, `animated_image`, `stage_size_unfixed`, `font_not_awaited`, `lint_directive_invalid`, and `lint_incomplete` (a source section could not be parsed and was skipped, leaving scan coverage incomplete) are warnings. Lint's `location` is `{file, line, column}` (relative to the resource root, 1-based), and `details.snippet` is the source line. Add a comment `multiplane-disable-next-line <rule-code>` on the preceding line to suppress a finding.

## 6. Rendering jobs

Each run of `render`, `stills`, or `verify` is a job.

- `jobId`: `<UTC time yyyyMMdd-HHmmss>-<shot filename>-<4 random hexadecimal digits>`, ensuring concurrent runs do not collide.
- Job directory: defaults to `<cwd>/out/jobs/<jobId>/`; change the parent directory with `--job-dir <dir>` or the environment variable `MULTIPLANE_JOBS_DIR`.
- Artifact locations: without `--out`, artifacts are written in the job directory (video `<jobDir>/<shot-name>.mp4`, stills `<jobDir>/stills/`, check reports and diff images `<jobDir>/verify/`), so runs do not overwrite each other. With `--out`, an existing target causes `output_exists` unless `--overwrite` is given. Replacement writes fully to a temporary location first, then replaces the target (directory artifacts are replaced in full). On failure, the original artifact stays untouched.
- Directory contents:
  - `events.jsonl`: **exactly the same** event stream as stdout with `--json` (written whether or not `--json` is enabled).
  - `status.json`: the latest snapshot, written atomically (write a temporary file, then rename): `{schema, jobId, command, shot, pid, state, phase, done, total, fps, etaMs, previewFrame, memoryBytes, startedAt, updatedAt, result}`. `state` is `running` / `succeeded` / `failed` / `cancelled`. At completion, `result` equals the contents of the `result` event; while running, it is `null`.
  - Stop request: create a `stop` file in the directory. The renderer detects it, cleans up, and ends with `cancelled`.
- `multiplane status <jobId|jobDir> [--json]`: read `status.json`. If the process is gone but `state` is still `running`, report `failed` / `internal_error` (without changing the file). The `ok` value of `status` itself only means the snapshot was read. Check `data.state` and `data.result` for the original job's outcome.
- `multiplane cancel <jobId|jobDir> [--json]`: create the `stop` file, wait for the job to finish (`--wait` seconds, default 30), and output the final status. If the job has already ended, return its original terminal state directly. If it is still running when the wait expires, return `cancel_timeout`.
- `--help` (global or `multiplane <command> --help`) and `--version` output only human-readable text and produce no events.
- Job directories are not cleaned up automatically. The desktop app and other readers depend on these files.

## 7. JS API

- `renderShot` / `stillsShot` / `verifyShot` / `lintShot` / `doctor` return an object with the same structure as the `result` event (without `schema`, `type`, or `ts`).
- On failure, throw `MultiplaneError` (extends `Error`), with `code`, `exitCode`, `hint`, `details`, and `result`.
- The optional `onEvent(event)` callback receives the same event objects as NDJSON. The `print` callback is no longer used.

## 8. User directory (for the desktop app and other readers)

The renderer registers jobs and reads user defaults in a user directory. The platform layer determines its location; the environment variable `MULTIPLANE_HOME` overrides it:

| Platform | Default location |
|---|---|
| Windows | `%APPDATA%\multiplane` |
| macOS | `~/Library/Application Support/multiplane` |
| Linux | `$XDG_CONFIG_HOME/multiplane`, or `~/.config/multiplane` when unset |

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
{"schema":"multiplane/1","ffmpeg":"D:/tools/ffmpeg/bin/ffmpeg.exe","raster":"gpu","encoder":"x264","workers":null,"jobsDir":null}
```

- All fields are optional. `null` or omission means use built-in defaults. Ignore unknown fields. Invalid values emit a `warning` (`config_invalid`, `details.field`), and the field is ignored.
- Priority: command-line options > environment variables (`MULTIPLANE_FFMPEG`, `MULTIPLANE_JOBS_DIR`) > `config.json` > built-in defaults.
- The `start` event's `options` reflects the merged values. The `doctor` result reports the config file path, whether it exists, and which fields take effect.
- The renderer only reads this file and never writes it. The user or desktop app writes it (write a temporary file, then rename).

### 8.3 Preview frame `preview.png`

While `render` runs, it maintains `preview.png` in the job directory, a thumbnail of the latest completed frame. Its longest edge is at most 480 pixels, it is updated at most once every 2 seconds, and writes are atomic. `status.json` gains `previewFrame` (the thumbnail's frame number, or `null` when unavailable). The preview is only a side output. It must not change any pixel in the finished video or noticeably slow rendering (measure and report the overhead).

### 8.4 Bundled skill

The npm package includes `skills/multiplane/`. The installer (the desktop app `app/` or the user) copies this directory into each agent's skill directory. The skill version follows the package version.
