import { parentPort, workerData } from 'node:worker_threads';
import { measuredShot } from './capture.mjs';
let measured;
try {
  measured=await measuredShot(workerData.shot,workerData.options);
  parentPort.postMessage({type:'ready',info:measured.info});
  parentPort.on('message',async message=>{
    try{
      if(message.type==='close'){await measured.capture.close();parentPort.close();return;}
      const frame=await measured.frame(message.index);const bytes=Uint8Array.from(frame.bytes);
      parentPort.postMessage({...frame,bytes,index:message.index},[bytes.buffer]);
    }catch(error){parentPort.postMessage({error:error.stack});await measured.capture.close();parentPort.close();}
  });
}catch(error){parentPort.postMessage({error:error.stack});await measured?.capture.close();parentPort.close();}
