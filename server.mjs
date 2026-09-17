import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes, randomInt, scryptSync, timingSafeEqual} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import {brotliCompress, constants as zlibConstants, gzip} from 'node:zlib';
import {promisify} from 'node:util';
import {WebSocketServer} from 'ws';
import cards from './cards.json' with {type:'json'};
import {createAccountStore} from './lib/account-store.mjs';

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
const ROOM_IDLE_MS=30*60*1000;
const DISCONNECT_GRACE_MS=60*1000;
const MAX_ROOM_MEMBERS=4;
const IP_FAIL_LIMIT=5,IP_LOCK_MS=10*60*1000,ROOM_FAIL_LIMIT=30,ROOM_LOCK_MS=10*60*1000;
const MAX_ROOMS=200;
const ROOM_CREATE_WINDOW_MS=10*60*1000,MAX_ROOM_CREATIONS_PER_WINDOW=5;
const MESSAGE_WINDOW_MS=10*1000,MAX_MESSAGES_PER_WINDOW=80;
const MAX_TOTAL_CONNECTIONS=500,MAX_CONNECTIONS_PER_IP=20,MAX_WS_PAYLOAD=16*1024;
const HEARTBEAT_MS=30*1000;
const SETTLEMENT_TRIGGER_RATE=Math.min(1,Math.max(0,Number(process.env.SETTLEMENT_TRIGGER_RATE??0.03)));
const DEFAULT_SETTLEMENT_CARD=cards.find(card=>card.id==='R06');
const TURN_TIMER_SECONDS=Object.freeze({R05:7,R02:8});
const ROUND_TIMER_SECONDS=Object.freeze({R03:60});
const RECENT_GAME_MULTIPLIERS=Object.freeze([0.35,0.6,0.8]);
const MIN_RECENT_CARD_WEIGHT=0.1;
const brotliAsync=promisify(brotliCompress),gzipAsync=promisify(gzip);

if(!DEFAULT_SETTLEMENT_CARD)throw new Error('Missing settlement card R06');
const accountStore=createAccountStore({databasePath:process.env.HEX_DB_PATH||path.join(root,'data','hex-mahjong.sqlite')});
const initialState=(phaseList=defaultPhases)=>({roundId:randomBytes(12).toString('base64url'),phase:phaseList[0]?.id||'opening',used:[],active:[],history:[],triggered:[],locked:false,turnTimer:{started:false,endsAt:null,revision:0,cardId:null,durationSeconds:7},roundTimer:{started:false,endsAt:null,revision:0,cardId:null,durationSeconds:60},version:0});
const rooms=new Map();
const connections=new Map();
const ipFailures=new Map();
const roomFailures=new Map();
const roomCreations=new Map();
const authAttempts=new Map();
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
  if(!CARD_RARITIES.has(rarity))throw problem('INVALID_CARD_RARITY','无法识别卡牌稀有度。');if(!CARD_TIMINGS.has(recommendedTiming))throw problem('INVALID_CARD_TIMING','无法识别建议出现时机。');
  return {name,effect,glyph,rarity,recommendedTiming};
}
function privateCardRuntime(card){return {id:card.id,name:card.name,effect:card.effect,scope:'本局',glyph:card.glyph,challenge:card.rarity==='challenge',prismatic:card.rarity==='prismatic',custom:true,recommendedTiming:card.recommendedTiming};}
function defaultRoomConfig(){return {poolId:null,poolName:'官方川麻卡池',phases:structuredClone(defaultPhases),cards:structuredClone(cards)};}
function automaticNodeIds(card,timing,nodes){
  if(card.tags?.includes('settlement')||timing==='settlement')return ['settlement'];
  const ids=nodes.map(node=>node.id),byType=type=>nodes.filter(node=>node.type===type).map(node=>node.id);
  if(card.tags?.includes('any')||timing==='any')return ids;
  if(card.tags?.includes('opening')||timing==='opening')return byType('opening').length?byType('opening'):[ids[0]];
  if(card.tags?.includes('firstWin'))return [byType('afterWin')[0]||ids[1]||ids[0]];
  if(card.tags?.includes('secondWin'))return [byType('afterWin')[1]||byType('lateGame')[0]||ids.at(-1)];
  if(timing==='afterWin')return byType('afterWin').length?byType('afterWin'):[ids[Math.min(1,ids.length-1)]];
  if(timing==='lateGame')return byType('lateGame').length?byType('lateGame'):[ids.at(-1)];
  return ids;
}
function sanitizePoolInput(userId,input){
  const name=cleanText(input?.name,30),description=cleanText(input?.description,160),rawNodes=Array.isArray(input?.nodes)?input.nodes:[],rawCards=Array.isArray(input?.cards)?input.cards:[];
  if(!name)throw problem('POOL_NAME_REQUIRED','请填写卡池名称。');if(rawNodes.length<1||rawNodes.length>5)throw problem('INVALID_NODE_COUNT','每个卡池需要设置 1～5 个抽取节点。');
  const nodeIds=new Set(),nodes=rawNodes.map((node,index)=>{const id=cleanText(node?.id||`node_${index+1}`,40),nodeName=cleanText(node?.name,18),nodeDescription=cleanText(node?.desc??node?.description,80),type=String(node?.type||'custom');if(!/^[A-Za-z0-9_-]{1,40}$/.test(id)||nodeIds.has(id))throw problem('INVALID_NODE_ID','抽取节点标识无效或重复。');if(!nodeName)throw problem('NODE_NAME_REQUIRED','每个抽取节点都需要名称。');if(!NODE_TYPES.has(type))throw problem('INVALID_NODE_TYPE','无法识别抽取节点类型。');nodeIds.add(id);return {id,name:nodeName,desc:nodeDescription,title:nodeName+'海克斯',detail:nodeDescription||('在“'+nodeName+'”时抽取一张海克斯。'),type,order:index+1};});
  if(rawCards.length<1||rawCards.length>120)throw problem('INVALID_POOL_SIZE','卡池需要包含 1～120 张卡牌。');
  const seen=new Set(),poolCards=rawCards.map(ref=>{const source=ref?.source==='private'?'private':'official',id=cleanText(ref?.id,48),key=source+'|'+id,assignmentMode=ref?.assignmentMode==='custom'?'custom':'auto',customNodeIds=assignmentMode==='custom'?[...new Set((Array.isArray(ref?.nodeIds)?ref.nodeIds:[]).map(value=>cleanText(value,40)).filter(value=>nodeIds.has(value)))]:[];if(!id||seen.has(key))throw problem('DUPLICATE_POOL_CARD','卡池中存在无效或重复卡牌。');seen.add(key);const card=source==='private'?accountStore.getCard(userId,id):cards.find(item=>item.id===id);if(!card)throw problem('POOL_CARD_NOT_FOUND','卡池中包含不存在或无权使用的卡牌。',404);if(assignmentMode==='custom'&&!customNodeIds.length&&id!=='R06')throw problem('CARD_NODE_REQUIRED','手动分配的卡牌至少需要选择一个节点。');return {source,id,assignmentMode,nodeIds:customNodeIds};});
  return {name,description,nodes,cards:poolCards};
}
function compilePoolConfig(userId,pool){
  const runtimeCards=pool.cards.map(ref=>{const sourceCard=ref.source==='private'?accountStore.getCard(userId,ref.id):cards.find(card=>card.id===ref.id);if(!sourceCard)return null;const card=ref.source==='private'?privateCardRuntime(sourceCard):structuredClone(sourceCard);const timing=ref.source==='private'?sourceCard.recommendedTiming:null;card.tags=ref.assignmentMode==='custom'&&ref.id!=='R06'?ref.nodeIds.filter(id=>pool.nodes.some(node=>node.id===id)):automaticNodeIds(card,timing,pool.nodes);return card;}).filter(Boolean);
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
  const cardIds=[...new Set(room.state.used.filter(id=>id!==DEFAULT_SETTLEMENT_CARD.id))];
  if(cardIds.length)room.recentGames=[cardIds,...(room.recentGames||[])].slice(0,RECENT_GAME_MULTIPLIERS.length);
}
function hashPassword(password,salt){return scryptSync(String(password),salt,32);}
function passwordMatches(room,password){const candidate=hashPassword(password,room.passwordSalt);return candidate.length===room.passwordHash.length&&timingSafeEqual(candidate,room.passwordHash);}
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
  if(origin==='null')return isLoopback(requestHost)&&isLoopback(request?.socket?.remoteAddress);
  if(!origin)return false;
  let parsed;try{parsed=new URL(origin);}catch{return false;}
  if(!['http:','https:'].includes(parsed.protocol))return false;
  const configured=String(process.env.ALLOWED_ORIGINS||'').split(',').map(value=>value.trim()).filter(Boolean);
  if(configured.includes(origin))return true;
  if(parsed.host.toLowerCase()===requestHost.toLowerCase())return true;
  return isLoopback(parsed.hostname)&&isLoopback(requestHost)&&isLoopback(request?.socket?.remoteAddress);
}
function connectionCountForIp(ip){let count=0;for(const session of connections.values())if(session.ip===ip)count+=1;return count;}
function allowMessage(session){
  const now=Date.now();if(!session.messageWindowStart||now-session.messageWindowStart>=MESSAGE_WINDOW_MS){session.messageWindowStart=now;session.messageCount=0;}
  session.messageCount+=1;return session.messageCount<=MAX_MESSAGES_PER_WINDOW;
}
function allowRoomCreation(ip){
  const cutoff=Date.now()-ROOM_CREATE_WINDOW_MS,entries=(roomCreations.get(ip)||[]).filter(time=>time>cutoff);
  if(entries.length>=MAX_ROOM_CREATIONS_PER_WINDOW){roomCreations.set(ip,entries);return false;}
  entries.push(Date.now());roomCreations.set(ip,entries);return true;
}
function cardsConflict(left,right){
  if(!left||!right)return false;
  const leftGroups=Array.isArray(left.conflictGroups)?left.conflictGroups:[],rightGroups=new Set(Array.isArray(right.conflictGroups)?right.conflictGroups:[]);
  return leftGroups.some(group=>rightGroups.has(group))||(Array.isArray(left.conflicts)&&left.conflicts.includes(right.id))||(Array.isArray(right.conflicts)&&right.conflicts.includes(left.id));
}
function canDrawSequence(nodes,availableCards,activeCards=[]){
  if(!nodes.length)return true;
  const [node,...remainingNodes]=nodes;
  for(const card of availableCards){
    if((!card.tags?.includes('any')&&!card.tags?.includes(node.id))||activeCards.some(active=>cardsConflict(card,active)))continue;
    if(card.lockFurtherDraws||card.id==='P31')return true;
    if(canDrawSequence(remainingNodes,availableCards.filter(item=>item.id!==card.id),[...activeCards,card]))return true;
  }
  return false;
}
function preservesFutureDraws(room,phaseId,candidate){
  if(candidate.lockFurtherDraws||candidate.id==='P31')return true;
  const currentIndex=room.phases.findIndex(phase=>phase.id===phaseId),remainingNodes=room.phases.slice(currentIndex+1).filter(phase=>!room.state.triggered.includes(phase.id));
  if(!remainingNodes.length)return true;
  const blockedIds=new Set([...room.state.used,candidate.id]);
  const available=room.cardPool.filter(card=>!blockedIds.has(card.id)&&!card.tags?.includes('settlement'));
  return canDrawSequence(remainingNodes,available,[...room.state.active.map(item=>item.card),candidate]);
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
function send(socket,message){if(socket.readyState===1)socket.send(JSON.stringify(message));}
function error(socket,code,message,extra={}){send(socket,{type:'error',code,message,...extra});}
function roomSummary(room){return {id:room.id,memberCount:room.clients.size,phase:room.state.phase,drawn:room.state.triggered.length,nodeCount:room.phases.length,locked:room.state.locked,createdAt:room.createdAt,lastActivity:room.lastActivity};}
function roomList(){return [...rooms.values()].sort((a,b)=>b.createdAt-a.createdAt).map(roomSummary);}
function sendLobby(socket,notice=''){send(socket,{type:'lobby',rooms:roomList(),notice});}
function broadcastLobby(){for(const [socket,session] of connections)if(!session.roomId)sendLobby(socket);}
function broadcastRoom(room,message){for(const socket of room.clients)send(socket,message);}

function scheduleRoomDeletion(room){
  if(room.disconnectTimer)clearTimeout(room.disconnectTimer);
  if(room.clients.size)return;
  room.disconnectTimer=setTimeout(()=>{room.disconnectTimer=null;if(rooms.get(room.id)===room&&!room.clients.size)deleteRoom(room,'房间内所有玩家已退出');},DISCONNECT_GRACE_MS);
  room.disconnectTimer.unref?.();
}
function deleteRoom(room,reason='房间已关闭'){
  if(rooms.get(room.id)!==room)return;
  rooms.delete(room.id);if(room.disconnectTimer)clearTimeout(room.disconnectTimer);roomFailures.delete(room.id);
  const members=[...room.clients];
  for(const socket of members){const session=connections.get(socket);if(session){session.roomId=null;session.memberToken=null;}send(socket,{type:'roomClosed',reason});sendLobby(socket,reason);}
  room.clients.clear();broadcastLobby();
}
function touch(room){room.lastActivity=Date.now();broadcastLobby();}
function addToRoom(socket,room,clientId,token){
  const session=connections.get(socket);if(!session)return;
  if(session.roomId){const old=rooms.get(session.roomId);if(old)old.clients.delete(socket);}
  if(room.disconnectTimer){clearTimeout(room.disconnectTimer);room.disconnectTimer=null;}
  room.clients.add(socket);room.members.set(token,{clientId,joinedAt:Date.now(),disconnectedAt:null});session.roomId=room.id;session.memberToken=token;session.clientId=clientId;
  send(socket,{type:'roomJoined',roomId:room.id,memberToken:token,owner:room.ownerClientId===clientId,state:snapshot(room),config:{poolId:room.poolId,poolName:room.poolName,poolVersion:room.poolVersion,phases:structuredClone(room.phases),cards:structuredClone(room.cardPool)},room:roomSummary(room),serverTime:Date.now()});
  broadcastRoom(room,{type:'roomPresence',room:roomSummary(room)});broadcastLobby();
}
function leaveRoom(socket,explicit=false){
  const session=connections.get(socket);if(!session?.roomId)return;
  const room=rooms.get(session.roomId);if(room){room.clients.delete(socket);broadcastRoom(room,{type:'roomPresence',room:roomSummary(room)});if(explicit&&room.clients.size===0)deleteRoom(room,'房间内所有玩家已退出');else if(!room.clients.size)scheduleRoomDeletion(room);}
  if(!explicit&&room&&session.memberToken){const member=room.members.get(session.memberToken);if(member)member.disconnectedAt=Date.now();}
  if(explicit&&room&&session.memberToken)room.members.delete(session.memberToken);
  session.roomId=null;session.memberToken=null;if(explicit){send(socket,{type:'roomLeft',reason:'已退出房间'});sendLobby(socket,'已退出房间');}broadcastLobby();
}
function failKey(ip,roomId){return ip+'|'+roomId;}
function checkJoinLock(ip,roomId){
  const now=Date.now(),key=failKey(ip,roomId),ipEntry=ipFailures.get(key),roomEntry=roomFailures.get(roomId);
  if(ipEntry?.lockedUntil>now)return {kind:'ip',seconds:Math.ceil((ipEntry.lockedUntil-now)/1000)};
  if(ipEntry?.lockedUntil&&ipEntry.lockedUntil<=now)ipFailures.delete(key);
  if(roomEntry?.lockedUntil>now)return {kind:'room',seconds:Math.ceil((roomEntry.lockedUntil-now)/1000)};
  if(roomEntry?.lockedUntil&&roomEntry.lockedUntil<=now)roomFailures.delete(roomId);return null;
}
function recordJoinFailure(ip,roomId){
  const key=failKey(ip,roomId),entry=ipFailures.get(key)||{count:0};entry.count+=1;if(entry.count>=IP_FAIL_LIMIT){entry.lockedUntil=Date.now()+IP_LOCK_MS;entry.count=0;}ipFailures.set(key,entry);
  const roomEntry=roomFailures.get(roomId)||{count:0};roomEntry.count+=1;if(roomEntry.count>=ROOM_FAIL_LIMIT){roomEntry.lockedUntil=Date.now()+ROOM_LOCK_MS;roomEntry.count=0;}roomFailures.set(roomId,roomEntry);
  return {ipLocked:!!entry.lockedUntil,roomLocked:!!roomEntry.lockedUntil};
}
function clearJoinFailure(ip,roomId){ipFailures.delete(failKey(ip,roomId));}
function resumeRoom(socket,clientId,roomId,token){
  const room=rooms.get(String(roomId)),key=String(token),member=room?.members.get(key);
  if(!room||!member||member.clientId!==clientId)return false;
  if(member.disconnectedAt&&Date.now()-member.disconnectedAt>DISCONNECT_GRACE_MS){room.members.delete(key);return false;}
  addToRoom(socket,room,clientId,key);return true;
}
function createRoom(socket,clientId,password,poolId=''){
  const session=connections.get(socket);if(session?.roomId)return error(socket,'ALREADY_IN_ROOM','你已经在一个房间中。');
  if(!/^\d{6}$/.test(password))return error(socket,'INVALID_PASSWORD','房间密码必须是 6 位数字。');
  if(rooms.size>=MAX_ROOMS)return error(socket,'ROOM_LIMIT','当前房间数量已达上限，请稍后再试。');
  if(!allowRoomCreation(session?.ip||'unknown'))return error(socket,'CREATE_LIMIT','创建房间过于频繁，请 10 分钟后再试。');
  const liveAccountSession=session?.accountToken?accountStore.session(session.accountToken):null;
  let config;try{config=buildRoomConfig(liveAccountSession?.user.id||null,cleanText(poolId,64));}catch(issue){return error(socket,issue.code||'POOL_INVALID',issue.message);}
  const id=makeRoomId();if(!id)return error(socket,'ROOM_FULL','暂时无法生成房间号，请稍后再试。');
  const now=Date.now(),passwordSalt=randomBytes(16);const room={id,passwordSalt,passwordHash:hashPassword(password,passwordSalt),state:initialState(config.phases),phases:config.phases,cardPool:config.cards,poolId:config.poolId,poolName:config.poolName,poolVersion:config.poolVersion||1,recentGames:[],clients:new Set(),members:new Map(),ownerClientId:clientId,ownerUserId:session?.userId||null,createdAt:now,lastActivity:now,disconnectTimer:null};rooms.set(id,room);addToRoom(socket,room,clientId,makeToken());
}
function joinRoom(socket,clientId,roomId,password){
  const session=connections.get(socket);if(session?.roomId)return error(socket,'ALREADY_IN_ROOM','你已经在一个房间中。');roomId=String(roomId||'').trim();password=String(password||'');
  if(!/^\d{4}$/.test(roomId))return error(socket,'INVALID_ROOM_ID','房间号必须是 4 位数字。');if(!/^\d{6}$/.test(password))return error(socket,'INVALID_PASSWORD','房间密码必须是 6 位数字。');
  const ip=session?.ip||'unknown',lock=checkJoinLock(ip,roomId);if(lock)return error(socket,'JOIN_LOCKED',lock.kind==='ip'?'该房间密码尝试次数过多，请稍后再试。':'该房间暂时停止加入，请稍后再试。',{retryAfter:lock.seconds});
  const room=rooms.get(roomId);if(!room)return error(socket,'ROOM_NOT_FOUND','房间不存在，可能已经结束或被删除。');
  if(room.clients.size>=MAX_ROOM_MEMBERS)return error(socket,'ROOM_FULL','该房间已满（最多 4 人）。');
  if(!passwordMatches(room,password)){const failure=recordJoinFailure(ip,roomId);const message=failure.ipLocked?'密码错误次数达到上限，已锁定 10 分钟。':failure.roomLocked?'该房间错误尝试过多，已暂停加入 10 分钟。':'房间密码错误。';return error(socket,failure.ipLocked||failure.roomLocked?'JOIN_LOCKED':'BAD_PASSWORD',message);}
  clearJoinFailure(ip,roomId);addToRoom(socket,room,clientId,makeToken());
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
  if(!['start','reset'].includes(action))return error(socket,'BAD_TIMER_ACTION','无法识别计时操作。');
  const previous=room.state[stateKey]||{revision:0};
  room.state[stateKey]={started:true,endsAt:Date.now()+durationSeconds*1000,revision:Number(previous.revision||0)+1,cardId,durationSeconds};
  room.state.version+=1;touch(room);
  broadcastRoom(room,{type:'timer',timerBy:clientId,action,state:snapshot(room),serverTime:Date.now()});
}
function draw(socket,clientId,requestedPhase){
  const session=connections.get(socket),room=rooms.get(session?.roomId);if(!room)return error(socket,'ROOM_REQUIRED','请先创建或加入房间。');const state=room.state,pending=room.phases.find(phase=>!state.triggered.includes(phase.id));
  if(state.locked)return error(socket,'LOCKED','本局后续海克斯抽取已被封锁。');if(!pending||requestedPhase!==pending.id||state.phase!==pending.id)return error(socket,'PHASE_NOT_ALLOWED','请按顺序完成前面的节点。');
  const eligible=phaseCards(room,requestedPhase).filter(card=>preservesFutureDraws(room,requestedPhase,card));if(!eligible.length)return error(socket,'POOL_EMPTY','该节点没有不会阻断后续抽取的海克斯。');let card=resolveCard(weightedCardPick(room,eligible));state.used.push(card.id);state.triggered.push(requestedPhase);let bonusCards=[];
  if(card.id==='P31'){while(bonusCards.length<3){const bonusPool=phaseCards(room,requestedPhase,[card,...bonusCards]).filter(item=>item.bonusEligible!==false);if(!bonusPool.length)break;const bonus=resolveCard(weightedCardPick(room,bonusPool));bonusCards.push(bonus);state.used.push(bonus.id);}card={...card,resolution:{kind:'bonusHexes',cards:bonusCards.map(item=>({id:item.id,name:item.name,effect:item.effect}))},effect:'本局随机抽取三张海克斯，额外生效：'+bonusCards.map(item=>item.name).join('、')+'；本局不再获得海克斯。'};}
  state.active.push({card,phase:requestedPhase});state.history.push(historyEntry(card,requestedPhase,room.phases));for(const bonus of bonusCards){state.active.push({card:bonus,phase:requestedPhase,source:'P31'});state.history.push(historyEntry(bonus,requestedPhase,room.phases));}
  if(card.id==='P31'){state.triggered=room.phases.map(phase=>phase.id);state.phase=room.phases.at(-1).id;state.locked=true;}else if(card.lockFurtherDraws)state.locked=true;
  if(!state.locked){const currentIndex=room.phases.findIndex(phase=>phase.id===requestedPhase);const next=room.phases.slice(currentIndex+1).find(phase=>!state.triggered.includes(phase.id));if(next)state.phase=next.id;}
  state.version+=1;touch(room);broadcastRoom(room,{type:'drawn',drawnBy:clientId,card,phase:requestedPhase,bonusCards:bonusCards.map(item=>({id:item.id,name:item.name})),state:snapshot(room),serverTime:Date.now()});
}
function roundReady(state,phaseList=defaultPhases){return state.locked||phaseList.every(phase=>state.triggered.includes(phase.id));}
function reset(socket,roundId=''){
  const session=connections.get(socket),room=rooms.get(session?.roomId);if(!room)return error(socket,'ROOM_REQUIRED','请先创建或加入房间。');
  if(roundId&&String(roundId)!==room.state.roundId)return error(socket,'STALE_ROUND','本局已经被其他玩家结算或重置。');
  if(roundReady(room.state,room.phases))return error(socket,'USE_SETTLEMENT','本局已经可以结算，请点击“结算本局”。');
  rememberRound(room);const next=initialState(room.phases);next.version=Number(room.state.version||0)+1;room.state=next;touch(room);broadcastRoom(room,{type:'reset',state:snapshot(room),serverTime:Date.now()});send(socket,{type:'reset-ack'});
}
function settle(socket,clientId,roundId){
  const session=connections.get(socket),room=rooms.get(session?.roomId);if(!room)return error(socket,'ROOM_REQUIRED','请先创建或加入房间。');
  if(!roundId||String(roundId)!==room.state.roundId)return error(socket,'STALE_ROUND','本局已经被其他玩家结算或重置。');
  if(!roundReady(room.state,room.phases))return error(socket,'SETTLEMENT_NOT_READY','完成全部抽取节点后才能结算本局。');
  const settlementCard=room.cardPool.find(card=>card.id==='R06'&&card.tags?.includes('settlement'))||null;
  const previousVersion=Number(room.state.version||0),triggered=!!settlementCard&&randomInt(1_000_000)<Math.round(SETTLEMENT_TRIGGER_RATE*1_000_000);rememberRound(room);
  const next=initialState(room.phases);next.version=previousVersion+1;room.state=next;touch(room);
  broadcastRoom(room,{type:'settlement',settledBy:clientId,triggered,card:triggered?settlementCard:null,state:snapshot(room),serverTime:Date.now()});
}
function cleanRooms(){
  const now=Date.now();
  for(const room of rooms.values()){
    for(const [token,member] of room.members)if(member.disconnectedAt&&now-member.disconnectedAt>DISCONNECT_GRACE_MS)room.members.delete(token);
    if(now-room.lastActivity>=ROOM_IDLE_MS)deleteRoom(room,'房间超过 30 分钟没有牌局操作，已自动删除');
  }
  for(const [ip,entries] of roomCreations){const recent=entries.filter(time=>now-time<ROOM_CREATE_WINDOW_MS);if(recent.length)roomCreations.set(ip,recent);else roomCreations.delete(ip);}
  for(const [ip,entries] of authAttempts){const recent=entries.filter(time=>now-time<10*60*1000);if(recent.length)authAttempts.set(ip,recent);else authAttempts.delete(ip);}
}

function parseCookies(request){const result={};for(const part of String(request.headers.cookie||'').split(';')){const separator=part.indexOf('=');if(separator<0)continue;const key=part.slice(0,separator).trim(),value=part.slice(separator+1).trim();if(key)result[key]=decodeURIComponent(value);}return result;}
function requestAccountSession(request){return accountStore.session(parseCookies(request).hex_session||'');}
function secureRequest(request){return request.socket?.encrypted||firstHeader(request.headers['x-forwarded-proto']).toLowerCase()==='https';}
function sessionCookie(request,token,maxAgeSeconds){return `hex_session=${encodeURIComponent(token||'')}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0,Math.floor(maxAgeSeconds))}${secureRequest(request)?'; Secure':''}`;}
function sendJson(response,status,payload,extraHeaders={}){const body=Buffer.from(JSON.stringify(payload));response.writeHead(status,{...responseHeaders('application/json; charset=utf-8'),...extraHeaders,'Content-Length':body.length});response.end(body);}
async function readJsonBody(request){return new Promise((resolve,reject)=>{let size=0,body='',tooLarge=false;request.setEncoding('utf8');request.on('data',chunk=>{if(tooLarge)return;size+=Buffer.byteLength(chunk);if(size>64*1024){tooLarge=true;body='';return;}body+=chunk;});request.on('end',()=>{if(tooLarge){reject(problem('BODY_TOO_LARGE','请求内容过大。',413));return;}try{resolve(body?JSON.parse(body):{});}catch{reject(problem('INVALID_JSON','请求内容不是有效的 JSON。'));}});request.on('error',reject);});}
function allowAuthRequest(ip){const now=Date.now(),recent=(authAttempts.get(ip)||[]).filter(time=>now-time<10*60*1000);if(recent.length>=20){authAttempts.set(ip,recent);return false;}recent.push(now);authAttempts.set(ip,recent);return true;}
function requireApiAuth(request){const session=requestAccountSession(request);if(!session)throw problem('AUTH_REQUIRED','请先登录账号。',401);return session;}
function requireApiMutation(request,session){if(!allowedWebSocketOrigin(request))throw problem('ORIGIN_REJECTED','请求来源不受信任。',403);if(firstHeader(request.headers['x-csrf-token'])!==session.csrfToken)throw problem('CSRF_REJECTED','登录状态校验失败，请刷新页面后重试。',403);}
function apiStudioPayload(userId){return {officialCards:cards,privateCards:accountStore.listCards(userId),pools:accountStore.listPools(userId),nodeTypes:[{id:'opening',name:'开局'},{id:'inGame',name:'牌局进行中'},{id:'afterWin',name:'有人胡牌后'},{id:'lateGame',name:'牌局后期'},{id:'custom',name:'自定义'}],timings:[{id:'any',name:'所有节点'},{id:'opening',name:'仅开局'},{id:'afterWin',name:'有人胡牌后'},{id:'lateGame',name:'牌局后期'}]};}
async function handleApi(request,response,pathname){
  const method=String(request.method||'GET').toUpperCase(),ip=clientIp(request);
  try{
    if(pathname==='/api/me'&&method==='GET'){const session=requestAccountSession(request);return sendJson(response,200,{user:session?.user||null,csrfToken:session?.csrfToken||null});}
    if(pathname==='/api/auth/register'&&method==='POST'){
      if(!allowedWebSocketOrigin(request))throw problem('ORIGIN_REJECTED','请求来源不受信任。',403);if(!allowAuthRequest(ip))throw problem('AUTH_RATE_LIMIT','注册或登录尝试过于频繁，请稍后再试。',429);
      const body=await readJsonBody(request),user=accountStore.register(validateUsername(body.username),validateAccountPassword(body.password)),session=accountStore.createSession(user.id);
      return sendJson(response,201,{user,csrfToken:session.csrfToken},{'Set-Cookie':sessionCookie(request,session.token,(session.expiresAt-Date.now())/1000)});
    }
    if(pathname==='/api/auth/login'&&method==='POST'){
      if(!allowedWebSocketOrigin(request))throw problem('ORIGIN_REJECTED','请求来源不受信任。',403);if(!allowAuthRequest(ip))throw problem('AUTH_RATE_LIMIT','注册或登录尝试过于频繁，请稍后再试。',429);
      const body=await readJsonBody(request),username=validateUsername(body.username),password=validateAccountPassword(body.password),user=accountStore.verify(username,password);if(!user)throw problem('INVALID_CREDENTIALS','用户名或密码错误。',401);const session=accountStore.createSession(user.id);
      return sendJson(response,200,{user,csrfToken:session.csrfToken},{'Set-Cookie':sessionCookie(request,session.token,(session.expiresAt-Date.now())/1000)});
    }
    if(pathname==='/api/auth/logout'&&method==='POST'){const session=requireApiAuth(request);requireApiMutation(request,session);accountStore.logout(parseCookies(request).hex_session||'');return sendJson(response,200,{ok:true},{'Set-Cookie':sessionCookie(request,'',0)});}
    if(pathname==='/api/studio'&&method==='GET'){const session=requireApiAuth(request);return sendJson(response,200,{user:session.user,csrfToken:session.csrfToken,...apiStudioPayload(session.user.id)});}

    const cardMatch=pathname.match(/^\/api\/private-cards(?:\/([A-Za-z0-9_-]+))?$/);
    if(cardMatch){const session=requireApiAuth(request);if(method!=='GET')requireApiMutation(request,session);const cardId=cardMatch[1];
      if(method==='GET'&&!cardId)return sendJson(response,200,{cards:accountStore.listCards(session.user.id)});
      if(method==='POST'&&!cardId)return sendJson(response,201,{card:accountStore.createCard(session.user.id,sanitizePrivateCard(await readJsonBody(request)))});
      if(method==='PUT'&&cardId){const card=accountStore.updateCard(session.user.id,cardId,sanitizePrivateCard(await readJsonBody(request)));if(!card)throw problem('CARD_NOT_FOUND','私人卡牌不存在。',404);return sendJson(response,200,{card});}
      if(method==='DELETE'&&cardId){if(accountStore.cardUsedByPool(session.user.id,cardId))throw problem('CARD_IN_USE','请先从所有卡池中移除这张卡。',409);if(!accountStore.deleteCard(session.user.id,cardId))throw problem('CARD_NOT_FOUND','私人卡牌不存在。',404);return sendJson(response,200,{ok:true});}
      throw problem('METHOD_NOT_ALLOWED','不支持该卡牌操作。',405);
    }

    const poolMatch=pathname.match(/^\/api\/pools(?:\/([A-Za-z0-9_-]+))?$/);
    if(poolMatch){const session=requireApiAuth(request);if(method!=='GET')requireApiMutation(request,session);const poolId=poolMatch[1];
      if(method==='GET'&&!poolId)return sendJson(response,200,{pools:accountStore.listPools(session.user.id)});
      if(method==='POST'&&!poolId){const input=sanitizePoolInput(session.user.id,await readJsonBody(request));compilePoolConfig(session.user.id,{id:'preview',version:1,...input});return sendJson(response,201,{pool:accountStore.createPool(session.user.id,input)});}
      if(method==='PUT'&&poolId){if(!accountStore.getPool(session.user.id,poolId))throw problem('POOL_NOT_FOUND','私人卡池不存在。',404);const input=sanitizePoolInput(session.user.id,await readJsonBody(request));compilePoolConfig(session.user.id,{id:poolId,version:1,...input});return sendJson(response,200,{pool:accountStore.updatePool(session.user.id,poolId,input)});}
      if(method==='DELETE'&&poolId){if([...rooms.values()].some(room=>room.poolId===poolId))throw problem('POOL_IN_USE','该卡池正在被房间使用，房间结束后才能删除。',409);if(!accountStore.deletePool(session.user.id,poolId))throw problem('POOL_NOT_FOUND','私人卡池不存在。',404);return sendJson(response,200,{ok:true});}
      throw problem('METHOD_NOT_ALLOWED','不支持该卡池操作。',405);
    }
    throw problem('API_NOT_FOUND','接口不存在。',404);
  }catch(issue){return sendJson(response,Number(issue.status)||500,{error:issue.code||'SERVER_ERROR',message:Number(issue.status)?issue.message:'服务器处理请求时出现错误。'});}
}

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
function responseHeaders(contentType='text/plain; charset=utf-8',allowSameOriginFrame=false,cacheControl='no-cache'){
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
    'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; connect-src 'self' ws: wss:; frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors "+frameAncestors+"; form-action 'self'"
  };
}
const server=http.createServer(async(request,response)=>{
  try{
    const parsed=new URL(request.url,'http://localhost');let pathname=decodeURIComponent(parsed.pathname);
    if(pathname==='/hex-mahjong')pathname='/';else if(pathname.startsWith('/hex-mahjong/'))pathname=pathname.slice('/hex-mahjong'.length);
    if(pathname.startsWith('/api/'))return await handleApi(request,response,pathname);
    if(!['GET','HEAD'].includes(request.method||'')){response.writeHead(405,{...responseHeaders(),'Allow':'GET, HEAD'});return response.end('Method not allowed');}
    const filename=publicFile(pathname);if(!filename){response.writeHead(404,responseHeaders());return response.end('Not found');}
    const fileStat=await stat(filename);if(!fileStat.isFile())throw new Error('Not a file');
    const extension=path.extname(filename).toLowerCase(),allowSameOriginFrame=pathname==='/artifacts/bai-zhe-shi-chen/web/index.html';
    const data=await readFile(filename),headers=responseHeaders(types[extension]||'application/octet-stream',allowSameOriginFrame,cacheControlFor(pathname,parsed.searchParams));
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
  verifyClient:({req})=>allowedWebSocketOrigin(req)&&connections.size<MAX_TOTAL_CONNECTIONS&&connectionCountForIp(clientIp(req))<MAX_CONNECTIONS_PER_IP
});
wss.on('connection',(socket,request)=>{
  socket.isAlive=true;socket.on('pong',()=>{socket.isAlive=true;});
  const accountToken=parseCookies(request).hex_session||'',accountSession=accountStore.session(accountToken);
  connections.set(socket,{clientId:'anonymous',roomId:null,memberToken:null,userId:accountSession?.user.id||null,accountToken,ip:clientIp(request),messageWindowStart:Date.now(),messageCount:0});sendLobby(socket);
  socket.on('message',raw=>{const session=connections.get(socket);if(!session)return;if(!allowMessage(session)){socket.close(1008,'消息过于频繁');return;}try{const message=JSON.parse(raw.toString());
    if(message.type==='hello'){session.clientId=String(message.clientId||'anonymous').slice(0,64);if(message.roomId&&message.memberToken&&!resumeRoom(socket,session.clientId,String(message.roomId),String(message.memberToken)))sendLobby(socket,'上次的房间已失效，请重新加入。');else if(!session.roomId)sendLobby(socket);return;}
    if(message.type==='listRooms')return sendLobby(socket);if(message.type==='createRoom')return createRoom(socket,session.clientId,String(message.password||''),String(message.poolId||''));if(message.type==='joinRoom')return joinRoom(socket,session.clientId,String(message.roomId||''),String(message.password||''));if(message.type==='leaveRoom')return leaveRoom(socket,true);if(message.type==='draw')return draw(socket,session.clientId,String(message.phase||''));if(message.type==='reveal')return revealRandomCard(socket,session.clientId,String(message.cardId||''));if(message.type==='timer')return updateTimer(socket,session.clientId,String(message.action||''),String(message.cardId||''));if(message.type==='settle')return settle(socket,session.clientId,String(message.roundId||''));if(message.type==='reset')return reset(socket,String(message.roundId||''));error(socket,'BAD_MESSAGE','无法识别请求。');
  }catch{error(socket,'BAD_MESSAGE','无法解析请求。');}});
  const disconnect=()=>{if(!connections.has(socket))return;leaveRoom(socket,false);connections.delete(socket);};socket.on('close',disconnect);socket.on('error',disconnect);
});
const heartbeatInterval=setInterval(()=>{for(const socket of wss.clients){if(socket.isAlive===false){socket.terminate();continue;}socket.isAlive=false;socket.ping();}},HEARTBEAT_MS);heartbeatInterval.unref?.();
setInterval(cleanRooms,60*1000).unref?.();server.listen(port,host,()=>console.log(`Hex Mahjong lobby server: http://${host}:${port}`));
