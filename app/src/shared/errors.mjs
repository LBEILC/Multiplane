import { t } from './i18n.mjs';
import zh from './copy/zh-CN.mjs';
import en from './copy/en.mjs';
export function userError(error) {
  let message = String(error?.message ?? error ?? '');
  for (;;) {
    const clean = message.replace(/^(?:Error:\s*|Error invoking remote method '[^']+':\s*)/, '');
    if (clean === message) break;
    message = clean;
  }
  message = message.split('\n')[0].slice(0, 500);
  const code = error?.code ?? message.match(/\b(?:EACCES|EPERM|ENOENT|ENOTDIR|EEXIST|[a-z]+_[a-z_]+)\b/)?.[0];
  const explanations = { EACCES: t('accessDenied'), EPERM: t('operationDenied'), ENOENT: t('fileMissing'), ENOTDIR: t('notDirectory'), EEXIST: t('targetExists'), browser_not_installed: t('browserMissing'), browser_launch_failed: t('browserLaunchFailed'), internal_error: t('retryError') };
  if (code && explanations[code]) return t('errorCode', { message: explanations[code], code });
  for (const key of ['wrapperVersionError', 'linkedSkill', 'unsupportedFile', 'skillChanged', 'skillPathChanged', 'checkError', 'retryError']) {
    if (message === zh[key] || message === en[key]) return t(key);
  }
  if (/[\u3400-\u9fff]/.test(message)) return message.split('\n')[0].slice(0, 500);
  return code ? t('errorCode', { message: t('checkError'), code }) : t('checkError');
}
