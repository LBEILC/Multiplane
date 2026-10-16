export const note = version => ({ schema: 'multiplane-release-notes/1', version, date: '2026-10-16', items: [
  { kind: 'new', area: 'renderer', highlight: true, icon: 'restart', title: { 'zh-CN': '断点续传', en: 'Resume rendering' }, detail: { 'zh-CN': '渲染中断后，从中断处接着渲。', en: 'After an interruption, continue rendering from where it stopped.' } },
  { kind: 'new', area: 'app', highlight: true, icon: 'film', title: { 'zh-CN': '逐帧查看成片', en: 'Frame-by-frame review' }, detail: { 'zh-CN': '逐帧查看完成的视频，切点标在进度条上。', en: 'Step through finished videos with cuts marked on the timeline.' } },
  { kind: 'improved', area: 'app', title: { 'zh-CN': '打开更快', en: 'Faster start' }, detail: { 'zh-CN': '先显示窗口，作业读完就出现。', en: 'The window shows at once and jobs appear as soon as they are read.' } },
  { kind: 'fixed', area: 'app', title: { 'zh-CN': '项目名显示成“.”', en: 'Project shown as "."' }, detail: { 'zh-CN': '相对路径现在显示实际的文件夹名。', en: 'Relative project roots now show the actual folder name.' } }
] });
export const release = (version, asset = true) => ({ tag_name: `v${version}`, html_url: `https://github.com/LBEILC/Multiplane/releases/tag/v${version}`, assets: asset ? [{ name: 'release-notes.json', browser_download_url: `https://github.com/LBEILC/Multiplane/releases/download/v${version}/release-notes.json` }] : [], body: '<img src=x onerror=alert(1)>Release body must not be displayed' });
export function notesFetcher(releases, documents = {}) {
  return async url => {
    if (url.endsWith('/latest')) return { ok: true, json: async () => releases[0] };
    if (url.includes('?per_page=')) return { ok: true, json: async () => releases };
    const version = /\/download\/v([^/]+)\//.exec(url)?.[1];
    if (!version) throw Error(`Unexpected request: ${url}`);
    return { ok: true, json: async () => documents[version] ?? note(version) };
  };
}
