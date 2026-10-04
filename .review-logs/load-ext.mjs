import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DIST = resolve("dist-chrome");
const PORT = 9339;
const profile = mkdtempSync(join(tmpdir(), "ptd-load-"));
const chrome = spawn(CHROME, ["--headless=new","--disable-gpu","--no-sandbox","--no-first-run",`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,"about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));
try {
  let ver;
  for (let i=0;i<60;i++){ try{ const r=await fetch(`http://127.0.0.1:${PORT}/json/version`); if(r.ok){ver=await r.json();break;} }catch{} await sleep(300); }
  console.log("browser ws:", ver.webSocketDebuggerUrl);
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  let id=0; const pending=new Map();
  ws.onmessage=(ev)=>{const m=JSON.parse(ev.data); if(m.id&&pending.has(m.id)){const{resolve:r,reject:j}=pending.get(m.id);pending.delete(m.id);m.error?j(new Error(JSON.stringify(m.error))):r(m.result);}};
  const send=(method,params={})=>new Promise((r,j)=>{const i=++id;pending.set(i,{resolve:r,reject:j});ws.send(JSON.stringify({id:i,method,params}));});
  const res = await send("Extensions.loadUnpacked", { path: DIST });
  console.log("loadUnpacked:", JSON.stringify(res));
  await sleep(3000);
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  console.log("targets:", targets.map(t=>`${t.type} ${t.url}`).join("\n  "));
  ws.close();
} catch (e) { console.log("ERR", e.message); } finally { chrome.kill("SIGKILL"); }
