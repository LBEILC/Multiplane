export const errorCodes = Object.freeze(Object.fromEntries([
  [1, 'shot_not_found', 'Shot file was not found.'],
  [1, 'shot_outside_root', 'Shot must be inside the project root.'],
  [1, 'shot_load_failed', 'Shot failed to load.'],
  [1, 'shot_contract_invalid', 'Shot contract is invalid.'],
  [1, 'stage_size_invalid', 'Stage must have fixed positive integer dimensions.'],
  [1, 'ready_timeout', 'Shot readiness timed out.'],
  [1, 'render_threw', 'Shot render function threw an error.'],
  [1, 'resource_failed', 'A shot resource failed to load.'],
  [1, 'nondeterministic_output', 'Determinism verification failed.'],
  [1, 'lint_failed', 'Shot lint checks failed.'],
  [1, 'cancel_timeout', 'Timed out waiting for job cancellation.'],
  [2, 'job_not_found', 'Job status was not found or is invalid.'],
  [3, 'unsupported_node', 'Node 24 or newer is required.'],
  [2, 'invalid_option', 'Invalid option.'],
  [2, 'invalid_scale', 'Scale must produce positive even integer dimensions.'],
  [2, 'output_exists', 'Output already exists.'],
  [3, 'ffmpeg_not_found', 'FFmpeg was not found.'],
  [3, 'ffmpeg_unusable', 'FFmpeg cannot run or lacks the requested encoder.'],
  [3, 'browser_not_installed', 'Chromium is not installed.'],
  [3, 'browser_launch_failed', 'Chromium failed to launch.'],
  [3, 'three_not_installed', 'Optional three.js is not installed.'],
  [3, 'job_dir_unwritable', 'Job directory cannot be created or written.'],
  [4, 'browser_crashed', 'Browser closed unexpectedly and recovery failed.'],
  [4, 'worker_crashed', 'A rendering worker exited unexpectedly.'],
  [4, 'encode_failed', 'Video encoding failed.'],
  [4, 'internal_error', 'An internal error occurred.'],
  [130, 'cancelled', 'Job was cancelled.'],
].map(([exitCode, code, message]) => [code, { exitCode, message }])));

export class MultiplaneError extends Error {
  constructor(code, message = errorCodes[code]?.message, { hint, details, result, cause } = {}) {
    super(message, { cause });
    this.name = 'MultiplaneError';
    this.code = code;
    this.exitCode = errorCodes[code]?.exitCode ?? 4;
    this.hint = hint;
    this.details = details;
    this.result = result;
  }
}
export const asError = error => error instanceof MultiplaneError ? error
  : new MultiplaneError('internal_error', undefined, { cause: error, details: { reason: error.message } });
export const invalidOption = (option, message) => new MultiplaneError('invalid_option', message, { details: { option } });
