const object = value => value && typeof value === 'object' && !Array.isArray(value);
const artifacts = value => Array.isArray(value) ? value.filter(a => object(a) && typeof a.path === 'string' && typeof a.kind === 'string') : [];

// Normalize only the desktop snapshot; never rewrite renderer-owned files.
export function jobData(value, report = (_error) => {}) {
  if (!object(value) || typeof value.jobId !== 'string' || typeof value.shot !== 'string'
    || typeof value.state !== 'string') {
    report(Error('Invalid job identity, shot or state')); return null;
  }
  const job = { ...value };
  if (!['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(job.state)) job.state = 'running';
  for (const field of ['startedAt', 'updatedAt', 'command']) if (typeof job[field] !== 'string') {
    report(Error(`Job ${job.jobId}: missing or invalid ${field}`)); job[field] = '';
  }
  job.events = (Array.isArray(job.events) ? job.events : []).filter(e => object(e) && typeof e.type === 'string')
    .filter(e => e.type !== 'artifact' || typeof e.path === 'string');
  job.result = object(job.result) ? { ...job.result, artifacts: artifacts(job.result.artifacts) } : null;
  return job;
}
