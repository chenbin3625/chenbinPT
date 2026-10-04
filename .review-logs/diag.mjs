import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DIST = resolve(process.argv[2] ?? "dist-chrome");
const HEADFUL = process.argv[3] === "headful";
const PORT = 9338;
const profile = mkdtempSync(join(tmpdir(), "ptd-diag-"));
const args = ["--disable-features=DisableLoadExtensionCommandLineSwitch","--no-first-run","--no-default-browser-check",`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,`--disable-extensions-except=${DIST}`,`--load-extension=${DIST}`,"--window-size=1200,800"];
if (!HEADFUL) args.unshift("--headless=new","--disable-gpu","--no-sandbox","--disable-features=DisableLoadExtensionCommandLineSwitch");
const chrome = spawn(CHROME, args, { stdio: "ignore" });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
try {
  for (let i=0;i<60;i++){ try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch {} await sleep(300); }
  let targets = [];
  for (let i=0;i<60;i++){ targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.some(t=>t.type==="service_worker")) break; await sleep(300); }
  console.log("TARGETS:", targets.map(t=>`${t.type} ${t.url}`).join("\n  "));
  const sw = targets.find(t=>t.type==="service_worker");
  if (!sw) { console.log("no sw"); process.exit(0); }
  const id = new URL(sw.url).host;
  const url = `chrome-extension://${id}/src/entries/options/index.html`;
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`,{method:"PUT"})).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  let id2=0; const pending=new Map();
  const logs=[];
  ws.onmessage=(ev)=>{const m=JSON.parse(ev.data); if(m.id&&pending.has(m.id)){const{resolve,reject}=pending.get(m.id);pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);} else if(m.method==="Runtime.consoleAPICalled"){logs.push("console:"+m.params.type+" "+m.params.args.map(a=>a.value??a.description??a.type).join(" ").slice(0,300));} else if(m.method==="Runtime.exceptionThrown"){logs.push("EXC:"+(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text).slice(0,600));} else if(m.method==="Log.entryAdded"){logs.push("log:"+m.params.entry.level+" "+m.params.entry.text.slice(0,300));}};
  const send=(method,params={})=>new Promise((res,rej)=>{const i=++id2;pending.set(i,{resolve:res,reject:rej});ws.send(JSON.stringify({id:i,method,params}));});
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
  await send("Page.navigate",{url});
  await sleep(6000);
  const ev = await send("Runtime.evaluate",{expression:`JSON.stringify({href:location.href, title:document.title, err:document.querySelector("#error-code, .error-code")?.textContent||document.body.innerText.slice(0,300), html:document.documentElement.outerHTML.slice(0,600)})`,returnByValue:true});
  console.log("PAGE:", ev.result.value);
  console.log("LOGS:\n"+logs.slice(0,40).join("\n"));
  ws.close();
} finally { chrome.kill("SIGKILL"); }
