import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,readdir,copyFile,writeFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const root=fileURLToPath(new URL('..',import.meta.url));
const destination=path.join(root,'.tmp-release-'+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(destination);
const files=['server.mjs','index.html','studio.html','cards.json','package.json','package-lock.json','scripts/backup-database.mjs','scripts/ops-check.mjs'];
async function collect(folder,extensions){for(const entry of await readdir(path.join(root,folder),{withFileTypes:true})){if(entry.isSymbolicLink())throw new Error('Release cannot contain symbolic links');const relative=folder+'/'+entry.name;if(entry.isDirectory())await collect(relative,extensions);else if(extensions.has(path.extname(entry.name).toLowerCase()))files.push(relative);}}
await collect('lib',new Set(['.mjs']));await collect('audio',new Set(['.mp3','.wav','.ogg']));await collect('image',new Set(['.png','.jpg','.jpeg','.webp','.avif']));
const flash='artifacts/bai-zhe-shi-chen/web';
files.push(...['index.html','app.js','style.css','card-config.json','package.json','package-lock.json'].map(name=>flash+'/'+name));
await collect(flash+'/assets',new Set(['.png','.webp','.glb']));
const manifest=[];
for(const relative of files){
  const source=path.join(root,relative);if(!(await lstat(source)).isFile())throw new Error('Release only accepts regular files');
  const target=path.join(destination,relative);await mkdir(path.dirname(target),{recursive:true});await copyFile(source,target);
  manifest.push({path:relative,sha256:createHash('sha256').update(await readFile(source)).digest('hex')});
}
await writeFile(path.join(destination,'release-manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),files:manifest},null,2));
console.log(JSON.stringify({event:'release_prepared',destination,files:files.length,note:'No database, credentials, logs, prototypes, or node_modules included. Run npm ci --omit=dev --ignore-scripts in both package directories before deployment.'}));
