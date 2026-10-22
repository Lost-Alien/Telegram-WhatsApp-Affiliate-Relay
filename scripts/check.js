import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
let failed=false;
for(const folder of ['src','scripts','tests'])for(const name of readdirSync(folder).filter(name=>name.endsWith('.js'))){const result=spawnSync(process.execPath,['--check',`${folder}/${name}`],{stdio:'inherit'});if(result.status!==0)failed=true;}
process.exitCode=failed?1:0;
