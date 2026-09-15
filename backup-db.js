require('dotenv').config();
const fs=require('fs');
const path=require('path');
const Database=require('better-sqlite3');

const source=process.env.DB_PATH||path.join(__dirname,process.env.NODE_ENV==='production'?'data/campus.db':'campus.db');
const backupDir=path.join(__dirname,'backups');
if(!fs.existsSync(source))throw new Error('campus.db was not found');
fs.mkdirSync(backupDir,{recursive:true});
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const target=path.join(backupDir,`campus-${stamp}.db`);
const db=new Database(source,{readonly:true});
try{db.backup(target).then(()=>{db.close();console.log(`Database backup created: ${target}`)}).catch(err=>{db.close();throw err})}catch(err){db.close();throw err}
