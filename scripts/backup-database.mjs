import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,chmod,link,rm,stat,readdir} from 'node:fs/promises';
import {DatabaseSync,backup} from 'node:sqlite';

// SQLite's backup API includes committed WAL transactions and produces one consistent database.
export async function backupDatabase(source,destination){
  source=path.resolve(source);destination=path.resolve(destination);
  if(source===destination)throw new Error('Backup must not overwrite the source database');
  await stat(source);
  try{await stat(destination);throw new Error('Backup destination already exists');}catch(issue){if(issue.code!=='ENOENT')throw issue;}
  await mkdir(path.dirname(destination),{recursive:true,mode:0o700});
  const temporary=destination+'.partial-'+process.pid;
  const db=new DatabaseSync(source,{readOnly:true});
  try{
    await backup(db,temporary);
    const check=new DatabaseSync(temporary,{readOnly:true});
    try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('Backup integrity check failed');}finally{check.close();}
    if(process.platform!=='win32')await chmod(temporary,0o600);
    // Atomic no-replace publication, even if another backup races this process.
    await link(temporary,destination);await rm(temporary);
    return {destination,bytes:(await stat(destination)).size};
  }catch(issue){await rm(temporary,{force:true});throw issue;}finally{db.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const source=process.env.HEX_DB_PATH;if(!source||source===':memory:')throw new Error('Set HEX_DB_PATH to the production database file');
    const folder=process.env.HEX_BACKUP_DIR||path.join(path.dirname(source),'backups');
    const result=await backupDatabase(source,path.join(folder,'hex-mahjong-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite'));
    const keep=Math.max(2,Math.min(90,Number(process.env.HEX_BACKUP_KEEP)||14));
    const old=(await readdir(folder,{withFileTypes:true})).filter(entry=>entry.isFile()&&/^hex-mahjong-\d{4}-\d{2}-\d{2}T[\dTZ-]+\.sqlite$/.test(entry.name)).map(entry=>entry.name).sort().reverse().slice(keep);
    for(const name of old)await rm(path.join(folder,name));
    console.log(JSON.stringify({event:'backup_complete',...result}));
  }catch(issue){console.error(JSON.stringify({event:'backup_failed',message:issue.message}));process.exitCode=1;}
}
