const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const [mode, record] = process.argv.slice(2);
process.on('SIGTERM', () => {});
if (mode === 'parent') {
  console.log(`parent=${process.pid}`);
  spawn(process.execPath, [__filename, 'child', record], { stdio: 'inherit' });
} else if (mode === 'child') {
  spawn(process.execPath, [__filename, 'grandchild', record], { stdio: 'inherit' });
} else {
  writeFileSync(record, JSON.stringify({ child: process.ppid, grandchild: process.pid }));
  console.log('tree ready');
}
setInterval(() => {}, 1000);
