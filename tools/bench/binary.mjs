import http from 'node:http';
import { createHash } from 'node:crypto';
export async function binaryReceiver(expected) {
  let received, resolveFrame, rejectFrame;
  const sockets=new Set();
  const accept=bytes=>{if(bytes.length!==expected){rejectFrame?.(Error('Unexpected frame size'));return;}received=bytes;resolveFrame?.(bytes);resolveFrame=rejectFrame=null;};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');
    if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','POST');res.setHeader('Access-Control-Allow-Headers','content-type');res.end();return;}
    if(req.method!=='POST'||req.url!=='/frame'){res.writeHead(404).end();return;}
    const chunks=[];let length=0;
    for await(const chunk of req){length+=chunk.length;if(length>expected){res.writeHead(413).end();return;}chunks.push(chunk);}
    accept(Buffer.concat(chunks));res.end();
  });
  server.on('upgrade',(req,socket,head)=>{
    if(req.url!=='/frame'){socket.destroy();return;}
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',e=>rejectFrame?.(e));
    const key=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
    const storage=Buffer.allocUnsafe(expected+14);let filled=0,parts=[],length=0;
    const parse=chunk=>{
      if(filled+chunk.length>storage.length){socket.destroy();return;}
      chunk.copy(storage,filled);filled+=chunk.length;
      while(filled>=2){
        const pending=storage.subarray(0,filled);
        const final=!!(pending[0]&128),op=pending[0]&15,masked=!!(pending[1]&128);let size=pending[1]&127,offset=2;
        if(size===126){if(pending.length<4)return;size=pending.readUInt16BE(2);offset=4;}
        else if(size===127){if(pending.length<10)return;size=Number(pending.readBigUInt64BE(2));offset=10;}
        if(!masked||size>expected){socket.destroy();return;}
        if(pending.length<offset+4+size)return;
        const mask=pending.subarray(offset,offset+4),payload=Buffer.from(pending.subarray(offset+4,offset+4+size));
        for(let i=0;i<size;i++)payload[i]^=mask[i%4];const consumed=offset+4+size;storage.copyWithin(0,consumed,filled);filled-=consumed;
        if(op===8){socket.end(Buffer.from([136,0]));return;}
        if(op===9){socket.write(Buffer.concat([Buffer.from([138,size]),payload]));continue;}
        if(op!==2&&op!==0){socket.destroy();return;}
        parts.push(payload);length+=size;if(length>expected){socket.destroy();return;}
        if(final){accept(parts.length===1?parts[0]:Buffer.concat(parts,length));parts=[];length=0;socket.write(Buffer.from([130,1,1]));}
      }
    };
    socket.on('data',parse);if(head.length)parse(head);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}/frame`,next(){received=null;return new Promise((resolve,reject)=>{resolveFrame=resolve;rejectFrame=reject;});},async close(){for(const socket of sockets)socket.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
export async function installReadback(page,url){
  await page.evaluate(async url=>{
    const canvas=document.querySelector('canvas'),gl=window.BENCH_GL;
    const ws=new WebSocket(url.replace('http:','ws:'));await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
    window.BENCH_TRANSFER=async mode=>{
      let bytes;
      if(gl){
        const raw=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,raw);
        bytes=new Uint8Array(raw.length);const stride=canvas.width*4;
        for(let y=0;y<canvas.height;y++)bytes.set(raw.subarray(y*stride,(y+1)*stride),(canvas.height-1-y)*stride);
      }else bytes=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height,{colorSpace:'srgb'}).data;
      if(mode==='post'){const response=await fetch(url,{method:'POST',body:bytes});if(!response.ok)throw Error('POST failed');}
      else await new Promise((resolve,reject)=>{ws.onmessage=resolve;ws.onerror=reject;ws.send(bytes);});
    };
  },url);
}
