import {performance} from 'node:perf_hooks';
import {securityError} from './security.mjs';

export function cardsConflict(left,right){
  const groups=new Set(right.conflictGroups||[]);
  return (left.conflictGroups||[]).some(group=>groups.has(group))||(left.conflicts||[]).includes(right.id)||(right.conflicts||[]).includes(left.id);
}
export function searchBudget({maxSteps=12000,maxMs=20}={}){
  const deadline=performance.now()+maxMs;let steps=0;
  return {tick(){if(++steps>maxSteps||performance.now()>deadline)throw securityError('POOL_TOO_COMPLEX','卡池组合过于复杂，请减少冲突卡或调整出现节点后重试。',422);},get steps(){return steps;}};
}
const atNode=(card,nodeId)=>card.tags?.includes('any')||card.tags?.includes(nodeId);
const compatible=(card,active)=>active.every(other=>!cardsConflict(card,other));

export function canCompleteSet(available,selected,count,nodeId,budget=searchBudget()){
  const ids=new Set(selected.map(card=>card.id));
  const candidates=available.filter(card=>!ids.has(card.id)&&card.bonusEligible!==false&&!card.tags?.includes('settlement')&&atNode(card,nodeId)&&compatible(card,selected));
  function visit(start,chosen){
    budget.tick();if(chosen.length===count)return true;
    if(candidates.length-start<count-chosen.length)return false;
    for(let i=start;i<candidates.length;i++){budget.tick();const card=candidates[i];if(compatible(card,chosen)&&visit(i+1,[...chosen,card]))return true;}
    return false;
  }
  return visit(0,[]);
}

export function canDrawSequence(nodes,available,active=[],budget=searchBudget()){
  const memo=new Map();
  function visit(index,remaining,chosen){
    budget.tick();if(index===nodes.length)return true;
    const key=index+'|'+chosen.map(card=>card.id).sort().join(',');if(memo.has(key))return memo.get(key);
    const usable=remaining.filter(card=>compatible(card,chosen));
    const lists=nodes.slice(index).map(node=>usable.filter(card=>atNode(card,node.id)));
    if(!lists[0].length)return false;
    // Hall matching detects nodes competing for the same cards without factorial search.
    // A possible early terminal card bypasses this prune; node order stays unchanged.
    if(!lists.some(list=>list.some(card=>card.lockFurtherDraws||card.id==='P31'))){
      const assigned=new Map();
      function match(i,seen){for(const card of lists[i]){budget.tick();if(seen.has(card.id))continue;seen.add(card.id);if(!assigned.has(card.id)||match(assigned.get(card.id),seen)){assigned.set(card.id,i);return true;}}return false;}
      for(const i of lists.map((_,i)=>i).sort((a,b)=>lists[a].length-lists[b].length))if(!match(i,new Set())){memo.set(key,false);return false;}
    }
    for(const card of lists[0]){
      budget.tick();let works;
      if(card.id==='P31')works=canCompleteSet(usable,[...chosen,card],3,nodes[index].id,budget);
      else works=card.lockFurtherDraws||visit(index+1,usable.filter(item=>item.id!==card.id),[...chosen,card]);
      if(works){memo.set(key,true);return true;}
    }
    memo.set(key,false);return false;
  }
  return visit(0,available,active);
}
