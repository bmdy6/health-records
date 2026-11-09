// Loopback-only development adapter, not a production WebDAV server.
import { openSync, closeSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rename, lstat, rm, realpath } from 'node:fs/promises';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
const etag = value => '"' + hash(value) + '"';
const safeUser = /^[a-zA-Z0-9_-]+$/;
const limit = 4 * 1024 * 1024;
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.json':'application/json' };
async function body(req, max=limit) {
 const chunks=[];let bytes=0;
 for await (const chunk of req) { bytes+=chunk.length;if(bytes>max){const e=new Error('Too large');e.status=413;throw e;}chunks.push(chunk); }
 return Buffer.concat(chunks);
}
async function bytes(file) { try { const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Unsafe data path');return await readFile(file); } catch(e){if(e.code==='ENOENT')return null;throw e;} }
export async function createLocalServer({dataDir, staticDir=fileURLToPath(new URL('../dist',import.meta.url)),username='demo',password='demo-only',ai={},fetchImpl=fetch}={}) {
 if(!dataDir||!safeUser.test(username)||username==='shared-viewer'||!password)throw new Error('Invalid local development configuration');
 const requestedRoot=resolve(dataDir);await mkdir(requestedRoot,{recursive:true,mode:0o700});
 if((await lstat(requestedRoot)).isSymbolicLink())throw new Error('Symlink data directory rejected');
 const root=await realpath(requestedRoot);
 for(const dir of ['bills',`personal`, `personal/${username}`, `personal/${username}/body`]){
  const path=join(root,dir);await mkdir(path,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Unsafe data directory');
 }
 const authHash=hash('Basic '+Buffer.from(username+':'+password).toString('base64'));
 let queue=Promise.resolve();
 const exclusive=fn=>{const task=queue.then(fn);queue=task.catch(()=>{});return task;};
 const server=createServer(async(req,res)=>{
  const send=(status,value='',type='text/plain; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(value);};
  try {
   const address=server.address();const expected=`127.0.0.1:${address.port}`;
   if(req.headers.host!==expected)return send(421,'Unexpected host');
   const origin=req.headers.origin;
   if(origin && ![`http://${expected}`,'http://127.0.0.1:5173'].includes(origin))return send(403,'Origin rejected');
   if(origin)res.setHeader('Access-Control-Allow-Origin',origin);
   res.setHeader('Vary','Origin');res.setHeader('Access-Control-Expose-Headers','ETag');
   const url=new URL(req.url,`http://${expected}`);
   if(req.method==='OPTIONS'){
    res.setHeader('Access-Control-Allow-Methods','GET,HEAD,PUT,MKCOL,PROPFIND,OPTIONS,POST');
    res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type,If-Match,If-None-Match,Depth');return send(204);
   }
   if(url.pathname==='/api/ai/chat/completions'){
    if(req.method!=='POST')return send(405);
    if(!req.headers['content-type']?.startsWith('application/json'))return send(415);
    if(!ai.baseUrl||!ai.key||!ai.textModel||!ai.visionModel)return send(503,JSON.stringify({error:{message:'尚未配置识别服务；请设置运行时 AI 端点、密钥和模型。'}}),'application/json');
    let input;try{input=JSON.parse(await body(req));}catch(e){return send(e.status??400,'Invalid request');}
    if(!['text','vision'].includes(input.model)||!Array.isArray(input.messages)||input.messages.length>20)return send(400,'Invalid request');
    const upstream=new URL(ai.baseUrl.replace(/\/$/,'')+'/chat/completions');
    if(upstream.protocol!=='https:' && !(upstream.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(upstream.hostname)))return send(503,'Invalid recognition endpoint');
    const ac=new AbortController();const timer=setTimeout(()=>ac.abort(),45000);const close=()=>{if(!res.writableEnded)ac.abort();};res.on('close',close);
    try {
     const response=await fetchImpl(upstream.href,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${ai.key}`},signal:ac.signal,
      body:JSON.stringify({model:input.model==='vision'?ai.visionModel:ai.textModel,messages:input.messages,temperature:0,max_tokens:Math.min(4000,Math.max(1,Number(input.max_tokens)||2000)),stream:false})});
     if(!response.ok)return send(502,JSON.stringify({error:{message:'识别服务返回错误，请检查配置后重试。'}}),'application/json');
     // Buffer with a bound; do not forward upstream headers or arbitrary error bodies.
     let total=0;const chunks=[];for await(const c of response.body){total+=c.length;if(total>limit){ac.abort();throw new Error('Response too large');}chunks.push(Buffer.from(c));}
     const raw=Buffer.concat(chunks).toString('utf8');const value=JSON.parse(raw);
     const content=value?.choices?.[0]?.message?.content;if(typeof content!=='string')throw new Error('Invalid provider response');
     return send(200,JSON.stringify({choices:[{message:{content}}]}),'application/json');
    }catch{if(!res.destroyed)return send(502,JSON.stringify({error:{message:'识别未完成，请重试；记录尚未保存。'}}),'application/json');}
    finally{clearTimeout(timer);res.removeListener('close',close);}
   }
   if(url.pathname.startsWith('/dav/')){
    if(!timingSafeEqual(Buffer.from(hash(req.headers.authorization??'')),Buffer.from(authHash))){res.setHeader('WWW-Authenticate','Basic realm="Health Records local development"');return send(401,'Authentication required');}
    let relative;try{relative=decodeURIComponent(url.pathname.slice(5));}catch{return send(404);}
    const validFiles=[`bills/_settings.json`,...['profile','weights','food','workouts','health-goals'].map(n=>`personal/${username}/body/${n}.json`)];
    const validDirs=['','bills','personal',`personal/${username}`,`personal/${username}/body`];
    if(req.method==='MKCOL'&&validDirs.includes(relative.replace(/\/$/,'')))return send(405);
    if(req.method==='PROPFIND'&&validDirs.includes(relative.replace(/\/$/,'')))return send(207,`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${url.pathname}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,'application/xml');
    if(!validFiles.includes(relative))return send(404);
    const file=join(root,relative);
    if(['GET','HEAD'].includes(req.method)){const current=await bytes(file);if(current===null)return send(404);res.setHeader('ETag',etag(current));return send(200,req.method==='HEAD'?'':current,'application/json');}
    if(req.method!=='PUT')return send(405);
    const content=await body(req);try{JSON.parse(content);}catch{return send(400,'Expected JSON');}
    await exclusive(async()=>{
     const current=await bytes(file),match=req.headers['if-match'],none=req.headers['if-none-match'];
     if((match&&none)||(match&&(current===null||match!==etag(current)))||(none&&(none!=='*'||current!==null)))return send(412,'Version conflict');
     // Profile is legacy single-owner configuration; record files always require CAS.
     if(!match&&!none&&!relative.endsWith('/profile.json')&&relative!=='bills/_settings.json')return send(428,'Conditional write required');
     const temp=file+'.'+randomUUID()+'.tmp';
     try{await writeFile(temp,content,{flag:'wx',mode:0o600});await rename(temp,file);}finally{await rm(temp,{force:true});}
     res.setHeader('ETag',etag(content));send(current===null?201:204);
    });return;
   }
   if(!['GET','HEAD'].includes(req.method))return send(405);
   const decoded=decodeURIComponent(url.pathname);const staticRoot=resolve(staticDir);
   const path=resolve(staticRoot,'.'+decoded);if(path!==staticRoot&&!path.startsWith(staticRoot+'/'))return send(404);
   let content=await bytes(path).catch(()=>null);let type=mime[extname(path)]??'application/octet-stream';
   if(content===null&&!extname(decoded)){content=await bytes(join(staticRoot,'index.html'));type=mime['.html'];}
   if(content===null)return send(404,'Build the browser with npm run build first.');return send(200,req.method==='HEAD'?'':content,type);
  }catch(e){if(!res.headersSent)send(e.status??500,'Local operation failed');else res.destroy();}
 });
 const lockPath=join(root,'.writer.lock');const lock=openSync(lockPath,'wx',0o600);writeFileSync(lock,String(process.pid));
 server.once('close',()=>{closeSync(lock);unlinkSync(lockPath);});
 return server;
}
async function main(){
 const port=Number(process.env.HEALTH_LOCAL_PORT??18740);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid port');
 const server=await createLocalServer({dataDir:process.env.HEALTH_LOCAL_DATA_DIR??'.local-data',username:process.env.HEALTH_LOCAL_USER??'demo',password:process.env.HEALTH_LOCAL_PASSWORD??'demo-only',
  ai:{baseUrl:process.env.HEALTH_AI_BASE_URL,key:process.env.HEALTH_AI_KEY,textModel:process.env.HEALTH_AI_TEXT_MODEL,visionModel:process.env.HEALTH_AI_VISION_MODEL}});
 server.listen(port,'127.0.0.1',()=>console.log(`Health Records local development: http://127.0.0.1:${port}`));
 server.on('error',()=>{console.error('Local listener failed; check HEALTH_LOCAL_PORT and whether the port is already occupied.');process.exitCode=1;server.close(()=>{});});
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close());
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.code==='EEXIST'?'Local data directory is locked. Confirm no process is using it; see README lock recovery.':'Invalid local runtime configuration; check data directory and port.');process.exitCode=1;});
