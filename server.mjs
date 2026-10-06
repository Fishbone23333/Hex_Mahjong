import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes, randomInt, createHash, timingSafeEqual} from 'node:crypto';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {readFile, stat} from 'node:fs/promises';
import {brotliCompress, constants as zlibConstants, gzip} from 'node:zlib';
import {promisify} from 'node:util';
import {WebSocketServer} from 'ws';
import cards from './cards.json' with {type:'json'};
import {createAccountStore} from './lib/account-store.mjs';
import {derivePassword,RateLimiter,readSessionCookie} from './lib/security.mjs';
import {cardsConflict,canDrawSequence,canCompleteSet,searchBudget} from './lib/card-search.mjs';
import {createMailer,normalizeEmail} from './lib/email.mjs';

if(process.platform!=='win32')process.umask(0o077);

const root=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PORT||3000);
const host=String(process.env.HOST||'127.0.0.1');
const defaultPhases=[
  {id:'opening',name:'开局',desc:'换三张前',title:'开局海克斯',detail:'在换三张之前，翻开第一张场地效果。'},
  {id:'firstWin',name:'第一家胡牌',desc:'胡牌结算后',title:'胡牌后海克斯',detail:'第一家胡牌结算后，翻开一张影响下一阶段牌局的效果。'},
  {id:'secondWin',name:'第二家胡牌',desc:'进入后半场',title:'后半场海克斯',detail:'第二家胡牌结算后，翻开最后一张节点效果。'}
];
const suits=['万','筒','条'];
const tileNumbers=['一','二','三','四','五','六','七','八','九'];
const tileFaces=suits.flatMap(suit=>tileNumbers.map(number=>number+suit));
const ROOM_IDLE_MS=10*60*1000;
const DISCONNECT_GRACE_MS=10*60*1000;
const MAX_ROOM_MEMBERS=4;
const IP_FAIL_LIMIT=5,IP_LOCK_MS=10*60*1000;
const MAX_ROOMS=200;
const ROOM_CREATE_WINDOW_MS=10*60*1000,MAX_ROOM_CREATIONS_PER_WINDOW=5;
const MESSAGE_WINDOW_MS=10*1000,MAX_MESSAGES_PER_WINDOW=80;
const MAX_TOTAL_CONNECTIONS=500,MAX_CONNECTIONS_PER_IP=20,MAX_WS_PAYLOAD=16*1024;
const HEARTBEAT_MS=30*1000;
const SETTLEMENT_TRIGGER_RATE=Math.min(1,Math.max(0,Number(process.env.SETTLEMENT_TRIGGER_RATE??0.03)));
const SOUL_TRANSFER_TRIGGER_RATE=Math.min(1,Math.max(0,Number(process.env.SOUL_TRANSFER_TRIGGER_RATE??0.03)));
const DEFAULT_SETTLEMENT_CARD=cards.find(card=>card.id==='R06');
const TURN_TIMER_SECONDS=Object.freeze({R05:7,R02:8});
const ROUND_TIMER_SECONDS=Object.freeze({R03:60});
const RECENT_GAME_MULTIPLIERS=Object.freeze([0.35,0.6,0.8]);
const MIN_RECENT_CARD_WEIGHT=0.1;
const brotliAsync=promisify(brotliCompress),gzipAsync=promisify(gzip);

if(!DEFAULT_SETTLEMENT_CARD)throw new Error('Missing settlement card R06');
function envNumber(name,fallback,min=1,max=100000){const value=Number(process.env[name]??fallback);if(!Number.isFinite(value)||value<min||value>max)throw new Error('Invalid '+name);return Math.floor(value);}
const production=process.env.NODE_ENV==='production';
const cookieName=process.env.HEX_COOKIE_NAME||'hex_session';
const cookiePath=process.env.HEX_BASE_PATH||'/';
if(!/^[A-Za-z0-9_-]+$/.test(cookieName)||!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(cookiePath))throw new Error('Invalid cookie configuration');
const configuredOrigins=String(process.env.ALLOWED_ORIGINS||'').split(',').map(value=>value.trim()).filter(Boolean);
if(configuredOrigins.length>10||configuredOrigins.some(origin=>new URL(origin).origin!==origin))throw new Error('ALLOWED_ORIGINS must contain canonical origins');
const allowedHosts=configuredOrigins.map(origin=>new URL(origin).host.toLowerCase());
if(production&&(!configuredOrigins.length||configuredOrigins.some(origin=>!origin.startsWith('https://'))))throw new Error('Production requires HTTPS ALLOWED_ORIGINS');
const accountStore=createAccountStore({databasePath:process.env.HEX_DB_PATH||path.join(root,'data','hex-mahjong.sqlite'),maxCards:envNumber('HEX_MAX_PRIVATE_CARDS',200,1,2000),maxPools:envNumber('HEX_MAX_POOLS',30,1,200),maxUsers:envNumber('HEX_MAX_USERS',5000),maxSessions:envNumber('HEX_MAX_SESSIONS',10,1,30)});
const mailer=createMailer({production});
const mailBaseUrl=new URL(process.env.MAIL_PUBLIC_BASE_URL||cookiePath,configuredOrigins[0]||`http://${host==='0.0.0.0'?'127.0.0.1':host}:${port}`);
if(!['http:','https:'].includes(mailBaseUrl.protocol)||mailBaseUrl.username||mailBaseUrl.password||mailBaseUrl.search||mailBaseUrl.hash||!mailBaseUrl.pathname.endsWith('/')||(production&&(mailBaseUrl.protocol!=='https:'||!configuredOrigins.includes(mailBaseUrl.origin))))throw new Error('Invalid MAIL_PUBLIC_BASE_URL');
const initialState=(phaseList=defaultPhases)=>({roundId:randomBytes(12).toString('base64url'),phase:phaseList[0]?.id||'opening',used:[],active:[],history:[],triggered:[],locked:false,turnTimer:{armed:false,started:false,endsAt:null,revision:0,cardId:null,durationSeconds:7},roundTimer:{armed:false,started:false,endsAt:null,revision:0,cardId:null,durationSeconds:60},version:0});
const rooms=new Map();
const connections=new Map();
const ipFailures=new Map();
const roomCreations=new Map();
const rateLimits=new RateLimiter();
let lobbyBroadcastTimer=null;
const loopDelay=monitorEventLoopDelay({resolution:20});loopDelay.enable();
function logEvent(event,fields={}){console.log(JSON.stringify({time:new Date().toISOString(),event,...fields}));}
function logIssue(event,issue){logEvent(event,{code:issue?.code||'INTERNAL_ERROR'});}
function enforceRate(key,limit,windowMs=60000){if(!rateLimits.take(key,limit,windowMs))throw problem('RATE_LIMIT','操作过于频繁，请稍后再试。',429);}
const NODE_TYPES=new Set(['opening','inGame','afterWin','lateGame','custom']);
const CARD_RARITIES=new Set(['standard','challenge','prismatic']);
const CARD_TIMINGS=new Set(['any','opening','afterWin','lateGame']);

function problem(code,message,status=400){const error=new Error(message);error.code=code;error.status=status;return error;}
function cleanText(value,maxLength){return String(value??'').normalize('NFKC').trim().slice(0,maxLength);}
function validateUsername(value){const username=cleanText(value,24);if(!/^[\p{L}\p{N}_-]{3,24}$/u.test(username))throw problem('INVALID_USERNAME','用户名需为 3～24 位文字、数字、下划线或短横线。');return username;}
function validateAccountPassword(value){const password=String(value??'');if(password.length<8||password.length>72)throw problem('INVALID_ACCOUNT_PASSWORD','账号密码需为 8～72 位。');return password;}
function sanitizePrivateCard(input){
  const name=cleanText(input?.name,30),effect=cleanText(input?.effect,500),glyph=cleanText(input?.glyph||'✦',4),rarity=String(input?.rarity||'standard'),recommendedTiming=String(input?.recommendedTiming||'any');
  if(!name)throw problem('CARD_NAME_REQUIRED','请填写卡牌名称。');if(!effect)throw problem('CARD_EFFECT_REQUIRED','请填写卡牌效果。');
  if(!CARD_RARITIES.has(rarity))throw problem('INVALID_CARD_RARITY','无法识别卡牌稀有度。');if(!CARD_TIMINGS.has(recommendedTiming))throw problem('INVALID_CARD_TIMING','无法识别出现节点。');
  return {name,effect,glyph,rarity,recommendedTiming};
}
function privateCardRuntime(card){return {id:card.id,name:card.name,effect:card.effect,scope:'本局',glyph:card.glyph,challenge:card.rarity==='challenge',prismatic:card.rarity==='prismatic',custom:true,recommendedTiming:card.recommendedTiming};}
function defaultRoomConfig(){return {poolId:null,poolName:'官方川麻卡池',phases:structuredClone(defaultPhases),cards:structuredClone(cards)};}
function automaticNodeIds(card,timing,nodes){
  if(card.tags?.includes('settlement')||timing==='settlement')return ['settlement'];
  const ids=nodes.map(node=>node.id),byType=type=>nodes.filter(node=>node.type===type).map(node=>node.id);
  if(card.tags?.includes('any')||timing==='any')return ids;
  if(card.tags?.includes('opening')||timing==='opening')return byType('opening').length?byType('opening'):[ids[0]];
  if(card.tags?.includes('firstWin')||card.tags?.includes('secondWin')){
    const afterWin=byType('afterWin');
    const targets=[];
    if(card.tags.includes('firstWin'))targets.push(afterWin[0]||ids[1]||ids[0]);
    if(card.tags.includes('secondWin'))targets.push(afterWin[1]||byType('lateGame')[0]||ids.at(-1));
    return [...new Set(targets)];
  }
  if(timing==='afterWin')return byType('afterWin').length?byType('afterWin'):[ids[Math.min(1,ids.length-1)]];
  if(timing==='lateGame')return byType('lateGame').length?byType('lateGame'):[ids.at(-1)];
  return ids;
}
function sanitizePoolInput(userId,input){
  const name=cleanText(input?.name,30),description=cleanText(input?.description,160),rawNodes=Array.isArray(input?.nodes)?input.nodes:[],rawCards=Array.isArray(input?.cards)?input.cards:[];
  if(!name)throw problem('POOL_NAME_REQUIRED','请填写卡池名称。');if(rawNodes.length<1||rawNodes.length>5)throw problem('INVALID_NODE_COUNT','每个卡池需要设置 1～5 个抽取节点。');
  const nodeIds=new Set(),nodes=rawNodes.map((node,index)=>{const id=cleanText(node?.id||`node_${index+1}`,40),nodeName=cleanText(node?.name,18),nodeDescription=cleanText(node?.desc??node?.description,80),type=String(node?.type||'custom');if(!/^[A-Za-z0-9_-]{1,40}$/.test(id)||nodeIds.has(id))throw problem('INVALID_NODE_ID','抽取节点标识无效或重复。');if(!nodeName)throw problem('NODE_NAME_REQUIRED','每个抽取节点都需要名称。');if(!NODE_TYPES.has(type))throw problem('INVALID_NODE_TYPE','无法识别抽取节点类型。');nodeIds.add(id);return {id,name:nodeName,desc:nodeDescription,title:nodeName+'海克斯',detail:nodeDescription||('在“'+nodeName+'”时抽取一张海克斯。'),type,order:index+1};});
  if(rawCards.length<1||rawCards.length>120)throw problem('INVALID_POOL_SIZE','卡池需要包含 1～120 张卡牌。');
  const seen=new Set(),poolCards=rawCards.map(ref=>{const source=ref?.source==='private'?'private':'official',id=cleanText(ref?.id,48),key=source+'|'+id,assignmentMode=ref?.assignmentMode==='custom'?'custom':'auto',customNodeIds=assignmentMode==='custom'?[...new Set((Array.isArray(ref?.nodeIds)?ref.nodeIds:[]).map(value=>cleanText(value,40)).filter(value=>nodeIds.has(value)))]:[];if(!id||seen.has(key))throw problem('DUPLICATE_POOL_CARD','卡池中存在无效或重复卡牌。');seen.add(key);const card=source==='private'?accountStore.getCard(userId,id):cards.find(item=>item.id===id);if(!card)throw problem('POOL_CARD_NOT_FOUND','卡池中包含不存在或无权使用的卡牌。',404);if(source==='private'&&assignmentMode!=='custom')throw problem('PRIVATE_CARD_NODE_REQUIRED','DIY 海克斯必须手动选择出现节点。');if(assignmentMode==='custom'&&!customNodeIds.length&&!card.tags?.includes('settlement'))throw problem('CARD_NODE_REQUIRED','手动分配的卡牌至少需要选择一个节点。');return {source,id,assignmentMode,nodeIds:customNodeIds};});
  return {name,description,nodes,cards:poolCards};
}
function compilePoolConfig(userId,pool){
  const runtimeCards=pool.cards.map(ref=>{const sourceCard=ref.source==='private'?accountStore.getCard(userId,ref.id):cards.find(card=>card.id===ref.id);if(!sourceCard)return null;const card=ref.source==='private'?privateCardRuntime(sourceCard):structuredClone(sourceCard);if(ref.source==='private')card.tags=(Array.isArray(ref.nodeIds)?ref.nodeIds:[]).filter(id=>pool.nodes.some(node=>node.id===id));else card.tags=ref.assignmentMode==='custom'&&!card.tags?.includes('settlement')?ref.nodeIds.filter(id=>pool.nodes.some(node=>node.id===id)):automaticNodeIds(card,null,pool.nodes);return card;}).filter(Boolean);
  const drawable=runtimeCards.filter(card=>!card.tags.includes('settlement'));if(!drawable.length)throw problem('POOL_HAS_NO_DRAWABLE_CARDS','该卡池没有可在普通节点抽取的卡牌。');
  const emptyNodes=pool.nodes.filter(node=>!drawable.some(card=>card.tags.includes(node.id)));if(emptyNodes.length)throw problem('POOL_NODE_EMPTY','以下节点没有可抽卡牌：'+emptyNodes.map(node=>node.name).join('、'));
  if(!canDrawSequence(pool.nodes,drawable,[]))throw problem('POOL_SEQUENCE_UNPLAYABLE','卡牌数量或节点分配无法保证每个节点都能抽到不同且不冲突的海克斯。');
  return {poolId:pool.id,poolName:pool.name,phases:pool.nodes.map(node=>({id:node.id,name:node.name,desc:node.desc,title:node.title,detail:node.detail,type:node.type})),cards:runtimeCards,poolVersion:pool.version};
}
function buildRoomConfig(userId,poolId){
  if(!poolId)return defaultRoomConfig();if(!userId)throw problem('LOGIN_REQUIRED','登录账号后才能使用私人卡池。',401);
  const pool=accountStore.getPool(userId,poolId);if(!pool)throw problem('POOL_NOT_FOUND','卡池不存在或不属于当前账号。',404);
  return compilePoolConfig(userId,pool);
}

function randomPick(items){return items[Math.floor(Math.random()*items.length)];}
function recentCardWeight(room,cardId){
  let weight=1;
  for(let index=0;index<RECENT_GAME_MULTIPLIERS.length;index++)if(room.recentGames?.[index]?.includes(cardId))weight*=RECENT_GAME_MULTIPLIERS[index];
  return Math.max(MIN_RECENT_CARD_WEIGHT,weight);
}
function weightedCardPick(room,items){
  const weighted=items.map(card=>({card,weight:recentCardWeight(room,card.id)})),total=weighted.reduce((sum,item)=>sum+item.weight,0);
  let target=Math.random()*total;
  for(const item of weighted){target-=item.weight;if(target<0)return item.card;}
  return weighted.at(-1)?.card;
}
function rememberRound(room){
  const settlementIds=new Set(room.cardPool.filter(card=>card.tags?.includes('settlement')).map(card=>card.id));
  const cardIds=[...new Set(room.state.used.filter(id=>!settlementIds.has(id)))];
  if(cardIds.length)room.recentGames=[cardIds,...(room.recentGames||[])].slice(0,RECENT_GAME_MULTIPLIERS.length);
}
async function hashPassword(password,salt){return derivePassword(password,salt,32);}
async function passwordMatches(room,password){const candidate=await hashPassword(password,room.passwordSalt);return candidate.length===room.passwordHash.length&&timingSafeEqual(candidate,room.passwordHash);}
function makeRoomId(){for(let i=0;i<100;i++){const id=String(1000+Math.floor(Math.random()*9000));if(!rooms.has(id))return id;}return null;}
function makeToken(){return randomBytes(18).toString('base64url');}
function normalizeIp(address='unknown'){address=String(address||'unknown').trim();return address.startsWith('::ffff:')?address.slice(7):address;}
function isLoopback(value){
  let address=normalizeIp(value).toLowerCase();
  if(address==='::1')return true;
  if(address.startsWith('[')){const end=address.indexOf(']');if(end>0)address=address.slice(1,end);}
  else if((address.match(/:/g)||[]).length===1)address=address.split(':')[0];
  return address==='127.0.0.1'||address==='localhost';
}
function firstHeader(value){return String(Array.isArray(value)?value[0]:(value||'')).split(',')[0].trim();}
function clientIp(request){
  const remote=normalizeIp(request?.socket?.remoteAddress);
  if(isLoopback(remote)){
    const real=firstHeader(request?.headers?.['x-real-ip']);
    if(real)return normalizeIp(real);
    const forwarded=String(request?.headers?.['x-forwarded-for']||'').split(',').map(value=>value.trim()).filter(Boolean).at(-1);
    if(forwarded)return normalizeIp(forwarded);
  }
  return remote;
}
function hostWithoutPort(host){host=String(host||'').trim().toLowerCase();if(host.startsWith('['))return host.slice(1,host.indexOf(']'));return host.split(':')[0];}
function allowedWebSocketOrigin(request){
  const origin=firstHeader(request?.headers?.origin),requestHost=firstHeader(request?.headers?.host);
  if(origin==='null')return !production&&!configuredOrigins.length&&isLoopback(requestHost)&&isLoopback(request?.socket?.remoteAddress);
  if(!origin)return false;
  let parsed;try{parsed=new URL(origin);}catch{return false;}
  if(!['http:','https:'].includes(parsed.protocol))return false;
  if(configuredOrigins.length)return configuredOrigins.includes(origin)&&allowedHosts.includes(requestHost.toLowerCase());
  if(parsed.host.toLowerCase()===requestHost.toLowerCase())return true;
  return isLoopback(parsed.hostname)&&isLoopback(requestHost)&&isLoopback(request?.socket?.remoteAddress);
}
function connectionCountForIp(ip){let count=0;for(const session of connections.values())if(session.ip===ip)count+=1;return count;}
function allowMessage(session){
  const now=Date.now();if(!session.messageWindowStart||now-session.messageWindowStart>=MESSAGE_WINDOW_MS){session.messageWindowStart=now;session.messageCount=0;}
  session.messageCount+=1;return session.messageCount<=MAX_MESSAGES_PER_WINDOW&&rateLimits.take('ws-ip:'+session.ip,240,MESSAGE_WINDOW_MS)&&(!session.memberToken||rateLimits.take('ws-member:'+session.memberToken,80,MESSAGE_WINDOW_MS));
}
function allowRoomCreation(ip){
  if(roomCreations.size>=10000&&!roomCreations.has(ip))return false;
  const cutoff=Date.now()-ROOM_CREATE_WINDOW_MS,entries=(roomCreations.get(ip)||[]).filter(time=>time>cutoff);
  if(entries.length>=MAX_ROOM_CREATIONS_PER_WINDOW){roomCreations.set(ip,entries);return false;}
  entries.push(Date.now());roomCreations.set(ip,entries);return true;
}
function canCompleteBonusDraw(room,phaseId,selected,remaining,budget){
  return canCompleteSet(room.cardPool.filter(card=>!room.state.used.includes(card.id)),selected,remaining,phaseId,budget);
}
function preservesFutureDraws(room,phaseId,candidate,budget){
  if(candidate.id==='P31')return canCompleteBonusDraw(room,phaseId,[...room.state.active.map(item=>item.card),candidate],3,budget);
  if(candidate.lockFurtherDraws||candidate.id==='P31')return true;
  const currentIndex=room.phases.findIndex(phase=>phase.id===phaseId),remainingNodes=room.phases.slice(currentIndex+1).filter(phase=>!room.state.triggered.includes(phase.id));
  if(!remainingNodes.length)return true;
  const blockedIds=new Set([...room.state.used,candidate.id]);
  const available=room.cardPool.filter(card=>!blockedIds.has(card.id)&&!card.tags?.includes('settlement'));
  return canDrawSequence(remainingNodes,available,[...room.state.active.map(item=>item.card),candidate],budget);
}
function phaseCards(room,phaseId,additional=[]){
  const active=[...room.state.active.map(item=>item.card),...additional];
  return room.cardPool.filter(card=>!room.state.used.includes(card.id)&&Array.isArray(card.tags)&&(card.tags.includes('any')||card.tags.includes(phaseId))&&active.every(other=>!cardsConflict(card,other)));
}
function activeTurnTimerSeconds(room){const values=room.state.active.map(item=>TURN_TIMER_SECONDS[item.card?.id]).filter(Number.isFinite);return values.length?Math.min(...values):null;}
function resolveCard(card){if(card.id==='P01')return {...card,resolution:{kind:'wildTile',revealed:false}};if(card.id==='N06')return {...card,resolution:{kind:'missingSuits',revealed:false}};return {...card};}
function resultSummary(card){if(card.resolution?.kind==='wildTile'&&card.resolution.revealed)return '万能牌：'+card.resolution.tile;if(card.resolution?.kind==='missingSuits'&&card.resolution.revealed)return card.resolution.seats.map(item=>item.seat+'号缺'+item.suit).join(' / ');if(card.resolution?.kind==='bonusHexes')return '额外海克斯：'+card.resolution.cards.map(item=>item.name).join('、');return '';}
function historyEntry(card,phaseId,phaseList=defaultPhases){return {id:card.id,name:card.name,challenge:!!card.challenge,result:resultSummary(card),phaseName:phaseList.find(phase=>phase.id===phaseId)?.name||phaseId,time:new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})};}
function snapshot(room){return structuredClone(room.state);}
const MAX_OUTPUT_BUFFER=256*1024;
function sendEncoded(socket,data){if(socket.readyState!==1)return;if(socket.bufferedAmount+Buffer.byteLength(data)>MAX_OUTPUT_BUFFER){logEvent('slow_connection');socket.terminate();return;}socket.send(data,issue=>{if(issue)socket.terminate();});}
function send(socket,message){sendEncoded(socket,JSON.stringify(message));}
function error(socket,code,message,extra={}){send(socket,{type:'error',code,message,...extra});}
function roomSummary(room){return {id:room.id,memberCount:room.clients.size,seatCount:room.members.size,phase:room.state.phase,drawn:room.state.triggered.length,nodeCount:room.phases.length,locked:room.state.locked,createdAt:room.createdAt,lastActivity:room.lastActivity};}
function roomList(){return [...rooms.values()].sort((a,b)=>b.createdAt-a.createdAt).map(roomSummary);}
function sendLobby(socket,notice=''){send(socket,{type:'lobby',rooms:roomList(),notice});}
function broadcastLobby(){if(lobbyBroadcastTimer)return;lobbyBroadcastTimer=setTimeout(()=>{lobbyBroadcastTimer=null;const data=JSON.stringify({type:'lobby',rooms:roomList(),notice:''});for(const [socket,session] of connections)if(!session.roomId)sendEncoded(socket,data);},100);lobbyBroadcastTimer.unref?.();}
function broadcastRoom(room,message){const data=JSON.stringify(message);for(const socket of room.clients)sendEncoded(socket,data);}

function deleteRoom(room,reason='房间已关闭'){
  if(rooms.get(room.id)!==room)return;
  rooms.delete(room.id);for(const key of ipFailures.keys())if(key.endsWith('|'+room.instanceId))ipFailures.delete(key);
  const members=[...room.clients];
  for(const socket of members){const session=connections.get(socket);if(session){session.roomId=null;session.memberToken=null;}send(socket,{type:'roomClosed',reason});sendLobby(socket,reason);}
  room.clients.clear();broadcastLobby();
}
function touch(room){room.lastActivity=Date.now();const summaryKey=[room.clients.size,room.state.phase,room.state.triggered.length,room.state.locked].join('|');if(room.lobbyKey!==summaryKey){room.lobbyKey=summaryKey;broadcastLobby();}}
function pruneDisconnectedMembers(room,now=Date.now()){
  let changed=false;
  for(const [token,member] of room.members)if(member.disconnectedAt!==null&&now-member.disconnectedAt>=DISCONNECT_GRACE_MS){room.members.delete(token);changed=true;}
  if(changed){broadcastRoom(room,{type:'roomPresence',room:roomSummary(room)});broadcastLobby();}
}
function addToRoom(socket,room,clientId,token){
  const session=connections.get(socket);if(!session)return;
  const previous=room.members.get(token);
  if(!previous&&room.members.size>=MAX_ROOM_MEMBERS)throw problem('ROOM_FULL','该房间已满（锁屏玩家的席位也会保留）。');
  if(session.roomId&&session.roomId!==room.id)throw problem('ALREADY_IN_ROOM','请先退出当前房间。');
  if(previous?.socket&&previous.socket!==socket){
    const old=previous.socket,oldSession=connections.get(old);room.clients.delete(old);
    if(oldSession){oldSession.roomId=null;oldSession.memberToken=null;}
    send(old,{type:'sessionReplaced',reason:'房间已由同一成员的新页面接管。'});old.close(4001,'Session replaced');
  }
  room.clients.add(socket);room.members.set(token,{clientId,joinedAt:previous?.joinedAt||Date.now(),disconnectedAt:null,socket});session.roomId=room.id;session.memberToken=token;session.clientId=clientId;
  send(socket,{type:'roomJoined',roomId:room.id,memberToken:token,owner:room.ownerClientId===clientId,state:snapshot(room),config:{poolId:room.poolId,poolName:room.poolName,poolVersion:room.poolVersion,phases:structuredClone(room.phases),cards:structuredClone(room.cardPool)},room:roomSummary(room),serverTime:Date.now()});
  broadcastRoom(room,{type:'roomPresence',room:roomSummary(room)});broadcastLobby();
}
function leaveRoom(socket,explicit=false){
  const session=connections.get(socket);if(!session?.roomId)return;
  const room=rooms.get(session.roomId);if(room)room.clients.delete(socket);
  if(!explicit&&room&&session.memberToken){const member=room.members.get(session.memberToken);if(member?.socket===socket){member.disconnectedAt=Date.now();member.socket=null;}}
  if(explicit&&room&&session.memberToken)room.members.delete(session.memberToken);
  session.roomId=null;session.memberToken=null;
  if(room){pruneDisconnectedMembers(room);if(!room.members.size&&!room.clients.size)deleteRoom(room,'所有玩家已退出房间，房间已解散');else broadcastRoom(room,{type:'roomPresence',room:roomSummary(room)});}
  if(explicit){send(socket,{type:'roomLeft',reason:'已退出房间'});sendLobby(socket,'已退出房间');}broadcastLobby();
}
function failKey(ip,room){return ip+'|'+room.instanceId;}
function checkJoinLock(ip,room){
  const now=Date.now(),key=failKey(ip,room),ipEntry=ipFailures.get(key);
  if(ipEntry?.expiresAt<=now){ipFailures.delete(key);return null;}
  if(ipEntry?.lockedUntil>now)return {kind:'ip',seconds:Math.ceil((ipEntry.lockedUntil-now)/1000)};
  return null;
}
function recordJoinFailure(ip,room){
  const now=Date.now(),key=failKey(ip,room);let entry=ipFailures.get(key);
  if(!entry||entry.expiresAt<=now)entry={count:0,expiresAt:now+IP_LOCK_MS};
  if(ipFailures.size>=10000&&!ipFailures.has(key))throw problem('RATE_LIMIT','入房校验繁忙，请稍后再试。',429);
  entry.count++;if(entry.count>=IP_FAIL_LIMIT){entry.lockedUntil=now+IP_LOCK_MS;entry.expiresAt=entry.lockedUntil;}ipFailures.set(key,entry);
  return {ipLocked:!!entry.lockedUntil};
}
function clearJoinFailure(ip,room){ipFailures.delete(failKey(ip,room));}
function resumeRoom(socket,clientId,roomId,token){
  const room=rooms.get(String(roomId)),key=String(token),member=room?.members.get(key);
  if(!room||!member||member.clientId!==clientId)return false;
  if(member.disconnectedAt!==null&&Date.now()-member.disconnectedAt>=DISCONNECT_GRACE_MS){room.members.delete(key);if(!room.members.size&&!room.clients.size)deleteRoom(room,'所有玩家已退出或断连超过 10 分钟，房间已解散');return false;}
  addToRoom(socket,room,clientId,key);return true;
}
async function createRoom(socket,clientId,password,poolId=''){
  const session=connections.get(socket);if(session?.roomId)return error(socket,'ALREADY_IN_ROOM','你已经在一个房间中。');
  if(!/^\d{6}$/.test(password))return error(socket,'INVALID_PASSWORD','房间密码必须是 6 位数字。');
  if(rooms.size>=MAX_ROOMS)return error(socket,'ROOM_LIMIT','当前房间数量已达上限，请稍后再试。');
  if(!allowRoomCreation(session?.ip||'unknown'))return error(socket,'CREATE_LIMIT','创建房间过于频繁，请 10 分钟后再试。');
  const liveAccountSession=session?.accountToken?accountStore.session(session.accountToken):null;
  let config;try{config=buildRoomConfig(liveAccountSession?.user.id||null,cleanText(poolId,64));}catch(issue){return error(socket,issue.code||'POOL_INVALID',issue.message);}
  enforceRate('room-password:'+session.ip,30);const passwordSalt=randomBytes(16),passwordHash=await hashPassword(password,passwordSalt);
  if(!connections.has(socket)||socket.readyState!==1)return;
  if(poolId&&!accountStore.session(session.accountToken))throw problem('LOGIN_REQUIRED','登录已失效，请重新登录。',401);
  if(rooms.size>=MAX_ROOMS)throw problem('ROOM_LIMIT','当前房间数量已达上限。');
  const id=makeRoomId();if(!id)return error(socket,'ROOM_FULL','暂时无法生成房间号，请稍后再试。');
  const now=Date.now();const room={id,instanceId:makeToken(),passwordSalt,passwordHash,state:initialState(config.phases),phases:config.phases,cardPool:config.cards,poolId:config.poolId,poolName:config.poolName,poolVersion:config.poolVersion||1,recentGames:[],clients:new Set(),members:new Map(),ownerClientId:clientId,ownerUserId:liveAccountSession?.user.id||null,createdAt:now,lastActivity:now};rooms.set(id,room);addToRoom(socket,room,clientId,makeToken());
}
async function joinRoom(socket,clientId,roomId,password){
  const session=connections.get(socket);if(session?.roomId)return error(socket,'ALREADY_IN_ROOM','你已经在一个房间中。');roomId=String(roomId||'').trim();password=String(password||'');
  if(!/^\d{4}$/.test(roomId))return error(socket,'INVALID_ROOM_ID','房间号必须是 4 位数字。');if(!/^\d{6}$/.test(password))return error(socket,'INVALID_PASSWORD','房间密码必须是 6 位数字。');
  const room=rooms.get(roomId);if(!room)return error(socket,'ROOM_NOT_FOUND','房间不存在，可能已经结束或被删除。');
  const ip=session?.ip||'unknown',lock=checkJoinLock(ip,room);if(lock)return error(socket,'JOIN_LOCKED','该房间密码尝试次数过多，请稍后再试。',{retryAfter:lock.seconds});
  pruneDisconnectedMembers(room);if(room.members.size>=MAX_ROOM_MEMBERS)return error(socket,'ROOM_FULL','该房间已满（最多 4 人，锁屏席位暂时保留）。');
  enforceRate('room-password:'+ip,30);const matches=await passwordMatches(room,password);
  if(!connections.has(socket)||socket.readyState!==1)return;
  if(rooms.get(roomId)!==room)throw problem('ROOM_NOT_FOUND','房间已关闭，请返回大厅。',404);
  if(!matches){const failure=recordJoinFailure(ip,room);return error(socket,failure.ipLocked?'JOIN_LOCKED':'BAD_PASSWORD',failure.ipLocked?'密码错误次数达到上限，已锁定 10 分钟。':'房间密码错误。');}
  clearJoinFailure(ip,room);addToRoom(socket,room,clientId,makeToken());
}

function revealRandomCard(socket,clientId,cardId){
  const session=connections.get(socket),room=rooms.get(session?.roomId);if(!room)return error(socket,'ROOM_REQUIRED','请先创建或加入房间。');
  const item=room.state.active.find(entry=>entry.card?.id===cardId),kind=item?.card?.resolution?.kind;if(!item||!['wildTile','missingSuits'].includes(kind))return error(socket,'NOT_REVEALABLE','这张海克斯没有待揭晓的随机结果。');
  if(!item.card.resolution.revealed){if(kind==='wildTile')item.card={...item.card,resolution:{kind,tile:randomPick(tileFaces),revealed:true}};else item.card={...item.card,resolution:{kind,seats:Array.from({length:4},(_,index)=>({seat:index+1,suit:randomPick(suits)})),revealed:true}};const historyItem=room.state.history.find(entry=>entry.id===cardId);if(historyItem)historyItem.result=resultSummary(item.card);room.state.version+=1;touch(room);}
  broadcastRoom(room,{type:'revealed',revealedBy:clientId,card:item.card,phase:item.phase,state:snapshot(room),serverTime:Date.now()});
}
function updateTimer(socket,clientId,action,cardId){
  const session=connections.get(socket),room=rooms.get(session?.roomId);if(!room)return error(socket,'ROOM_REQUIRED','请先创建或加入房间。');
  const cardDuration=TURN_TIMER_SECONDS[cardId]||ROUND_TIMER_SECONDS[cardId];
  if(!cardDuration||!room.state.active.some(item=>item.card?.id===cardId))return error(socket,'TIMER_UNAVAILABLE','这张海克斯当前没有可用的计时器。');
  const isTurnTimer=Number.isFinite(TURN_TIMER_SECONDS[cardId]),stateKey=isTurnTimer?'turnTimer':'roundTimer';
  const durationSeconds=isTurnTimer?activeTurnTimerSeconds(room):cardDuration;
  if(!['arm','start','reset'].includes(action))return error(socket,'BAD_TIMER_ACTION','无法识别计时操作。');
  const previous=room.state[stateKey]||{revision:0};
  const revision=Number(previous.revision||0)+1;
  room.state[stateKey]=action==='arm'
    ? {armed:true,started:false,endsAt:null,revision,cardId,durationSeconds}
    : {armed:true,started:true,endsAt:Date.now()+durationSeconds*1000,revision,cardId,durationSeconds};
  room.state.version+=1;touch(room);
  broadcastRoom(room,{type:'timer',timerBy:clientId,action,state:snapshot(room),serverTime:Date.now()});
}
function draw(socket,clientId,requestedPhase){
  const session=connections.get(socket),room=rooms.get(session?.roomId);if(!room)return error(socket,'ROOM_REQUIRED','请先创建或加入房间。');const state=room.state,pending=room.phases.find(phase=>!state.triggered.includes(phase.id));
  if(state.locked)return error(socket,'LOCKED','本局后续海克斯抽取已被封锁。');if(!pending||requestedPhase!==pending.id||state.phase!==pending.id)return error(socket,'PHASE_NOT_ALLOWED','请按顺序完成前面的节点。');
  const budget=searchBudget();const eligible=phaseCards(room,requestedPhase).filter(card=>preservesFutureDraws(room,requestedPhase,card,budget));if(!eligible.length)return error(socket,'POOL_EMPTY','该节点没有不会阻断后续抽取的海克斯。');let card=resolveCard(weightedCardPick(room,eligible));let bonusCards=[];
  // Compute the complete result before committing anything, including on budget failure.
  if(card.id==='P31'){while(bonusCards.length<3){const bonusPool=phaseCards(room,requestedPhase,[card,...bonusCards]).filter(item=>item.id!==card.id&&!bonusCards.some(bonus=>bonus.id===item.id)&&item.bonusEligible!==false&&canCompleteBonusDraw(room,requestedPhase,[...state.active.map(active=>active.card),card,...bonusCards,item],2-bonusCards.length,budget));if(!bonusPool.length)throw problem('POOL_SEQUENCE_UNPLAYABLE','火力全开没有足够的兼容卡牌。');const bonus=resolveCard(weightedCardPick(room,bonusPool));bonusCards.push(bonus);}card={...card,resolution:{kind:'bonusHexes',cards:bonusCards.map(item=>({id:item.id,name:item.name,effect:item.effect}))},effect:'本局随机抽取三张海克斯，额外生效：'+bonusCards.map(item=>item.name).join('、')+'；本局不再获得海克斯。'};}
  state.used.push(card.id,...bonusCards.map(item=>item.id));state.triggered.push(requestedPhase);
  state.active.push({card,phase:requestedPhase});state.history.push(historyEntry(card,requestedPhase,room.phases));for(const bonus of bonusCards){state.active.push({card:bonus,phase:requestedPhase,source:'P31'});state.history.push(historyEntry(bonus,requestedPhase,room.phases));}
  if(card.id==='P31'){state.triggered=room.phases.map(phase=>phase.id);state.phase=room.phases.at(-1).id;state.locked=true;}else if(card.lockFurtherDraws)state.locked=true;
  if(!state.locked){const currentIndex=room.phases.findIndex(phase=>phase.id===requestedPhase);const next=room.phases.slice(currentIndex+1).find(phase=>!state.triggered.includes(phase.id));if(next)state.phase=next.id;}
  state.version+=1;touch(room);broadcastRoom(room,{type:'drawn',drawnBy:clientId,card,phase:requestedPhase,bonusCards:bonusCards.map(item=>({id:item.id,name:item.name})),state:snapshot(room),serverTime:Date.now()});
}
function roundReady(state,phaseList=defaultPhases){return state.locked||phaseList.every(phase=>state.triggered.includes(phase.id));}
function reset(socket,roundId=''){
  const session=connections.get(socket),room=rooms.get(session?.roomId);if(!room)return error(socket,'ROOM_REQUIRED','请先创建或加入房间。');
  if(!roundId||String(roundId)!==room.state.roundId)return error(socket,'STALE_ROUND','本局已经被其他玩家结算或重置，请刷新当前牌局。');
  if(roundReady(room.state,room.phases))return error(socket,'USE_SETTLEMENT','本局已经可以结算，请点击“结算本局”。');
  rememberRound(room);const next=initialState(room.phases);next.version=Number(room.state.version||0)+1;room.state=next;touch(room);broadcastRoom(room,{type:'reset',state:snapshot(room),serverTime:Date.now()});send(socket,{type:'reset-ack'});
}
function settle(socket,clientId,roundId){
  const session=connections.get(socket),room=rooms.get(session?.roomId);if(!room)return error(socket,'ROOM_REQUIRED','请先创建或加入房间。');
  if(!roundId||String(roundId)!==room.state.roundId)return error(socket,'STALE_ROUND','本局已经被其他玩家结算或重置。');
  if(!roundReady(room.state,room.phases))return error(socket,'SETTLEMENT_NOT_READY','完成全部抽取节点后才能结算本局。');
  const activeIds=new Set(room.state.active.map(item=>item.card?.id));
  const independentPoolMode=activeIds.has('P42')||activeIds.has('R03');
  const settlementCandidates=independentPoolMode?[]:room.cardPool.filter(card=>card.tags?.includes('settlement')&&['R06','N07'].includes(card.id)&&!(card.id==='N07'&&activeIds.has('R01')));
  const r06=settlementCandidates.find(card=>card.id==='R06'),n07=settlementCandidates.find(card=>card.id==='N07');
  const r06Triggered=!!r06&&randomInt(1_000_000)<Math.round(SETTLEMENT_TRIGGER_RATE*1_000_000);
  const n07Triggered=!!n07&&randomInt(1_000_000)<Math.round(SOUL_TRANSFER_TRIGGER_RATE*1_000_000);
  const settlementCards=[r06Triggered?r06:null,n07Triggered?n07:null].filter(Boolean);
  const previousVersion=Number(room.state.version||0),triggered=settlementCards.length>0;rememberRound(room);
  const next=initialState(room.phases);next.version=previousVersion+1;room.state=next;touch(room);
  broadcastRoom(room,{type:'settlement',settledBy:clientId,triggered,cards:settlementCards,settlementCards,card:settlementCards[0]||null,state:snapshot(room),serverTime:Date.now()});
}
function cleanRooms(){
  const now=Date.now();
  for(const room of rooms.values()){
    pruneDisconnectedMembers(room,now);
    if(now-room.lastActivity>=ROOM_IDLE_MS)deleteRoom(room,'房间超过 10 分钟没有牌局操作，已自动删除');
    else if(!room.members.size&&!room.clients.size)deleteRoom(room,'所有玩家已退出或断连超过 10 分钟，房间已解散');
  }
  for(const [ip,entries] of roomCreations){const recent=entries.filter(time=>now-time<ROOM_CREATE_WINDOW_MS);if(recent.length)roomCreations.set(ip,recent);else roomCreations.delete(ip);}
  for(const [key,entry] of ipFailures)if(entry.expiresAt<=now)ipFailures.delete(key);
  rateLimits.cleanup();accountStore.cleanup();
}

function requestAccountSession(request){return accountStore.session(readSessionCookie(request,cookieName));}
function secureRequest(request){return !!request.socket?.encrypted||(isLoopback(request.socket?.remoteAddress)&&firstHeader(request.headers['x-forwarded-proto']).toLowerCase()==='https');}
function sessionCookie(request,token,maxAgeSeconds){if(production&&!secureRequest(request))throw problem('HTTPS_REQUIRED','账号操作需要 HTTPS。',400);return `${cookieName}=${encodeURIComponent(token||'')}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0,Math.floor(maxAgeSeconds))}${production||secureRequest(request)?'; Secure':''}`;}
function sendJson(response,status,payload,extraHeaders={}){const body=Buffer.from(JSON.stringify(payload));response.writeHead(status,{...responseHeaders('application/json; charset=utf-8'),...extraHeaders,'Cache-Control':'private, no-store','Content-Length':body.length});response.end(body);}
async function readJsonBody(request){
  if(Number(request.headers['content-length'])>64*1024)throw problem('BODY_TOO_LARGE','请求内容过大。',413);
  return new Promise((resolve,reject)=>{let size=0,body='',done=false;request.setEncoding('utf8');
    const fail=issue=>{if(done)return;done=true;body='';reject(issue);};
    request.on('data',chunk=>{if(done)return;size+=Buffer.byteLength(chunk);if(size>64*1024)return fail(problem('BODY_TOO_LARGE','请求内容过大。',413));body+=chunk;});
    request.on('end',()=>{if(done)return;done=true;try{const parsed=body?JSON.parse(body):{};if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();resolve(parsed);}catch{reject(problem('INVALID_JSON','请求内容不是有效的 JSON 对象。'));}});
    request.on('aborted',()=>fail(problem('REQUEST_ABORTED','请求已中断。')));request.on('error',fail);
  });
}
function allowAuthRequest(ip){return rateLimits.take('auth-ip:'+ip,20,10*60*1000);}
function requireApiAuth(request){const session=requestAccountSession(request);if(!session)throw problem('AUTH_REQUIRED','请先登录账号。',401);return session;}
function requireApiMutation(request,session){if(!allowedWebSocketOrigin(request))throw problem('ORIGIN_REJECTED','请求来源不受信任。',403);if(firstHeader(request.headers['x-csrf-token'])!==session.csrfToken)throw problem('CSRF_REJECTED','登录状态校验失败，请刷新页面后重试。',403);}
async function readAuthenticatedBody(request,session){const body=await readJsonBody(request),live=requestAccountSession(request);if(!live||live.tokenHash!==session.tokenHash)throw problem('AUTH_REQUIRED','登录已失效，请重新登录。',401);return body;}
function requireWriteBudget(ip,userId){enforceRate('write-global',1200);enforceRate('write-ip:'+ip,120);enforceRate('write-user:'+userId,60);}
function apiStudioPayload(userId){const cardPage=accountStore.cardPage(userId),poolPage=accountStore.poolPage(userId);return {officialCards:cards,privateCards:cardPage.items,pools:poolPage.items,pagination:{cards:{total:cardPage.total,nextOffset:cardPage.nextOffset},pools:{total:poolPage.total,nextOffset:poolPage.nextOffset}},limits:accountStore.limits,nodeTypes:[{id:'opening',name:'开局'},{id:'inGame',name:'牌局进行中'},{id:'afterWin',name:'有人胡牌后'},{id:'lateGame',name:'牌局后期'},{id:'custom',name:'自定义'}],timings:[{id:'any',name:'所有节点'},{id:'opening',name:'仅开局'},{id:'afterWin',name:'有人胡牌后'},{id:'lateGame',name:'牌局后期'}]};}
async function handleApi(request,response,pathname){
  const method=String(request.method||'GET').toUpperCase(),ip=clientIp(request);
  try{
    enforceRate('api-ip:'+ip,240);
    if(production&&method!=='GET'&&!secureRequest(request))throw problem('HTTPS_REQUIRED','账号操作需要 HTTPS。',400);
    if(pathname==='/api/internal-health'&&method==='GET'){if(!isLoopback(ip))throw problem('FORBIDDEN','禁止访问。',403);return sendJson(response,200,{status:'ok',rooms:rooms.size,connections:connections.size,rateEntries:rateLimits.entries.size,failedJoinEntries:ipFailures.size,rss:process.memoryUsage().rss,eventLoopP99Ms:Number(loopDelay.percentile(99)/1e6)});}
    if(pathname==='/api/me'&&method==='GET'){const session=requestAccountSession(request);return sendJson(response,200,{user:session?.user||null,csrfToken:session?.csrfToken||null,emailEnabled:mailer.enabled});}
    if(pathname==='/api/room-pools'&&method==='GET'){
      const session=requestAccountSession(request);
      const summarize=(id,name,description,nodes,cardCount,drawCount)=>({id,name,description,nodes:nodes.map(node=>({id:node.id,name:node.name})),cardCount,drawCount});
      const available=[summarize('','官方川麻卡池','使用默认的川麻海克斯规则。',defaultPhases,cards.length,cards.filter(card=>!card.tags?.includes('settlement')).length)];
      if(session)for(const pool of accountStore.listPools(session.user.id)){
        const drawCount=pool.cards.filter(ref=>ref.source==='private'||!cards.find(card=>card.id===ref.id)?.tags?.includes('settlement')).length;
        available.push(summarize(pool.id,pool.name,pool.description,pool.nodes,pool.cards.length,drawCount));
      }
      return sendJson(response,200,{user:session?.user||null,pools:available},{'Cache-Control':'no-store'});
    }
    if(pathname==='/api/auth/register'&&method==='POST'){
      if(!allowedWebSocketOrigin(request))throw problem('ORIGIN_REJECTED','请求来源不受信任。',403);if(!allowAuthRequest(ip))throw problem('AUTH_RATE_LIMIT','注册或登录尝试过于频繁，请稍后再试。',429);
      if(process.env.HEX_REGISTRATION_ENABLED==='false')throw problem('REGISTRATION_CLOSED','暂时关闭新账号注册。',503);
      enforceRate('register-global',30);
      enforceRate('register-ip:'+ip,5,10*60*1000);
      const body=await readJsonBody(request),user=await accountStore.register(validateUsername(body.username),validateAccountPassword(body.password)),session=accountStore.createSession(user.id);
      return sendJson(response,201,{user,csrfToken:session.csrfToken},{'Set-Cookie':sessionCookie(request,session.token,(session.expiresAt-Date.now())/1000)});
    }
    if(pathname==='/api/auth/login'&&method==='POST'){
      if(!allowedWebSocketOrigin(request))throw problem('ORIGIN_REJECTED','请求来源不受信任。',403);if(!allowAuthRequest(ip))throw problem('AUTH_RATE_LIMIT','注册或登录尝试过于频繁，请稍后再试。',429);
      const body=await readJsonBody(request),username=validateUsername(body.username),password=validateAccountPassword(body.password);
      enforceRate('login-user:'+createHash('sha256').update(username.toLowerCase()).digest('hex'),10);
      const user=await accountStore.verify(username,password);if(!user)throw problem('INVALID_CREDENTIALS','用户名或密码错误。',401);const session=accountStore.createSession(user.id);
      return sendJson(response,200,{user,csrfToken:session.csrfToken},{'Set-Cookie':sessionCookie(request,session.token,(session.expiresAt-Date.now())/1000)});
    }
    if(pathname==='/api/auth/logout'&&method==='POST'){const session=requireApiAuth(request);requireApiMutation(request,session);accountStore.logout(readSessionCookie(request,cookieName));return sendJson(response,200,{ok:true},{'Set-Cookie':sessionCookie(request,'',0)});}
    if(pathname==='/api/auth/password'&&method==='POST'){const session=requireApiAuth(request);requireApiMutation(request,session);enforceRate('password-ip:'+ip,10);enforceRate('password-user:'+session.user.id,5);const body=await readJsonBody(request),currentPassword=validateAccountPassword(body.currentPassword),newPassword=validateAccountPassword(body.newPassword);if(currentPassword===newPassword)throw problem('PASSWORD_UNCHANGED','新密码不能与当前密码相同。');if(!await accountStore.changePassword(session.user.id,currentPassword,newPassword,session.tokenHash))throw problem('CURRENT_PASSWORD_WRONG','当前密码错误。',401);return sendJson(response,200,{ok:true});}
    if(pathname==='/api/account/email/send'&&method==='POST'){
      const session=requireApiAuth(request);requireApiMutation(request,session);
      if(!mailer.enabled)throw problem('MAIL_NOT_CONFIGURED','邮箱服务暂未开放，请稍后再试。',503);
      enforceRate('password-ip:'+ip,10);enforceRate('password-user:'+session.user.id,5);
      const body=await readAuthenticatedBody(request,session),email=normalizeEmail(body.email),password=validateAccountPassword(body.currentPassword);
      accountStore.reserveEmailSend({ip,email,purpose:'binding',userId:session.user.id});
      const challenge=await accountStore.issueBinding(session.user.id,password,email,session.tokenHash);
      try{await mailer.sendBinding(email,challenge.code);accountStore.activateEmailChallenge(challenge.id);}catch(issue){accountStore.cancelEmailChallenge(challenge.id);throw issue;}
      return sendJson(response,200,{ok:true,challengeId:challenge.id,expiresIn:600,resendAfter:60});
    }
    if(pathname==='/api/account/email/verify'&&method==='POST'){
      const session=requireApiAuth(request);requireApiMutation(request,session);enforceRate('email-verify-ip:'+ip,30);enforceRate('email-verify-user:'+session.user.id,20);
      const body=await readAuthenticatedBody(request,session),email=normalizeEmail(body.email),code=String(body.code||''),challengeId=String(body.challengeId||'');
      if(!/^\d{6}$/.test(code)||!/^em_[A-Za-z0-9_-]{16}$/.test(challengeId))throw problem('INVALID_EMAIL_CODE','请输入收到的六位邮箱验证码。');
      const result=accountStore.bindEmail(session.user.id,{challengeId,email,code,currentTokenHash:session.tokenHash});
      if(result.previousEmail)void mailer.sendChanged(result.previousEmail).catch(issue=>logIssue('email_notice_failed',issue));
      return sendJson(response,200,{ok:true,user:result.user});
    }
    if(pathname==='/api/auth/forgot-password'&&method==='POST'){
      if(!allowedWebSocketOrigin(request))throw problem('ORIGIN_REJECTED','请求来源不受信任。',403);
      if(!mailer.enabled)throw problem('MAIL_NOT_CONFIGURED','邮箱服务暂未开放，请稍后再试。',503);
      const body=await readJsonBody(request),email=normalizeEmail(body.email);
      accountStore.reserveEmailSend({ip,email,purpose:'reset'});
      const challenge=accountStore.issuePasswordReset(email);
      if(challenge){
        const url=new URL('studio.html',mailBaseUrl);url.hash='reset-password='+challenge.token;
        // Reply identically for unknown and bound addresses; mail is delivered in a bounded queue.
        void mailer.sendReset(email,url.href).then(()=>accountStore.activateEmailChallenge(challenge.id)).catch(issue=>{accountStore.cancelEmailChallenge(challenge.id);logIssue('password_reset_mail_failed',issue);});
      }
      return sendJson(response,202,{ok:true,message:'如果该邮箱已验证并绑定账号，重置邮件将发送到邮箱，请查看收件箱或垃圾邮件。',resendAfter:60});
    }
    if(pathname==='/api/auth/reset-password'&&method==='POST'){
      if(!allowedWebSocketOrigin(request))throw problem('ORIGIN_REJECTED','请求来源不受信任。',403);
      enforceRate('reset-password-ip:'+ip,10);
      const body=await readJsonBody(request);await accountStore.resetPassword(String(body.token||''),validateAccountPassword(body.newPassword));
      return sendJson(response,200,{ok:true},{'Set-Cookie':sessionCookie(request,'',0)});
    }
    if(pathname==='/api/studio'&&method==='GET'){const session=requireApiAuth(request);return sendJson(response,200,{user:session.user,csrfToken:session.csrfToken,emailEnabled:mailer.enabled,...apiStudioPayload(session.user.id)});}

    const cardMatch=pathname.match(/^\/api\/private-cards(?:\/([A-Za-z0-9_-]+))?$/);
    if(cardMatch){const session=requireApiAuth(request);if(method!=='GET'){requireApiMutation(request,session);requireWriteBudget(ip,session.user.id);}const cardId=cardMatch[1];
      if(method==='GET'&&!cardId){const page=accountStore.cardPage(session.user.id,listOptions(request));return sendJson(response,200,{cards:page.items,total:page.total,nextOffset:page.nextOffset});}
      if(method==='POST'&&!cardId)return sendJson(response,201,{card:accountStore.createCard(session.user.id,sanitizePrivateCard(await readAuthenticatedBody(request,session)))});
      if(method==='PUT'&&cardId){const card=accountStore.updateCard(session.user.id,cardId,sanitizePrivateCard(await readAuthenticatedBody(request,session)));if(!card)throw problem('CARD_NOT_FOUND','私人卡牌不存在。',404);return sendJson(response,200,{card});}
      if(method==='DELETE'&&cardId){if(accountStore.cardUsedByPool(session.user.id,cardId))throw problem('CARD_IN_USE','请先从所有卡池中移除这张卡。',409);if(!accountStore.deleteCard(session.user.id,cardId))throw problem('CARD_NOT_FOUND','私人卡牌不存在。',404);return sendJson(response,200,{ok:true});}
      throw problem('METHOD_NOT_ALLOWED','不支持该卡牌操作。',405);
    }

    const poolMatch=pathname.match(/^\/api\/pools(?:\/([A-Za-z0-9_-]+))?$/);
    if(poolMatch){const session=requireApiAuth(request);if(method!=='GET'){requireApiMutation(request,session);requireWriteBudget(ip,session.user.id);if(method!=='DELETE'){enforceRate('compile-ip:'+ip,20);enforceRate('compile-user:'+session.user.id,10);}}const poolId=poolMatch[1];
      if(method==='GET'&&!poolId){const page=accountStore.poolPage(session.user.id,listOptions(request));return sendJson(response,200,{pools:page.items,total:page.total,nextOffset:page.nextOffset});}
      if(method==='POST'&&!poolId){const input=sanitizePoolInput(session.user.id,await readAuthenticatedBody(request,session));compilePoolConfig(session.user.id,{id:'preview',version:1,...input});return sendJson(response,201,{pool:accountStore.createPool(session.user.id,input)});}
      if(method==='PUT'&&poolId){if(!accountStore.getPool(session.user.id,poolId))throw problem('POOL_NOT_FOUND','私人卡池不存在。',404);const input=sanitizePoolInput(session.user.id,await readAuthenticatedBody(request,session));compilePoolConfig(session.user.id,{id:poolId,version:1,...input});return sendJson(response,200,{pool:accountStore.updatePool(session.user.id,poolId,input)});}
      if(method==='DELETE'&&poolId){if([...rooms.values()].some(room=>room.poolId===poolId))throw problem('POOL_IN_USE','该卡池正在被房间使用，房间结束后才能删除。',409);if(!accountStore.deletePool(session.user.id,poolId))throw problem('POOL_NOT_FOUND','私人卡池不存在。',404);return sendJson(response,200,{ok:true});}
      throw problem('METHOD_NOT_ALLOWED','不支持该卡池操作。',405);
    }
    throw problem('API_NOT_FOUND','接口不存在。',404);
  }catch(issue){const status=Number(issue.status)||500;if(status>=500)logIssue('api_error',issue);if(status===429)logEvent('api_rate_limit');const headers=status===413?{Connection:'close'}:{};if(status===413)request.resume();if(!response.destroyed)return sendJson(response,status,{error:issue.code||'SERVER_ERROR',message:Number(issue.status)?issue.message:'服务器处理请求时出现错误。'},headers);}
}
function listOptions(request){const params=new URL(request.url,'http://localhost').searchParams;return {limit:Math.floor(Math.min(100,Math.max(1,Number(params.get('limit'))||100))),offset:Math.max(0,Math.min(100000,Math.floor(Number(params.get('offset'))||0)))};}

const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.webp':'image/webp','.mp3':'audio/mpeg','.wav':'audio/wav','.glb':'model/gltf-binary'};
const compressibleExtensions=new Set(['.html','.js','.mjs','.json','.css']);
const cachedArtifactExtensions=new Set(['.js','.mjs','.css','.png','.webp','.glb']);
const publicDirectories=new Map([
  ['/audio/',{directory:path.join(root,'audio'),extensions:new Set(['.mp3','.wav','.ogg'])}],
  ['/image/',{directory:path.join(root,'image'),extensions:new Set(['.png','.jpg','.jpeg','.webp','.avif'])}],
  ['/artifacts/bai-zhe-shi-chen/web/',{directory:path.join(root,'artifacts','bai-zhe-shi-chen','web'),extensions:new Set(['.html','.js','.json','.css','.png','.webp','.glb'])}]
]);
function publicFile(pathname){
  if(pathname==='/'||pathname==='/index.html')return path.join(root,'index.html');
  if(pathname==='/studio'||pathname==='/studio.html')return path.join(root,'studio.html');
  for(const [prefix,rule] of publicDirectories){
    if(!pathname.startsWith(prefix))continue;
    const relative=pathname.slice(prefix.length);if(!relative||path.basename(relative).startsWith('.'))return null;
    const filename=path.resolve(rule.directory,relative),fromBase=path.relative(rule.directory,filename);
    if(fromBase.startsWith('..')||path.isAbsolute(fromBase)||!rule.extensions.has(path.extname(filename).toLowerCase()))return null;
    return filename;
  }
  return null;
}
function cacheControlFor(pathname,searchParams){
  const extension=path.extname(pathname).toLowerCase();
  if(pathname.startsWith('/artifacts/bai-zhe-shi-chen/web/')&&cachedArtifactExtensions.has(extension)){
    return searchParams?.has('v')?'public, max-age=31536000, immutable':'public, max-age=604800';
  }
  return 'no-cache';
}
function responseHeaders(contentType='text/plain; charset=utf-8',allowSameOriginFrame=false,cacheControl='no-cache',scriptHashes=[]){
  const frameAncestors=allowSameOriginFrame?"'self'":"'none'";
  return {
    'Content-Type':contentType,
    'Cache-Control':cacheControl,
    'X-Content-Type-Options':'nosniff',
    'X-Frame-Options':allowSameOriginFrame?'SAMEORIGIN':'DENY',
    'Referrer-Policy':'no-referrer',
    'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy':'same-origin',
    'Cross-Origin-Resource-Policy':'same-origin',
    'Content-Security-Policy':"default-src 'self'; script-src 'self' "+scriptHashes.join(' ')+"; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; connect-src 'self' "+configuredOrigins.map(origin=>origin.replace(/^https:/,'wss:').replace(/^http:/,'ws:')).join(' ')+"; frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors "+frameAncestors+"; form-action 'self'"
  };
}
const server=http.createServer(async(request,response)=>{
  try{
    if(production&&!allowedHosts.includes(firstHeader(request.headers.host).toLowerCase())){response.writeHead(421,responseHeaders());return response.end('Unknown host');}
    const parsed=new URL(request.url,'http://localhost');let pathname=decodeURIComponent(parsed.pathname);
    if(pathname==='/hex-mahjong')pathname='/';else if(pathname.startsWith('/hex-mahjong/'))pathname=pathname.slice('/hex-mahjong'.length);
    if(pathname.startsWith('/api/'))return await handleApi(request,response,pathname);
    if(!['GET','HEAD'].includes(request.method||'')){response.writeHead(405,{...responseHeaders(),'Allow':'GET, HEAD'});return response.end('Method not allowed');}
    const filename=publicFile(pathname);if(!filename){response.writeHead(404,responseHeaders());return response.end('Not found');}
    const fileStat=await stat(filename);if(!fileStat.isFile())throw new Error('Not a file');
    const extension=path.extname(filename).toLowerCase(),allowSameOriginFrame=pathname==='/artifacts/bai-zhe-shi-chen/web/index.html';
    // 页面脚本内联在 HTML 中，使用弱 ETag 让大厅与个人中心切换时只需校验版本，避免重复传输整页。
    // API 响应仍由 sendJson 强制 no-store，不会缓存账号数据。
    const etag=`W/\"${fileStat.size.toString(16)}-${Math.floor(fileStat.mtimeMs).toString(16)}\"`;
    let data=await readFile(filename);const hashes=[];
    if(extension==='.html'){data=Buffer.from(data.toString('utf8').replace(/\r\n?/g,'\n'));for(const match of data.toString('utf8').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/\bsrc\s*=/i.test(match[1]))hashes.push("'sha256-"+createHash('sha256').update(match[2]).digest('base64')+"'");}
    const headers=responseHeaders(types[extension]||'application/octet-stream',allowSameOriginFrame,cacheControlFor(pathname,parsed.searchParams),hashes);headers.ETag=etag;
    const ifNoneMatch=String(request.headers['if-none-match']||'');
    if(ifNoneMatch==='*'||ifNoneMatch.split(',').some(value=>value.trim()===etag)){
      response.writeHead(304,headers);return response.end();
    }
    let body=data;
    if(compressibleExtensions.has(extension)){
      headers.Vary='Accept-Encoding';
      const accepted=String(request.headers['accept-encoding']||'');
      if(request.method==='GET'&&data.length>=1024&&/\bbr\b/.test(accepted)){
        body=await brotliAsync(data,{params:{[zlibConstants.BROTLI_PARAM_QUALITY]:5}});headers['Content-Encoding']='br';
      }else if(request.method==='GET'&&data.length>=1024&&/\bgzip\b/.test(accepted)){
        body=await gzipAsync(data,{level:6});headers['Content-Encoding']='gzip';
      }
    }
    headers['Content-Length']=body.length;
    response.writeHead(200,headers);response.end(request.method==='HEAD'?undefined:body);
  }catch{response.writeHead(404,responseHeaders());response.end('Not found');}
});
server.requestTimeout=10*1000;server.headersTimeout=10*1000;server.keepAliveTimeout=5*1000;server.maxHeadersCount=50;server.maxConnections=600;
const wss=new WebSocketServer({
  server,
  maxPayload:MAX_WS_PAYLOAD,
  perMessageDeflate:false,
  verifyClient:({req})=>{try{return allowedWebSocketOrigin(req)&&connections.size<MAX_TOTAL_CONNECTIONS&&connectionCountForIp(clientIp(req))<MAX_CONNECTIONS_PER_IP&&rateLimits.take('handshake:'+clientIp(req),40,60000);}catch(issue){logIssue('handshake_error',issue);return false;}}
});
wss.on('connection',(socket,request)=>{
  socket.isAlive=true;socket.on('pong',()=>{socket.isAlive=true;});
  let accountToken,accountSession;
  try{accountToken=readSessionCookie(request,cookieName);accountSession=accountStore.session(accountToken);}catch(issue){logIssue('connection_init_error',issue);socket.on('error',()=>{});socket.close(1011,'Initialization failed');return;}
  connections.set(socket,{clientId:'anonymous',roomId:null,memberToken:null,userId:accountSession?.user.id||null,accountToken,ip:clientIp(request),messageWindowStart:Date.now(),messageCount:0,helloReceived:false,pending:0,queue:Promise.resolve()});sendLobby(socket);
  socket.on('message',raw=>{
    const session=connections.get(socket);if(!session)return;
    if(!allowMessage(session)||session.pending>=4){socket.close(1008,'消息过于频繁');return;}
    let message;try{message=JSON.parse(raw.toString());if(!message||typeof message!=='object'||Array.isArray(message))throw new Error();}catch{return error(socket,'BAD_MESSAGE','无法解析请求。');}
    session.pending++;
    // Serialize this connection across asynchronous KDF jobs; never retain an unbounded queue.
    session.queue=session.queue.then(async()=>{
      if(!connections.has(socket)||socket.readyState!==1)return;
      if(message.type==='hello'){
        if(session.roomId||(session.helloReceived&&session.clientId!==String(message.clientId||'anonymous').slice(0,64)))return error(socket,'IDENTITY_FIXED','连接身份已经确定，请重新连接后恢复房间。');
        session.helloReceived=true;session.clientId=String(message.clientId||'anonymous').slice(0,64);
        if(message.roomId&&message.memberToken&&!resumeRoom(socket,session.clientId,String(message.roomId),String(message.memberToken)))sendLobby(socket,'上次的房间已失效，请重新加入。');else if(!session.roomId)sendLobby(socket);return;
      }
      if(message.type==='listRooms')return sendLobby(socket);
      if(message.type==='createRoom'){if(message.poolId){enforceRate('compile-ip:'+session.ip,20);if(session.userId)enforceRate('compile-user:'+session.userId,10);}return await createRoom(socket,session.clientId,String(message.password||''),String(message.poolId||''));}
      if(message.type==='joinRoom')return await joinRoom(socket,session.clientId,String(message.roomId||''),String(message.password||''));
      if(message.type==='leaveRoom')return leaveRoom(socket,true);
      if(['draw','reveal','timer','settle','reset'].includes(message.type)&&session.memberToken)enforceRate('room-action:'+session.memberToken,60);
      if(message.type==='draw')return draw(socket,session.clientId,String(message.phase||''));
      if(message.type==='reveal')return revealRandomCard(socket,session.clientId,String(message.cardId||''));
      if(message.type==='timer')return updateTimer(socket,session.clientId,String(message.action||''),String(message.cardId||''));
      if(message.type==='settle')return settle(socket,session.clientId,String(message.roundId||''));
      if(message.type==='reset')return reset(socket,String(message.roundId||''));error(socket,'BAD_MESSAGE','无法识别请求。');
    }).catch(issue=>{if(!issue.status)logIssue('ws_action_error',issue);error(socket,issue.code||'SERVER_ERROR',issue.status?issue.message:'服务器处理请求时出现错误。');}).finally(()=>{session.pending--;});
  });
  const disconnect=()=>{if(!connections.has(socket))return;leaveRoom(socket,false);connections.delete(socket);};socket.on('close',disconnect);socket.on('error',disconnect);
});
const heartbeatInterval=setInterval(()=>{for(const socket of wss.clients){if(socket.isAlive===false){socket.terminate();continue;}socket.isAlive=false;socket.ping();}},HEARTBEAT_MS);heartbeatInterval.unref?.();
setInterval(cleanRooms,60*1000).unref?.();server.listen(port,host,()=>console.log(`Hex Mahjong lobby server: http://${host}:${port}`));
setInterval(()=>{logEvent('health',{rooms:rooms.size,connections:connections.size,rss:process.memoryUsage().rss,eventLoopP99Ms:Math.round(loopDelay.percentile(99)/1e6)});loopDelay.reset();},60000).unref();
