import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import WebSocket from 'ws';

const port=3222,canonical='https://mahjong.example.test';
const server=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),NODE_ENV:'production',HEX_DB_PATH:':memory:',ALLOWED_ORIGINS:canonical,HEX_BASE_PATH:'/hex-mahjong/',HEX_COOKIE_NAME:'hex_mahjong_session',NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});
let stderr='';server.stderr.on('data',chunk=>stderr+=chunk);
function request({host='mahjong.example.test',origin=canonical,secure=true,body}={}){
  return new Promise((resolve,reject)=>{const data=body?JSON.stringify(body):null;const req=http.request({hostname:'127.0.0.1',port,path:body?'/api/auth/register':'/api/me',method:body?'POST':'GET',headers:{Host:host,Origin:origin,...(secure?{'X-Forwarded-Proto':'https'}:{}),...(data?{'Content-Length':Buffer.byteLength(data),'Content-Type':'application/json'}:{})}},response=>{let data='';response.on('data',chunk=>data+=chunk);response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:data}));});req.on('error',reject);req.end(data);});
}
try{
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error(stderr||'Startup timeout')),5000);server.stdout.on('data',chunk=>{if(String(chunk).includes('Hex Mahjong lobby server')){clearTimeout(timeout);resolve();}});});
  assert.equal((await request({host:'evil.example',origin:'https://evil.example'})).status,421);
  const account={username:'正式配置玩家',password:'production-password-2026'};
  assert.equal((await request({origin:'https://evil.example',body:account})).status,403);
  assert.equal((await request({secure:false,body:account})).status,400);
  const registered=await request({body:account});assert.equal(registered.status,201);
  const cookie=registered.headers['set-cookie'][0];assert.ok(cookie.startsWith('hex_mahjong_session='));assert.ok(cookie.includes('Path=/hex-mahjong/'));assert.ok(cookie.includes('Secure'));assert.ok(cookie.includes('HttpOnly'));assert.ok(cookie.includes('SameSite=Strict'));
  await new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${port}`,{origin:'https://evil.example',headers:{Host:'evil.example'}});ws.once('open',()=>{ws.terminate();reject(new Error('Host match bypassed configured origins'));});ws.once('error',resolve);});
  assert.equal(stderr,'');console.log(JSON.stringify({strictOrigins:true,unknownHostRejected:true,productionHttpsRequired:true,secureScopedCookie:true}));
}finally{server.kill();}
