// CORA Lite community API. Never commit invitation codes or passwords.
// Required Cloudflare Secrets: ADMIN_INVITE_CODE, AUTHOR_INVITE_CODE.
// Existing D1 binding: DB. Requires the four previously created tables.
const origins = new Set([
  "https://gravitysedgeai.github.io",
  "https://raw.githack.com",
  "https://rawcdn.githack.com"
]);
const encoder = new TextEncoder();
function response(data,status=200,origin=""){
  const h = new Headers({"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",
    "X-Content-Type-Options":"nosniff","Vary":"Origin"});
  if(origins.has(origin)){
    h.set("Access-Control-Allow-Origin",origin);
    h.set("Access-Control-Allow-Headers","Authorization, Content-Type");
    h.set("Access-Control-Allow-Methods","GET, POST, DELETE, OPTIONS");
  }
  return new Response(JSON.stringify(data),{status,headers:h});
}
function error(msg,status=400){throw Object.assign(new Error(msg),{status});}
function value(s,max){return typeof s==="string"?s.trim().slice(0,max+1):"";}
function hex(a){return Array.from(a,b=>b.toString(16).padStart(2,"0")).join("");}
function unhex(s){return new Uint8Array(s.match(/.{2}/g).map(x=>parseInt(x,16)));}
function random(n){return hex(crypto.getRandomValues(new Uint8Array(n)));}
function equal(a,b){if(typeof a!=="string"||typeof b!=="string"||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
async function hash(s){return hex(new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(s))));}
async function passHash(password,salt){
  const key=await crypto.subtle.importKey("raw",encoder.encode(password),"PBKDF2",false,["deriveBits"]);
  return hex(new Uint8Array(await crypto.subtle.deriveBits(
    {name:"PBKDF2",salt:unhex(salt),iterations:100000,hash:"SHA-256"},key,256)));
}
async function body(request){
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type")||""))error("Expected JSON",415);
  if(Number(request.headers.get("Content-Length")||0)>48000)error("Request too large",413);
  const raw=await request.text();if(encoder.encode(raw).length>48000)error("Request too large",413);
  try{const v=JSON.parse(raw);if(v&&typeof v==="object"&&!Array.isArray(v))return v;}catch(_){}
  error("Invalid JSON object");
}
function publicAuthor(a){return {id:a.id,username:a.username,displayName:a.display_name,role:a.role};}
async function session(env,a){
  const token=random(32),expiresAt=new Date(Date.now()+7*86400000).toISOString();
  await env.DB.prepare("INSERT INTO author_sessions(token_hash,author_id,expires_at) VALUES(?,?,?)")
    .bind(await hash(token),a.id,expiresAt).run();
  return {token,expiresAt,author:publicAuthor(a)};
}
async function user(env,req,required=false){
  const match=(req.headers.get("Authorization")||"").match(/^Bearer ([a-f0-9]{64})$/i);
  if(!match){if(required)error("Please sign in",401);return null;}
  const row=await env.DB.prepare("SELECT a.id,a.username,a.display_name,a.role FROM author_sessions s JOIN authors a ON s.author_id=a.id WHERE s.token_hash=? AND s.expires_at>?")
    .bind(await hash(match[1]),new Date().toISOString()).first();
  if(!row&&required)error("Session expired",401);
  return row;
}
function admin(a){if(a.role!=="admin")error("Admin access required",403);}
function media(urlText){
  if(!urlText)return {url:null,provider:"other"};
  if(urlText.length>2048)error("Audio link too long",422);
  let u;try{u=new URL(urlText);}catch(_){error("Invalid audio URL",422);}
  if(u.protocol!=="https:"||u.username||u.password)error("Use a public HTTPS URL",422);
  const h=u.hostname.toLowerCase(),is=x=>h===x||h.endsWith("."+x);
  const provider=is("soundcloud.com")?"soundcloud":is("suno.com")?"suno":
    (is("youtube.com")||is("youtu.be"))?"youtube":"other";
  return {url:u.toString(),provider};
}
const fields="s.id,s.author_id,s.title,s.audio_url,s.audio_provider,s.lyrics,s.status,s.created_at,s.published_at,a.username,a.display_name,(SELECT COUNT(*) FROM song_likes l WHERE l.song_id=s.id) likes";
function out(s){return {id:s.id,title:s.title,lyrics:s.lyrics,audioUrl:s.audio_url,audioProvider:s.audio_provider,
  status:s.status,createdAt:s.created_at,publishedAt:s.published_at,likes:Number(s.likes)||0,
  author:{username:s.username,displayName:s.display_name}};}
async function song(env,id){return env.DB.prepare("SELECT "+fields+" FROM songs s JOIN authors a ON s.author_id=a.id WHERE s.id=?").bind(id).first();}
// Optional email notifications using Resend (https://resend.com).
// RESEND_API_KEY and NOTIFY_EMAIL are Cloudflare Secrets.
// NOTIFY_FROM is a verified sender such as "Songwriting Studio <notify@yourdomain.com>".
// Email delivery failures are logged but never block saving a song.
async function notifyPendingSubmission(env, submission) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL || !env.NOTIFY_FROM) return;
  const title = String(submission.title || "Untitled").replace(/[\r\n\t]+/g, " ").slice(0, 150);
  const handle = String(submission.username || "Songwriter").replace(/[\r\n\t]+/g, " ").slice(0, 32);
  const reviewPage = "https://raw.githack.com/gravitysedgeai/gravitysedge-site/feature/songwriting-studio-mvp/the_art_of_songwriting/community.html";
  const mail = {
    from: env.NOTIFY_FROM,
    to: [env.NOTIFY_EMAIL],
    subject: "Song awaiting approval: " + title,
    text: "A song was submitted to The Art of Songwriting.\n\n" +
      "Title: " + title + "\n" +
      "Songwriter: @" + handle + "\n" +
      "Status: Pending approval\n\n" +
      "Review the submission:\n" + reviewPage + "\n\n" +
      "Sign in as an administrator to approve or hide it.\n" +
      "This is an automated notification; please do not reply."
  };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.RESEND_API_KEY,
        "Content-Type": "application/json",
        "Idempotency-Key": "song-notification/" + submission.id },
      body: JSON.stringify(mail)
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error("Notification email failed; HTTP " + res.status + ": " + detail.slice(0, 400));
    }
  } catch (err) {
    console.error("Notification email request failed:", String(err));
  }
}
async function route(req,env,url,ctx){
  const p=url.pathname.replace(/\/+$/,"")||"/",m=req.method;
  if(p==="/health"&&m==="GET"){
    const tables=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('authors','author_sessions','songs','song_likes')").all();
    const found=new Set((tables.results||[]).map(r=>r.name));
    const missing=["authors","author_sessions","songs","song_likes"].filter(t=>!found.has(t));
    return [{ok:missing.length===0,service:"songwriting-community-api",tablesFound:4-missing.length,
      missingTables:missing,publishingReady:!!(env.ADMIN_INVITE_CODE&&env.AUTHOR_INVITE_CODE)},missing.length?503:200];
  }
  if(p==="/auth/register"&&m==="POST"){
    if(!env.ADMIN_INVITE_CODE||!env.AUTHOR_INVITE_CODE||
      env.ADMIN_INVITE_CODE.length<12||env.AUTHOR_INVITE_CODE.length<12||
      env.ADMIN_INVITE_CODE===env.AUTHOR_INVITE_CODE)error("Invitation setup incomplete",503);
    const b=await body(req),username=value(b.username,32).toLowerCase(),name=value(b.displayName,80);
    if(!/^[a-z0-9_]{3,32}$/.test(username)||!name||name.length>80)error("Invalid username or display name",422);
    if(typeof b.password!=="string"||b.password.length<12||b.password.length>128)error("Password must contain 12–128 characters",422);
    let role;
    if(equal(b.inviteCode,env.ADMIN_INVITE_CODE)){
      const existing=await env.DB.prepare("SELECT COUNT(*) n FROM authors WHERE role='admin'").first();
      if(existing.n>0)error("Admin account already created",403);
      role="admin";
    }else if(equal(b.inviteCode,env.AUTHOR_INVITE_CODE))role="author";
    else error("Invalid invitation code",403);
    const id=crypto.randomUUID(),salt=random(16),pwd=await passHash(b.password,salt);
    try{await env.DB.prepare("INSERT INTO authors(id,username,display_name,password_hash,password_salt,role) VALUES(?,?,?,?,?,?)")
      .bind(id,username,name,pwd,salt,role).run();}
    catch(e){if(/UNIQUE/i.test(String(e)))error("Username already in use",409);throw e;}
    return [await session(env,{id,username,display_name:name,role}),201];
  }
  if(p==="/auth/login"&&m==="POST"){
    const b=await body(req),username=value(b.username,32).toLowerCase();
    if(!/^[a-z0-9_]{3,32}$/.test(username)||typeof b.password!=="string"||b.password.length>128)error("Incorrect credentials",401);
    const a=await env.DB.prepare("SELECT * FROM authors WHERE username=?").bind(username).first();
    if(!a||!equal(await passHash(b.password,a.password_salt),a.password_hash))error("Incorrect credentials",401);
    return [await session(env,a),200];
  }
  if(p==="/auth/me"&&m==="GET")return [{author:publicAuthor(await user(env,req,true))},200];
  if(p==="/auth/logout"&&m==="POST"){
    await user(env,req,true);
    await env.DB.prepare("DELETE FROM author_sessions WHERE token_hash=?")
      .bind(await hash(req.headers.get("Authorization").slice(7))).run();
    return [{ok:true},200];
  }
  if(p==="/songs"&&m==="GET"){
    const limit=Math.min(30,Math.max(1,parseInt(url.searchParams.get("limit")||"20",10)||20));
    const offset=Math.min(2000,Math.max(0,parseInt(url.searchParams.get("offset")||"0",10)||0));
    const rows=await env.DB.prepare("SELECT "+fields+" FROM songs s JOIN authors a ON s.author_id=a.id WHERE s.status='published' ORDER BY s.published_at DESC LIMIT ? OFFSET ?")
      .bind(limit,offset).all();
    return [{songs:(rows.results||[]).map(out),limit,offset},200];
  }
  if(p==="/songs"&&m==="POST"){
    const a=await user(env,req,true),b=await body(req),title=value(b.title,150),lyrics=typeof b.lyrics==="string"?b.lyrics:"";
    if(!title||title.length>150)error("Song title required (max 150 characters)",422);
    if(lyrics.length>40000)error("Lyrics too long",422);
    const audio=media(value(b.audioUrl,2100));
    if(!lyrics.trim()&&!audio.url)error("Lyrics or an audio link required",422);
    const id=crypto.randomUUID();
    // Style prompts are private and never saved to this public database.
    await env.DB.prepare("INSERT INTO songs(id,author_id,title,audio_url,audio_provider,lyrics,status) VALUES(?,?,?,?,?,?,'pending')")
      .bind(id,a.id,title,audio.url,audio.provider,b.shareLyrics===false?null:(lyrics||null)).run();
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(notifyPendingSubmission(env, {id, title, username:a.username}));
    }
    return [{id,status:"pending",message:"Submitted for approval"},201];
  }
  if(p==="/me/songs"&&m==="GET"){
    const a=await user(env,req,true);
    const rows=await env.DB.prepare("SELECT "+fields+" FROM songs s JOIN authors a ON s.author_id=a.id WHERE s.author_id=? ORDER BY s.created_at DESC LIMIT 100").bind(a.id).all();
    return [{songs:(rows.results||[]).map(out)},200];
  }
  if(p==="/admin/pending"&&m==="GET"){
    admin(await user(env,req,true));
    const rows=await env.DB.prepare("SELECT "+fields+" FROM songs s JOIN authors a ON s.author_id=a.id WHERE s.status='pending' ORDER BY s.created_at LIMIT 100").all();
    return [{songs:(rows.results||[]).map(out)},200];
  }
  const pattern="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
  const details=p.match(new RegExp("^/songs/"+pattern+"$","i"));
  const moderation=p.match(new RegExp("^/songs/"+pattern+"/moderate$","i"));
  const liked=p.match(new RegExp("^/songs/"+pattern+"/like$","i"));
  if(moderation&&m==="POST"){
    admin(await user(env,req,true));const b=await body(req);
    if(!["published","hidden"].includes(b.status))error("Invalid status",422);
    if(!await song(env,moderation[1]))error("Song not found",404);
    await env.DB.prepare("UPDATE songs SET status=?,published_at=CASE WHEN ?='published' THEN COALESCE(published_at,CURRENT_TIMESTAMP) ELSE published_at END,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(b.status,b.status,moderation[1]).run();
    return [{ok:true,status:b.status},200];
  }
  if(details&&m==="GET"){
    const s=await song(env,details[1]);
    const a=s&&s.status!=="published"?await user(env,req):null;
    if(!s||(s.status!=="published"&&(!a||(a.id!==s.author_id&&a.role!=="admin"))))error("Song not found",404);
    return [{song:out(s)},200];
  }
  if(details&&m==="DELETE"){
    const a=await user(env,req,true),s=await song(env,details[1]);
    if(!s||(s.author_id!==a.id&&a.role!=="admin"))error("Song not found",404);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM song_likes WHERE song_id=?").bind(details[1]),
      env.DB.prepare("DELETE FROM songs WHERE id=?").bind(details[1])
    ]);
    return [{ok:true},200];
  }
  if(liked&&(m==="POST"||m==="DELETE")){
    const a=await user(env,req,true),s=await song(env,liked[1]);
    if(!s||s.status!=="published")error("Song not found",404);
    const key="author:"+a.id;
    if(m==="POST")await env.DB.prepare("INSERT OR IGNORE INTO song_likes(song_id,visitor_key) VALUES(?,?)").bind(liked[1],key).run();
    else await env.DB.prepare("DELETE FROM song_likes WHERE song_id=? AND visitor_key=?").bind(liked[1],key).run();
    const c=await env.DB.prepare("SELECT COUNT(*) likes FROM song_likes WHERE song_id=?").bind(liked[1]).first();
    return [{ok:true,likes:Number(c.likes)||0},200];
  }
  error("Route not found",404);
}
export default {
  async fetch(req,env,ctx){
    const origin=req.headers.get("Origin")||"";
    if(origin&&!origins.has(origin))return response({error:"Origin not allowed"},403);
    if(req.method==="OPTIONS")return new Response(null,{status:204,headers:new Headers({
      "Access-Control-Allow-Origin":origins.has(origin)?origin:"null",
      "Access-Control-Allow-Methods":"GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":"Authorization, Content-Type",
      "Vary":"Origin"
    })});
    if(!env.DB)return response({error:"Missing D1 binding DB"},503,origin);
    try{const [data,status]=await route(req,env,new URL(req.url),ctx);return response(data,status,origin);}
    catch(e){const status=e.status||500;if(status===500)console.error(String(e));return response({error:status===500?"Server error":e.message},status,origin);}
  }
};
