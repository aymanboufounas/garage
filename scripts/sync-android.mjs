import { cpSync,mkdirSync,rmSync } from 'node:fs';
const target=new URL('../android/app/src/main/assets/web',import.meta.url);
rmSync(target,{recursive:true,force:true});mkdirSync(target,{recursive:true});
cpSync(new URL('../web',import.meta.url),target,{recursive:true});
console.log('Android assets updated.');
