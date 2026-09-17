import {strict as assert} from 'node:assert';
import {spawn} from 'node:child_process';
import WebSocket from 'ws';

const port=3201,origin=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['server.mjs'],{
  cwd:new URL('..',import.meta.url),
  env:{...process.env,PORT:String(port),SETTLEMENT_TRIGGER_RATE:'1',HEX_DB_PATH:':memory:',NODE_NO_WARNINGS:'1'},
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
  const owner=await connect();
  owner.send(JSON.stringify({type:'hello',clientId:'settlement-owner'}));
  const created=await sendAndWait(owner,{type:'createRoom',password:'123456'},message=>message.type==='roomJoined');
  let state=created.state;

  const tooEarly=await sendAndWait(owner,{type:'settle',roundId:state.roundId},message=>message.type==='error');
  assert.equal(tooEarly.code,'SETTLEMENT_NOT_READY');

  while(!state.locked&&!['opening','firstWin','secondWin'].every(id=>state.triggered.includes(id))){
    const drawn=await sendAndWait(owner,{type:'draw',phase:state.phase},message=>message.type==='drawn');
    assert.notEqual(drawn.card.id,'R06','settlement card entered the normal draw pool');
    assert.ok(!(drawn.bonusCards||[]).some(card=>card.id==='R06'),'settlement card entered Firepower Full On bonus pool');
    state=drawn.state;
  }

  const previousRoundId=state.roundId;
  const bypass=await sendAndWait(owner,{type:'reset',roundId:previousRoundId},message=>message.type==='error');
  assert.equal(bypass.code,'USE_SETTLEMENT');
  const settlement=await sendAndWait(owner,{type:'settle',roundId:previousRoundId},message=>message.type==='settlement');
  assert.equal(settlement.triggered,true);
  assert.equal(settlement.card?.id,'R06');
  assert.equal(settlement.card?.effect,'本局损失筹码最多的玩家(们)的结算作废。');
  assert.notEqual(settlement.state.roundId,previousRoundId);
  assert.deepEqual(settlement.state.active,[]);

  const duplicate=await sendAndWait(owner,{type:'settle',roundId:previousRoundId},message=>message.type==='error');
  assert.equal(duplicate.code,'STALE_ROUND');
  owner.close();
  console.log(JSON.stringify({normalPoolExcluded:true,settlementGate:true,triggerSynced:true,duplicateBlocked:true}));
}finally{
  stop();
}
