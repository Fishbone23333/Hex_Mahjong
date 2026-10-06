import {strict as assert} from 'node:assert';
import {spawn} from 'node:child_process';
import WebSocket from 'ws';

const port=3215,origin=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['--input-type=module','--eval',"Math.random=()=>0; await import('./server.mjs');"],{
  cwd:new URL('..',import.meta.url),
  env:{...process.env,PORT:String(port),SETTLEMENT_TRIGGER_RATE:'0',SOUL_TRANSFER_TRIGGER_RATE:'1',HEX_DB_PATH:':memory:',NODE_NO_WARNINGS:'1'},
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
const waitFor=(ws,predicate,timeout=3000)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(new Error('message timeout'));},timeout);
  const handler=raw=>{const message=JSON.parse(raw.toString());if(predicate(message)){cleanup();resolve(message);}};
  const cleanup=()=>{clearTimeout(timer);ws.off('message',handler);};ws.on('message',handler);
});
const sendAndWait=(ws,payload,predicate)=>{const waiting=waitFor(ws,predicate);ws.send(JSON.stringify(payload));return waiting;};

try{
  await ready;
  const owner=new WebSocket(`ws://127.0.0.1:${port}`,{origin});
  await new Promise((resolve,reject)=>{owner.once('open',resolve);owner.once('error',reject);});
  owner.send(JSON.stringify({type:'hello',clientId:'soul-owner'}));
  const created=await sendAndWait(owner,{type:'createRoom',password:'123456'},message=>message.type==='roomJoined');
  let state=created.state;
  while(!state.locked&&!created.config.phases.every(phase=>state.triggered.includes(phase.id))){
    const drawn=await sendAndWait(owner,{type:'draw',phase:state.phase},message=>message.type==='drawn');
    assert.notEqual(drawn.card.id,'N07');
    assert.ok(!(drawn.bonusCards||[]).some(card=>card.id==='N07'));
    state=drawn.state;
  }
  const settled=await sendAndWait(owner,{type:'settle',roundId:state.roundId},message=>message.type==='settlement');
  assert.equal(state.active.some(item=>['R01','P42','R03'].includes(item.card.id)),false);
  assert.equal(settled.triggered,true);
  assert.deepEqual(settled.cards.map(card=>card.id),['N07']);
  assert.equal(settled.card?.id,'N07');
  owner.close();
  console.log(JSON.stringify({normalPoolExcluded:true,soulTriggered:true,drawnCards:state.active.map(item=>item.card.id)}));
}finally{stop();}
