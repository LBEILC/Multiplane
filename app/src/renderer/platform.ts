let platform = '', home = '';
export async function initPlatform() {
  ({ platform, home } = await window.multiplane.platform());
  document.documentElement.dataset.platform = platform;
}
export const revealLabel = () => platform === 'darwin' ? '在访达中显示' : '在文件夹中显示';
export function displayPath(value: string) {
  if (platform === 'win32') return value.replaceAll('/', '\\');
  return home && (value === home || value.startsWith(home + '/')) ? '~' + value.slice(home.length) : value;
}
