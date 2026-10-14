import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

export function assertSkillIsolation(args, options = {}) {
  if (!Array.isArray(args) || !args.includes('skill')) return;
  const env = options.env ?? process.env;
  if (!env.MULTIPLANE_HOME || !env.MULTIPLANE_AGENT_HOME) throw Error('Skill command tests require MULTIPLANE_HOME and MULTIPLANE_AGENT_HOME');
}
// Patch the builtin once, so direct calls, aliases and helpers share the guard.
let guarded = false;
export function guardSkillProcesses() {
  if (guarded) return;
  guarded = true;
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const original = childProcess[name];
    childProcess[name] = function(file, args, options, ...rest) {
      assertSkillIsolation(args, options);
      return Reflect.apply(original, this, [file, args, options, ...rest]);
    };
  }
  syncBuiltinESMExports();
}
