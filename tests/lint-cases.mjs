export const base = '<div id="stage" style="width:32px;height:32px"></div>\n<script src="/multiplane/runtime/shot.js"></script>\n<script>Shot.define({duration:1,render(){}})</script>\n';
const js = text => base + '<script>\n' + text + '\n</script>';
const css = text => base + '<style>\n' + text + '\n</style>';
export const cases = [
  ['wall_clock', js('Date.now();'), js("new Date(0); new Date('2020-01-01'); // Date.now()\nconst text='performance.now()';"), 'Date.now()', 5, 1],
  ['unseeded_random', js('Math.random();'), js('function random(){return 1} random(); const x={random:1};'), 'Math.random()', 5, 1],
  ['css_animation', css('@keyframes spin {to{opacity:0}}'), css('#stage{animation:none;transition:none} p{transition:0s}'), '@keyframes', 5, 1],
  ['web_animations', js('element.animate([]);'), js('function animate(){}'), 'element.animate', 5, 1],
  ['timer_driven', js('setTimeout(()=>{},0);'), js('const text="setTimeout";'), 'setTimeout', 5, 1],
  ['media_playback', base + '<video></video>', base + '<div>video and audio</div>', '<video>', 4, 1],
  ['animated_image', base + '<img src="image.gif">', base + '<img src="image.png">', 'src=', 4, 6],
  ['remote_resource', base + '<img src="https://example.com/a.png">', base + '<a href="https://example.com">https://example.com</a>', 'src=', 4, 6],
  ['resource_missing', base + '<img src="missing.png">', base + '<img src="image.png">', 'src=', 4, 6],
  ['stage_missing', '<script>window.SHOT={render(){}}</script>', base, '<script>', 1, 1],
  ['stage_size_unfixed', '<div id="stage"></div>\n<script>window.SHOT={render(){}}</script>', base, '<div', 1, 1],
  ['shot_missing', '<div id="stage" style="width:32px;height:32px"></div>', base, '<div', 1, 1],
  ['runtime_missing', '<div id="stage" style="width:32px;height:32px"></div>\n<script>Shot.define({render(){}})</script>', base, 'Shot.define', 2, 9],
  ['async_render', js('const shot={async render(){await work()}};'), js('const shot={async setup(){await work()},render(){}};'), 'async render', 5, 13],
  ['font_not_awaited', css('@font-face{font-family:Test;src:url(font.woff2)}'), css('@font-face{font-family:Test;src:url(font.woff2)}') + '<script>document.fonts.load("12px Test");</script>', '@font-face', 5, 1],
  ['lint_directive_invalid', js('// multiplane-disable-next-line\nconst x=1;'), js('// multiplane-disable-next-line wall_clock\nDate.now();'), 'multiplane-disable-next-line', 5, 1],
];
