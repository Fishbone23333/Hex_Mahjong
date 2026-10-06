import path from 'node:path';
import {mkdirSync,chmodSync,statSync,statfsSync} from 'node:fs';
import {randomBytes,randomInt,createHash,timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {derivePassword,securityError} from './security.mjs';
import {maskedEmail} from './email.mjs';

const SESSION_TTL_MS=30*24*60*60*1000;

function randomId(prefix,bytes=12){return prefix+randomBytes(bytes).toString('base64url');}
function tokenHash(token){return createHash('sha256').update(String(token)).digest('hex');}
async function passwordHash(password,salt){return (await derivePassword(password,Buffer.from(salt,'hex'),64)).toString('hex');}
function rowCard(row){return row&&{id:row.id,name:row.name,effect:row.effect,rarity:row.rarity,glyph:row.glyph,recommendedTiming:row.recommended_timing,createdAt:row.created_at,updatedAt:row.updated_at};}
function rowPool(row){return row&&{id:row.id,name:row.name,description:row.description,nodes:JSON.parse(row.nodes_json),cards:JSON.parse(row.cards_json),version:row.version,createdAt:row.created_at,updatedAt:row.updated_at};}

export function createAccountStore({databasePath,maxCards=200,maxPools=30,maxUsers=5000,maxSessions=10,maxDatabaseBytes=256*1024*1024,minFreeBytes=100*1024*1024,now=Date.now}){
  const filename=databasePath||path.resolve('data','hex-mahjong.sqlite');
  if(filename!==':memory:')mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
  const db=new DatabaseSync(filename);
  if(filename!==':memory:'&&process.platform!=='win32')chmodSync(filename,0o600);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(user_id,created_at);
    CREATE TABLE IF NOT EXISTS private_cards (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      effect TEXT NOT NULL,
      rarity TEXT NOT NULL,
      glyph TEXT NOT NULL,
      recommended_timing TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS private_cards_owner ON private_cards(owner_id,updated_at DESC);
    CREATE TABLE IF NOT EXISTS pools (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      nodes_json TEXT NOT NULL,
      cards_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pools_owner ON pools(owner_id,updated_at DESC);
  `);
  const userColumns=new Set(db.prepare('PRAGMA table_info(users)').all().map(column=>column.name));
  if(!userColumns.has('email'))db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  if(!userColumns.has('email_verified_at'))db.exec('ALTER TABLE users ADD COLUMN email_verified_at INTEGER');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_verified_email ON users(email) WHERE email IS NOT NULL;
    CREATE TABLE IF NOT EXISTS email_challenges (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK(purpose IN ('binding','reset')),
      email TEXT NOT NULL,
      previous_email TEXT,
      password_hash TEXT NOT NULL,
      session_hash TEXT,
      secret_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      ready INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id,purpose)
    );
    CREATE INDEX IF NOT EXISTS email_challenges_secret ON email_challenges(secret_hash);
    CREATE INDEX IF NOT EXISTS email_challenges_expiry ON email_challenges(expires_at);
    CREATE TABLE IF NOT EXISTS email_send_limits (
      scope TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  if(filename!==':memory:'&&process.platform!=='win32')for(const file of [filename,filename+'-wal',filename+'-shm']){try{chmodSync(file,0o600);}catch(issue){if(issue.code!=='ENOENT')throw issue;}}

  const queries={
    userByKey:db.prepare('SELECT * FROM users WHERE username_key = ?'),
    userById:db.prepare('SELECT id,username,created_at,email,email_verified_at FROM users WHERE id = ?'),
    userByEmail:db.prepare('SELECT * FROM users WHERE email=? AND email_verified_at IS NOT NULL'),
    authUserById:db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser:db.prepare('INSERT INTO users(id,username,username_key,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)'),
    updatePassword:db.prepare('UPDATE users SET password_salt=?,password_hash=? WHERE id=? AND password_hash=?'),
    insertSession:db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)'),
    sessionByHash:db.prepare('SELECT sessions.*, users.username,users.email,users.email_verified_at, users.created_at AS user_created_at FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=?'),
    deleteSession:db.prepare('DELETE FROM sessions WHERE token_hash=?'),
    deleteOtherSessions:db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?'),
    deleteExpiredSessions:db.prepare('DELETE FROM sessions WHERE expires_at<=?'),
    cardsByOwner:db.prepare('SELECT * FROM private_cards WHERE owner_id=? ORDER BY updated_at DESC,id LIMIT ? OFFSET ?'),
    countCards:db.prepare('SELECT COUNT(*) AS total FROM private_cards WHERE owner_id=?'),
    countPools:db.prepare('SELECT COUNT(*) AS total FROM pools WHERE owner_id=?'),
    countUsers:db.prepare('SELECT COUNT(*) AS total FROM users'),
    cardReferenced:db.prepare("SELECT 1 FROM pools,json_each(pools.cards_json) AS ref WHERE owner_id=? AND json_extract(ref.value,'$.source')='private' AND json_extract(ref.value,'$.id')=? LIMIT 1"),
    cardByOwner:db.prepare('SELECT * FROM private_cards WHERE id=? AND owner_id=?'),
    insertCard:db.prepare('INSERT INTO private_cards(id,owner_id,name,effect,rarity,glyph,recommended_timing,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)'),
    updateCard:db.prepare('UPDATE private_cards SET name=?,effect=?,rarity=?,glyph=?,recommended_timing=?,updated_at=? WHERE id=? AND owner_id=?'),
    deleteCard:db.prepare('DELETE FROM private_cards WHERE id=? AND owner_id=?'),
    poolsByOwner:db.prepare('SELECT * FROM pools WHERE owner_id=? ORDER BY updated_at DESC,id LIMIT ? OFFSET ?'),
    poolByOwner:db.prepare('SELECT * FROM pools WHERE id=? AND owner_id=?'),
    insertPool:db.prepare('INSERT INTO pools(id,owner_id,name,description,nodes_json,cards_json,version,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)'),
    updatePool:db.prepare('UPDATE pools SET name=?,description=?,nodes_json=?,cards_json=?,version=version+1,updated_at=? WHERE id=? AND owner_id=?'),
    deletePool:db.prepare('DELETE FROM pools WHERE id=? AND owner_id=?')
  };

  const dummySalt=randomBytes(16).toString('hex');
  let storageCheckedAt=0,storageIssue=null;
  function writable(){
    if(filename===':memory:')return;
    if(Date.now()-storageCheckedAt>30000){
      storageCheckedAt=Date.now();storageIssue=null;
      const disk=statfsSync(path.dirname(filename));
      const bytes=[filename,filename+'-wal'].reduce((sum,file)=>{try{return sum+statSync(file).size;}catch{return sum;}},0);
      if(Number(disk.bavail)*Number(disk.bsize)<minFreeBytes||bytes>=maxDatabaseBytes)storageIssue=securityError('STORAGE_LIMIT','存储暂时不可写，请稍后重试。',503);
    }
    if(storageIssue)throw storageIssue;
  }
  function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(issue){db.exec('ROLLBACK');throw issue;}}
  const limits=Object.freeze({maxCards,maxPools,maxUsers,maxSessions});
  function page(query,count,ownerId,{limit=100,offset=0}={}){limit=Math.floor(Math.min(100,Math.max(1,Number(limit)||100)));offset=Math.floor(Math.max(0,Math.min(100000,Number(offset)||0)));const items=query.all(ownerId,limit,offset),total=count.get(ownerId).total;return {items,total,nextOffset:offset+items.length<total?offset+items.length:null};}

  function publicUser(row){return row&&{id:row.id,username:row.username,createdAt:row.created_at??row.user_created_at,emailBound:!!row.email_verified_at,emailMasked:row.email_verified_at?maskedEmail(row.email):null};}
  async function register(username,password){
    writable();
    if(queries.countUsers.get().total>=maxUsers)throw securityError('REGISTRATION_LIMIT','当前注册名额已满，请稍后再试。',503);
    const usernameKey=username.normalize('NFKC').toLowerCase(),existing=queries.userByKey.get(usernameKey);
    if(existing){const error=new Error('用户名已被使用。');error.code='USERNAME_TAKEN';error.status=409;throw error;}
    const id=randomId('usr_'),salt=randomBytes(16).toString('hex'),now=Date.now();
    const hash=await passwordHash(password,salt);
    transaction(()=>{if(queries.countUsers.get().total>=maxUsers)throw securityError('REGISTRATION_LIMIT','当前注册名额已满，请稍后再试。',503);if(queries.userByKey.get(usernameKey))throw securityError('USERNAME_TAKEN','用户名已被使用。',409);queries.insertUser.run(id,username,usernameKey,salt,hash,now);});
    return publicUser(queries.userById.get(id));
  }
  async function verify(username,password){
    const row=queries.userByKey.get(username.normalize('NFKC').toLowerCase());
    const hash=await passwordHash(password,row?.password_salt||dummySalt);
    if(!row)return null;
    const expected=Buffer.from(row.password_hash,'hex'),candidate=Buffer.from(hash,'hex');
    return timingSafeEqual(candidate,expected)&&queries.authUserById.get(row.id)?.password_hash===row.password_hash?publicUser(row):null;
  }
  async function passwordMatchesUser(row,password){const candidate=Buffer.from(await passwordHash(password,row.password_salt),'hex'),expected=Buffer.from(row.password_hash,'hex');return candidate.length===expected.length&&timingSafeEqual(candidate,expected);}
  function createSession(userId){
    writable();
    queries.deleteExpiredSessions.run(Date.now());
    const token=randomBytes(32).toString('base64url'),csrfToken=randomBytes(18).toString('base64url'),now=Date.now(),expiresAt=now+SESSION_TTL_MS;
    transaction(()=>{queries.insertSession.run(tokenHash(token),userId,csrfToken,expiresAt,now);db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?)').run(userId,userId,maxSessions);});
    return {token,csrfToken,expiresAt};
  }
  function session(token){
    if(!token)return null;const hash=tokenHash(token),row=queries.sessionByHash.get(hash);if(!row)return null;
    if(row.expires_at<=Date.now()){queries.deleteSession.run(hash);return null;}
    return {tokenHash:hash,csrfToken:row.csrf_token,expiresAt:row.expires_at,user:publicUser({...row,id:row.user_id,created_at:row.user_created_at})};
  }
  function logout(token){if(token)queries.deleteSession.run(tokenHash(token));}
  async function changePassword(userId,currentPassword,newPassword,currentTokenHash){
    writable();const row=queries.authUserById.get(userId);if(!row||!await passwordMatchesUser(row,currentPassword))return false;
    const salt=randomBytes(16).toString('hex'),hash=await passwordHash(newPassword,salt);
    return transaction(()=>{const live=queries.sessionByHash.get(currentTokenHash);if(!live||live.user_id!==userId||live.expires_at<=Date.now())throw securityError('AUTH_REQUIRED','登录已失效，请重新登录。',401);const result=queries.updatePassword.run(salt,hash,userId,row.password_hash);if(!result.changes)return false;queries.deleteOtherSessions.run(userId,currentTokenHash);db.prepare('DELETE FROM email_challenges WHERE user_id=?').run(userId);return true;});
  }

  // Persist budgets and verification attempts so a restart cannot reset them.
  function reserveEmailSend({ip,email,purpose,userId=null}){
    writable();const time=now(),hour=60*60*1000;
    const budgets=[['global',60,hour],['ip:'+tokenHash(ip),10,hour],['email:'+tokenHash(email),6,hour],['cooldown:'+purpose+':'+tokenHash(email),1,60000]];
    if(userId)budgets.push(['user:'+userId,6,hour],['user-cooldown:'+userId,1,60000]);
    transaction(()=>{
      db.prepare('DELETE FROM email_send_limits WHERE expires_at<=?').run(time);
      if(db.prepare('SELECT COUNT(*) AS count FROM email_send_limits').get().count>=10000)throw securityError('MAIL_BUSY','邮件发送繁忙，请稍后再试。',503);
      for(const [scope,limit] of budgets){const row=db.prepare('SELECT count FROM email_send_limits WHERE scope=?').get(scope);if(row&&row.count>=limit)throw securityError('MAIL_RATE_LIMIT','邮件申请过于频繁，请稍后再试。',429);}
      for(const [scope,,duration] of budgets)db.prepare('INSERT INTO email_send_limits(scope,count,expires_at) VALUES(?,1,?) ON CONFLICT(scope) DO UPDATE SET count=count+1').run(scope,time+duration);
    });
  }
  function requireLiveSession(userId,hash){const row=queries.sessionByHash.get(hash);if(!row||row.user_id!==userId||row.expires_at<=Date.now())throw securityError('AUTH_REQUIRED','登录已失效，请重新登录。',401);}
  function saveChallenge(row,purpose,email,secret,currentTokenHash=null){
    const id=randomId('em_');
    db.prepare('DELETE FROM email_challenges WHERE user_id=? AND purpose=?').run(row.id,purpose);
    db.prepare('INSERT INTO email_challenges(id,user_id,purpose,email,previous_email,password_hash,session_hash,secret_hash,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,row.id,purpose,email,row.email,row.password_hash,currentTokenHash,tokenHash(purpose==='binding'?id+':'+secret:secret),now()+(purpose==='binding'?10:15)*60000);
    return id;
  }
  async function issueBinding(userId,currentPassword,email,currentTokenHash){
    writable();const row=queries.authUserById.get(userId);
    if(!row||!await passwordMatchesUser(row,currentPassword))throw securityError('CURRENT_PASSWORD_WRONG','当前密码错误。',401);
    const code=String(randomInt(1000000)).padStart(6,'0');
    const id=transaction(()=>{
      requireLiveSession(userId,currentTokenHash);const live=queries.authUserById.get(userId);
      if(live.password_hash!==row.password_hash||live.email!==row.email)throw securityError('ACCOUNT_CHANGED','账号信息已变化，请刷新后重试。',409);
      if(live.email===email)throw securityError('EMAIL_UNCHANGED','该邮箱已绑定，无需重复验证。',409);
      if(queries.userByEmail.get(email))throw securityError('EMAIL_IN_USE','该邮箱已绑定其他账号。',409);
      return saveChallenge(live,'binding',email,code,currentTokenHash);
    });
    return {id,code};
  }
  function activateEmailChallenge(id){db.prepare('UPDATE email_challenges SET ready=1 WHERE id=? AND expires_at>?').run(id,now());}
  function cancelEmailChallenge(id){db.prepare('DELETE FROM email_challenges WHERE id=?').run(id);}
  function bindEmail(userId,{challengeId,email,code,currentTokenHash}){
    writable();let previousEmail=null;
    const outcome=transaction(()=>{
      requireLiveSession(userId,currentTokenHash);
      const challenge=db.prepare("SELECT * FROM email_challenges WHERE id=? AND user_id=? AND purpose='binding'").get(challengeId,userId),row=queries.authUserById.get(userId);
      if(!challenge||!challenge.ready||challenge.expires_at<=now()||challenge.attempts>=5||challenge.session_hash!==currentTokenHash||challenge.email!==email||challenge.password_hash!==row.password_hash||challenge.previous_email!==row.email)return false;
      const candidate=Buffer.from(tokenHash(challenge.id+':'+code),'hex'),expected=Buffer.from(challenge.secret_hash,'hex');
      if(!timingSafeEqual(candidate,expected)){db.prepare('UPDATE email_challenges SET attempts=attempts+1 WHERE id=?').run(challengeId);return false;}
      if(queries.userByEmail.get(email))throw securityError('EMAIL_IN_USE','该邮箱已绑定其他账号。',409);
      previousEmail=row.email;
      db.prepare('UPDATE users SET email=?,email_verified_at=? WHERE id=?').run(email,now(),userId);
      db.prepare('DELETE FROM email_challenges WHERE user_id=?').run(userId);
      return true;
    });
    if(!outcome)throw securityError('INVALID_EMAIL_CODE','验证码错误、过期或已失效，请重新获取验证码。',400);
    return {user:publicUser(queries.userById.get(userId)),previousEmail};
  }
  function issuePasswordReset(email){
    writable();const row=queries.userByEmail.get(email);if(!row)return null;
    const token=randomBytes(32).toString('base64url');
    return {id:transaction(()=>saveChallenge(row,'reset',email,token)),token};
  }
  async function resetPassword(token,newPassword){
    writable();const invalid=()=>securityError('INVALID_RESET_LINK','重置链接无效、过期或已使用，请重新申请。',400);
    if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw invalid();
    const secretHash=tokenHash(token),challenge=db.prepare("SELECT * FROM email_challenges WHERE secret_hash=? AND purpose='reset' AND ready=1").get(secretHash);
    if(!challenge||challenge.expires_at<=now())throw invalid();
    const row=queries.authUserById.get(challenge.user_id);
    if(!row||row.password_hash!==challenge.password_hash||row.email!==challenge.email||!row.email_verified_at)throw invalid();
    const salt=randomBytes(16).toString('hex'),hash=await passwordHash(newPassword,salt);
    return transaction(()=>{
      const live=db.prepare('SELECT * FROM email_challenges WHERE id=? AND ready=1').get(challenge.id),user=queries.authUserById.get(row.id);
      if(!live||live.secret_hash!==secretHash||live.expires_at<=now()||user.password_hash!==row.password_hash||user.email!==challenge.email)throw invalid();
      if(!queries.updatePassword.run(salt,hash,row.id,row.password_hash).changes)throw invalid();
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.id);
      db.prepare('DELETE FROM email_challenges WHERE user_id=?').run(row.id);
      return true;
    });
  }
  function cardPage(ownerId,options){const result=page(queries.cardsByOwner,queries.countCards,ownerId,options);return {...result,items:result.items.map(rowCard)};}
  function listCards(ownerId){return queries.cardsByOwner.all(ownerId,maxCards,0).map(rowCard);}
  function getCard(ownerId,id){return rowCard(queries.cardByOwner.get(id,ownerId));}
  function createCard(ownerId,input){writable();const id=randomId('D',8),now=Date.now();transaction(()=>{if(queries.countCards.get(ownerId).total>=maxCards)throw securityError('CARD_QUOTA',`每个账号最多保存 ${maxCards} 张私人海克斯。`,409);queries.insertCard.run(id,ownerId,input.name,input.effect,input.rarity,input.glyph,input.recommendedTiming,now,now);});return getCard(ownerId,id);}
  function updateCard(ownerId,id,input){writable();const result=queries.updateCard.run(input.name,input.effect,input.rarity,input.glyph,input.recommendedTiming,Date.now(),id,ownerId);return result.changes?getCard(ownerId,id):null;}
  function cardUsedByPool(ownerId,cardId){return !!queries.cardReferenced.get(ownerId,cardId);}
  function deleteCard(ownerId,id){return queries.deleteCard.run(id,ownerId).changes>0;}
  function poolPage(ownerId,options){const result=page(queries.poolsByOwner,queries.countPools,ownerId,options);return {...result,items:result.items.map(rowPool)};}
  function listPools(ownerId){return queries.poolsByOwner.all(ownerId,maxPools,0).map(rowPool);}
  function getPool(ownerId,id){return rowPool(queries.poolByOwner.get(id,ownerId));}
  function createPool(ownerId,input){writable();const id=randomId('pool_',10),now=Date.now();transaction(()=>{if(queries.countPools.get(ownerId).total>=maxPools)throw securityError('POOL_QUOTA',`每个账号最多保存 ${maxPools} 个私人卡池。`,409);queries.insertPool.run(id,ownerId,input.name,input.description,JSON.stringify(input.nodes),JSON.stringify(input.cards),now,now);});return getPool(ownerId,id);}
  function updatePool(ownerId,id,input){writable();const result=queries.updatePool.run(input.name,input.description,JSON.stringify(input.nodes),JSON.stringify(input.cards),Date.now(),id,ownerId);return result.changes?getPool(ownerId,id):null;}
  function deletePool(ownerId,id){return queries.deletePool.run(id,ownerId).changes>0;}
  function close(){db.close();}

  function cleanup(){queries.deleteExpiredSessions.run(Date.now());db.prepare('DELETE FROM email_challenges WHERE expires_at<=?').run(now());db.prepare('DELETE FROM email_send_limits WHERE expires_at<=?').run(now());}
  return {register,verify,createSession,session,logout,changePassword,reserveEmailSend,issueBinding,activateEmailChallenge,cancelEmailChallenge,bindEmail,issuePasswordReset,resetPassword,listCards,cardPage,getCard,createCard,updateCard,deleteCard,cardUsedByPool,listPools,poolPage,getPool,createPool,updatePool,deletePool,limits,cleanup,close};
}
