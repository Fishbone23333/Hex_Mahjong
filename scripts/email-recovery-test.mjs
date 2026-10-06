import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createAccountStore} from '../lib/account-store.mjs';
import {normalizeEmail} from '../lib/email.mjs';
import {createTestSmtp,mailText} from './test-smtp.mjs';

assert.equal(normalizeEmail(' Alice@EXAMPLE.COM '),'alice@example.com');
for(const invalid of ['a@b','a@b.com\r\nBcc:c@d.com','a..b@c.com','.a@c.com','a@-c.com'])assert.throws(()=>normalizeEmail(invalid));

const directory=await mkdtemp(path.join(os.tmpdir(),'hex-email-test-')),filename=path.join(directory,'accounts.sqlite');
let clock=Date.now();let store=createAccountStore({databasePath:filename,now:()=>clock});
try{
  const user=await store.register('邮箱存储测试','old-password-2026'),other=await store.register('邮箱其他账号','other-password-2026');
  const session=store.createSession(user.id),hash=store.session(session.token).tokenHash,otherSession=store.createSession(other.id),otherHash=store.session(otherSession.token).tokenHash;
  assert.equal(user.emailBound,false);assert.equal(store.issuePasswordReset('alice@example.com'),null);
  store.reserveEmailSend({ip:'local-unit',email:'alice@example.com',purpose:'binding',userId:user.id});
  store.close();store=createAccountStore({databasePath:filename,now:()=>clock});
  assert.throws(()=>store.reserveEmailSend({ip:'local-unit',email:'alice@example.com',purpose:'binding',userId:user.id}),issue=>issue.code==='MAIL_RATE_LIMIT');
  const locked=await store.issueBinding(user.id,'old-password-2026','alice@example.com',hash);store.activateEmailChallenge(locked.id);
  const wrong=locked.code==='000000'?'111111':'000000';
  for(let attempt=0;attempt<5;attempt++)assert.throws(()=>store.bindEmail(user.id,{challengeId:locked.id,email:'alice@example.com',code:wrong,currentTokenHash:hash}));
  assert.throws(()=>store.bindEmail(user.id,{challengeId:locked.id,email:'alice@example.com',code:locked.code,currentTokenHash:hash}));
  const expired=await store.issueBinding(user.id,'old-password-2026','alice@example.com',hash);store.activateEmailChallenge(expired.id);clock+=600001;
  assert.throws(()=>store.bindEmail(user.id,{challengeId:expired.id,email:'alice@example.com',code:expired.code,currentTokenHash:hash}));
  const binding=await store.issueBinding(user.id,'old-password-2026','alice@example.com',hash);store.activateEmailChallenge(binding.id);
  const competing=await store.issueBinding(other.id,'other-password-2026','alice@example.com',otherHash);store.activateEmailChallenge(competing.id);
  const bound=store.bindEmail(user.id,{challengeId:binding.id,email:'alice@example.com',code:binding.code,currentTokenHash:hash});assert.equal(bound.user.emailBound,true);assert.equal(bound.user.emailMasked,'al***@example.com');
  assert.throws(()=>store.bindEmail(other.id,{challengeId:competing.id,email:'alice@example.com',code:competing.code,currentTokenHash:otherHash}),issue=>issue.code==='EMAIL_IN_USE');
  const reset=store.issuePasswordReset('alice@example.com');await assert.rejects(store.resetPassword(reset.token,'new-password-2026'));store.activateEmailChallenge(reset.id);clock+=900001;await assert.rejects(store.resetPassword(reset.token,'new-password-2026'));
  const stale=store.issuePasswordReset('alice@example.com');store.activateEmailChallenge(stale.id);
  const swap=await store.issueBinding(user.id,'old-password-2026','new@example.com',hash);store.activateEmailChallenge(swap.id);
  assert.equal(store.bindEmail(user.id,{challengeId:swap.id,email:'new@example.com',code:swap.code,currentTokenHash:hash}).previousEmail,'alice@example.com');
  await assert.rejects(store.resetPassword(stale.token,'new-password-2026'));assert.equal(store.issuePasswordReset('alice@example.com'),null);
  const pending=store.issuePasswordReset('new@example.com');store.activateEmailChallenge(pending.id);assert.equal(await store.changePassword(user.id,'old-password-2026','changed-password-2026',hash),true);await assert.rejects(store.resetPassword(pending.token,'new-password-2026'));
  const final=store.issuePasswordReset('new@example.com');store.activateEmailChallenge(final.id);
  const race=await Promise.allSettled([store.resetPassword(final.token,'final-password-2026'),store.resetPassword(final.token,'final-password-2026')]);assert.equal(race.filter(item=>item.status==='fulfilled').length,1);
  assert.equal(store.session(session.token),null);assert.ok(await store.verify('邮箱存储测试','final-password-2026'));
}finally{store.close();}

// The old production schema migrates in place, preserving users and private content.
const oldFile=path.join(directory,'old.sqlite'),old=new DatabaseSync(oldFile);
old.exec("CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL,username_key TEXT UNIQUE NOT NULL,password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,created_at INTEGER NOT NULL); INSERT INTO users VALUES('existing','旧用户','旧用户','salt','hash',1);");old.close();
const migrated=createAccountStore({databasePath:oldFile});migrated.close();const check=new DatabaseSync(oldFile);assert.equal(check.prepare('SELECT username,email FROM users').get().username,'旧用户');assert.equal(check.prepare('SELECT email FROM users').get().email,null);check.close();

const smtp=await createTestSmtp(),port=3231,base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,NODE_ENV:'development',ALLOWED_ORIGINS:base,PORT:String(port),HEX_DB_PATH:':memory:',SMTP_HOST:'127.0.0.1',SMTP_PORT:String(smtp.port),SMTP_SECURE:'false',SMTP_USER:'sender@example.com',SMTP_PASS:'test-password',MAIL_FROM:'sender@example.com',MAIL_PUBLIC_BASE_URL:base+'/hex-mahjong/',NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});
let stdout='',stderr='';child.stdout.on('data',data=>stdout+=String(data));child.stderr.on('data',data=>stderr+=String(data));
async function api(route,{body,cookie='',csrf='',origin=base}={}){
  const response=await fetch(base+route,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json',Origin:origin}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]||'',headers:response.headers};
}
async function waitForMail(count){for(let attempt=0;attempt<100;attempt++){if(smtp.messages.length>=count)return smtp.messages[count-1];await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Local test mail missing');}
try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(stderr||'startup timeout')),5000);child.stdout.on('data',chunk=>{if(String(chunk).includes('Hex Mahjong lobby server')){clearTimeout(timer);resolve();}});});
  const registered=await api('/api/auth/register',{body:{username:'邮箱流程玩家',password:'old-password-2026'}});assert.equal(registered.status,201);assert.equal(registered.data.user.emailBound,false);
  const auth={cookie:registered.cookie,csrf:registered.data.csrfToken};
  const second=await api('/api/auth/login',{body:{username:'邮箱流程玩家',password:'old-password-2026'}});assert.equal(second.status,200);
  const card=await api('/api/private-cards',{...auth,body:{name:'保留的海克斯',effect:'重置密码后仍保留。',glyph:'✦',rarity:'standard',recommendedTiming:'any'}});assert.equal(card.status,201);
  const pool=await api('/api/pools',{...auth,body:{name:'保留的卡池',nodes:[{id:'opening',name:'开局',type:'opening'}],cards:[{source:'private',id:card.data.card.id,assignmentMode:'custom',nodeIds:['opening']}]}});assert.equal(pool.status,201);
  const input={email:'player@example.com',currentPassword:'old-password-2026'};
  assert.equal((await api('/api/account/email/send',{cookie:auth.cookie,body:input})).status,403);
  const sent=await api('/api/account/email/send',{...auth,body:input});assert.equal(sent.status,200);assert.ok(sent.data.challengeId);assert.equal(sent.headers.get('cache-control'),'private, no-store');
  assert.equal((await api('/api/account/email/send',{...auth,body:input})).status,429);
  const code=mailText(await waitForMail(1)).match(/\d{6}/)?.[0];assert.ok(code);assert.ok(!JSON.stringify(sent.data).includes(code));
  const verify={email:input.email,challengeId:sent.data.challengeId,code};
  assert.equal((await api('/api/account/email/verify',{...auth,body:{...verify,code:code==='000000'?'111111':'000000'}})).status,400);
  const bound=await api('/api/account/email/verify',{...auth,body:verify});assert.equal(bound.status,200);assert.equal(bound.data.user.emailBound,true);assert.equal(bound.data.user.emailMasked,'pl***@example.com');assert.ok(!JSON.stringify(bound.data).includes(input.email));
  assert.equal((await api('/api/account/email/verify',{...auth,body:verify})).status,400);
  assert.equal((await api('/api/me',{cookie:auth.cookie})).data.user.emailBound,true);
  const unbound=await api('/api/auth/register',{body:{username:'未绑定邮箱玩家',password:'unbound-password-2026'}});assert.equal(unbound.status,201);
  const unknown=await api('/api/auth/forgot-password',{body:{email:'unknown@example.com'}});assert.equal(unknown.status,202);assert.equal(smtp.messages.length,1);
  assert.equal((await api('/api/auth/forgot-password',{body:{email:input.email},origin:'https://evil.example'})).status,403);
  const forgot=await api('/api/auth/forgot-password',{body:{email:input.email}});assert.equal(forgot.status,202);assert.deepEqual(forgot.data,unknown.data);
  const resetText=mailText(await waitForMail(2)),token=resetText.match(/#reset-password=([A-Za-z0-9_-]{43})/)?.[1];assert.ok(token);assert.ok(resetText.includes(base+'/hex-mahjong/studio.html#reset-password='));
  assert.equal((await api('/api/auth/reset-password',{body:{token:'invalid',newPassword:'reset-password-2026'}})).status,400);
  // Delivery activation happens after the SMTP response, on the next event-loop turn.
  await new Promise(resolve=>setTimeout(resolve,30));
  const results=await Promise.all([api('/api/auth/reset-password',{body:{token,newPassword:'reset-password-2026'}}),api('/api/auth/reset-password',{body:{token,newPassword:'reset-password-2026'}})]);assert.deepEqual(results.map(item=>item.status).sort(),[200,400]);
  assert.equal((await api('/api/me',{cookie:auth.cookie})).data.user,null);assert.equal((await api('/api/me',{cookie:second.cookie})).data.user,null);
  assert.equal((await api('/api/auth/login',{body:{username:'邮箱流程玩家',password:'old-password-2026'}})).status,401);
  const login=await api('/api/auth/login',{body:{username:'邮箱流程玩家',password:'reset-password-2026'}});assert.equal(login.status,200);
  assert.equal((await api('/api/private-cards',{cookie:login.cookie})).data.cards[0].id,card.data.card.id);assert.equal((await api('/api/pools',{cookie:login.cookie})).data.pools[0].id,pool.data.pool.id);
  const failed=await api('/api/auth/register',{body:{username:'发信失败玩家',password:'failed-password-2026'}});assert.equal(failed.status,201);smtp.failNext();
  const failure=await api('/api/account/email/send',{cookie:failed.cookie,csrf:failed.data.csrfToken,body:{email:'failure@example.com',currentPassword:'failed-password-2026'}});assert.equal(failure.status,503);assert.equal(failure.data.error,'MAIL_UNAVAILABLE');
  assert.equal(stderr,'');assert.ok(!stdout.includes(code)&&!stdout.includes(token)&&!stdout.includes(input.email));
  console.log(JSON.stringify({optionalEmailRegistration:true,verifiedBinding:true,csrf:true,maskedEmail:true,persistentSendLimits:true,verificationExpiryAndAttemptLimits:true,emailUniqueness:true,resetDelivery:true,uniformRecoveryResponse:true,resetRaceAndReplay:true,resetRevokesAllSessions:true,passwordAndEmailChangesInvalidateLinks:true,privateContentPreserved:true,oldSchemaMigration:true,smtpFailuresHandled:true,noExternalMailSent:true}));
}finally{child.kill();await smtp.close();if(path.dirname(directory)===os.tmpdir())await rm(directory,{recursive:true,force:true});}
