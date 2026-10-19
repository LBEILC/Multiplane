import test from 'node:test';
import assert from 'node:assert/strict';
import { trayPosition, trayProgress, trayTemplate } from '../src/main/tray.mjs';
const bounds = {x:0,y:0,width:1920,height:1080}, size={width:300,height:400};
test('tray anchors eight DIP from all four taskbar edges',()=>{
  for(const [edge,workArea,icon,expected] of [
    ['bottom',{x:0,y:0,width:1920,height:1040},{x:1700,y:1040,width:24,height:40},{x:1562,y:632}],
    ['top',{x:0,y:40,width:1920,height:1040},{x:1700,y:0,width:24,height:40},{x:1562,y:48}],
    ['left',{x:40,y:0,width:1880,height:1080},{x:0,y:500,width:40,height:24},{x:48,y:312}],
    ['right',{x:0,y:0,width:1880,height:1080},{x:1880,y:500,width:40,height:24},{x:1572,y:312}],
  ]) assert.deepEqual(trayPosition(icon,{x:0,y:0},{bounds,workArea},size),{...expected,...size,edge});
});
test('tray clamps negative monitor edges and falls back to cursor without bounds',()=>{
  const display={bounds:{x:-1920,y:-200,width:1920,height:1080},workArea:{x:-1920,y:-200,width:1920,height:1040}};
  assert.deepEqual(trayPosition({x:-12,y:840,width:12,height:40},{x:0,y:0},display,size),{x:-300,y:432,...size,edge:'bottom'});
  for(const icon of [undefined,{x:0,y:0,width:0,height:0}]) assert.deepEqual(trayPosition(icon,{x:-1919,y:860},display,size),{x:-1920,y:432,...size,edge:'bottom'});
  const tiny={bounds:{x:0,y:0,width:200,height:200},workArea:{x:0,y:0,width:200,height:160}};
  const result=trayPosition(undefined,{x:100,y:190},tiny,size);assert.equal(result.width,200);assert.equal(result.height,160);assert.equal(result.y,0);
});
test('tray progress clears, clamps and uses indeterminate encoding; zero queue is absent',()=>{
  assert.equal(trayProgress([]).value,-1);
  assert.deepEqual(trayProgress([{state:'running',done:46,total:100}]),{count:1,percent:46,value:.46});
  assert.equal(trayProgress([{state:'running',phase:'encode',done:0,total:null}]).value,2);
  assert.equal(trayProgress([{state:'running',done:150,total:100}]).value,1);
  assert.equal(trayTemplate([],()=>{},()=>{}).some(item=>item.enabled===false),false);
});

test('overflow tray icons anchor above or below the icon for every taskbar edge',()=>{
  for(const [workArea,icon,expected] of [
    [{x:0,y:0,width:1920,height:1040},{x:1700,y:900,width:24,height:24},{x:1562,y:492,edge:'bottom'}],
    [{x:0,y:0,width:1920,height:1040},{x:1700,y:200,width:24,height:24},{x:1562,y:232,edge:'top'}],
    [{x:40,y:0,width:1880,height:1080},{x:60,y:600,width:24,height:24},{x:40,y:192,edge:'bottom'}],
    [{x:0,y:0,width:1880,height:1080},{x:1820,y:600,width:24,height:24},{x:1580,y:192,edge:'bottom'}],
    [{x:0,y:40,width:1920,height:1040},{x:1700,y:60,width:24,height:24},{x:1562,y:92,edge:'top'}],
  ]) assert.deepEqual(trayPosition(icon,{x:0,y:0},{bounds,workArea},size),{...expected,...size});
});

test('overflow tray prefers above and clamps when neither side fits',()=>{
  const display={bounds:{x:-800,y:-200,width:800,height:640},workArea:{x:-800,y:-200,width:800,height:600}};
  assert.deepEqual(trayPosition({x:-20,y:50,width:20,height:24},{x:0,y:0},display,size),{x:-300,y:-200,...size,edge:'bottom'});
});

test('overflow tray treats missing icon bounds as a one DIP cursor icon',()=>{
  const display={bounds,workArea:{x:0,y:0,width:1920,height:1040}};
  for(const icon of [undefined,{x:0,y:0,width:0,height:0}]) {
    assert.deepEqual(trayPosition(icon,{x:1000,y:900},display,size),{x:850,y:492,...size,edge:'bottom'});
    assert.deepEqual(trayPosition(icon,{x:1000,y:200},display,size),{x:850,y:209,...size,edge:'top'});
  }
});
