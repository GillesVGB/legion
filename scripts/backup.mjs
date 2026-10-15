import {loadConfig} from '../src/config.mjs';
import {createDataBackup} from '../src/backups.mjs';
import {readFileSync} from 'node:fs';
try{const config=loadConfig(process.env,false),version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;const result=createDataBackup(config.dataDir,version);console.log(result.saved?`Privé-back-up ${result.id}: ${result.files} bestanden opgeslagen in data/backups.`:'Nog geen botgegevens om te bewaren.');}
catch(error){console.error(`Back-up mislukt (${error.code||error.name}). De oorspronkelijke gegevens zijn behouden.`);process.exitCode=1;}
