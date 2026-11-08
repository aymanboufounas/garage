import { makeApp } from './app.mjs';
import { resolve } from 'node:path';
const port=Number(process.env.PORT||3000);
const app=makeApp({production:process.env.NODE_ENV==='production',demo:process.env.GARAGESHARE_DEMO==='1',origin:process.env.APP_ORIGIN||`http://localhost:${port}`,trustedProxy:process.env.TRUST_PROXY_IP||'',database:resolve(process.env.DATA_DIR||'data','garageshare.sqlite'),
 google:{clientId:process.env.GOOGLE_CLIENT_ID,clientSecret:process.env.GOOGLE_CLIENT_SECRET,
  androidCert:process.env.ANDROID_APP_SHA256,previewCert:process.env.ANDROID_PREVIEW_SHA256}});
app.server.listen(port,process.env.HOST||'127.0.0.1',()=>console.log(`GarageShare ${process.env.GARAGESHARE_DEMO==='1'?'preview':'server'} ready at ${app.origin}`));
const clean=setInterval(()=>{
 const now=Date.now();
 app.db.prepare('DELETE FROM sessions WHERE expires_at<? OR last_seen<?').run(now,now-30*60000);
 app.db.prepare('DELETE FROM google_attempts WHERE expires_at<?').run(now);
 app.db.prepare('DELETE FROM rate_limits WHERE resets_at<?').run(now);
 app.db.prepare('DELETE FROM audit WHERE created_at<?').run(now-90*86400000);
},60000).unref();
function stop(){clearInterval(clean);app.server.close(()=>{app.db.close();process.exit(0);});}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
