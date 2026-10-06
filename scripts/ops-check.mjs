import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {stat,statfs,readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';

const execute=promisify(execFile),issues=[];
const check=async(name,fn)=>{try{await fn();}catch(issue){issues.push({check:name,code:issue.code||'CHECK_FAILED',message:issue.message});}};
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const database=process.env.HEX_DB_PATH||'/var/lib/hex-mahjong/hex-mahjong.sqlite';
const backupFolder=process.env.HEX_BACKUP_DIR||'/var/backups/hex-mahjong';
const origin=String(process.env.ALLOWED_ORIGINS||'').split(',')[0];
const cmd=(file,args)=>execute(file,args,{timeout:10000,maxBuffer:16384});

await check('service',async()=>{
  const {stdout}=await cmd('/usr/bin/systemctl',['show','hex-mahjong.service','--property=ActiveState,NRestarts','--value']);
  const values=stdout.trim().split('\n');assert(values.includes('active'),'网页服务未运行');
  const count=Number(values.find(value=>/^\d+$/.test(value)))||0;
  const stateFolder=process.env.HEX_MONITOR_STATE||'/var/lib/hex-mahjong-monitor';await mkdir(stateFolder,{recursive:true,mode:0o700});
  const filename=path.join(stateFolder,'restarts.json');let previous;
  try{previous=JSON.parse(await readFile(filename,'utf8'));}catch{}
  await writeFile(filename,JSON.stringify({count}),{mode:0o600});
  assert(!previous||count<=previous.count,'网页服务重启次数增加');
});
await check('application',async()=>{
  const host=origin?new URL(origin).host:'127.0.0.1:3000';
  const response=await fetch('http://127.0.0.1:3000/api/internal-health',{headers:{Host:host},signal:AbortSignal.timeout(5000)});
  assert(response.ok,'内部健康接口无法访问');const health=await response.json();
  assert(health.rss<450*1024*1024,'网页进程内存超过 450 MiB');assert(health.eventLoopP99Ms<200,'事件循环延迟超过 200 ms');
  assert(health.connections<450,'连接数接近全站上限');
});
await check('storage',async()=>{
  const disk=await statfs(path.dirname(database));assert(Number(disk.bavail)*Number(disk.bsize)>500*1024*1024,'数据库磁盘余量不足 500 MiB');
  let bytes=(await stat(database)).size;try{bytes+=(await stat(database+'-wal')).size;}catch{}
  assert(bytes<200*1024*1024,'数据库及 WAL 大于 200 MiB，接近写入保护阈值');
});
await check('backup',async()=>{
  const entries=(await readdir(backupFolder,{withFileTypes:true})).filter(entry=>entry.isFile()&&/^hex-mahjong-.*\.sqlite$/.test(entry.name));
  assert(entries.length>0,'没有数据库备份');const times=await Promise.all(entries.map(async entry=>(await stat(path.join(backupFolder,entry.name))).mtimeMs));
  assert(Date.now()-Math.max(...times)<36*60*60*1000,'最新备份超过 36 小时');
});
await check('certificate',async()=>{
  const certificate=process.env.HEX_CERT_PATH||'/etc/letsencrypt/live/hax-ip/fullchain.pem';
  const {stdout}=await cmd('/usr/bin/openssl',['x509','-in',certificate,'-noout','-enddate']);
  const expiresAt=Date.parse(stdout.trim().replace('notAfter=',''));assert(Number.isFinite(expiresAt),'无法读取证书到期时间');
  assert(expiresAt-Date.now()>48*60*60*1000,'HTTPS 证书剩余有效期不足 48 小时');
  assert(origin,'未配置正式来源');const response=await fetch(origin+(process.env.HEX_BASE_PATH||'/'),{signal:AbortSignal.timeout(10000)});
  assert(response.ok,'实际对外 HTTPS 请求失败');
});
console.log(JSON.stringify({time:new Date().toISOString(),event:'ops_check',ok:issues.length===0,issues}));
if(issues.length)process.exitCode=1;
