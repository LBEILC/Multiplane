import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { openShot } from '../src/capture.mjs';
import { verifyShot } from '../src/verify.mjs';
import { createTempDirectory } from './helpers.mjs';

const root = createTempDirectory();
await writeFile(path.join(root, 'font.ttf'), await readFile('examples/assets/Roboto-Variable.ttf'));
await writeFile(path.join(root, 'card.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect x="100" y="100" width="10" height="10" fill="white"/></svg>');
const layerStyle = { annotationFontFamily: 'LayerFont', annotationColor: '#ff0000', annotationTextColor: '#00ff00',
  textureBackground: '#112233', browserFrameColor: '#0000ff', browserFrameFontFamily: 'LayerFont' };
const cardStyle = { annotationFontFamily: 'CardFont', annotationColor: '#00ffff', annotationTextColor: '#ff00ff',
  textureBackground: '#445566', browserFrameColor: '#ffff00', browserFrameFontFamily: 'CardFont' };

async function fixture(name, style = layerStyle, override = cardStyle, extraCSS = '') {
  await writeFile(path.join(root, name), `<!doctype html><html><meta charset="utf-8">
<link rel="stylesheet" href="/multiplane/runtime/shot.css">
<style>#stage{width:128px;height:128px;background:white}
@font-face{font-family:LayerFont;src:url('./font.ttf');font-weight:100 900}
@font-face{font-family:CardFont;src:url('./font.ttf');font-weight:100 900}${extraCSS}</style>
<script type="importmap">{"imports":{"three":"/multiplane/vendor/three/build/three.module.js","three/addons/":"/multiplane/vendor/three/examples/jsm/"}}</script>
<div id="stage"></div><script src="/multiplane/runtime/shot.js"></script>
<script type="module">
import {createThreeLayer} from '/multiplane/three.js';
window.textCalls=[];
const fillText=CanvasRenderingContext2D.prototype.fillText;
CanvasRenderingContext2D.prototype.fillText=function(...args){textCalls.push({font:this.font,color:this.fillStyle,loaded:[...document.fonts].map(f=>[f.family,f.status])});return fillText.apply(this,args);};
const layer=createThreeLayer({samples:2,maxSamples:2,aperture:0,style:${JSON.stringify(style)}});
const options={src:'./card.svg',width:2,height:2,textureWidth:128,browserFrame:true,
annotations:[{type:'underline',x:0.1,y:0.6,w:0.8,lineWidth:0.04},{x:0.1,y:0.3,text:'Text',fontSize:0.12}]};
const cards=[layer.card(options),layer.card({...options,style:${JSON.stringify(override)}}),layer.card(options)];
window.layer=layer;window.cards=cards;
Shot.define({duration:1,fps:2,setup:()=>layer.ready,render(t){cards.forEach((c,i)=>{c.position.x=(i-1)*1.5+t*0.1;});layer.render({t});}});
</script></html>`);
  return name;
}

test('layer style defaults, per-card overrides and cache keys affect texture pixels and fonts', async () => {
  const capture = await openShot(await fixture('style.html'), 1, { root });
  try {
    const result = await capture.page.evaluate(() => ({
      textures: cards.slice(0, 2).map(card => {
        const canvas = card.userData.material.map.image, ctx = canvas.getContext('2d');
        const pixel = (x,y) => [...ctx.getImageData(x,y,1,1).data];
        return { background: pixel(0,0), line: pixel(64,77) };
      }),
      shared: cards[0].userData.material.map === cards[2].userData.material.map,
      distinct: cards[0].userData.material.map !== cards[1].userData.material.map,
      calls: textCalls,
    }));
    assert.deepEqual(result.textures, [
      { background: [17,34,51,255], line: [255,0,0,255] },
      { background: [68,85,102,255], line: [0,255,255,255] },
    ]);
    assert.equal(result.shared, true); assert.equal(result.distinct, true);
    for (const [family, color] of [['LayerFont','#00ff00'], ['CardFont','#ff00ff'], ['LayerFont','#0000ff'], ['CardFont','#ffff00']]) {
      const call = result.calls.find(call => call.font.includes(family) && call.color === color);
      assert.ok(call, JSON.stringify(result.calls));
      assert.ok(call.loaded.some(([name,status]) => name === family && status === 'loaded'));
    }
    const inherited = await capture.page.evaluate(async () => {
      const plain = layer.card({src:'./card.svg',width:1,height:1,textureWidth:128,style:{textureBackground:'#abcdef'}});
      const framed = layer.card({src:'./card.svg',width:1,height:1,textureWidth:128,browserFrame:true,style:{textureBackground:'#abcdef'},
        annotations:[{x:0.1,y:0.5,text:'Override',textColor:'#123456'}]});
      await layer.ready;
      return { background:[...plain.userData.material.map.image.getContext('2d').getImageData(0,0,1,1).data],
        calls:textCalls.slice(-2), framed:!!framed.userData.material.map };
    });
    assert.deepEqual(inherited.background, [171,205,239,255]);
    assert.equal(inherited.framed, true);
    assert.ok(inherited.calls.every(call => call.font.includes('LayerFont')));
    assert.equal(inherited.calls[1].color, '#123456');
  } finally { await capture.close(); }
});

test('custom three styles are deterministic across reorder, reload and workers', { timeout: 120000 }, async () => {
  const name = await fixture('deterministic.html');
  const result = await verifyShot(name, { root, at:'0,0.5', workers:2, out:path.join(root,'verify'), 'job-dir':path.join(root,'jobs') });
  assert.equal(result.data.passed, true);
  assert.deepEqual(result.data.checks.map(c=>c.name), ['reorder','reload','workers:1','workers:2','range']);
});

test('unavailable annotation and browser frame fonts fail instead of falling back', async () => {
  for (const field of ['annotationFontFamily','browserFrameFontFamily']) {
    const name = await fixture(`${field}.html`, { ...layerStyle, [field]:'MissingMultiplaneFont' }, {});
    await assert.rejects(openShot(name, 1, { root }), { code:'resource_failed' });
  }
  const name = await fixture('broken-font.html', { ...layerStyle, annotationFontFamily:'BrokenFont' }, {},
    "@font-face{font-family:BrokenFont;src:url('./missing.ttf')}");
  await assert.rejects(openShot(name, 1, { root }), { code:'resource_failed' });
});

test('generic and locally installed fonts are supported', async () => {
  const name = await fixture('generic.html', { annotationFontFamily:'serif', browserFrameFontFamily:'monospace' }, {});
  const capture = await openShot(name, 1, { root });
  try {
    if (process.platform === 'win32') {
      await capture.page.evaluate(async () => {
        layer.card({src:'./card.svg',width:1,height:1,browserFrame:true,style:{browserFrameFontFamily:'Arial'}});
        await layer.ready;
      });
    }
  } finally { await capture.close(); }
});
