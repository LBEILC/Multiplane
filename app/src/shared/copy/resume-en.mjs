export default {

  resumeBtn: 'Resume', resumeShort: 'Resume', resumeDone: '{a} of {b} frames are done; rendering can continue from there.', resumeStarting: 'Starting…',
  resumedTag: 'Resumed', resumedBy: 'Continued in a new job', view: 'View', resumedFrom: 'Continued from', resumedFromD: '{s} segments · {f} frames reused',
  rr_inputs_changed: 'Files used by the shot have changed', rr_inputs_changedH: 'These files differ from before the interruption. Render again to use the current files.',
  rr_environment_changed: 'The rendering environment has changed', rr_environment_changedH: 'Different from before: {list}. Render again instead.',
  rr_running: 'This job is already being resumed', rr_runningH: 'The original job is still running, or another resume is in progress.',
  rr_missing_manifest: 'This job has no segment record', rr_missing_manifestH: 'It was rendered by a version without resume, or failed before capturing began. Render again instead.',
  rr_succeeded: 'This job has finished', rr_succeededH: 'There is nothing left to render.',
  rr_not_render: 'Only render jobs can be resumed', rr_not_renderH: 'Stills and verify jobs cannot be resumed.',
  env_multiplane: 'Multiplane version', env_chromium: 'Chromium version', env_raster: 'rasterization', env_ffmpeg: 'FFmpeg version', env_encoder: 'encoder',
  copyRerender: 'Copy command to render again',
  w_resume_renderer_changed: 'The GPU or driver differs from before', w_resume_renderer_changedH: 'The resumed part may differ by imperceptible amounts.',
};
