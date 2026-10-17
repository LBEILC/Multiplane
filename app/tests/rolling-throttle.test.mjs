import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Exercise the real scheduling and DOM lifecycle with a controller spy and virtual time.
const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/renderer/jobMotion.ts',import.meta.url))],bundle:true,write:false,platform:'browser',format:'iife',globalName:'motion',plugins:[{
  name:'controller-spy',setup(build){
    build.onResolve({filter:/^@kitlangton\/rolling-number$/},()=>({path:'spy',namespace:'spy'}));
    build.onLoad({filter:/.*/,namespace:'spy'},()=>({contents:`
      function create(el,opts){
        window.durations.push(opts.duration);let destroyed=false;
        return {update(value){if(destroyed)throw Error('update after destroy');window.calls.push({key:el.dataset.roll,...value});el.textContent=String(value.value??value.text);},
          finish(){window.finished++;},destroy(){destroyed=true;window.destroyed++;}};
      }
      export {create as createRollingNumber,create as createRollingText};
    `}));
  }
}]});

test('rolling updates retain the latest value without interrupting animations',async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());
  async function mount(reduced=false){
    const page=await browser.newPage();
    await page.emulateMedia({reducedMotion:reduced?'reduce':'no-preference'});
    await page.clock.install();
    await page.setContent('<span data-roll="number" data-value="0" data-numeric="true" data-digits="0">0</span><span data-roll="text" data-value="start">start</span>');
    await page.evaluate(()=>{window.calls=[];window.durations=[];window.destroyed=0;window.finished=0;});
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    await page.evaluate(()=>motion.hydrateRolls());
    return page;
  }
  await t.test('ten updates in 600ms reach only the first then the last value',async()=>{
    const page=await mount();
    for(let i=1;i<=10;i++){
      await page.evaluate(i=>{motion.setRoll('number',i);motion.setRoll('text','value '+i);},i);
      await page.clock.runFor(60);
    }
    assert.equal(await page.evaluate(()=>calls.length),2);
    const duration=await page.evaluate(()=>durations[0]);
    await page.clock.runFor(duration+150-600);
    assert.deepEqual(await page.evaluate(()=>calls.map(c=>c.value??c.text)),[1,'value 1',10,'value 10']);
    await page.clock.runFor(2000);
    assert.equal(await page.locator('[data-roll=number]').textContent(),'10');
    assert.equal(await page.locator('[data-roll=text]').textContent(),'value 10');
    assert.equal(await page.evaluate(()=>calls.length),4);
    await page.close();
  });
  await t.test('reduced motion displays every input immediately',async()=>{
    const page=await mount(true);
    for(let i=1;i<=10;i++){
      await page.evaluate(i=>motion.setRoll('number',i),i);
      assert.equal(await page.locator('[data-roll=number]').textContent(),String(i));
      await page.clock.runFor(60);
    }
    assert.equal(await page.evaluate(()=>calls.length),10);
    assert.equal(await page.evaluate(()=>calls.every(c=>c.animated===false)),true);
    await page.clock.runFor(2000);
    assert.equal(await page.evaluate(()=>calls.length),10);
    await page.close();
  });
  await t.test('returning to the displayed value discards an obsolete pending value',async()=>{
    const page=await mount();
    await page.evaluate(()=>{motion.setRoll('number',1);motion.setRoll('number',2);motion.setRoll('number',1);});
    await page.clock.runFor(2000);
    assert.deepEqual(await page.evaluate(()=>calls.map(c=>c.value)),[1]);
    await page.close();
  });
  await t.test('completion bypasses the window and cannot be overwritten by pending values',async()=>{
    const page=await mount();
    await page.evaluate(()=>{motion.setRoll('text','capture');motion.setRoll('text','encode');motion.setRoll('text','completed',true);});
    assert.deepEqual(await page.evaluate(()=>calls.map(c=>c.text)),['capture','completed']);
    assert.equal(await page.evaluate(()=>calls.at(-1).animated),true);
    await page.clock.runFor(2000);
    assert.equal(await page.locator('[data-roll=text]').textContent(),'completed');
    assert.equal(await page.evaluate(()=>calls.length),2);
    await page.close();
  });
  await t.test('removal cancels pending work even without another hydration',async()=>{
    const page=await mount();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.evaluate(()=>{motion.setRoll('number',1);motion.setRoll('number',2);document.querySelector('[data-roll=number]').remove();});
    assert.equal(await page.evaluate(()=>destroyed),1);
    await page.clock.runFor(2000);
    assert.equal(await page.evaluate(()=>calls.length),1);assert.deepEqual(errors,[]);
    await page.close();
  });
  await t.test('enabling reduced motion flushes a pending value without waiting',async()=>{
    const page=await mount();
    await page.evaluate(()=>{motion.setRoll('number',1);motion.setRoll('number',2);});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForFunction(()=>document.querySelector('[data-roll=number]').textContent==='2',{},{polling:10});
    assert.equal(await page.locator('[data-roll=number]').textContent(),'2');
    assert.equal(await page.evaluate(()=>calls.at(-1).animated),false);
    await page.clock.runFor(2000);
    assert.equal(await page.evaluate(()=>calls.length),2);
    await page.close();
  });
});
