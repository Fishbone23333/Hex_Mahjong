import {strict as assert} from 'node:assert';
import {spawn} from 'node:child_process';
import WebSocket from 'ws';

const port=3205,origin=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['--input-type=module','--eval',`let randomCall=0; Math.random=()=>{randomCall+=1;return randomCall===6?0.02:randomCall===8?0.022:0.01;}; await import('./server.mjs');`],{
  cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),SETTLEMENT_TRIGGER_RATE:'0',HEX_DB_PATH:':memory:',NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']
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
  ws.once('open',()=>{clearTimeout(timer);resolve(ws);});ws.once('error',reject);
});
const waitFor=(ws,predicate,timeout=3000)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(new Error('message timeout'));},timeout);
  const handler=raw=>{const message=JSON.parse(raw.toString());if(predicate(message)){cleanup();resolve(message);}};
  const cleanup=()=>{clearTimeout(timer);ws.off('message',handler);};ws.on('message',handler);
});
const sendAndWait=(ws,payload,predicate)=>{const waiting=waitFor(ws,predicate);ws.send(JSON.stringify(payload));return waiting;};
const createRoom=async(ws,clientId,password)=>{
  ws.send(JSON.stringify({type:'hello',clientId}));
  return sendAndWait(ws,{type:'createRoom',password},message=>message.type==='roomJoined');
};
const finishRound=async(ws,state)=>{
  for(const phase of ['opening','firstWin','secondWin']){
    const drawn=await sendAndWait(ws,{type:'draw',phase},message=>message.type==='drawn');
    state=drawn.state;
  }
  return sendAndWait(ws,{type:'settle',roundId:state.roundId},message=>message.type==='settlement');
};

try{
  await ready;
  const roomA=await connect(),joinedA=await createRoom(roomA,'recent-owner-a','123456');
  const firstRound=await finishRound(roomA,joinedA.state);
  const firstNextDraw=await sendAndWait(roomA,{type:'draw',phase:'opening'},message=>message.type==='drawn');
  assert.equal(firstNextDraw.card.id,'P02','recent P01 should lose to fresh P02 after weight decay');

  const roomB=await connect(),joinedB=await createRoom(roomB,'recent-owner-b','654321');
  const freshRoomDraw=await sendAndWait(roomB,{type:'draw',phase:'opening'},message=>message.type==='drawn');
  assert.equal(freshRoomDraw.card.id,'P01','fresh room should keep the original unpenalized selection');

  const resetRoundId=firstNextDraw.state.roundId;
  const reset=await sendAndWait(roomA,{type:'reset',roundId:resetRoundId},message=>message.type==='reset');
  const afterEarlyReset=await sendAndWait(roomA,{type:'draw',phase:'opening'},message=>message.type==='drawn');
  assert.equal(afterEarlyReset.card.id,'P03','early reset should archive P02 and reduce its next-round weight');

  assert.notEqual(firstRound.state.roundId,joinedA.state.roundId,'settlement should start a new round');
  assert.notEqual(reset.state.roundId,resetRoundId,'early reset should start a new round');
  roomA.close();roomB.close();
  console.log(JSON.stringify({recentCardPenalized:true,roomHistoryIsolated:true,settlementArchived:true,earlyResetArchived:true}));
}finally{stop();}
