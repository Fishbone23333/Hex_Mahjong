import {strict as assert} from 'node:assert';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import WebSocket from 'ws';

const port=3203,origin=`http://127.0.0.1:${port}`;
const cards=JSON.parse(await readFile(new URL('../cards.json',import.meta.url),'utf8'));
const openingPool=cards.filter(card=>card.tags.includes('any')||card.tags.includes('opening'));
const targetIndex=openingPool.findIndex(card=>card.id==='R03');
assert.ok(targetIndex>=0,'R03 missing from opening pool');
const fixedRandom=((targetIndex+0.25)/openingPool.length).toString();
const server=spawn(process.execPath,['--input-type=module','--eval',`Math.random=()=>${fixedRandom}; await import('./server.mjs');`],{
  cwd:new URL('..',import.meta.url),
  env:{...process.env,PORT:String(port)},
  stdio:['ignore','pipe','pipe']
});
const stop=()=>{if(!server.killed)server.kill();};
process.on('exit',stop);

const ready=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('server startup timeout')),5000);
  server.stdout.on('data',data=>{if(data.toString().includes('Hex Mahjong lobby server')){clearTimeout(timer);resolve();}});
  server.stderr.on('data',data=>{clearTimeout(timer);reject(new Error(data.toString()));});
  server.once('exit',code=>{if(code)reject(new Error(`server exited with ${code}`));});
});
const connect=()=>new Promise((resolve,reject)=>{
  const ws=new WebSocket(`ws://127.0.0.1:${port}`,{origin});
  const timer=setTimeout(()=>{ws.terminate();reject(new Error('connect timeout'));},3000);
  ws.once('open',()=>{clearTimeout(timer);resolve(ws);});
  ws.once('error',error=>{clearTimeout(timer);reject(error);});
});
const waitFor=(ws,predicate,timeout=3000)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(new Error('message timeout'));},timeout);
  const handler=raw=>{const message=JSON.parse(raw.toString());if(predicate(message)){cleanup();resolve(message);}};
  const cleanup=()=>{clearTimeout(timer);ws.off('message',handler);};
  ws.on('message',handler);
});
const sendAndWait=(ws,payload,predicate)=>{const waiting=waitFor(ws,predicate);ws.send(JSON.stringify(payload));return waiting;};

try{
  await ready;
  const owner=await connect(),guest=await connect();
  owner.send(JSON.stringify({type:'hello',clientId:'battle-owner'}));
  guest.send(JSON.stringify({type:'hello',clientId:'battle-guest'}));
  const created=await sendAndWait(owner,{type:'createRoom',password:'123456'},message=>message.type==='roomJoined');
  await sendAndWait(guest,{type:'joinRoom',roomId:created.roomId,password:'123456'},message=>message.type==='roomJoined');

  const drawn=await sendAndWait(owner,{type:'draw',phase:'opening'},message=>message.type==='drawn');
  assert.equal(drawn.card.id,'R03');
  assert.equal(drawn.card.name,'大逃杀');
  assert.ok(drawn.card.effect.includes('8、6、2'));
  assert.equal(drawn.state.locked,true);

  const ownerTimerPromise=waitFor(owner,message=>message.type==='timer');
  const guestTimerPromise=waitFor(guest,message=>message.type==='timer');
  owner.send(JSON.stringify({type:'timer',action:'start',cardId:'R03'}));
  const [ownerTimer,guestTimer]=await Promise.all([ownerTimerPromise,guestTimerPromise]);
  assert.equal(ownerTimer.state.roundTimer.cardId,'R03');
  assert.equal(ownerTimer.state.roundTimer.durationSeconds,60);
  assert.equal(ownerTimer.state.roundTimer.endsAt,guestTimer.state.roundTimer.endsAt);
  assert.equal(ownerTimer.state.turnTimer.started,false);
  assert.ok(ownerTimer.state.roundTimer.endsAt-ownerTimer.serverTime<=60000);
  assert.ok(ownerTimer.state.roundTimer.endsAt-ownerTimer.serverTime>=59900);

  const reset=await sendAndWait(guest,{type:'timer',action:'reset',cardId:'R03'},message=>message.type==='timer');
  assert.equal(reset.state.roundTimer.durationSeconds,60);
  assert.equal(reset.state.roundTimer.revision,2);

  const locked=await sendAndWait(owner,{type:'draw',phase:'firstWin'},message=>message.type==='error');
  assert.equal(locked.code,'LOCKED');
  owner.close();guest.close();
  console.log(JSON.stringify({drawn:true,sixtySeconds:true,synced:true,reset:true,nextDrawLocked:true}));
}finally{
  stop();
}
