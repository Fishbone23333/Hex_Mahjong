function cardsConflict(left,right){
  const rightGroups=new Set(right.conflictGroups||[]);
  return (left.conflictGroups||[]).some(group=>rightGroups.has(group))||(left.conflicts||[]).includes(right.id)||(right.conflicts||[]).includes(left.id);
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

export function initialOpeningPool(cards){
  const opening=cards.filter(card=>card.tags?.includes('any')||card.tags?.includes('opening'));
  const future=[{id:'firstWin'},{id:'secondWin'}];
  return opening.filter(candidate=>{
    if(candidate.lockFurtherDraws||candidate.id==='P31')return true;
    const available=cards.filter(card=>card.id!==candidate.id&&!card.tags?.includes('settlement'));
    return canDrawSequence(future,available,[candidate]);
  });
}
