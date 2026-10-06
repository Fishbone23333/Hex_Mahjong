import {strict as assert} from 'node:assert';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import WebSocket from 'ws';
import {initialOpeningPool} from './test-card-selection.mjs';

const port=3202,origin=`http://127.0.0.1:${port}`;
const cards=JSON.parse(await readFile(new URL('../cards.json',import.meta.url),'utf8'));
const openingPool=initialOpeningPool(cards);
const targetIndex=openingPool.findIndex(card=>card.id==='R02');
assert.ok(targetIndex>=0,'R02 missing from opening pool');
const fixedRandom=((targetIndex+0.25)/openingPool.length).toString();
const server=spawn(process.execPath,['--input-type=module','--eval',`Math.random=()=>${fixedRandom}; await import('./server.mjs');`],{
  cwd:new URL('..',import.meta.url),
  env:{...process.env,PORT:String(port),HEX_DB_PATH:':memory:',NODE_NO_WARNINGS:'1'},
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
  owner.send(JSON.stringify({type:'hello',clientId:'timer-owner'}));
  guest.send(JSON.stringify({type:'hello',clientId:'timer-guest'}));
  const created=await sendAndWait(owner,{type:'createRoom',password:'123456'},message=>message.type==='roomJoined');
  await sendAndWait(guest,{type:'joinRoom',roomId:created.roomId,password:'123456'},message=>message.type==='roomJoined');

  const drawn=await sendAndWait(owner,{type:'draw',phase:'opening'},message=>message.type==='drawn');
  assert.equal(drawn.card.id,'R02');
  assert.equal(drawn.card.name,'无限火力');

  const armedOwnerPromise=waitFor(owner,message=>message.type==='timer');
  const armedGuestPromise=waitFor(guest,message=>message.type==='timer');
  owner.send(JSON.stringify({type:'timer',action:'arm',cardId:'R02'}));
  const [armedOwner,armedGuest]=await Promise.all([armedOwnerPromise,armedGuestPromise]);
  assert.equal(armedOwner.state.turnTimer.cardId,'R02');
  assert.equal(armedOwner.state.turnTimer.armed,true);
  assert.equal(armedOwner.state.turnTimer.started,false);
  assert.equal(armedOwner.state.turnTimer.endsAt,null);
  assert.deepEqual(armedOwner.state.turnTimer,armedGuest.state.turnTimer);

  const ownerTimerPromise=waitFor(owner,message=>message.type==='timer');
  const guestTimerPromise=waitFor(guest,message=>message.type==='timer');
  owner.send(JSON.stringify({type:'timer',action:'start',cardId:'R02'}));
  const [ownerTimer,guestTimer]=await Promise.all([ownerTimerPromise,guestTimerPromise]);
  assert.equal(ownerTimer.state.turnTimer.cardId,'R02');
  assert.equal(ownerTimer.state.turnTimer.armed,true);
  assert.equal(ownerTimer.state.turnTimer.started,true);
  assert.equal(ownerTimer.state.turnTimer.durationSeconds,8);
  assert.equal(ownerTimer.state.turnTimer.endsAt,guestTimer.state.turnTimer.endsAt);
  assert.ok(ownerTimer.state.turnTimer.endsAt-ownerTimer.serverTime<=8000);
  assert.ok(ownerTimer.state.turnTimer.endsAt-ownerTimer.serverTime>=7900);

  const reset=await sendAndWait(guest,{type:'timer',action:'reset',cardId:'R02'},message=>message.type==='timer');
  assert.equal(reset.state.turnTimer.durationSeconds,8);
  assert.equal(reset.state.turnTimer.revision,3);

  const unavailable=await sendAndWait(owner,{type:'timer',action:'start',cardId:'R05'},message=>message.type==='error');
  assert.equal(unavailable.code,'TIMER_UNAVAILABLE');
  owner.close();guest.close();
  console.log(JSON.stringify({drawn:true,eightSeconds:true,synced:true,reset:true,wrongCardBlocked:true}));
}finally{
  stop();
}
