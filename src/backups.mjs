import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync,renameSync,rmSync,chmodSync,lstatSync,openSync,readSync,writeSync,closeSync,statfsSync} from 'node:fs';
import {join,resolve,sep,relative,dirname,isAbsolute} from 'node:path';

const mainDatabase='legion-1555685630640652338.sqlite';
const MiB=1024*1024,chunkSize=64*1024;
const generatedId=/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[\w.-]{1,40}-[a-f0-9]{6}$/;
const backupOptions=dataDir=>{
  const defaults={enabled:true,keep:2,maxTotalMB:96},file=join(dataDir,mainDatabase);if(!existsSync(file))return defaults;
  const db=new DatabaseSync(file,{readOnly:true});
  try{const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get();
    const columns=exists?new Set(db.prepare('PRAGMA table_info(settings)').all().map(column=>column.name)):new Set();
    const saved=columns.has('key')&&columns.has('value')?JSON.parse(db.prepare("SELECT value FROM settings WHERE key='dashboard-config'").get()?.value||'{}'):{};
    const value=saved.operations?.backups||{};return{enabled:value.enabled!==false,keep:Number.isSafeInteger(value.keep)&&value.keep>=1&&value.keep<=30?value.keep:defaults.keep,maxTotalMB:Number.isSafeInteger(value.maxTotalMB)&&value.maxTotalMB>=16&&value.maxTotalMB<=256?value.maxTotalMB:defaults.maxTotalMB};
  }finally{db.close();}
};
function inside(root,path){const target=resolve(root,path);if(target===resolve(root)||!target.startsWith(resolve(root)+sep))throw new Error('UNSAFE_BACKUP_PATH');return target;}
function safeStoredPath(root,path){
  if(typeof path!=='string'||isAbsolute(path)||path.split(/[\\/]/).some(part=>part==='..'))throw new Error('UNSAFE_BACKUP_PATH');
  const target=inside(root,path);let parent=target;
  while(parent!==resolve(root)){if(existsSync(parent)&&lstatSync(parent).isSymbolicLink())throw new Error('BACKUP_FILE_IS_LINK');parent=dirname(parent);}
  return target;
}
function diskBytes(folder){let bytes=0;for(const entry of readdirSync(folder,{withFileTypes:true})){const path=join(folder,entry.name);if(entry.isDirectory())bytes+=diskBytes(path);else if(entry.isFile())bytes+=lstatSync(path).size;}return bytes;}
export function backupSummary(dataDir){
  const root=join(resolve(dataDir),'backups');if(!existsSync(root)||lstatSync(root).isSymbolicLink())return[];
  const result=[];for(const entry of readdirSync(root,{withFileTypes:true})){
    if(!entry.isDirectory()||entry.name.startsWith('.')||!generatedId.test(entry.name))continue;
    try{const folder=join(root,entry.name),value=JSON.parse(readFileSync(join(folder,'manifest.json'),'utf8'));if(value.app==='legion'&&value.complete===true&&Array.isArray(value.files))result.push({id:entry.name,version:value.version,createdAt:value.createdAt,files:value.files.length,bytes:diskBytes(folder),compressed:value.format===2});}catch{}
  }return result.sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id));
}
function dataFiles(root,folder=root){
  return readdirSync(folder,{withFileTypes:true}).flatMap(entry=>{
    const name=entry.name.toLowerCase();
    if(folder===root&&name==='backups'||name==='.env'||name.endsWith('-wal')||name.endsWith('-shm')||name.endsWith('-journal'))return[];
    const path=join(folder,entry.name);return entry.isDirectory()?dataFiles(root,path):entry.isFile()?[path]:[];
  });
}
function removeOwnFolder(root,id){if(!generatedId.test(id))return;const target=inside(root,id);if(existsSync(target)&&!lstatSync(target).isSymbolicLink())rmSync(target,{recursive:true,force:true});}
function pruneBackups(dataDir,options){
  const root=join(dataDir,'backups'),items=backupSummary(dataDir);let bytes=items.reduce((sum,item)=>sum+item.bytes,0),count=items.length;
  for(const old of items.slice(1).reverse())if(count>options.keep||bytes>options.maxTotalMB*MiB){removeOwnFolder(root,old.id);bytes-=old.bytes;count--;}
}
function cleanStalePartials(root,now){
  for(const entry of readdirSync(root,{withFileTypes:true})){
    const id=entry.name.startsWith('.partial-')?entry.name.slice(9):null;
    if(!entry.isDirectory()||!id||!generatedId.test(id))continue;
    const path=inside(root,entry.name);if(now-lstatSync(path).mtimeMs>60*60*1000)rmSync(path,{recursive:true,force:true});
  }
}
function compressFile(source,target){
  mkdirSync(dirname(target),{recursive:true,mode:0o700});const input=openSync(source,'r');let output;
  try{output=openSync(target,'wx',0o600);const buffer=Buffer.allocUnsafe(chunkSize);let count=0,total=0;
    while((count=readSync(input,buffer,0,buffer.length,null))>0){writeSync(output,gzipSync(buffer.subarray(0,count),{level:6}));total+=count;}
    if(!total)writeSync(output,gzipSync(Buffer.alloc(0)));
  }finally{closeSync(input);if(output!==undefined)closeSync(output);}
}
function saveManifest(folder,manifest){const target=join(folder,'manifest.json'),temp=join(folder,'.manifest-next.json');writeFileSync(temp,JSON.stringify(manifest,null,2),{mode:0o600});renameSync(temp,target);}
function compressLegacyBackup(root,id){
  const folder=inside(root,id),manifest=JSON.parse(readFileSync(join(folder,'manifest.json'),'utf8'));
  if(manifest.format===2)return;
  manifest.storage=manifest.storage||{};
  const payloadDirectory=manifest.payloadDirectory||`payload-${randomBytes(6).toString('hex')}`;
  manifest.payloadDirectory=payloadDirectory;
  for(const [index,file]of manifest.files.entries()){
    const source=safeStoredPath(folder,file);
    if(manifest.storage[file]){const stored=safeStoredPath(folder,manifest.storage[file]);if(!existsSync(stored))throw new Error('BACKUP_FILE_MISSING');if(existsSync(source))rmSync(source);continue;}
    const stored=`${payloadDirectory}/${index}.gz`,target=safeStoredPath(folder,stored),partial=`${target}.partial`;
    if(!existsSync(source)||!lstatSync(source).isFile())throw new Error('BACKUP_FILE_MISSING');
    try{if(existsSync(partial))rmSync(partial);compressFile(source,partial);renameSync(partial,target);manifest.storage[file]=stored;saveManifest(folder,manifest);rmSync(source);}
    catch(error){if(existsSync(partial))rmSync(partial,{force:true});throw error;}
  }
  manifest.format=2;manifest.compression='gzip';saveManifest(folder,manifest);
}
function snapshotDatabase(source,target){
  const db=new DatabaseSync(source,{readOnly:true});try{
    db.exec('PRAGMA busy_timeout=5000;');
    try{db.prepare('VACUUM INTO ?').run(target);}
    catch(error){
      if(error.code!=='ERR_SQLITE_ERROR'||!/(?:near\s+["']?\?|syntax error)/i.test(error.message||''))throw error;
      rmSync(target,{force:true});db.exec(`VACUUM INTO '${target.replaceAll("'","''")}'`);
    }
  }finally{db.close();}
  const copy=new DatabaseSync(target,{readOnly:true});try{if(copy.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('BACKUP_INTEGRITY');}finally{copy.close();}
}
function spaceError(error){return error?.code==='ENOSPC'||error?.code==='SQLITE_FULL'||/database or disk is full|no space left on device/i.test(error?.message||'');}
export function createDataBackup(dataDir,version,{automatic=false,now=Date.now()}={}){
  dataDir=resolve(dataDir);if(!existsSync(dataDir))return{saved:false,reason:'no-data'};
  const options=backupOptions(dataDir),root=join(dataDir,'backups'),stateFile=join(root,'state.json');
  if(existsSync(root)&&lstatSync(root).isSymbolicLink())throw new Error('BACKUP_DIRECTORY_IS_LINK');
  mkdirSync(root,{recursive:true,mode:0o700});cleanStalePartials(root,now);pruneBackups(dataDir,options);
  let partial;
  try{
    for(const old of backupSummary(dataDir))compressLegacyBackup(root,old.id);
    pruneBackups(dataDir,options);
    if(automatic&&!options.enabled)return{saved:false,reason:'disabled'};
    let state={};if(existsSync(stateFile))try{state=JSON.parse(readFileSync(stateFile,'utf8'));}catch{}
    if(automatic&&state.version===version&&backupSummary(dataDir).some(item=>item.id===state.id))return{saved:false,reason:'current'};
    const files=dataFiles(dataDir);if(!files.length)return{saved:false,reason:'no-data'};
    const id=`${new Date(now).toISOString().replace(/[:.]/g,'-')}-${String(version).replace(/[^\w.-]/g,'').slice(0,40)}-${randomBytes(3).toString('hex')}`;
    partial=join(root,`.partial-${id}`);const destination=join(root,id);mkdirSync(partial,{mode:0o700});
    const manifest={app:'legion',complete:true,format:2,compression:'gzip',version,createdAt:now,files:[],storage:{}};
    for(const [index,file]of files.entries()){
      const name=relative(dataDir,file).replaceAll('\\','/'),stored=`payload/${index}.gz`,target=join(partial,stored),snapshot=join(partial,'.database-snapshot.sqlite');
      try{
        if(/\.(sqlite|db)$/i.test(file)){
          // VACUUM reads committed WAL data and excludes free SQLite pages.
          const free=statfsSync(root),reserve=lstatSync(file).size+2*MiB;
          if(Number(free.bavail)*Number(free.bsize)<reserve)throw Object.assign(new Error('Onvoldoende ruimte voor een consistente databaseback-up.'),{code:'BACKUP_SPACE'});
          snapshotDatabase(file,snapshot);compressFile(snapshot,target);rmSync(snapshot);
        }else compressFile(file,target);
        chmodSync(target,0o600);manifest.files.push(name);manifest.storage[name]=stored;
      }catch(error){if(error&&typeof error==='object')error.message=`${name}: ${error.message}`;throw error;}
    }
    saveManifest(partial,manifest);renameSync(partial,destination);partial=null;
    if(automatic){const temp=join(root,`.state-${id}.json`);writeFileSync(temp,JSON.stringify({version,id}),{mode:0o600});renameSync(temp,stateFile);}
    pruneBackups(dataDir,options);return{saved:true,id,files:files.length,compressed:true};
  }catch(error){
    if(partial&&resolve(partial).startsWith(resolve(root)+sep))rmSync(partial,{recursive:true,force:true});
    if(spaceError(error)){const full=new Error('Onvoldoende opslag voor een veilige back-up; de nieuwste volledige back-up is behouden. Maak hostingopslag vrij.');full.code='BACKUP_SPACE';throw full;}
    throw error;
  }
}
