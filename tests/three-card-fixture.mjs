import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { encodePNG } from '../src/png.mjs';

// Self-drawn pixels shared by the regression tests and visual acceptance script.
export async function cardFixture(root, name, { mode = 'lod', module = '/multiplane/three.js', lodBias, near = false } = {}) {
  await mkdir(root, { recursive: true });
  const data = Buffer.alloc(512 * 256 * 4);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) {
    const p = (y * 512 + x) * 4;
    const ink = x % 16 < 2 || y % 24 < 2;
    data[p] = data[p + 1] = data[p + 2] = ink ? 24 : 240;
    data[p + 3] = mode === 'transparency' && (x < 128 || x >= 384 || y < 64 || y >= 192) ? 0 : 255;
  }
  await writeFile(path.join(root, `${mode}.png`), encodePNG({ width: 512, height: 256, data }));
  const body = mode === 'transparency' ? `
    const common={src:'./transparency.png',width:3,height:1.5,textureWidth:512};
    const cards=[layer.card({...common,position:[-3.3,0,0]}),
      layer.card({...common,annotations:[{type:'underline',x:.2,y:.7,w:.6}]}),
      layer.card({...common,position:[3.3,0,0],style:{textureBackground:'#88bb66'}})];`
    : `const cards=[layer.card({src:'./${mode}.png',width:${mode === 'border' ? 12 : 9.4},height:${mode === 'border' ? 6 : 4.7},
      ${mode === 'border' ? "border:{width:.12,color:'#101010'},rotation:[.13,.32,0]," : ''}
      ${lodBias === undefined ? '' : `lodBias:${lodBias},`}textureWidth:512})];`;
  const file = path.join(root, name);
  await writeFile(file, `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/multiplane/runtime/shot.css">
<style>#stage{width:640px;height:360px;background:#347ca4}</style>
<script type="importmap">{"imports":{"three":"/multiplane/vendor/three/build/three.module.js","three/addons/":"/multiplane/vendor/three/examples/jsm/"}}</script>
<div id="stage"></div><script src="/multiplane/runtime/shot.js"></script>
<script type="module">
import {createThreeLayer} from '${module}';
const layer=createThreeLayer({fov:${near ? 57.5 : 9},near:.1,far:100,samples:1,maxSamples:1,aperture:0,style:{textureBackground:'#e8dfca'}});
layer.camera.position.z=${near ? 10 : 70};
${body}
window.layer=layer;window.cards=cards;
Shot.define({duration:1,fps:2,post:{motionBlur:4},setup:()=>layer.ready,render(t){cards[0].position.y=t*.1;layer.render({t});}});
</script>`);
  return file;
}
