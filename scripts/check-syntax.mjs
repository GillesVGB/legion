import {readdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
export function checkSyntax(root=fileURLToPath(new URL('../',import.meta.url))){
  const walk=folder=>existsSync(folder)?readdirSync(folder,{withFileTypes:true}).flatMap(item=>item.isDirectory()?walk(join(folder,item.name)):item.isFile()&&/\.(?:mjs|cjs|js)$/.test(item.name)?[join(folder,item.name)]:[]):[];
  const files=[...(existsSync(join(root,'index.js'))?[join(root,'index.js')]:[]),...['src','scripts','tests'].flatMap(name=>walk(join(root,name)))];
  for(const file of files)try{execFileSync(process.execPath,['--check',file],{stdio:['ignore','pipe','pipe'],timeout:15000});}catch(error){throw new Error(`Syntaxcontrole mislukt: ${file}\n${String(error.stderr||error.code||'TIMEOUT').slice(0,2000)}`);}
  return files.length;
}
