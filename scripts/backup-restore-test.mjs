import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createAccountStore} from '../lib/account-store.mjs';
import {backupDatabase} from './backup-database.mjs';

const folder=await mkdtemp(path.join(os.tmpdir(),'hex-restore-'));
let original,restored;
try{
  const source=path.join(folder,'source.sqlite'),copy=path.join(folder,'backup.sqlite');
  original=createAccountStore({databasePath:source});
  const user=await original.register('恢复测试玩家','restore-password-2026');
  const card=original.createCard(user.id,{name:'备份牌',effect:'恢复后仍可查看',glyph:'✦',rarity:'standard',recommendedTiming:'opening'});
  const pool=original.createPool(user.id,{name:'备份池',description:'',nodes:[{id:'opening',name:'开局'}],cards:[{source:'private',id:card.id,assignmentMode:'custom',nodeIds:['opening']}]});
  const session=original.createSession(user.id);
  // Keep the original writer open: copying the main file alone would not verify WAL safety.
  await backupDatabase(source,copy);
  restored=createAccountStore({databasePath:copy});
  assert.equal((await restored.verify(user.username,'restore-password-2026')).id,user.id);
  assert.equal(restored.session(session.token).user.id,user.id);
  assert.deepEqual(restored.getCard(user.id,card.id),card);
  assert.deepEqual(restored.getPool(user.id,pool.id),pool);
  assert.equal(restored.listCards(user.id).length,1);assert.equal(restored.listPools(user.id).length,1);
  await assert.rejects(backupDatabase(source,copy),/already exists/);
  console.log(JSON.stringify({consistentWalBackup:true,restoreLogin:true,restoreSession:true,restoreCardsAndPools:true,overwritePrevented:true}));
}finally{restored?.close();original?.close();await rm(folder,{recursive:true,force:true});}
