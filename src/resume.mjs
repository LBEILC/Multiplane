import { renderShot } from './render.mjs';
import { readStatus, resolveJob } from './jobs.mjs';
import { readManifest, segmentDirectory, unavailable, checkInputs } from './segments.mjs';
import { invalidOption } from './errors.mjs';
import { loadUserConfig } from './user-home.mjs';

export async function resumeRender(target, options = {}) {
  const allowed = ['workers', 'json', 'job-dir', 'no-hosted', 'onEvent', '_hostedCLI', '_segmentHook', '_inspectFFmpeg', '_probeVideo', 'hosted-executor', 'job-dir-exact'];
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw invalidOption('--' + key, 'This option cannot be changed when resuming.');
  const configured = loadUserConfig('status', options);
  const jobDir = resolveJob(target, configured.options);
  const status = await readStatus(jobDir);
  if (status.command !== 'render') throw unavailable('not_render');
  if (status.state === 'succeeded') throw unavailable('succeeded');
  if (!['failed', 'cancelled'].includes(status.state)) throw unavailable('running');
  const directory = segmentDirectory(jobDir), manifest = readManifest(directory);
  if (!manifest) throw unavailable('missing_manifest');
  await checkInputs(manifest);
  return renderShot(manifest.shot, { ...manifest.options, ...options,
    _resume: { directory, jobId: status.jobId }, _effectiveOptions: true,
    // Only hosting policy and job lookup use current configuration.
    hosted: loadUserConfig('render', {}).options.hosted, 'no-hosted': options['no-hosted'] ?? false });
}
