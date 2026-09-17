import {strict as assert} from 'node:assert';
import http from 'node:http';
import {spawn} from 'node:child_process';
import WebSocket from 'ws';

const port=3205,base=`http://127.0.0.1:${port}`,origin=base;
const server=spawn(process.execPath,['server.mjs'],{
  cwd:new URL('..',import.meta.url),
  env:{...process.env,PORT:String(port),HEX_DB_PATH:':memory:',SETTLEMENT_TRIGGER_RATE:'1',NODE_NO_WARNINGS:'1'},
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

function api(pathname,{method='GET',cookie='',csrf='',body}={}){
  return new Promise((resolve,reject)=>{
    const payload=body===undefined?null:Buffer.from(JSON.stringify(body));
    const headers={Accept:'application/json'};
    if(cookie)headers.Cookie=cookie;
    if(method!=='GET')headers.Origin=origin;
    if(csrf)headers['X-CSRF-Token']=csrf;
    if(payload){headers['Content-Type']='application/json';headers['Content-Length']=payload.length;}
    const request=http.request(base+pathname,{method,headers},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');let data={};try{data=text?JSON.parse(text):{};}catch{}
        const rawCookie=Array.isArray(response.headers['set-cookie'])?response.headers['set-cookie'][0]:response.headers['set-cookie'];
        resolve({status:response.statusCode,data,cookie:rawCookie?.split(';')[0]||'',headers:response.headers});
      });
    });
    request.on('error',reject);if(payload)request.write(payload);request.end();
  });
}

const connect=(cookie='')=>new Promise((resolve,reject)=>{
  const ws=new WebSocket(`ws://127.0.0.1:${port}`,{origin,headers:cookie?{Cookie:cookie}:{}});
  const timer=setTimeout(()=>{ws.terminate();reject(new Error('connect timeout'));},3000);
  ws.once('open',()=>{clearTimeout(timer);resolve(ws);});ws.once('error',reject);
});
const waitFor=(ws,predicate,timeout=3000)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(new Error('message timeout'));},timeout);
  const handler=raw=>{const message=JSON.parse(raw.toString());if(predicate(message)){cleanup();resolve(message);}};
  const cleanup=()=>{clearTimeout(timer);ws.off('message',handler);};ws.on('message',handler);
});
const sendAndWait=(ws,payload,predicate)=>{const waiting=waitFor(ws,predicate);ws.send(JSON.stringify(payload));return waiting;};

async function createCard(cookie,csrf,input){
  const response=await api('/api/private-cards',{method:'POST',cookie,csrf,body:input});assert.equal(response.status,201,response.data.message);return response.data.card;
}

try{
  await ready;
  const registered=await api('/api/auth/register',{method:'POST',body:{username:'牌桌设计师',password:'correct-horse-2026'}});
  assert.equal(registered.status,201);assert.ok(registered.cookie);assert.ok(registered.data.csrfToken);
  const cookie=registered.cookie,csrf=registered.data.csrfToken;
  const me=await api('/api/me',{cookie});assert.equal(me.data.user.username,'牌桌设计师');
  const login=await api('/api/auth/login',{method:'POST',body:{username:'牌桌设计师',password:'correct-horse-2026'}});assert.equal(login.status,200);assert.ok(login.cookie);

  const wrongCurrentPassword=await api('/api/auth/password',{method:'POST',cookie,csrf,body:{currentPassword:'wrong-password-2026',newPassword:'new-correct-horse-2026'}});
  assert.equal(wrongCurrentPassword.status,401);assert.equal(wrongCurrentPassword.data.error,'CURRENT_PASSWORD_WRONG');
  const changedPassword=await api('/api/auth/password',{method:'POST',cookie,csrf,body:{currentPassword:'correct-horse-2026',newPassword:'new-correct-horse-2026'}});
  assert.equal(changedPassword.status,200);assert.equal(changedPassword.data.ok,true);
  const currentSessionAfterChange=await api('/api/me',{cookie});assert.equal(currentSessionAfterChange.data.user.username,'牌桌设计师');
  const otherSessionAfterChange=await api('/api/me',{cookie:login.cookie});assert.equal(otherSessionAfterChange.data.user,null);
  const oldPasswordLogin=await api('/api/auth/login',{method:'POST',body:{username:'牌桌设计师',password:'correct-horse-2026'}});assert.equal(oldPasswordLogin.status,401);assert.equal(oldPasswordLogin.data.error,'INVALID_CREDENTIALS');
  const newPasswordLogin=await api('/api/auth/login',{method:'POST',body:{username:'牌桌设计师',password:'new-correct-horse-2026'}});assert.equal(newPasswordLogin.status,200);assert.ok(newPasswordLogin.cookie);

  const rejectedCsrf=await api('/api/private-cards',{method:'POST',cookie,body:{name:'无效请求',effect:'不应保存',glyph:'×',rarity:'standard',recommendedTiming:'any'}});
  assert.equal(rejectedCsrf.status,403);assert.equal(rejectedCsrf.data.error,'CSRF_REJECTED');

  const openingA=await createCard(cookie,csrf,{name:'开门见喜',effect:'开局测试卡。',glyph:'开',rarity:'standard',recommendedTiming:'opening'});
  const openingB=await createCard(cookie,csrf,{name:'二次开门',effect:'第二个开局节点测试卡。',glyph:'二',rarity:'standard',recommendedTiming:'opening'});
  const afterA=await createCard(cookie,csrf,{name:'胜后余波',effect:'胡牌后测试卡。',glyph:'胜',rarity:'challenge',recommendedTiming:'afterWin'});
  const afterB=await createCard(cookie,csrf,{name:'再胜余波',effect:'第二个胡牌后节点测试卡。',glyph:'再',rarity:'standard',recommendedTiming:'afterWin'});
  const late=await createCard(cookie,csrf,{name:'终盘奇迹',effect:'保留为纯文本：<script>alert(1)</script>',glyph:'终',rarity:'prismatic',recommendedTiming:'lateGame'});
  assert.equal(late.effect,'保留为纯文本:<script>alert(1)</script>');

  const fiveNodes=[
    {id:'open_a',name:'起手准备',description:'第一步',type:'opening'},
    {id:'open_b',name:'换牌之后',description:'第二步',type:'opening'},
    {id:'win_a',name:'第一家胡牌',description:'第三步',type:'afterWin'},
    {id:'win_b',name:'第二家胡牌',description:'第四步',type:'afterWin'},
    {id:'finale',name:'终盘',description:'第五步',type:'lateGame'}
  ];
  const fiveCards=[openingA,openingB,afterA,afterB,late].map(card=>({source:'private',id:card.id,assignmentMode:'auto',nodeIds:[]}));
  const fivePool=await api('/api/pools',{method:'POST',cookie,csrf,body:{name:'五节点测试池',description:'最多五个节点',nodes:fiveNodes,cards:fiveCards}});
  assert.equal(fivePool.status,201,fivePool.data.message);assert.equal(fivePool.data.pool.nodes.length,5);
  const sixPool=await api('/api/pools',{method:'POST',cookie,csrf,body:{name:'六节点非法池',description:'',nodes:[...fiveNodes,{id:'too_many',name:'多余节点',description:'',type:'custom'}],cards:fiveCards}});
  assert.equal(sixPool.status,400);assert.equal(sixPool.data.error,'INVALID_NODE_COUNT');

  const threeNodes=[fiveNodes[0],fiveNodes[2],fiveNodes[4]];
  const threeCards=[openingA,afterA,late].map(card=>({source:'private',id:card.id,assignmentMode:'auto',nodeIds:[]}));
  const threePool=await api('/api/pools',{method:'POST',cookie,csrf,body:{name:'三节点私人池',description:'房间同步测试',nodes:threeNodes,cards:threeCards}});
  assert.equal(threePool.status,201,threePool.data.message);

  const revoked=await connect(newPasswordLogin.cookie);revoked.send(JSON.stringify({type:'hello',clientId:'revoked-session'}));
  const loggedOut=await api('/api/auth/logout',{method:'POST',cookie:newPasswordLogin.cookie,csrf:newPasswordLogin.data.csrfToken,body:{}});assert.equal(loggedOut.status,200);
  const revokedAttempt=await sendAndWait(revoked,{type:'createRoom',password:'123456',poolId:threePool.data.pool.id},message=>message.type==='error');assert.equal(revokedAttempt.code,'LOGIN_REQUIRED');revoked.close();

  const second=await api('/api/auth/register',{method:'POST',body:{username:'另一位玩家',password:'another-password-2026'}});
  assert.equal(second.status,201);const secondCards=await api('/api/private-cards',{cookie:second.cookie});const secondPools=await api('/api/pools',{cookie:second.cookie});
  assert.deepEqual(secondCards.data.cards,[]);assert.deepEqual(secondPools.data.pools,[]);

  const visitor=await connect();visitor.send(JSON.stringify({type:'hello',clientId:'visitor'}));
  const loginRequired=await sendAndWait(visitor,{type:'createRoom',password:'123456',poolId:threePool.data.pool.id},message=>message.type==='error');
  assert.equal(loginRequired.code,'LOGIN_REQUIRED');

  const owner=await connect(cookie);owner.send(JSON.stringify({type:'hello',clientId:'account-owner'}));
  const created=await sendAndWait(owner,{type:'createRoom',password:'123456',poolId:threePool.data.pool.id},message=>message.type==='roomJoined');
  assert.equal(created.config.poolName,'三节点私人池');assert.deepEqual(created.config.phases.map(phase=>phase.id),['open_a','win_a','finale']);
  assert.ok(created.config.cards.every(card=>card.custom));
  const joined=await sendAndWait(visitor,{type:'joinRoom',roomId:created.roomId,password:'123456'},message=>message.type==='roomJoined');
  assert.deepEqual(joined.config,created.config);

  const outOfOrder=await sendAndWait(owner,{type:'draw',phase:'win_a'},message=>message.type==='error');assert.equal(outOfOrder.code,'PHASE_NOT_ALLOWED');
  const first=await sendAndWait(owner,{type:'draw',phase:'open_a'},message=>message.type==='drawn');assert.equal(first.card.id,openingA.id);assert.equal(first.state.phase,'win_a');
  const secondDraw=await sendAndWait(owner,{type:'draw',phase:'win_a'},message=>message.type==='drawn');assert.equal(secondDraw.card.id,afterA.id);assert.equal(secondDraw.state.phase,'finale');
  const third=await sendAndWait(owner,{type:'draw',phase:'finale'},message=>message.type==='drawn');assert.equal(third.card.id,late.id);
  const settlement=await sendAndWait(owner,{type:'settle',roundId:third.state.roundId},message=>message.type==='settlement');assert.equal(settlement.triggered,false);

  owner.close();visitor.close();
  console.log(JSON.stringify({registration:true,login:true,passwordChange:true,otherSessionsRevoked:true,csrf:true,revokedSessionBlocked:true,privateIsolation:true,fiveNodes:true,sixNodesRejected:true,privatePoolRoom:true,guestConfigSync:true,nodeOrder:true,noSettlementCardMeansNoTrigger:true}));
}finally{stop();}
