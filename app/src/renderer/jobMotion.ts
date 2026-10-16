import { createRollingNumber, createRollingText, type RollingNumberController, type RollingTextController } from '@kitlangton/rolling-number';
import { language, number, formatDuration } from '../shared/i18n.mjs';
import { esc } from './jobDetail';
import type { Job } from '../shared/types';
export const motionOn = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;
const controllers = new Map<HTMLElement,{value:string; controller:RollingNumberController|RollingTextController}>();
export const roll = (key:string,value:string|number|null,digits=0) => `<span data-roll="${esc(key)}" data-value="${esc(value??'—')}" data-numeric="${typeof value==='number'}" data-digits="${digits}">${esc(typeof value==='number'?number(value,digits):value??'—')}</span>`;
export function hydrateRolls() {
  for(const [el,c] of controllers)if(!el.isConnected){c.controller.destroy();controllers.delete(el);}
  document.querySelectorAll<HTMLElement>('[data-roll]').forEach(el=>{if(controllers.has(el))return;const value=el.dataset.value!,opts={duration:460,motionBlur:true,animated:false};const controller=el.dataset.numeric==='true'?createRollingNumber(el,{...opts,value:Number(value),locales:language(),format:{minimumFractionDigits:Number(el.dataset.digits),maximumFractionDigits:Number(el.dataset.digits)}}):createRollingText(el,{...opts,text:value,transition:'direct',stagger:'none'});controllers.set(el,{value,controller});});
}
export function setRoll(key:string,value:string|number) {
  for(const [el,c] of controllers){if(el.dataset.roll!==key||c.value===String(value))continue;c.value=String(value);el.dataset.value=String(value);if(el.dataset.numeric==='true')(c.controller as RollingNumberController).update({value:Number(value),animated:motionOn()});else(c.controller as RollingTextController).update({text:String(value),animated:motionOn()});}
}
export function updateRolls(_host:HTMLElement,j:Job) {const total=_host.querySelector('[data-row-total]');if(total)total.textContent=number(j.total);setRoll('row-'+j.jobId,j.done);setRoll('left-'+j.jobId,j.etaMs==null?'—':formatDuration(j.etaMs));}
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>{if(!motionOn())for(const c of controllers.values())c.controller.finish();});
