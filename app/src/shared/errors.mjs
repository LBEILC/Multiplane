export function userError(error) {
  let message = String(error?.message ?? error ?? '');
  for (;;) {
    const clean = message.replace(/^(?:Error:\s*|Error invoking remote method '[^']+':\s*)/, '');
    if (clean === message) break;
    message = clean;
  }
  const code = error?.code ?? message.match(/\b(?:EACCES|EPERM|ENOENT|ENOTDIR|EEXIST|[a-z]+_[a-z_]+)\b/)?.[0];
  const explanations = { EACCES: '没有权限访问此位置', EPERM: '没有权限执行此操作', ENOENT: '文件或目录不存在', ENOTDIR: '此位置不是目录', EEXIST: '目标位置已存在', browser_not_installed: '尚未安装浏览器', browser_launch_failed: '浏览器启动失败', internal_error: '操作失败，请重试' };
  if (code && explanations[code]) return `${explanations[code]}（${code}）`;
  if (/[\u3400-\u9fff]/.test(message)) return message.split('\n')[0].slice(0, 500);
  return `操作失败，请重新检查${code ? `（${code}）` : ''}`;
}
