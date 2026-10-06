import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import WebSocket from 'ws';
import {createAccountStore} from '../lib/account-store.mjs';
import {derivePassword,RateLimiter,readSessionCookie} from '../lib/security.mjs';
import {canDrawSequence,searchBudget} from '../lib/card-search.mjs';

let now=0;const limiter=new RateLimiter({maxEntries:2,now:()=>now});
assert.equal(limiter.take('a',1,10),true);assert.equal(limiter.take('a',1,10),false);
assert.equal(limiter.take('b',1,10),true);assert.equal(limiter.take('c',1,10),false);
now=11;assert.equal(limiter.take('a',1,10),true);limiter.cleanup();assert.equal(limiter.entries.size,1);
assert.equal(readSessionCookie({headers:{cookie:'unrelated=%; hex_session=abc'}}),'');
assert.equal(readSessionCookie({headers:{cookie:'hex_session='+'a'.repeat(43)+'; hex_session='+'a'.repeat(43)}}),'');
const passwordJobs=await Promise.allSettled(Array.from({length:30},()=>derivePassword('password-2026','salt',64)));
assert.ok(passwordJobs.some(item=>item.status==='rejected'&&item.reason.code==='PASSWORD_BUSY'));

const nodes=Array.from({length:5},(_,i)=>({id:'n'+i,name:'节点'+i,type:'custom'}));
const hardCards=Array.from({length:120},(_,i)=>({id:'test'+i,tags:i===119?['n3','n4']:['n0','n1','n2']}));
assert.equal(canDrawSequence(nodes,hardCards),false);
assert.throws(()=>canDrawSequence(nodes,hardCards,[],searchBudget({maxSteps:1})),issue=>issue.code==='POOL_TOO_COMPLEX');
assert.equal(canDrawSequence(nodes,[{id:'terminal',tags:['n0'],lockFurtherDraws:true}]),true);
assert.equal(canDrawSequence([{id:'n0'}],[{id:'P31',tags:['n0']}]),false,'Firepower needs three eligible bonuses');

const quotaStore=createAccountStore({databasePath:':memory:',maxCards:2,maxPools:1,maxSessions:2});
const quotaUser=await quotaStore.register('限额玩家','quota-password-2026');
const input={name:'测试卡',effect:'测试',glyph:'✦',rarity:'standard',recommendedTiming:'any'};
quotaStore.createCard(quotaUser.id,input);const second=quotaStore.createCard(quotaUser.id,input);
assert.throws(()=>quotaStore.createCard(quotaUser.id,input),issue=>issue.code==='CARD_QUOTA');
assert.ok(quotaStore.updateCard(quotaUser.id,second.id,{...input,name:'配额内修改'}));
const poolInput={name:'测试池',description:'',nodes:[nodes[0]],cards:[]};quotaStore.createPool(quotaUser.id,poolInput);
assert.throws(()=>quotaStore.createPool(quotaUser.id,poolInput),issue=>issue.code==='POOL_QUOTA');
const firstSession=quotaStore.createSession(quotaUser.id);quotaStore.createSession(quotaUser.id);const currentSession=quotaStore.createSession(quotaUser.id);
assert.equal(quotaStore.session(firstSession.token),null);
const currentHash=quotaStore.session(currentSession.token).tokenHash;
const passwordRace=await Promise.all([quotaStore.changePassword(quotaUser.id,'quota-password-2026','new-password-one',currentHash),quotaStore.changePassword(quotaUser.id,'quota-password-2026','new-password-two',currentHash)]);
assert.equal(passwordRace.filter(Boolean).length,1,'Concurrent password changes must not both succeed');quotaStore.close();

const folder=await mkdtemp(path.join(os.tmpdir(),'hex-hardening-')),filename=path.join(folder,'test.sqlite');
const store=createAccountStore({databasePath:filename});
const user=await store.register('压力测试玩家','audit-password-2026'),auth=store.createSession(user.id);
const refs=hardCards.map((card,index)=>({source:'private',id:store.createCard(user.id,{...input,name:'卡牌'+index}).id,assignmentMode:'custom',nodeIds:card.tags}));
store.close();
const port=3221,origin=`http://127.0.0.1:${port}`,cookie='hex_session='+auth.token;
const bootstrap=`const realNow=Date.now;let offset=0;Date.now=()=>realNow()+offset;Math.random=()=>0.2;await import('./server.mjs');process.on('message',m=>{offset+=m.advanceMs;process.send({advanced:true});});`;
const server=spawn(process.execPath,['--input-type=module','--eval',bootstrap],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),HEX_DB_PATH:filename,HEX_MAX_PRIVATE_CARDS:'120',NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe','ipc']});
const sockets=new Set();let stderr='';server.stderr.on('data',data=>{stderr+=data;});
function api(pathname,{method='GET',body,cookieValue=cookie,headers={}}={}){
  return new Promise((resolve,reject)=>{
    const payload=body===undefined?null:JSON.stringify(body);
    const req=http.request(origin+pathname,{method,headers:{Origin:origin,Cookie:cookieValue,'X-CSRF-Token':auth.csrfToken,...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}),...headers}},response=>{
      let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>{let data;try{data=JSON.parse(text);}catch{data=text;}resolve({status:response.statusCode,data,headers:response.headers});});
    });req.on('error',reject);req.end(payload);
  });
}
const wait=(ws,predicate)=>new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{ws.off('message',onMessage);reject(new Error('WS timeout'));},3000);function onMessage(raw){const message=JSON.parse(raw);if(predicate(message)){clearTimeout(timeout);ws.off('message',onMessage);resolve(message);}}ws.on('message',onMessage);});
const send=(ws,payload,type)=>{const waiting=wait(ws,m=>m.type===type);ws.send(JSON.stringify(payload));return waiting;};
async function connect(cookieValue=''){
  const ws=new WebSocket(origin.replace('http:','ws:'),{origin,headers:{Cookie:cookieValue}});sockets.add(ws);
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});return ws;
}
try{
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error(stderr||'Startup timeout')),5000);server.stdout.on('data',chunk=>{if(String(chunk).includes('Hex Mahjong lobby server')){clearTimeout(timeout);resolve();}});});
  const owner=await connect();await send(owner,{type:'hello',clientId:'audit-owner'},'lobby');
  const created=await send(owner,{type:'createRoom',password:'123456'},'roomJoined');
  assert.equal((await send(owner,{type:'reset'},'error')).code,'STALE_ROUND','Reset without a round ID must be rejected');
  assert.equal((await send(owner,{type:'reset',roundId:'previous-round'},'error')).code,'STALE_ROUND');
  for(const malformed of ['unrelated=%','hex_session=%',cookie+'; '+cookie]){
    const bad=await connect(malformed);await send(bad,{type:'hello',clientId:'bad-cookie'},'lobby');bad.close();
    assert.equal((await api('/api/me',{cookieValue:malformed})).data.user,null);
  }
  assert.equal((await api('/api/me',{cookieValue:'unrelated=%; '+cookie})).data.user.id,user.id);
  const hostilePool={name:'计算压力池',nodes,cards:refs};const started=performance.now();
  const [invalid,alive]=await Promise.all([api('/api/pools',{method:'POST',body:hostilePool}),send(owner,{type:'listRooms'},'lobby')]);
  assert.equal(invalid.status,400);assert.equal(invalid.data.error,'POOL_SEQUENCE_UNPLAYABLE');assert.ok(performance.now()-started<1000,'Pathological pool still stalls the server');
  assert.ok(alive.rooms.some(room=>room.id===created.roomId));
  const firstPage=await api('/api/private-cards?limit=100'),lastPage=await api('/api/private-cards?offset=100');
  assert.equal(firstPage.data.cards.length,100);assert.equal(firstPage.data.nextOffset,100);assert.equal(lastPage.data.cards.length,20);assert.equal(lastPage.data.nextOffset,null);
  for(const url of ['/api/me','/api/studio','/api/pools','/api/no-such-api'])assert.equal((await api(url)).headers['cache-control'],'private, no-store');
  const oversized=await api('/api/private-cards',{method:'POST',body:{...input,effect:'x'.repeat(70000)}});assert.equal(oversized.status,413);
  const quotaAttempts=await Promise.all([api('/api/private-cards',{method:'POST',body:input}),api('/api/private-cards',{method:'POST',body:input})]);
  assert.ok(quotaAttempts.every(result=>result.status===409&&result.data.error==='CARD_QUOTA'));assert.equal((await api('/api/private-cards')).data.total,120);
  const html=await api('/');const csp=html.headers['content-security-policy'];
  assert.ok(csp.includes("'sha256-"));assert.ok(!csp.split('style-src')[0].includes('unsafe-inline'));assert.ok(!csp.includes(' ws: wss:'));
  assert.ok(!html.data.includes('onclick='));
  for(let i=0;i<6;i++){const result=await api('/api/auth/password',{method:'POST',body:{currentPassword:'wrong-password',newPassword:'new-password-2026'}});assert.equal(result.status,i<5?401:429);}
  let current=owner;
  for(let i=0;i<5;i++){
    const next=await connect(),replaced=wait(current,m=>m.type==='sessionReplaced');
    const resumed=await send(next,{type:'hello',clientId:'audit-owner',roomId:created.roomId,memberToken:created.memberToken},'roomJoined');
    await replaced;assert.equal(resumed.room.memberCount,1);assert.equal(resumed.room.seatCount,1);current=next;
  }
  const ghost=await send(current,{type:'hello',clientId:'new-identity'},'error');assert.equal(ghost.code,'IDENTITY_FIXED');
  const guests=[];for(let i=0;i<3;i++){const guest=await connect();await send(guest,{type:'hello',clientId:'guest'+i},'lobby');const joined=await send(guest,{type:'joinRoom',roomId:created.roomId,password:'123456'},'roomJoined');assert.ok(joined.room.memberCount<=4);guests.push(guest);}
  const fifth=await connect();assert.equal((await send(fifth,{type:'joinRoom',roomId:created.roomId,password:'123456'},'error')).code,'ROOM_FULL');
  await send(guests[0],{type:'leaveRoom'},'roomLeft');
  for(let i=0;i<5;i++){const bad=await send(fifth,{type:'joinRoom',roomId:created.roomId,password:'000000'},'error');assert.equal(bad.code,i<4?'BAD_PASSWORD':'JOIN_LOCKED');}
  // A different source with the correct password must not inherit a whole-room lock.
  const otherIp=new WebSocket(origin.replace('http:','ws:'),{origin,headers:{'X-Real-IP':'192.0.2.15'}});sockets.add(otherIp);await new Promise((resolve,reject)=>{otherIp.once('open',resolve);otherIp.once('error',reject);});
  assert.equal((await send(otherIp,{type:'joinRoom',roomId:created.roomId,password:'123456'},'roomJoined')).room.memberCount,4);
  for(const guest of guests.slice(1))await send(guest,{type:'leaveRoom'},'roomLeft');await send(otherIp,{type:'leaveRoom'},'roomLeft');await send(current,{type:'leaveRoom'},'roomLeft');
  const reused=await send(current,{type:'createRoom',password:'123456'},'roomJoined');assert.equal(reused.roomId,created.roomId);
  assert.equal((await send(fifth,{type:'joinRoom',roomId:reused.roomId,password:'123456'},'roomJoined')).room.memberCount,2,'Reused room number inherited the old IP lock');
  await send(fifth,{type:'leaveRoom'},'roomLeft');
  for(let i=0;i<4;i++)assert.equal((await send(fifth,{type:'joinRoom',roomId:reused.roomId,password:'000000'},'error')).code,'BAD_PASSWORD');
  await new Promise(resolve=>{server.once('message',resolve);server.send({advanceMs:10*60*1000+1});});
  assert.equal((await send(fifth,{type:'joinRoom',roomId:reused.roomId,password:'000000'},'error')).code,'BAD_PASSWORD','Expired sub-threshold failures were retained');
  assert.equal((await api('/api/me')).status,200);assert.equal(server.exitCode,null);assert.equal(stderr,'');
  console.log(JSON.stringify({malformedCookiesSafe:true,boundedPoolSearch:true,quotas:true,pagination:true,passwordQueueBounded:true,passwordRateLimit:true,passwordRaceSafe:true,privateNoStore:true,scriptHashes:true,atomicMemberTakeover:true,fourSeats:true,noGlobalRoomLock:true,rateExpiry:true,roomIdReuseSafe:true}));
}finally{for(const ws of sockets)ws.terminate();server.kill();await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));await rm(folder,{recursive:true,force:true});}
