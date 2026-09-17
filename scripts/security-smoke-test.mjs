import http from 'node:http';
import {spawn} from 'node:child_process';
import WebSocket from 'ws';

const port=3199,base=`http://127.0.0.1:${port}`,origin=base;
const server=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
const stop=()=>{if(!server.killed)server.kill();};
process.on('exit',stop);

const ready=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('server startup timeout')),5000);
  server.stdout.on('data',data=>{if(data.toString().includes('Hex Mahjong lobby server')){clearTimeout(timer);resolve();}});
  server.stderr.on('data',data=>{clearTimeout(timer);reject(new Error(data.toString()));});
  server.once('exit',code=>{if(code)reject(new Error(`server exited with ${code}`));});
});
const request=pathname=>new Promise((resolve,reject)=>{
  http.get(base+pathname,response=>{response.resume();response.on('end',()=>resolve({status:response.statusCode,headers:response.headers}));}).on('error',reject);
});
const connect=connectionOrigin=>new Promise((resolve,reject)=>{
  const ws=new WebSocket(`ws://127.0.0.1:${port}`,{origin:connectionOrigin});
  const timer=setTimeout(()=>{ws.terminate();reject(new Error('connect timeout'));},3000);
  ws.once('open',()=>{clearTimeout(timer);resolve(ws);});
  ws.once('error',error=>{clearTimeout(timer);reject(error);});
});
const waitFor=(ws,predicate,timeout=3000)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(new Error('message timeout'));},timeout);
  const handler=raw=>{const message=JSON.parse(raw.toString());if(predicate(message)){cleanup();resolve(message);}};
  const cleanup=()=>{clearTimeout(timer);ws.off('message',handler);};ws.on('message',handler);
});
const sendAndWait=(ws,payload,predicate)=>{const waiting=waitFor(ws,predicate);ws.send(JSON.stringify(payload));return waiting;};

try{
  await ready;
  const [root,prefixedRoot,source,prefixedSource,packageFile,audio]=await Promise.all([request('/'),request('/hex-mahjong/'),request('/server.mjs'),request('/hex-mahjong/server.mjs'),request('/package.json'),request('/audio/ding.mp3')]);
  if(root.status!==200||prefixedRoot.status!==200||source.status!==404||prefixedSource.status!==404||packageFile.status!==404||audio.status!==200)throw new Error('static allowlist failed');
  if(root.headers['x-content-type-options']!=='nosniff'||root.headers['x-frame-options']!=='DENY'||!root.headers['content-security-policy'])throw new Error('security headers missing');

  let maliciousRejected=false;
  try{const malicious=await connect('https://evil.example');malicious.close();}catch{maliciousRejected=true;}
  if(!maliciousRejected)throw new Error('malicious origin accepted');

  const localFileClient=await connect('null');localFileClient.close();

  const owner=await connect(origin),guest=await connect(origin);
  owner.send(JSON.stringify({type:'hello',clientId:'security-owner'}));guest.send(JSON.stringify({type:'hello',clientId:'security-guest'}));
  const created=await sendAndWait(owner,{type:'createRoom',password:'123456'},message=>message.type==='roomJoined');
  const joined=await sendAndWait(guest,{type:'joinRoom',roomId:created.roomId,password:'123456'},message=>message.type==='roomJoined');
  if(joined.roomId!==created.roomId)throw new Error('scrypt password join failed');
  await sendAndWait(guest,{type:'leaveRoom'},message=>message.type==='roomLeft');
  await sendAndWait(owner,{type:'leaveRoom'},message=>message.type==='roomLeft');

  for(let index=1;index<5;index++){
    await sendAndWait(owner,{type:'createRoom',password:'123456'},message=>message.type==='roomJoined');
    await sendAndWait(owner,{type:'leaveRoom'},message=>message.type==='roomLeft');
  }
  const limited=await sendAndWait(owner,{type:'createRoom',password:'123456'},message=>message.type==='error');
  if(limited.code!=='CREATE_LIMIT')throw new Error('room creation rate limit failed');

  const oversized=await connect(origin);
  const closeCode=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('oversized message not closed')),3000);oversized.once('close',code=>{clearTimeout(timer);resolve(code);});oversized.send('x'.repeat(20*1024));});
  if(closeCode!==1009)throw new Error(`unexpected oversized close code ${closeCode}`);

  owner.close();guest.close();
  console.log(JSON.stringify({staticAllowlist:true,securityHeaders:true,originCheck:true,localFileOrigin:true,passwordJoin:true,roomCreationLimit:true,maxPayload:true}));
}finally{
  stop();
}
