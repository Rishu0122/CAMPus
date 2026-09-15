require('dotenv').config();
const express=require('express');
const http=require('http');
const cors=require('cors');
const path=require('path');
const crypto=require('crypto');
const Database=require('better-sqlite3');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const nodemailer=require('nodemailer');
const {Server}=require('socket.io');
const {attachSocket}=require('./socket');

const app=express();
const server=http.createServer(app);
const io=new Server(server,{cors:{origin:'*'}});
const db=new Database(process.env.DB_PATH||path.join(__dirname,process.env.NODE_ENV==='production'?'data/campus.db':'campus.db'));
const PORT=process.env.PORT||3000;
const SECRET=process.env.CAMPUS_SECRET||'CHANGE_THIS_CAMPUS_SECRET';
if(process.env.NODE_ENV==='production'&&(!process.env.CAMPUS_SECRET||process.env.CAMPUS_SECRET.length<32))throw new Error('CAMPUS_SECRET must be at least 32 characters in production');
app.disable('x-powered-by');
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');if(process.env.NODE_ENV==='production')res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');next()});
app.use(cors()); app.use(express.json({limit:'6mb'})); app.use(express.static(path.join(__dirname,'public')));
app.get('/api/health',(req,res)=>res.json({ok:true,service:'CAMPus'}));

db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'student',teacher_verified INTEGER DEFAULT 0,course TEXT DEFAULT 'BCA',year INTEGER DEFAULT 1,
 bio TEXT DEFAULT '',online INTEGER DEFAULT 0,last_seen TEXT DEFAULT CURRENT_TIMESTAMP,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS posts(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,text TEXT NOT NULL,likes INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS post_likes(user_id INTEGER,post_id INTEGER,PRIMARY KEY(user_id,post_id),FOREIGN KEY(user_id) REFERENCES users(id),FOREIGN KEY(post_id) REFERENCES posts(id));
CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY AUTOINCREMENT,post_id INTEGER NOT NULL,user_id INTEGER NOT NULL,text TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,FOREIGN KEY(user_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS groups_tbl(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,description TEXT DEFAULT '',course TEXT DEFAULT 'BCA',year INTEGER DEFAULT 1,code TEXT UNIQUE NOT NULL,admin_id INTEGER NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(admin_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS memberships(user_id INTEGER,group_id INTEGER,joined_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(user_id,group_id),FOREIGN KEY(user_id) REFERENCES users(id),FOREIGN KEY(group_id) REFERENCES groups_tbl(id));
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,description TEXT DEFAULT '',category TEXT DEFAULT 'Other',date TEXT NOT NULL,time TEXT DEFAULT '',venue TEXT DEFAULT '',created_by INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(created_by) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS event_rsvps(event_id INTEGER NOT NULL,user_id INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'going',created_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(event_id,user_id),FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS timetable(id INTEGER PRIMARY KEY AUTOINCREMENT,course TEXT NOT NULL,year INTEGER NOT NULL,day TEXT NOT NULL,start_time TEXT NOT NULL,end_time TEXT NOT NULL,subject TEXT NOT NULL,room TEXT DEFAULT '',teacher TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS attendance_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT,group_id INTEGER,subject TEXT NOT NULL,session_date TEXT NOT NULL,start_time TEXT NOT NULL,code TEXT UNIQUE NOT NULL,created_by INTEGER NOT NULL,expires_at TEXT,FOREIGN KEY(group_id) REFERENCES groups_tbl(id),FOREIGN KEY(created_by) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS attendance(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id INTEGER NOT NULL,user_id INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'present',marked_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(session_id,user_id),FOREIGN KEY(session_id) REFERENCES attendance_sessions(id),FOREIGN KEY(user_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,sender_id INTEGER NOT NULL,receiver_id INTEGER NOT NULL,text TEXT NOT NULL,seen INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(sender_id) REFERENCES users(id),FOREIGN KEY(receiver_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS connections(user_id INTEGER,other_id INTEGER,status TEXT DEFAULT 'connected',PRIMARY KEY(user_id,other_id),FOREIGN KEY(user_id) REFERENCES users(id),FOREIGN KEY(other_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,type TEXT DEFAULT 'system',read_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS email_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,group_id INTEGER,sender_id INTEGER,subject TEXT,body TEXT,sent_count INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS audit_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,action TEXT NOT NULL,target_type TEXT DEFAULT '',target_id INTEGER,details TEXT DEFAULT '',ip TEXT DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS password_resets(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,used_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS user_blocks(blocker_id INTEGER NOT NULL,blocked_id INTEGER NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(blocker_id,blocked_id),FOREIGN KEY(blocker_id) REFERENCES users(id) ON DELETE CASCADE,FOREIGN KEY(blocked_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS post_reports(id INTEGER PRIMARY KEY AUTOINCREMENT,post_id INTEGER NOT NULL,reporter_id INTEGER NOT NULL,reason TEXT NOT NULL,reviewed_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(post_id,reporter_id),FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,FOREIGN KEY(reporter_id) REFERENCES users(id) ON DELETE CASCADE);
`);
const postColumns=db.prepare('PRAGMA table_info(posts)').all().map(c=>c.name);
if(!postColumns.includes('image_data'))db.exec("ALTER TABLE posts ADD COLUMN image_data TEXT DEFAULT ''");
// Verification fields were added after the initial database version.
const userColumns=db.prepare('PRAGMA table_info(users)').all().map(c=>c.name);
[
 ['avatar_data','TEXT DEFAULT \'\''],
 ['institution','TEXT DEFAULT \'\''],
 ['department','TEXT DEFAULT \'\''],
 ['employee_id','TEXT DEFAULT \'\''],
 ['qualification','TEXT DEFAULT \'\''],
 ['teaching_subjects','TEXT DEFAULT \'\''],
 ['verification_document','TEXT DEFAULT \'\'']
].forEach(([name,definition])=>{if(!userColumns.includes(name))db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`)});

const now=()=>new Date().toISOString();
const mailer=process.env.GMAIL_USER&&process.env.GMAIL_APP_PASSWORD
  ? nodemailer.createTransport({service:'gmail',auth:{user:process.env.GMAIL_USER,pass:process.env.GMAIL_APP_PASSWORD}})
  : null;
function tokenFor(u){return jwt.sign({id:u.id,role:u.role,name:u.name},SECRET,{expiresIn:'7d'});}
const requestAttempts=new Map();
function rateLimit(windowMs,max,scope){
 return (req,res,next)=>{
  const key=`${scope}:${req.ip}`;
  const current=Date.now();
  const recent=(requestAttempts.get(key)||[]).filter(time=>current-time<windowMs);
  if(recent.length>=max)return res.status(429).json({error:'Too many attempts. Please try again later.'});
  recent.push(current);requestAttempts.set(key,recent);next();
 };
}
function auth(req,res,next){try{const h=req.headers.authorization||'';if(!h.startsWith('Bearer '))throw Error();const claims=jwt.verify(h.slice(7),SECRET);const user=db.prepare('SELECT * FROM users WHERE id=?').get(claims.id);if(!user)throw Error();req.user={id:user.id,role:user.role,name:user.name};next()}catch(e){res.status(401).json({error:'Authentication required'})}}
function role(...roles){return (req,res,next)=>{if(!roles.includes(req.user.role))return res.status(403).json({error:'Permission denied'});if(req.user.role==='teacher'&&!db.prepare('SELECT teacher_verified FROM users WHERE id=?').get(req.user.id)?.teacher_verified)return res.status(403).json({error:'Teacher account is awaiting admin verification'});next()};}
function audit(req,action,targetType='',targetId=null,details=''){const actor=req.user||req;db.prepare('INSERT INTO audit_logs(user_id,action,target_type,target_id,details,ip) VALUES(?,?,?,?,?,?)').run(actor?.id||null,action,targetType,targetId,details,req.ip||'');}
function hashResetToken(token){return crypto.createHash('sha256').update(token).digest('hex');}
function safeUser(u){return u&&{id:u.id,name:u.name,email:u.email,role:u.role,teacher_verified:!!u.teacher_verified,course:u.course,year:u.year,bio:u.bio,avatar_data:u.avatar_data||'',institution:u.institution||'',department:u.department||'',employee_id:u.employee_id||'',qualification:u.qualification||'',teaching_subjects:u.teaching_subjects||'',verification_document:u.verification_document||'',online:!!u.online,last_seen:u.last_seen};}
function uniqueCode(){let c;do{c='CAMP-'+Math.random().toString(36).slice(2,7).toUpperCase()}while(db.prepare('SELECT 1 FROM groups_tbl WHERE code=?').get(c));return c;}
function randomCode(){return Math.floor(100000+Math.random()*900000).toString();}
function notifyUser(userId,title,body,type='system'){
  const result=db.prepare('INSERT INTO notifications(user_id,title,body,type) VALUES(?,?,?,?)').run(userId,title,body,type);
  io.to('user:'+userId).emit('notification:new',{id:result.lastInsertRowid,title,body,type});
}
function notifyUsers(title,body,type='system',where='role IN (\'student\',\'teacher\',\'admin\')',params=[]){
  db.prepare(`SELECT id FROM users WHERE ${where}`).all(...params).forEach(u=>notifyUser(u.id,title,body,type));
}
function connected(userId,otherId){return !!db.prepare("SELECT 1 FROM connections WHERE status='connected' AND ((user_id=? AND other_id=?) OR (user_id=? AND other_id=?))").get(userId,otherId,otherId,userId);}
function blocked(userId,otherId){return !!db.prepare('SELECT 1 FROM user_blocks WHERE blocker_id=? AND blocked_id=?').get(userId,otherId)||!!db.prepare('SELECT 1 FROM user_blocks WHERE blocker_id=? AND blocked_id=?').get(otherId,userId);}

function seed(){
 if(db.prepare('SELECT 1 FROM users LIMIT 1').get())return;
 const pass=bcrypt.hashSync('demo123',10);
 const admin=db.prepare('INSERT INTO users(name,email,password,role,teacher_verified,course,year,bio) VALUES(?,?,?,?,?,?,?,?)').run('CAMPus Admin','admin@campus.local',pass,'admin',1,'CAMPus',0,'College administrator');
 const teacher=db.prepare('INSERT INTO users(name,email,password,role,teacher_verified,course,year,bio) VALUES(?,?,?,?,?,?,?,?)').run('Dr. Ananya Sharma','teacher@campus.local',pass,'teacher',1,'BCA',3,'Faculty · Computer Science');
 const student=db.prepare('INSERT INTO users(name,email,password,role,teacher_verified,course,year,bio) VALUES(?,?,?,?,?,?,?,?)').run('Rishab Kumar','demo@campus.local',pass,'student',0,'BCA',3,'BCA 3rd Year · Building projects');
 const personal=db.prepare('INSERT INTO users(name,email,password,role,teacher_verified,course,year,bio) VALUES(?,?,?,?,?,?,?,?)').run('Aarav Mehta','personal@campus.local',pass,'personal',0,'','1','Personal CAMPus account');
 const gid=db.prepare('INSERT INTO groups_tbl(name,description,course,year,code,admin_id) VALUES(?,?,?,?,?,?)').run('BCA 3rd Year','Official discussion and academic updates for BCA 3rd Year.','BCA',3,'BCA3RD26',teacher.lastInsertRowid);
 db.prepare('INSERT INTO memberships(user_id,group_id) VALUES(?,?)').run(teacher.lastInsertRowid,gid.lastInsertRowid);
 db.prepare('INSERT INTO memberships(user_id,group_id) VALUES(?,?)').run(student.lastInsertRowid,gid.lastInsertRowid);
 const posts=[['Rishab Kumar','🚀 CAMPus is ready for the new semester! Share resources, notes and project ideas here.',18],['Dr. Ananya Sharma','📢 BCA 3rd Year: please check the updated timetable and attendance section before tomorrow’s classes.',32]];
 posts.forEach(p=>{const uid=p[0].startsWith('Dr.')?teacher.lastInsertRowid:student.lastInsertRowid;db.prepare('INSERT INTO posts(user_id,text,likes) VALUES(?,?,?)').run(uid,p[1],p[2])});
 [['Tech Symposium 2026','Student talks, demos and project showcase.','Program','2026-09-18','10:00','Auditorium'],['DSA Study Circle','Trees, graphs, sorting and problem solving session.','Workshop','2026-09-19','15:00','Central Library'],['Annual College Fest','Music, competitions, food and student activities.','Other','2026-09-24','10:00','Main Ground']].forEach(e=>db.prepare('INSERT INTO events(title,description,category,date,time,venue,created_by) VALUES(?,?,?,?,?,?,?)').run(...e,teacher.lastInsertRowid));
 const slots=[['Monday','09:00','10:00','Computer Architecture','Lab 1','Dr. Ananya Sharma'],['Monday','11:00','12:00','Data Structures','Room 204','Dr. Ananya Sharma'],['Tuesday','10:00','11:00','Numerical Methods','Room 204','Prof. Mehta'],['Wednesday','09:00','10:00','Machine Learning','AI Lab','Dr. Ananya Sharma'],['Thursday','12:00','13:00','Backend Web Development','Lab 2','Mr. Arjun'],['Friday','10:00','11:00','English Language Skills','Room 101','Ms. Neha']];
 slots.forEach(s=>db.prepare('INSERT INTO timetable(course,year,day,start_time,end_time,subject,room,teacher) VALUES(?,?,?,?,?,?,?,?)').run('BCA',3,...s));
}
seed();

// Auth
app.post('/api/auth/register',rateLimit(15*60*1000,8,'register'),(req,res)=>{
 const {name,email,password,role:requestedRole='student',course='BCA',year=1,bio='',institution='',department='',employee_id='',qualification='',teaching_subjects='',verification_document=''}=req.body||{};
 if(!name||!email||!password||password.length<6)return res.status(400).json({error:'Name, email and a 6+ character password are required'});
 let userRole=['student','teacher','personal'].includes(requestedRole)?requestedRole:'student';
 if(userRole==='teacher'){
  const missing=[['institution','college/institution'],['department','department'],['employee_id','employee ID'],['qualification','qualification'],['teaching_subjects','teaching subjects'],['verification_document','proof document link']].filter(([key])=>!String(req.body?.[key]||'').trim()).map(([,label])=>label);
  if(missing.length)return res.status(400).json({error:`Teacher verification details required: ${missing.join(', ')}`});
  if(!/^https?:\/\/\S+$/i.test(String(verification_document).trim()))return res.status(400).json({error:'Proof document must be a valid http(s) link'});
 }
 try{
  const hash=bcrypt.hashSync(password,10); const verified=userRole==='teacher'?0:0;
  const r=db.prepare('INSERT INTO users(name,email,password,role,teacher_verified,course,year,bio,institution,department,employee_id,qualification,teaching_subjects,verification_document) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(name,email.toLowerCase(),hash,userRole,verified,course,Number(year)||1,bio,String(institution).trim(),String(department).trim(),String(employee_id).trim(),String(qualification).trim(),String(teaching_subjects).trim(),String(verification_document).trim());
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
  if(userRole==='teacher') notifyUser(1,'Teacher verification requested',`${name} requested teacher access.`,'teacher_verification');
  audit({user:u},'account_registered','user',u.id,`role=${userRole}`);
  res.json({token:tokenFor(u),user:safeUser(u),message:userRole==='teacher'?'Teacher account created and sent for verification.':'Account created.'});
 }catch(e){res.status(409).json({error:'Email already registered'})}
});
app.post('/api/setup/admin',rateLimit(15*60*1000,3,'admin-setup'),(req,res)=>{
 const key=String(req.body?.setup_key||'');
 if(!process.env.ADMIN_SETUP_KEY||key!==process.env.ADMIN_SETUP_KEY)return res.status(403).json({error:'Admin setup is unavailable'});
 if(db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get())return res.status(409).json({error:'An administrator already exists'});
 const name=String(req.body?.name||'').trim(),email=String(req.body?.email||'').trim().toLowerCase(),password=String(req.body?.password||'');
 if(!name||!email||password.length<8)return res.status(400).json({error:'Name, email and an 8+ character password are required'});
 try{const hash=bcrypt.hashSync(password,12);const r=db.prepare("INSERT INTO users(name,email,password,role,teacher_verified,course,year,bio) VALUES(?,?,?,'admin',1,'CAMPUS',0,'College administrator')").run(name,email,hash);audit({id:r.lastInsertRowid,name,role:'admin'},'admin_bootstrapped','user',r.lastInsertRowid);res.status(201).json({ok:true,message:'Administrator created. Remove ADMIN_SETUP_KEY from the environment now.'})}catch(e){res.status(409).json({error:'Email already registered'})}
});
app.post('/api/auth/login',rateLimit(15*60*1000,10,'login'),(req,res)=>{const u=db.prepare('SELECT * FROM users WHERE email=?').get((req.body?.email||'').toLowerCase());if(!u||!bcrypt.compareSync(req.body?.password||'',u.password))return res.status(401).json({error:'Invalid email or password'});db.prepare('UPDATE users SET online=1,last_seen=? WHERE id=?').run(now(),u.id);audit({user:u},'login','user',u.id);res.json({token:tokenFor(u),user:safeUser(u)})});
app.post('/api/auth/forgot-password',rateLimit(15*60*1000,5,'forgot-password'),(req,res)=>{
 const email=String(req.body?.email||'').trim().toLowerCase();
 if(email){
  const u=db.prepare('SELECT id,name,email FROM users WHERE email=?').get(email);
  if(u){
   db.prepare("DELETE FROM password_resets WHERE user_id=? OR expires_at<=datetime('now')").run(u.id);
   const raw=crypto.randomBytes(32).toString('hex');
   db.prepare('INSERT INTO password_resets(user_id,token_hash,expires_at) VALUES(?,?,datetime(?,\'+1 hour\'))').run(u.id,hashResetToken(raw),now());
   const base=process.env.APP_URL||`http://localhost:${PORT}`;
   const link=`${base}/?reset_token=${encodeURIComponent(raw)}`;
   if(mailer)mailer.sendMail({from:`CAMPus <${process.env.GMAIL_USER}>`,to:u.email,subject:'Reset your CAMPus password',text:`Hi ${u.name},\n\nReset your password using this link (valid for 1 hour):\n${link}\n\nIf you did not request this, you can ignore this email.`}).catch(error=>console.error('Password reset email failed:',error.message));
   else console.warn('Password reset email skipped: configure GMAIL_USER and GMAIL_APP_PASSWORD in .env.');
   audit({user:u},'password_reset_requested','user',u.id);
  }
 }
 res.json({ok:true,message:'If an account exists for that email, a password reset link has been sent.'});
});
app.post('/api/auth/reset-password',rateLimit(15*60*1000,8,'reset-password'),(req,res)=>{
 const token=String(req.body?.token||'');const password=String(req.body?.password||'');
 if(!/^[a-f0-9]{64}$/i.test(token)||password.length<6)return res.status(400).json({error:'A valid reset token and a 6+ character password are required'});
 const reset=db.prepare("SELECT * FROM password_resets WHERE token_hash=? AND used_at IS NULL AND expires_at>datetime('now')").get(hashResetToken(token));
 if(!reset)return res.status(400).json({error:'This reset link is invalid or has expired'});
 const update=db.transaction(()=>{db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(password,10),reset.user_id);db.prepare('UPDATE password_resets SET used_at=? WHERE id=?').run(now(),reset.id);db.prepare("DELETE FROM password_resets WHERE user_id=? AND id<>?").run(reset.user_id,reset.id)});
 update();audit({user:{id:reset.user_id}},'password_reset_completed','user',reset.user_id);res.json({ok:true,message:'Password updated. You can now sign in.'});
});
app.post('/api/auth/logout',auth,(req,res)=>{db.prepare('UPDATE users SET online=0,last_seen=? WHERE id=?').run(now(),req.user.id);audit(req,'logout','user',req.user.id);res.json({ok:true})});
app.get('/api/me',auth,(req,res)=>res.json(safeUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id))));
app.patch('/api/me',auth,(req,res)=>{const {name,bio,course,year,avatar_data}=req.body||{};if(name!==undefined&&!String(name).trim())return res.status(400).json({error:'Name cannot be empty'});if(avatar_data&&(!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=\s]+$/.test(avatar_data)||avatar_data.length>1400000))return res.status(400).json({error:'Choose a JPG, PNG or WebP image smaller than 1 MB'});db.prepare('UPDATE users SET name=COALESCE(?,name),bio=COALESCE(?,bio),course=COALESCE(?,course),year=COALESCE(?,year),avatar_data=COALESCE(?,avatar_data) WHERE id=?').run(name?.trim()||null,bio??null,course?.trim()||null,year?Number(year):null,avatar_data||null,req.user.id);res.json(safeUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)))});

// Feed / users
app.get('/api/posts',auth,(req,res)=>res.json(db.prepare(`SELECT p.id,p.text,p.image_data,p.likes,p.created_at,u.id user_id,u.name,u.role,u.course,u.year,u.avatar_data,EXISTS(SELECT 1 FROM post_likes l WHERE l.post_id=p.id AND l.user_id=?) liked FROM posts p JOIN users u ON u.id=p.user_id WHERE NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=? AND b.blocked_id=p.user_id) OR (b.blocker_id=p.user_id AND b.blocked_id=?)) ORDER BY p.id DESC`).all(req.user.id,req.user.id,req.user.id)));
app.post('/api/posts',auth,(req,res,next)=>{if(req.user.role==='personal')return res.status(403).json({error:'Personal accounts are limited to normal one-to-one communication'});next()},(req,res)=>{const text=(req.body?.text||'').trim();const image=String(req.body?.image_data||'').trim();if(!text&&!image)return res.status(400).json({error:'Write something or choose a photo'});if(image&&(!/^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/=\s]+$/.test(image)||image.length>4500000))return res.status(400).json({error:'Choose a JPG, PNG, GIF or WebP image smaller than 3 MB'});const r=db.prepare('INSERT INTO posts(user_id,text,image_data) VALUES(?,?,?)').run(req.user.id,text,image);res.json(db.prepare('SELECT p.id,p.text,p.image_data,p.likes,p.created_at,u.id user_id,u.name,u.role,u.course,u.year,0 liked FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=?').get(r.lastInsertRowid))});
app.get('/api/posts/:id/comments',auth,(req,res)=>res.json(db.prepare(`SELECT c.id,c.text,c.created_at,u.id user_id,u.name,u.role FROM comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? ORDER BY c.id ASC`).all(req.params.id)));
app.post('/api/posts/:id/comments',auth,(req,res)=>{const text=(req.body?.text||'').trim();if(!text)return res.status(400).json({error:'Comment cannot be empty'});if(!db.prepare('SELECT 1 FROM posts WHERE id=?').get(req.params.id))return res.status(404).json({error:'Post not found'});const r=db.prepare('INSERT INTO comments(post_id,user_id,text) VALUES(?,?,?)').run(req.params.id,req.user.id,text);res.json(db.prepare(`SELECT c.id,c.text,c.created_at,u.id user_id,u.name,u.role FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=?`).get(r.lastInsertRowid))});

app.post('/api/posts/:id/like',auth,(req,res)=>{const p=db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);if(!p)return res.status(404).json({error:'Post not found'});const existing=db.prepare('SELECT 1 FROM post_likes WHERE user_id=? AND post_id=?').get(req.user.id,p.id);if(existing){db.prepare('DELETE FROM post_likes WHERE user_id=? AND post_id=?').run(req.user.id,p.id);db.prepare('UPDATE posts SET likes=MAX(likes-1,0) WHERE id=?').run(p.id)}else{db.prepare('INSERT INTO post_likes(user_id,post_id) VALUES(?,?)').run(req.user.id,p.id);db.prepare('UPDATE posts SET likes=likes+1 WHERE id=?').run(p.id)}res.json({likes:db.prepare('SELECT likes FROM posts WHERE id=?').get(p.id).likes,liked:!existing})});
app.delete('/api/posts/:id',auth,(req,res)=>{const p=db.prepare('SELECT id,user_id FROM posts WHERE id=?').get(req.params.id);if(!p)return res.status(404).json({error:'Post not found'});if(p.user_id!==req.user.id)return res.status(403).json({error:'You can delete only your own posts'});const remove=db.transaction(()=>{db.prepare('DELETE FROM comments WHERE post_id=?').run(p.id);db.prepare('DELETE FROM post_likes WHERE post_id=?').run(p.id);db.prepare('DELETE FROM posts WHERE id=?').run(p.id)});remove();res.json({ok:true})});
app.post('/api/posts/:id/report',auth,(req,res)=>{const post=db.prepare('SELECT id,user_id FROM posts WHERE id=?').get(req.params.id);if(!post)return res.status(404).json({error:'Post not found'});if(post.user_id===req.user.id)return res.status(400).json({error:'You cannot report your own post'});const reason=String(req.body?.reason||'Inappropriate content').trim().slice(0,200);try{db.prepare('INSERT INTO post_reports(post_id,reporter_id,reason) VALUES(?,?,?)').run(post.id,req.user.id,reason)}catch(e){return res.status(409).json({error:'You already reported this post'})}res.json({ok:true})});
app.get('/api/users',auth,(req,res)=>res.json(db.prepare(`SELECT u.id,u.name,u.role,u.teacher_verified,u.course,u.year,u.bio,u.avatar_data,u.online,u.last_seen,
 EXISTS(SELECT 1 FROM connections c WHERE c.status='connected' AND ((c.user_id=? AND c.other_id=u.id) OR (c.user_id=u.id AND c.other_id=?))) connected,
 EXISTS(SELECT 1 FROM connections c WHERE c.user_id=? AND c.other_id=u.id AND c.status='pending') request_sent,
 EXISTS(SELECT 1 FROM connections c WHERE c.user_id=u.id AND c.other_id=? AND c.status='pending') request_received
 FROM users u WHERE u.id<>? AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=? AND b.blocked_id=u.id) OR (b.blocker_id=u.id AND b.blocked_id=?)) ORDER BY online DESC,name LIMIT 100`).all(req.user.id,req.user.id,req.user.id,req.user.id,req.user.id,req.user.id,req.user.id)));
app.post('/api/users/:id/block',auth,(req,res)=>{const other=Number(req.params.id);if(other===req.user.id)return res.status(400).json({error:'Cannot block yourself'});if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(other))return res.status(404).json({error:'User not found'});db.prepare('INSERT OR IGNORE INTO user_blocks(blocker_id,blocked_id) VALUES(?,?)').run(req.user.id,other);db.prepare('DELETE FROM connections WHERE (user_id=? AND other_id=?) OR (user_id=? AND other_id=?)').run(req.user.id,other,other,req.user.id);res.json({ok:true,blocked:true})});
app.delete('/api/users/:id/block',auth,(req,res)=>{db.prepare('DELETE FROM user_blocks WHERE blocker_id=? AND blocked_id=?').run(req.user.id,Number(req.params.id));res.json({ok:true,blocked:false})});
app.get('/api/users/blocked',auth,(req,res)=>res.json(db.prepare(`SELECT u.id,u.name,u.role,u.course,u.year,u.avatar_data,b.created_at
 FROM user_blocks b JOIN users u ON u.id=b.blocked_id WHERE b.blocker_id=? ORDER BY u.name`).all(req.user.id)));
app.get('/api/connections',auth,(req,res)=>res.json(db.prepare(`SELECT u.id,u.name,u.role,u.teacher_verified,u.course,u.year,u.bio,u.online,u.last_seen,1 connected
 FROM connections c JOIN users u ON u.id=CASE WHEN c.user_id=? THEN c.other_id ELSE c.user_id END
 WHERE c.status='connected' AND (c.user_id=? OR c.other_id=?) ORDER BY u.online DESC,u.name`).all(req.user.id,req.user.id,req.user.id)));
app.post('/api/users/:id/connect',auth,(req,res)=>{const other=Number(req.params.id);if(other===req.user.id)return res.status(400).json({error:'Cannot connect to yourself'});if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(other))return res.status(404).json({error:'User not found'});if(connected(req.user.id,other))return res.status(409).json({error:'You are already connected'});const existing=db.prepare('SELECT status FROM connections WHERE user_id=? AND other_id=?').get(req.user.id,other);if(existing?.status==='pending')return res.status(409).json({error:'Connection request already sent'});db.prepare("INSERT OR REPLACE INTO connections(user_id,other_id,status) VALUES(?,?,'pending')").run(req.user.id,other);notifyUser(other,'Connection request',`${req.user.name||'Someone'} wants to connect with you on CAMPus. [request:${req.user.id}]`,'connection_request');res.json({ok:true,requestSent:true})});
app.post('/api/connections/:id/accept',auth,(req,res)=>{const requester=Number(req.params.id);const pending=db.prepare("SELECT 1 FROM connections WHERE user_id=? AND other_id=? AND status='pending'").get(requester,req.user.id);if(!pending)return res.status(404).json({error:'Connection request not found'});const accept=db.transaction(()=>{db.prepare("UPDATE connections SET status='connected' WHERE user_id=? AND other_id=?").run(requester,req.user.id);db.prepare("INSERT OR REPLACE INTO connections(user_id,other_id,status) VALUES(?,?,'connected')").run(req.user.id,requester)});accept();notifyUser(requester,'Connection accepted',`${req.user.name||'This user'} accepted your CAMPus connection request.`,'connection_accepted');res.json({ok:true,connected:true})});
app.post('/api/connections/:id/reject',auth,(req,res)=>{const requester=Number(req.params.id);const result=db.prepare("DELETE FROM connections WHERE user_id=? AND other_id=? AND status='pending'").run(requester,req.user.id);if(!result.changes)return res.status(404).json({error:'Connection request not found'});res.json({ok:true,rejected:true})});

// Groups
app.get('/api/groups',auth,(req,res,next)=>req.user.role==='personal'?res.status(403).json({error:'Groups are available to student and faculty accounts only'}):next(),(req,res)=>res.json(db.prepare(`SELECT g.*,u.name admin_name,(SELECT COUNT(*) FROM memberships m WHERE m.group_id=g.id) members,EXISTS(SELECT 1 FROM memberships m2 WHERE m2.group_id=g.id AND m2.user_id=?) joined FROM groups_tbl g JOIN users u ON u.id=g.admin_id ORDER BY g.created_at DESC`).all(req.user.id)));
app.post('/api/groups',auth,role('teacher','admin'),(req,res)=>{const {name,description='',course='BCA',year=1,code}=req.body||{};if(!name)return res.status(400).json({error:'Group name required'});const c=code||uniqueCode();try{const r=db.prepare('INSERT INTO groups_tbl(name,description,course,year,code,admin_id) VALUES(?,?,?,?,?,?)').run(name,description,course,Number(year)||1,c,req.user.id);db.prepare('INSERT INTO memberships(user_id,group_id) VALUES(?,?)').run(req.user.id,r.lastInsertRowid);notifyUsers('New group available',`${name} has been created for ${course} Year ${Number(year)||1}. Join it from Groups.`,'group_created');res.json(db.prepare('SELECT * FROM groups_tbl WHERE id=?').get(r.lastInsertRowid))}catch(e){res.status(409).json({error:'Group code already exists'})}});
app.post('/api/groups/join',auth,(req,res,next)=>req.user.role==='personal'?res.status(403).json({error:'Personal accounts cannot join college groups'}):next(),(req,res)=>{const code=(req.body?.code||'').trim().toUpperCase();const g=db.prepare('SELECT * FROM groups_tbl WHERE UPPER(code)=?').get(code);if(!g)return res.status(404).json({error:'Invalid group code'});try{db.prepare('INSERT INTO memberships(user_id,group_id) VALUES(?,?)').run(req.user.id,g.id)}catch(e){}res.json({ok:true,group:g})});
app.post('/api/groups/:id/join',auth,(req,res,next)=>req.user.role==='personal'?res.status(403).json({error:'Personal accounts cannot join college groups'}):next(),(req,res)=>{const group=db.prepare('SELECT * FROM groups_tbl WHERE id=?').get(req.params.id);if(!group)return res.status(404).json({error:'Group not found'});try{db.prepare('INSERT INTO memberships(user_id,group_id) VALUES(?,?)').run(req.user.id,group.id)}catch(e){}res.json({ok:true,group})});
app.get('/api/groups/:id/members',auth,(req,res,next)=>req.user.role==='personal'?res.status(403).json({error:'Groups are available to college accounts only'}):next(),(req,res)=>res.json(db.prepare('SELECT u.id,u.name,u.email,u.role,u.course,u.year,u.online,u.last_seen,m.joined_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.group_id=? ORDER BY u.name').all(req.params.id)));
app.delete('/api/groups/:gid/members/:uid',auth,role('teacher','admin'),(req,res)=>{const g=db.prepare('SELECT * FROM groups_tbl WHERE id=?').get(req.params.gid);if(!g|| (req.user.role!=='admin'&&g.admin_id!==req.user.id))return res.status(403).json({error:'Only group admin can manage members'});db.prepare('DELETE FROM memberships WHERE group_id=? AND user_id=?').run(req.params.gid,req.params.uid);res.json({ok:true})});

// Events
app.get('/api/events',auth,(req,res,next)=>req.user.role==='personal'?res.status(403).json({error:'Events are available to college accounts only'}):next(),(req,res)=>res.json(db.prepare(`SELECT e.*,u.name created_by_name,er.status rsvp_status,(SELECT COUNT(*) FROM event_rsvps x WHERE x.event_id=e.id AND x.status='going') rsvp_count FROM events e LEFT JOIN users u ON u.id=e.created_by LEFT JOIN event_rsvps er ON er.event_id=e.id AND er.user_id=? ORDER BY e.date,e.time`).all(req.user.id)));
app.post('/api/events',auth,role('teacher','admin'),(req,res)=>{const {title,description='',category='Other',date,time='',venue=''}=req.body||{};if(!title||!date)return res.status(400).json({error:'Title and date required'});const r=db.prepare('INSERT INTO events(title,description,category,date,time,venue,created_by) VALUES(?,?,?,?,?,?,?)').run(title,description,category,date,time,venue,req.user.id);notifyUsers('New campus event',`${title} is scheduled for ${date}${time?' at '+time:''}${venue?' in '+venue:''}.`,'event_created');res.json(db.prepare('SELECT * FROM events WHERE id=?').get(r.lastInsertRowid))});
app.post('/api/events/:id/rsvp',auth,(req,res)=>{const event=db.prepare('SELECT id,title FROM events WHERE id=?').get(req.params.id);if(!event)return res.status(404).json({error:'Event not found'});const status=req.body?.status==='going'?'going':'not_going';db.prepare('INSERT INTO event_rsvps(event_id,user_id,status) VALUES(?,?,?) ON CONFLICT(event_id,user_id) DO UPDATE SET status=excluded.status').run(event.id,req.user.id,status);res.json({ok:true,status})});

// Timetable + smart reminders
app.get('/api/timetable',auth,(req,res,next)=>req.user.role==='personal'?res.status(403).json({error:'Timetable is available to student and faculty accounts only'}):next(),(req,res)=>{const u=db.prepare('SELECT course,year FROM users WHERE id=?').get(req.user.id);const query=`SELECT * FROM timetable ORDER BY CASE day WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3 WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 ELSE 7 END,start_time`;res.json(req.user.role==='admin'?db.prepare(query).all():db.prepare(`${query.replace(' ORDER BY',' WHERE course=? AND year=? ORDER BY')}`).all(u.course,u.year))});
app.post('/api/timetable',auth,role('teacher','admin'),(req,res)=>{const {course='BCA',year=1,day,start_time,end_time,subject,room='',teacher=''}=req.body||{};if(!day||!start_time||!end_time||!subject)return res.status(400).json({error:'Complete timetable details required'});const numericYear=Number(year);const r=db.prepare('INSERT INTO timetable(course,year,day,start_time,end_time,subject,room,teacher) VALUES(?,?,?,?,?,?,?,?)').run(course,numericYear,day,start_time,end_time,subject,room,teacher);notifyUsers('Timetable updated',`${subject} has been added to the ${course} Year ${numericYear} timetable for ${day} at ${start_time}.`,'timetable_update','role IN (\'student\',\'teacher\',\'admin\') AND course=? AND year=?',[course,numericYear]);res.json(db.prepare('SELECT * FROM timetable WHERE id=?').get(r.lastInsertRowid))});
app.patch('/api/timetable/:id',auth,role('teacher','admin'),(req,res)=>{const {course='BCA',year=1,day,start_time,end_time,subject,room='',teacher=''}=req.body||{};if(!day||!start_time||!end_time||!subject)return res.status(400).json({error:'Complete timetable details required'});const result=db.prepare('UPDATE timetable SET course=?,year=?,day=?,start_time=?,end_time=?,subject=?,room=?,teacher=? WHERE id=?').run(course,Number(year),day,start_time,end_time,subject,room,teacher,req.params.id);if(!result.changes)return res.status(404).json({error:'Timetable slot not found'});res.json(db.prepare('SELECT * FROM timetable WHERE id=?').get(req.params.id))});
app.delete('/api/timetable/:id',auth,role('teacher','admin'),(req,res)=>{const result=db.prepare('DELETE FROM timetable WHERE id=?').run(req.params.id);if(!result.changes)return res.status(404).json({error:'Timetable slot not found'});res.json({ok:true})});
app.get('/api/reminders',auth,(req,res,next)=>req.user.role==='personal'?res.status(403).json({error:'Timetable reminders are available to college accounts only'}):next(),(req,res)=>{const u=db.prepare('SELECT course,year FROM users WHERE id=?').get(req.user.id);const day=new Intl.DateTimeFormat('en-US',{weekday:'long',timeZone:'Asia/Kolkata'}).format(new Date());const rows=db.prepare('SELECT * FROM timetable WHERE course=? AND year=? AND day=? ORDER BY start_time').all(u.course,u.year,day);res.json({day,reminders:rows.map(x=>({subject:x.subject,start:x.start_time,end:x.end_time,room:x.room,teacher:x.teacher,message:`Your ${u.course} class ${x.subject} is scheduled at ${x.start_time}${x.room?' in '+x.room:''}.`}))})});

// Attendance
app.post('/api/attendance/sessions',auth,role('teacher','admin'),(req,res)=>{const {group_id=null,subject,session_date,start_time,expires_minutes=15}=req.body||{};if(!subject||!session_date||!start_time)return res.status(400).json({error:'Subject, date and start time are required'});const g=group_id?db.prepare('SELECT * FROM groups_tbl WHERE id=?').get(group_id):null;if(group_id&&!g)return res.status(404).json({error:'Group not found'});if(req.user.role==='teacher'&&g&&g.admin_id!==req.user.id)return res.status(403).json({error:'Only the group admin teacher can start attendance for this group'});const code=randomCode();const expires=new Date(Date.now()+Number(expires_minutes)*60000).toISOString();const r=db.prepare('INSERT INTO attendance_sessions(group_id,subject,session_date,start_time,code,created_by,expires_at) VALUES(?,?,?,?,?,?,?)').run(group_id||null,subject,session_date,start_time,code,req.user.id,expires);if(g)notifyUsers('Attendance session started',`${subject} attendance is open for ${g.name}. Use the attendance code in Attendance.`,'attendance_started','id IN (SELECT user_id FROM memberships WHERE group_id=?)',[g.id]);else notifyUsers('Attendance session started',`${subject} attendance is open. Use the attendance code in Attendance.`,'attendance_started');res.json(db.prepare('SELECT * FROM attendance_sessions WHERE id=?').get(r.lastInsertRowid))});
app.post('/api/attendance/mark',auth,(req,res,next)=>req.user.role!=='student'?res.status(403).json({error:'Only student accounts can mark attendance'}):next(),(req,res)=>{const {code}=req.body||{};const s=db.prepare('SELECT * FROM attendance_sessions WHERE code=?').get((code||'').trim());if(!s)return res.status(404).json({error:'Invalid attendance code'});if(s.expires_at&&new Date(s.expires_at)<new Date())return res.status(400).json({error:'Attendance session expired'});if(s.group_id&&!db.prepare('SELECT 1 FROM memberships WHERE group_id=? AND user_id=?').get(s.group_id,req.user.id))return res.status(403).json({error:'You are not a member of this group'});try{db.prepare('INSERT INTO attendance(session_id,user_id,status) VALUES(?,?,\'present\')').run(s.id,req.user.id)}catch(e){return res.status(409).json({error:'Attendance already marked'})}res.json({ok:true,message:`Attendance marked present for ${s.subject}`})});
app.get('/api/attendance/my',auth,(req,res,next)=>req.user.role==='personal'?res.status(403).json({error:'Attendance is available to student and faculty accounts only'}):next(),(req,res)=>{
 const rows=db.prepare(`SELECT s.id session_id,s.subject,s.session_date,s.start_time,s.code,COALESCE(a.status,CASE WHEN datetime(s.expires_at)<datetime('now') THEN 'absent' ELSE 'pending' END) status,a.marked_at FROM attendance_sessions s LEFT JOIN attendance a ON a.session_id=s.id AND a.user_id=? LEFT JOIN memberships m ON m.group_id=s.group_id AND m.user_id=? WHERE s.group_id IS NULL OR m.user_id IS NOT NULL ORDER BY s.session_date DESC,s.start_time DESC`).all(req.user.id,req.user.id);
 res.json(rows);
});
app.get('/api/attendance/sessions',auth,role('teacher','admin'),(req,res)=>res.json(db.prepare(`SELECT s.*,g.name group_name,(SELECT COUNT(*) FROM attendance a WHERE a.session_id=s.id AND a.status='present') present_count,(SELECT COUNT(*) FROM memberships m WHERE m.group_id=s.group_id) member_count FROM attendance_sessions s LEFT JOIN groups_tbl g ON g.id=s.group_id WHERE s.created_by=? OR ?='admin' ORDER BY s.session_date DESC,s.start_time DESC`).all(req.user.id,req.user.role)));
app.get('/api/attendance/session/:id',auth,role('teacher','admin'),(req,res)=>res.json(db.prepare(`SELECT u.id,u.name,u.email,u.course,u.year,COALESCE(a.status,'absent') status,a.marked_at FROM attendance_sessions s JOIN memberships m ON m.group_id=s.group_id JOIN users u ON u.id=m.user_id LEFT JOIN attendance a ON a.session_id=s.id AND a.user_id=u.id WHERE s.id=? ORDER BY u.name`).all(req.params.id)));
app.get('/api/attendance/report',auth,role('teacher','admin'),(req,res)=>res.json(db.prepare(`SELECT u.id,u.name,u.email,u.course,u.year,COUNT(DISTINCT s.id) total_sessions,COUNT(DISTINCT CASE WHEN a.status='present' THEN s.id END) present_sessions,CASE WHEN COUNT(DISTINCT s.id)=0 THEN 0 ELSE ROUND(COUNT(DISTINCT CASE WHEN a.status='present' THEN s.id END)*100.0/COUNT(DISTINCT s.id),1) END percentage FROM users u LEFT JOIN memberships m ON m.user_id=u.id LEFT JOIN attendance_sessions s ON (s.group_id IS NULL OR s.group_id=m.group_id) LEFT JOIN attendance a ON a.session_id=s.id AND a.user_id=u.id WHERE u.role='student' GROUP BY u.id ORDER BY u.name`).all()));

// Chat
app.get('/api/chats',auth,(req,res)=>res.json(db.prepare(`SELECT u.id,u.name,u.role,u.course,u.year,u.online,u.last_seen,
 (SELECT text FROM messages m WHERE (m.sender_id=? AND m.receiver_id=u.id) OR (m.sender_id=u.id AND m.receiver_id=?) ORDER BY m.id DESC LIMIT 1) last_message,
 (SELECT created_at FROM messages m WHERE (m.sender_id=? AND m.receiver_id=u.id) OR (m.sender_id=u.id AND m.receiver_id=?) ORDER BY m.id DESC LIMIT 1) last_message_at,
 (SELECT COUNT(*) FROM messages m WHERE m.sender_id=u.id AND m.receiver_id=? AND m.seen=0) unread
 FROM users u WHERE u.id<>? AND EXISTS(SELECT 1 FROM connections c WHERE c.status='connected' AND ((c.user_id=? AND c.other_id=u.id) OR (c.user_id=u.id AND c.other_id=?))) ORDER BY CASE WHEN last_message_at IS NULL THEN 1 ELSE 0 END,last_message_at DESC,u.online DESC,u.name`).all(req.user.id,req.user.id,req.user.id,req.user.id,req.user.id,req.user.id,req.user.id,req.user.id)));
app.get('/api/chats/:id/messages',auth,(req,res)=>{const other=Number(req.params.id);if(!connected(req.user.id,other))return res.status(403).json({error:'Accept the connection request before chatting'});db.prepare('UPDATE messages SET seen=1 WHERE sender_id=? AND receiver_id=?').run(other,req.user.id);res.json(db.prepare(`SELECT m.*,s.name sender_name,r.name receiver_name FROM messages m JOIN users s ON s.id=m.sender_id JOIN users r ON r.id=m.receiver_id WHERE (m.sender_id=? AND m.receiver_id=?) OR (m.sender_id=? AND m.receiver_id=?) ORDER BY m.id ASC`).all(req.user.id,other,other,req.user.id))});
app.post('/api/chats/:id/messages',auth,(req,res)=>{const text=(req.body?.text||'').trim();const receiver=Number(req.params.id);if(!text)return res.status(400).json({error:'Message cannot be empty'});if(blocked(req.user.id,receiver))return res.status(403).json({error:'Messaging is unavailable for this user'});if(!connected(req.user.id,receiver))return res.status(403).json({error:'Accept the connection request before chatting'});if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(receiver))return res.status(404).json({error:'User not found'});const r=db.prepare('INSERT INTO messages(sender_id,receiver_id,text) VALUES(?,?,?)').run(req.user.id,receiver,text);const m=db.prepare('SELECT m.*,s.name sender_name,r.name receiver_name FROM messages m JOIN users s ON s.id=m.sender_id JOIN users r ON r.id=m.receiver_id WHERE m.id=?').get(r.lastInsertRowid);io.to('user:'+receiver).emit('message:new',m);res.json(m)});
app.post('/api/chats/:id/seen',auth,(req,res)=>{db.prepare('UPDATE messages SET seen=1 WHERE sender_id=? AND receiver_id=?').run(req.params.id,req.user.id);res.json({ok:true})});

// Notifications
app.get('/api/notifications',auth,(req,res)=>res.json(db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id)));
app.post('/api/notifications/:id/read',auth,(req,res)=>{db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?').run(now(),req.params.id,req.user.id);res.json({ok:true})});
app.post('/api/notifications/read-all',auth,(req,res)=>{db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(now(),req.user.id);res.json({ok:true})});

// Admin / teacher verification
app.get('/api/admin/teachers',auth,role('admin'),(req,res)=>res.json(db.prepare("SELECT id,name,email,course,year,teacher_verified,institution,department,employee_id,qualification,teaching_subjects,verification_document,created_at FROM users WHERE role='teacher' ORDER BY teacher_verified,id DESC").all()));
app.get('/api/admin/audit-logs',auth,role('admin'),(req,res)=>res.json(db.prepare(`SELECT a.*,u.name user_name,u.email user_email FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200`).all()));
app.get('/api/admin/post-reports',auth,role('admin'),(req,res)=>res.json(db.prepare(`SELECT r.*,p.text post_text,p.image_data,u.name reporter_name,o.name owner_name FROM post_reports r JOIN posts p ON p.id=r.post_id JOIN users u ON u.id=r.reporter_id JOIN users o ON o.id=p.user_id WHERE r.reviewed_at IS NULL ORDER BY r.id DESC`).all()));
app.post('/api/admin/post-reports/:id/resolve',auth,role('admin'),(req,res)=>{const result=db.prepare('UPDATE post_reports SET reviewed_at=? WHERE id=? AND reviewed_at IS NULL').run(now(),req.params.id);if(!result.changes)return res.status(404).json({error:'Report not found'});res.json({ok:true})});
app.post('/api/admin/teachers/:id/verify',auth,role('admin'),(req,res)=>{const u=db.prepare("SELECT * FROM users WHERE id=? AND role='teacher'").get(req.params.id);if(!u)return res.status(404).json({error:'Teacher not found'});const required=['institution','department','employee_id','qualification','teaching_subjects','verification_document'];if(required.some(k=>!String(u[k]||'').trim()))return res.status(400).json({error:'Teacher verification details are incomplete. Ask the teacher to submit all required proof details.'});db.prepare('UPDATE users SET teacher_verified=1 WHERE id=?').run(u.id);audit(req,'teacher_verified','user',u.id,`teacher=${u.email}`);notifyUser(u.id,'Teacher account verified','Your CAMPus teacher account has been verified by an administrator.','teacher_verified');res.json({ok:true})});
app.post('/api/admin/teachers/:id/revoke',auth,role('admin'),(req,res)=>{const result=db.prepare('UPDATE users SET teacher_verified=0 WHERE id=? AND role=\'teacher\'').run(req.params.id);if(!result.changes)return res.status(404).json({error:'Teacher not found'});audit(req,'teacher_verification_revoked','user',Number(req.params.id));res.json({ok:true})});

// Group email via Gmail SMTP. Uses configured Gmail account but displays teacher/admin name.
app.post('/api/groups/:id/email',auth,role('teacher','admin'),async(req,res)=>{
 const g=db.prepare('SELECT * FROM groups_tbl WHERE id=?').get(req.params.id);if(!g)return res.status(404).json({error:'Group not found'});
 if(req.user.role!=='admin'&&g.admin_id!==req.user.id)return res.status(403).json({error:'Only group admin can send group email'});
 const {subject,body}=req.body||{};if(!subject||!body)return res.status(400).json({error:'Subject and message are required'});
 const sender=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);const members=db.prepare("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.group_id=? AND u.role='student' AND u.email IS NOT NULL").all(g.id);
 if(!process.env.GMAIL_USER||!process.env.GMAIL_APP_PASSWORD)return res.status(503).json({error:'Gmail is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD in .env.'});
 try{
  const transporter=nodemailer.createTransport({service:'gmail',auth:{user:process.env.GMAIL_USER,pass:process.env.GMAIL_APP_PASSWORD}});
  await transporter.sendMail({from:`"${sender.name}" <${process.env.GMAIL_USER}>`,to:members.map(x=>x.email).join(','),subject,text:body});
  db.prepare('INSERT INTO email_logs(group_id,sender_id,subject,body,sent_count) VALUES(?,?,?,?,?)').run(g.id,sender.id,subject,body,members.length);
  res.json({ok:true,sent_count:members.length,from_name:sender.name});
 }catch(e){res.status(500).json({error:'Email sending failed. Check Gmail credentials/app password.'})}
});

// Socket.IO presence + authenticated user rooms
attachSocket(io,{db,secret:SECRET,now});

// Notify all college accounts shortly before a scheduled campus event or class.
setInterval(()=>{
  const d=new Date();
  const events=db.prepare("SELECT * FROM events WHERE date>=date('now','-1 day')").all();
  for(const event of events){
    if(!event.time) continue;
    const startsAt=new Date(`${event.date}T${event.time}:00+05:30`);
    const delta=Math.round((startsAt-d)/60000);
    if(delta<0||delta>10) continue;
    notifyUsers('Event starting soon',`${event.title} starts at ${event.time}${event.venue?' in '+event.venue:''}.`,'event_reminder',`role IN ('student','teacher','admin') AND id NOT IN (SELECT user_id FROM notifications WHERE type='event_reminder' AND body LIKE ? AND created_at>datetime('now','-20 minutes'))`,[`%${event.title}%`]);
  }
  const day=new Intl.DateTimeFormat('en-US',{weekday:'long',timeZone:'Asia/Kolkata'}).format(d);
  const hm=new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Kolkata'}).format(d);
  const [hh,mm]=hm.split(':').map(Number);
  const minutes=hh*60+mm;
  const slots=db.prepare('SELECT * FROM timetable WHERE day=?').all(day);
  for(const slot of slots){
    const [sh,sm]=slot.start_time.split(':').map(Number);
    const delta=sh*60+sm-minutes;
    if(delta<0||delta>10) continue;
    const students=db.prepare('SELECT id FROM users WHERE course=? AND year=?').all(slot.course,slot.year);
    for(const u of students){
      const exists=db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND type='timetable_reminder' AND body LIKE ? AND created_at>datetime('now','-20 minutes')").get(u.id,`%${slot.subject}%`);
      if(!exists){
        const body=`Your ${slot.course} class ${slot.subject} is starting soon at ${slot.start_time}${slot.room?' in '+slot.room:''}.`;
        db.prepare("INSERT INTO notifications(user_id,title,body,type) VALUES(?,?,?,'timetable_reminder')").run(u.id,'Class starting soon',body);
        io.to('user:'+u.id).emit('notification:new',{title:'Class starting soon',body,type:'timetable_reminder'});
        if(mailer){
          const recipient=db.prepare('SELECT email,name FROM users WHERE id=?').get(u.id);
          if(recipient?.email){
            mailer.sendMail({
              from:`"${slot.teacher||'CAMPus Admin'} via CAMPus" <${process.env.GMAIL_USER}>`,
              replyTo:process.env.GMAIL_USER,
              to:recipient.email,
              subject:`Class reminder: ${slot.subject} at ${slot.start_time}`,
              text:`Hi ${recipient.name},\n\nYour ${slot.course} class "${slot.subject}" starts at ${slot.start_time}${slot.room?' in '+slot.room:''}.`+
                `${slot.teacher?' Your teacher is '+slot.teacher+'.':''}\n\nThis is an automatic CAMPus reminder.`
            }).catch(error=>console.error(`Reminder email failed for user ${u.id}:`,error.message));
          }
        }else if(!globalThis.__campusReminderEmailWarning){
          globalThis.__campusReminderEmailWarning=true;
          console.warn('Reminder email skipped: configure GMAIL_USER and GMAIL_APP_PASSWORD in .env.');
        }
      }
    }
  }
},60000);

app.use((req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

server.on('error',error=>{
  if(error.code==='EADDRINUSE'){
    console.error(`Port ${PORT} is already in use. Stop the existing CAMPus server or set a different PORT.`);
    return;
  }
  console.error('CAMPus server error:',error);
});

server.listen(PORT,()=>console.log(`CAMPus running at http://localhost:${PORT}`));
