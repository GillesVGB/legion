import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync,copyFileSync,renameSync,rmSync,chmodSync,lstatSync} from 'node:fs';
import {join,resolve,sep,relative,dirname} from 'node:path';

const mainDatabase='legion-1555685630640652338.sqlite';
const backupOptions=dataDir=>{
  const file=join(dataDir,mainDatabase);if(!existsSync(file))return{enabled:true,keep:5};
  const db=new DatabaseSync(file,{readOnly:true});
  try{const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get();const saved=exists?JSON.parse(db.prepare("SELECT value FROM settings WHERE key='dashboard-config'").get()?.value||'{}'):{};
    const value=saved.operations?.backups||{};return{enabled:value.enabled!==false,keep:Number.isSafeInteger(value.keep)&&value.keep>=1&&value.keep<=30?value.keep:5};
  }finally{db.close();}
};
export function backupSummary(dataDir){
  const root=join(resolve(dataDir),'backups');if(!existsSync(root))return[];
  const result=[];for(const entry of readdirSync(root,{withFileTypes:true})){
    if(!entry.isDirectory()||entry.name.startsWith('.'))continue;
    try{const value=JSON.parse(readFileSync(join(root,entry.name,'manifest.json'),'utf8'));if(value.app==='legion'&&value.complete===true)result.push({id:entry.name,version:value.version,createdAt:value.createdAt,files:value.files.length});}catch{}
  }return result.sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id));
}
function dataFiles(root,folder=root){
  return readdirSync(folder,{withFileTypes:true}).flatMap(entry=>{
    const name=entry.name.toLowerCase();
    if(folder===root&&name==='backups'||name==='.env'||name.endsWith('-wal')||name.endsWith('-shm')||name.endsWith('-journal'))return[];
    const path=join(folder,entry.name);return entry.isDirectory()?dataFiles(root,path):entry.isFile()?[path]:[];
  });
}
export function createDataBackup(dataDir,version,{automatic=false,now=Date.now()}={}){
  dataDir=resolve(dataDir);if(!existsSync(dataDir))return{saved:false,reason:'no-data'};
  const options=backupOptions(dataDir),root=join(dataDir,'backups'),stateFile=join(root,'state.json');
  if(existsSync(root)&&lstatSync(root).isSymbolicLink())throw new Error('BACKUP_DIRECTORY_IS_LINK');
  if(automatic&&!options.enabled)return{saved:false,reason:'disabled'};
  let state={};if(existsSync(stateFile))try{state=JSON.parse(readFileSync(stateFile,'utf8'));}catch{}
  if(automatic&&state.version===version&&backupSummary(dataDir).some(item=>item.id===state.id))return{saved:false,reason:'current'};
  const files=dataFiles(dataDir);if(!files.length)return{saved:false,reason:'no-data'};
  mkdirSync(root,{recursive:true,mode:0o700});
  const id=`${new Date(now).toISOString().replace(/[:.]/g,'-')}-${String(version).replace(/[^\w.-]/g,'').slice(0,40)}-${randomBytes(3).toString('hex')}`;
  const partial=join(root,`.partial-${id}`),destination=join(root,id);mkdirSync(partial,{mode:0o700});
  try{
    for(const file of files){
      const target=join(partial,relative(dataDir,file));mkdirSync(dirname(target),{recursive:true,mode:0o700});
      if(/\.(sqlite|db)$/i.test(file)){
        const db=new DatabaseSync(file,{readOnly:true});try{db.exec('PRAGMA busy_timeout=5000;');db.prepare('VACUUM INTO ?').run(target);}finally{db.close();}
        const copy=new DatabaseSync(target,{readOnly:true});try{if(copy.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('BACKUP_INTEGRITY');}finally{copy.close();}
      }else copyFileSync(file,target);
      chmodSync(target,0o600);
    }
    writeFileSync(join(partial,'manifest.json'),JSON.stringify({app:'legion',complete:true,version,createdAt:now,files:files.map(file=>relative(dataDir,file).replaceAll('\\','/'))},null,2),{mode:0o600});
    renameSync(partial,destination);
    if(automatic){const temp=join(root,`.state-${id}.json`);writeFileSync(temp,JSON.stringify({version,id}),{mode:0o600});renameSync(temp,stateFile);}
    for(const old of backupSummary(dataDir).slice(options.keep)){
      const target=resolve(root,old.id);if(target.startsWith(resolve(root)+sep))rmSync(target,{recursive:true,force:true});
    }
    return{saved:true,id,files:files.length};
  }catch(error){if(resolve(partial).startsWith(resolve(root)+sep))rmSync(partial,{recursive:true,force:true});throw error;}
}
