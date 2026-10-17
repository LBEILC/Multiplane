import { createRollingNumber, createRollingText, type RollingNumberController, type RollingTextController } from '@kitlangton/rolling-number';
import { language, number, formatDuration } from '../shared/i18n.mjs';
import { esc } from './jobDetail';
import type { Job } from '../shared/types';
export const motionOn = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;
const rollDuration = 460;
const rollInterval = rollDuration + 150;
type RollState = { value:string; pending?:string; timer?:ReturnType<typeof setTimeout>; controller:RollingNumberController|RollingTextController };
const controllers = new Map<HTMLElement,RollState>();
export const roll = (key:string,value:string|number|null,digits=0) => `<span data-roll="${esc(key)}" data-value="${esc(value??'—')}" data-numeric="${typeof value==='number'}" data-digits="${digits}">${esc(typeof value==='number'?number(value,digits):value??'—')}</span>`;
function clearWait(c:RollState) {
  clearTimeout(c.timer);c.timer=undefined;c.pending=undefined;
}
function dispose(el:HTMLElement,c:RollState) {
  clearWait(c);c.controller.destroy();controllers.delete(el);
}
function pruneRolls() {
  for(const [el,c] of controllers)if(!el.isConnected)dispose(el,c);
}
// Some page replacements do not hydrate new rolls, so observe removal as well.
new MutationObserver(records=>{if(records.some(record=>record.removedNodes.length))pruneRolls();}).observe(document.documentElement,{childList:true,subtree:true});
export function hydrateRolls() {
  pruneRolls();
  document.querySelectorAll<HTMLElement>('[data-roll]').forEach(el=>{if(controllers.has(el))return;const value=el.dataset.value!,opts={duration:rollDuration,motionBlur:true,animated:false};const controller=el.dataset.numeric==='true'?createRollingNumber(el,{...opts,value:Number(value),locales:language(),format:{minimumFractionDigits:Number(el.dataset.digits),maximumFractionDigits:Number(el.dataset.digits)}}):createRollingText(el,{...opts,text:value,transition:'direct',stagger:'none'});controllers.set(el,{value,controller});});
}
function applyRoll(el:HTMLElement,c:RollState,value:string,animated:boolean) {
  if(c.value===value)return;
  c.value=value;el.dataset.value=value;
  if(el.dataset.numeric==='true')(c.controller as RollingNumberController).update({value:Number(value),animated});
  else(c.controller as RollingTextController).update({text:value,animated});
  if(animated)c.timer=setTimeout(()=>{
    const pending=c.pending;c.timer=undefined;c.pending=undefined;
    if(!el.isConnected){dispose(el,c);return;}
    if(pending!==undefined)applyRoll(el,c,pending,motionOn());
  },rollInterval);
}
export function setRoll(key:string,value:string|number,immediate=false) {
  const animated=motionOn();
  for(const [el,c] of controllers){
    if(!el.isConnected){dispose(el,c);continue;}
    if(el.dataset.roll!==key)continue;
    if(immediate||!animated)clearWait(c);
    // Record even a return to the displayed value, replacing any stale pending value.
    if(c.timer!==undefined){c.pending=String(value);continue;}
    applyRoll(el,c,String(value),animated);
  }
}
export function updateRolls(_host:HTMLElement,j:Job) {const total=_host.querySelector('[data-row-total]');if(total)total.textContent=number(j.total);setRoll('row-'+j.jobId,j.done);setRoll('left-'+j.jobId,j.etaMs==null?'—':formatDuration(j.etaMs));}
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>{
  if(!motionOn())for(const [el,c] of controllers){
    if(!el.isConnected){dispose(el,c);continue;}
    const pending=c.pending;clearWait(c);
    if(pending!==undefined)applyRoll(el,c,pending,false);
    c.controller.finish();
  }
});
