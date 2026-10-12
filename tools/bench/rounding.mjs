import { linearToByte,averageLinear } from '../../src/post.mjs';
import { save } from './runner.mjs';
const linear=Float64Array.from({length:256},(_,i)=>{const v=i/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});
let state=0x19201080,found;
for(let trial=0;trial<3000000&&!found;trial++){
 const values=[];let full=0,reduced=0;
 for(let i=0;i<8;i++){state^=state<<13;state^=state>>>17;state^=state<<5;const value=(state>>>0)&255;values.push(value);full+=linear[value];reduced=Math.fround(reduced+linear[value]);}
 const a=linearToByte(full/8),b=linearToByte(reduced/8);
 if(a!==b){const actual=averageLinear(values.map(v=>({width:1,height:1,data:Buffer.from([v,v,v,255])}))).data;found={trial,values,float64:a,float32:b,production:[...actual],changedPixels:1,maxChannelDiff:Math.abs(a-b)};}
}
await save('out/bench/rounding.json',{seed:'0x19201080',limit:3000000,found:found??null});console.log(found??'No counterexample found within limit.');
