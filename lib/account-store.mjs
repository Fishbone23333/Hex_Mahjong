import path from 'node:path';
import {mkdirSync} from 'node:fs';
import {randomBytes,createHash,scryptSync,timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const SESSION_TTL_MS=30*24*60*60*1000;

function randomId(prefix,bytes=12){return prefix+randomBytes(bytes).toString('base64url');}
function tokenHash(token){return createHash('sha256').update(String(token)).digest('hex');}
function passwordHash(password,salt){return scryptSync(String(password),Buffer.from(salt,'hex'),64).toString('hex');}
function rowCard(row){return row&&{id:row.id,name:row.name,effect:row.effect,rarity:row.rarity,glyph:row.glyph,recommendedTiming:row.recommended_timing,createdAt:row.created_at,updatedAt:row.updated_at};}
function rowPool(row){return row&&{id:row.id,name:row.name,description:row.description,nodes:JSON.parse(row.nodes_json),cards:JSON.parse(row.cards_json),version:row.version,createdAt:row.created_at,updatedAt:row.updated_at};}

export function createAccountStore({databasePath}){
  const filename=databasePath||path.resolve('data','hex-mahjong.sqlite');
  if(filename!==':memory:')mkdirSync(path.dirname(filename),{recursive:true});
  const db=new DatabaseSync(filename);
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

  const queries={
    userByKey:db.prepare('SELECT * FROM users WHERE username_key = ?'),
    userById:db.prepare('SELECT id,username,created_at FROM users WHERE id = ?'),
    insertUser:db.prepare('INSERT INTO users(id,username,username_key,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)'),
    insertSession:db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)'),
    sessionByHash:db.prepare('SELECT sessions.*, users.username, users.created_at AS user_created_at FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=?'),
    deleteSession:db.prepare('DELETE FROM sessions WHERE token_hash=?'),
    deleteExpiredSessions:db.prepare('DELETE FROM sessions WHERE expires_at<=?'),
    cardsByOwner:db.prepare('SELECT * FROM private_cards WHERE owner_id=? ORDER BY updated_at DESC,id'),
    cardByOwner:db.prepare('SELECT * FROM private_cards WHERE id=? AND owner_id=?'),
    insertCard:db.prepare('INSERT INTO private_cards(id,owner_id,name,effect,rarity,glyph,recommended_timing,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)'),
    updateCard:db.prepare('UPDATE private_cards SET name=?,effect=?,rarity=?,glyph=?,recommended_timing=?,updated_at=? WHERE id=? AND owner_id=?'),
    deleteCard:db.prepare('DELETE FROM private_cards WHERE id=? AND owner_id=?'),
    poolsByOwner:db.prepare('SELECT * FROM pools WHERE owner_id=? ORDER BY updated_at DESC,id'),
    poolByOwner:db.prepare('SELECT * FROM pools WHERE id=? AND owner_id=?'),
    insertPool:db.prepare('INSERT INTO pools(id,owner_id,name,description,nodes_json,cards_json,version,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)'),
    updatePool:db.prepare('UPDATE pools SET name=?,description=?,nodes_json=?,cards_json=?,version=version+1,updated_at=? WHERE id=? AND owner_id=?'),
    deletePool:db.prepare('DELETE FROM pools WHERE id=? AND owner_id=?')
  };

  function publicUser(row){return row&&{id:row.id,username:row.username,createdAt:row.created_at??row.user_created_at};}
  function register(username,password){
    const usernameKey=username.normalize('NFKC').toLowerCase(),existing=queries.userByKey.get(usernameKey);
    if(existing){const error=new Error('用户名已被使用。');error.code='USERNAME_TAKEN';error.status=409;throw error;}
    const id=randomId('usr_'),salt=randomBytes(16).toString('hex'),now=Date.now();
    queries.insertUser.run(id,username,usernameKey,salt,passwordHash(password,salt),now);
    return publicUser(queries.userById.get(id));
  }
  function verify(username,password){
    const row=queries.userByKey.get(username.normalize('NFKC').toLowerCase());if(!row)return null;
    const candidate=Buffer.from(passwordHash(password,row.password_salt),'hex'),expected=Buffer.from(row.password_hash,'hex');
    return candidate.length===expected.length&&timingSafeEqual(candidate,expected)?publicUser(row):null;
  }
  function createSession(userId){
    queries.deleteExpiredSessions.run(Date.now());
    const token=randomBytes(32).toString('base64url'),csrfToken=randomBytes(18).toString('base64url'),now=Date.now(),expiresAt=now+SESSION_TTL_MS;
    queries.insertSession.run(tokenHash(token),userId,csrfToken,expiresAt,now);
    return {token,csrfToken,expiresAt};
  }
  function session(token){
    if(!token)return null;const hash=tokenHash(token),row=queries.sessionByHash.get(hash);if(!row)return null;
    if(row.expires_at<=Date.now()){queries.deleteSession.run(hash);return null;}
    return {tokenHash:hash,csrfToken:row.csrf_token,expiresAt:row.expires_at,user:publicUser({id:row.user_id,username:row.username,created_at:row.user_created_at})};
  }
  function logout(token){if(token)queries.deleteSession.run(tokenHash(token));}
  function listCards(ownerId){return queries.cardsByOwner.all(ownerId).map(rowCard);}
  function getCard(ownerId,id){return rowCard(queries.cardByOwner.get(id,ownerId));}
  function createCard(ownerId,input){const id=randomId('D',8),now=Date.now();queries.insertCard.run(id,ownerId,input.name,input.effect,input.rarity,input.glyph,input.recommendedTiming,now,now);return getCard(ownerId,id);}
  function updateCard(ownerId,id,input){const result=queries.updateCard.run(input.name,input.effect,input.rarity,input.glyph,input.recommendedTiming,Date.now(),id,ownerId);return result.changes?getCard(ownerId,id):null;}
  function cardUsedByPool(ownerId,cardId){return listPools(ownerId).some(pool=>pool.cards.some(ref=>ref.source==='private'&&ref.id===cardId));}
  function deleteCard(ownerId,id){return queries.deleteCard.run(id,ownerId).changes>0;}
  function listPools(ownerId){return queries.poolsByOwner.all(ownerId).map(rowPool);}
  function getPool(ownerId,id){return rowPool(queries.poolByOwner.get(id,ownerId));}
  function createPool(ownerId,input){const id=randomId('pool_',10),now=Date.now();queries.insertPool.run(id,ownerId,input.name,input.description,JSON.stringify(input.nodes),JSON.stringify(input.cards),now,now);return getPool(ownerId,id);}
  function updatePool(ownerId,id,input){const result=queries.updatePool.run(input.name,input.description,JSON.stringify(input.nodes),JSON.stringify(input.cards),Date.now(),id,ownerId);return result.changes?getPool(ownerId,id):null;}
  function deletePool(ownerId,id){return queries.deletePool.run(id,ownerId).changes>0;}
  function close(){db.close();}

  return {register,verify,createSession,session,logout,listCards,getCard,createCard,updateCard,deleteCard,cardUsedByPool,listPools,getPool,createPool,updatePool,deletePool,close};
}
