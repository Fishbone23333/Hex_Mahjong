import {strict as assert} from 'node:assert';
import {spawn} from 'node:child_process';
import WebSocket from 'ws';

const port=3217,origin=`http://127.0.0.1:${port}`;
// Advance server time and invoke its real cleanup callback without a ten-minute wait.
const bootstrap=`
  const realNow=Date.now,realInterval=globalThis.setInterval,cleanupCallbacks=[];
  let offset=0;Date.now=()=>realNow()+offset;
  globalThis.setInterval=(fn,delay,...args)=>{
    if(delay===60000)cleanupCallbacks.push(fn);
    return realInterval(fn,delay,...args);
  };
  await import('./server.mjs');
  process.on('message',message=>{
    offset+=message.advanceMs;
    for(const fn of cleanupCallbacks)fn();
    process.send({advanced:true});
  });
`;
const server=spawn(process.execPath,['--input-type=module','--eval',bootstrap],{
  cwd:new URL('..',import.meta.url),
  env:{...process.env,PORT:String(port),HEX_DB_PATH:':memory:',NODE_NO_WARNINGS:'1'},
  stdio:['ignore','pipe','pipe','ipc']
});
const sockets=new Set();
const stop=()=>{for(const socket of sockets)socket.terminate();if(!server.killed)server.kill();};
process.on('exit',stop);
const ready=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('server startup timeout')),5000);
  server.stdout.on('data',data=>{if(data.toString().includes('Hex Mahjong lobby server')){clearTimeout(timer);resolve();}});
  server.stderr.on('data',data=>{clearTimeout(timer);reject(new Error(data.toString()));});
});
const waitFor=(ws,predicate,timeout=3000)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(new Error('message timeout'));},timeout);
  const handler=raw=>{const message=JSON.parse(raw.toString());if(predicate(message)){cleanup();resolve(message);}};
  const cleanup=()=>{clearTimeout(timer);ws.off('message',handler);};ws.on('message',handler);
});
const sendAndWait=(ws,payload,predicate)=>{const waiting=waitFor(ws,predicate);ws.send(JSON.stringify(payload));return waiting;};
const connect=async(clientId)=>{
  const ws=new WebSocket(`ws://127.0.0.1:${port}`,{origin});sockets.add(ws);
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  await sendAndWait(ws,{type:'hello',clientId},message=>message.type==='lobby');
  return ws;
};
const advance=advanceMs=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('clock advance timeout')),3000);
  server.once('message',()=>{clearTimeout(timer);resolve();});server.send({advanceMs});
});
const list=ws=>sendAndWait(ws,{type:'listRooms'},message=>message.type==='lobby');
const create=ws=>sendAndWait(ws,{type:'createRoom',password:'123456'},message=>message.type==='roomJoined');
const join=(ws,roomId)=>sendAndWait(ws,{type:'joinRoom',roomId,password:'123456'},message=>message.type==='roomJoined');
const leave=ws=>sendAndWait(ws,{type:'leaveRoom'},message=>message.type==='roomLeft');
const resume=(ws,clientId,previous)=>sendAndWait(ws,{type:'hello',clientId,roomId:previous.roomId,memberToken:previous.memberToken},message=>message.type==='roomJoined'||(message.type==='lobby'&&message.notice.includes('失效')));

try{
  await ready;
  const observer=await connect('lifecycle-observer');
  const owner=await connect('lifecycle-owner'),guest=await connect('lifecycle-guest');
  const created=await create(owner),joined=await join(guest,created.roomId);
  const empty=waitFor(observer,message=>message.type==='lobby'&&message.rooms.some(room=>room.id===created.roomId&&room.memberCount===0));
  owner.close();guest.close();await empty;
  await advance(5*60*1000);
  assert.ok((await list(observer)).rooms.some(room=>room.id===created.roomId),'five-minute lockscreen deleted room');
  const ownerAgain=await connect('lifecycle-owner');
  const restored=await resume(ownerAgain,'lifecycle-owner',created);
  assert.equal(restored.type,'roomJoined');assert.equal(restored.memberToken,created.memberToken);
  assert.deepEqual(restored.state,created.state,'reconnect changed the round');
  await leave(ownerAgain);
  assert.ok((await list(observer)).rooms.some(room=>room.id===created.roomId),'explicit exit deleted a disconnected member’s room');
  const guestAgain=await connect('lifecycle-guest');
  assert.equal((await resume(guestAgain,'lifecycle-guest',joined)).type,'roomJoined');
  await leave(guestAgain);
  assert.ok(!(await list(observer)).rooms.some(room=>room.id===created.roomId),'last explicit exit did not delete room');

  const second=await create(ownerAgain),secondGuest=await join(guestAgain,second.roomId);
  const disconnected=waitFor(ownerAgain,message=>message.type==='roomPresence'&&message.room.memberCount===1);
  guestAgain.close();await disconnected;
  await advance(9*60*1000);
  await sendAndWait(ownerAgain,{type:'reset',roundId:second.state.roundId},message=>message.type==='reset');
  await advance(60*1000+100);
  assert.ok((await list(observer)).rooms.some(room=>room.id===second.roomId),'recent gameplay did not preserve room');
  const expiredGuest=await connect('lifecycle-guest');
  const expired=await resume(expiredGuest,'lifecycle-guest',secondGuest);
  assert.equal(expired.type,'lobby');assert.match(expired.notice,/失效/,'expired identity resumed');
  await leave(ownerAgain);
  assert.ok(!(await list(observer)).rooms.some(room=>room.id===second.roomId),'expired identity prevented final exit cleanup');

  const third=await create(ownerAgain);
  const idleClosed=waitFor(ownerAgain,message=>message.type==='roomClosed');
  await advance(10*60*1000+100);
  assert.match((await idleClosed).reason,/10 分钟没有牌局操作/);
  assert.ok(!(await list(observer)).rooms.some(room=>room.id===third.roomId),'idle rule failed with an online player');
  console.log(JSON.stringify({fiveMinuteReconnect:true,retainedMemberPreventsDeletion:true,lastExplicitExitDeletes:true,disconnectedIdentityExpires:true,tenMinuteIdleRulePreserved:true}));
}finally{stop();}
