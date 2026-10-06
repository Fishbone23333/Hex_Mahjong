import {strict as assert} from 'node:assert';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import WebSocket from 'ws';
import {initialOpeningPool} from './test-card-selection.mjs';

const cards=JSON.parse(await readFile(new URL('../cards.json',import.meta.url),'utf8'));
const byId=Object.fromEntries(cards.map(card=>[card.id,card]));
const cardsConflict=(left,right)=>{
  const rightGroups=new Set(right.conflictGroups||[]);
  return (left.conflictGroups||[]).some(group=>rightGroups.has(group))||(left.conflicts||[]).includes(right.id)||(right.conflicts||[]).includes(left.id);
};
const expectedPairs=[
  ['P02','P14'],['P04','P05'],['P04','P16'],['P05','P16'],
  ['P19','P17'],['P19','N06'],['P19','P44'],
  ['P18','P42'],['P18','R01'],['P18','R03'],['P42','R01'],['P42','R03'],['R01','R03'],
  ['P21','R02'],['P24','P25'],
  ['P18','N03'],['R02','R05'],['N01','P44'],['P01','P33'],
  ['N05','N09'],['P41','N05'],['P41','P29'],['N03','P15'],
  ['R04','P18'],['R04','P42'],['R04','R01'],['R04','R03']
];
for(const [left,right] of expectedPairs){
  assert.equal(cardsConflict(byId[left],byId[right]),true,`${left} and ${right} must conflict`);
  assert.equal(cardsConflict(byId[right],byId[left]),true,`${right} and ${left} must conflict`);
}
const compatiblePairs=[
  ['P12','P11'],['P12','P10'],['P15','P11'],['P15','P12'],
  ['P02','P16'],['P14','P16'],['P04','N01'],['P21','P17'],
  ['P09','P36'],['P07','P06'],['P07','P08'],['P07','P30'],
  ['P22','P03'],['P39','N09']
];
for(const [left,right] of compatiblePairs)assert.equal(cardsConflict(byId[left],byId[right]),false,`${left} and ${right} should stay compatible`);
for(const id of ['R01','R04','P42','R03']){
  assert.equal(byId[id].bonusEligible,false,`${id} must be excluded from Firepower Full On bonuses`);
  assert.equal(byId[id].lockFurtherDraws,true,`${id} must lock later draws`);
}
assert.deepEqual(byId.N07.tags,['settlement'],'soul transfer must not enter normal draws');
const prismaticIds=['R01','R02','R03','R04','R05','R06'];
for(const id of prismaticIds)assert.equal(byId[id].prismatic,true,`${id} must be marked prismatic`);
assert.deepEqual(cards.filter(card=>card.prismatic).map(card=>card.id),prismaticIds,'prismatic cards must stay together in R-series order');
assert.deepEqual(cards.slice(-prismaticIds.length).map(card=>card.id),prismaticIds,'prismatic cards must remain grouped at the end of the catalog data');
for(const id of ['R01','R02','R03','R04','R05'])assert.equal(byId[id].tags.includes('settlement'),false,`${id} prismatic rarity must not change its draw node`);

const port=3204,origin=`http://127.0.0.1:${port}`;
const openingPool=initialOpeningPool(cards);
const targetIndex=openingPool.findIndex(card=>card.id==='P31');
assert.ok(targetIndex>=0,'P31 missing from opening pool');
const fixedRandom=((targetIndex+0.25)/openingPool.length).toString();
const server=spawn(process.execPath,['--input-type=module','--eval',`Math.random=()=>${fixedRandom}; await import('./server.mjs');`],{
  cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),HEX_DB_PATH:':memory:',NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']
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

try{
  await ready;
  const owner=await connect();owner.send(JSON.stringify({type:'hello',clientId:'conflict-owner'}));
  await sendAndWait(owner,{type:'createRoom',password:'123456'},message=>message.type==='roomJoined');
  const drawn=await sendAndWait(owner,{type:'draw',phase:'opening'},message=>message.type==='drawn');
  assert.equal(drawn.card.id,'P31');
  assert.equal(drawn.bonusCards.length,3);
  const bonusCards=drawn.bonusCards.map(item=>byId[item.id]);
  assert.ok(bonusCards.every(card=>card.bonusEligible!==false),'locked card entered bonus pool');
  for(let left=0;left<bonusCards.length;left++)for(let right=left+1;right<bonusCards.length;right++)assert.equal(cardsConflict(bonusCards[left],bonusCards[right]),false,`${bonusCards[left].id} conflicts with ${bonusCards[right].id}`);
  owner.close();
  console.log(JSON.stringify({metadataPairs:true,lockedCardsExcluded:true,firepowerConflictFree:true,bonusCards:drawn.bonusCards.map(card=>card.id)}));
}finally{stop();}
