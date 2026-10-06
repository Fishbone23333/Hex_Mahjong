import {scrypt} from 'node:crypto';

export function securityError(code,message,status=429){return Object.assign(new Error(message),{code,status});}

// A bounded queue keeps libuv and memory available for other rooms and HTTP requests.
let active=0;
const pending=[];
const KDF_CONCURRENCY=2,KDF_QUEUE_LIMIT=8;
export function derivePassword(password,salt,length=64){
  return new Promise((resolve,reject)=>{
    if(active>=KDF_CONCURRENCY&&pending.length>=KDF_QUEUE_LIMIT)return reject(securityError('PASSWORD_BUSY','密码校验繁忙，请稍后重试。',503));
    const run=()=>{active++;scrypt(String(password),salt,length,(issue,key)=>{active--;if(issue)reject(issue);else resolve(key);pending.shift()?.();});};
    if(active<KDF_CONCURRENCY)run();else pending.push(run);
  });
}

export class RateLimiter {
  constructor({maxEntries=10000,now=Date.now}={}){this.entries=new Map();this.maxEntries=maxEntries;this.now=now;}
  take(key,limit,windowMs){
    const now=this.now();let entry=this.entries.get(key);
    if(entry&&entry.expiresAt<=now){this.entries.delete(key);entry=null;}
    if(!entry){
      if(this.entries.size>=this.maxEntries)this.cleanup();
      // Do not evict live budgets: flooding fresh keys must not reset existing limits.
      if(this.entries.size>=this.maxEntries)return false;
      entry={count:0,expiresAt:now+windowMs};this.entries.set(key,entry);
    }
    if(entry.count>=limit)return false;entry.count++;return true;
  }
  cleanup(){const now=this.now();for(const [key,entry] of this.entries)if(entry.expiresAt<=now)this.entries.delete(key);}
}

export function readSessionCookie(request,name='hex_session'){
  let token='',seen=false;
  for(const part of String(request.headers.cookie||'').split(';')){
    const separator=part.indexOf('=');if(separator<0||part.slice(0,separator).trim()!==name)continue;
    if(seen)return '';seen=true;
    try{token=decodeURIComponent(part.slice(separator+1).trim());}catch{return '';}
  }
  return /^[A-Za-z0-9_-]{43}$/.test(token)?token:'';
}
