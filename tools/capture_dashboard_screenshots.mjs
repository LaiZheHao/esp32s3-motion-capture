import fs from "node:fs/promises";
import path from "node:path";

const endpoint=process.argv[2]||"http://127.0.0.1:9228";
const pageUrl=process.argv[3]||"http://127.0.0.1:8000/";
const output=path.resolve(process.argv[4]||"docs/ui/reviews");
const viewports=[
  {name:"dashboard-v2-1920x1080.png",route:"dashboard",width:1920,height:1080},
  {name:"dashboard-v2-1366x768.png",route:"dashboard",width:1366,height:768},
  {name:"dashboard-v2-430x932.png",route:"dashboard",width:430,height:932},
  {name:"calibration-v2-1920x1080.png",route:"calibration",width:1920,height:1080},
  {name:"calibration-v2-1366x768.png",route:"calibration",step:2,width:1366,height:768},
  {name:"direction-v2-1366x768.png",route:"calibration",step:3,width:1366,height:768},
  {name:"records-v2-1920x1080.png",route:"records",width:1920,height:1080},
  {name:"replay-v2-1920x1080.png",route:"replay",width:1920,height:1080},
  {name:"replay-v5-1366x768.png",route:"replay",width:1366,height:768},
  {name:"mannequin-v5-front.png",route:"calibration",modelOnly:true,width:1920,height:1080},
  {name:"mannequin-v5-oblique.png",route:"calibration",modelOnly:true,drag:90,width:1920,height:1080},
].filter(item=>!process.argv[5]||item.name.includes(process.argv[5]));

const target=await fetch(`${endpoint}/json/new?${encodeURIComponent(pageUrl)}`,{method:"PUT"}).then(response=>{
  if(!response.ok)throw new Error(`无法创建浏览器页面：${response.status}`);
  return response.json();
});
const socket=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{
  socket.addEventListener("open",resolve,{once:true});
  socket.addEventListener("error",reject,{once:true});
});
let sequence=0;
const pending=new Map();
const errors=[];
socket.addEventListener("message",event=>{
  const message=JSON.parse(event.data);
  if(message.method==="Runtime.exceptionThrown")errors.push(message.params.exceptionDetails);
  if(!message.id)return;
  const task=pending.get(message.id);if(!task)return;
  pending.delete(message.id);
  if(message.error)task.reject(new Error(message.error.message));else task.resolve(message.result);
});
function command(method,params={}) {
  const id=++sequence;
  return new Promise((resolve,reject)=>{
    pending.set(id,{resolve,reject});
    socket.send(JSON.stringify({id,method,params}));
  });
}

await fs.mkdir(output,{recursive:true});
await command("Page.enable");
await command("Runtime.enable");
for(const viewport of viewports) {
  await command("Emulation.setDeviceMetricsOverride",{
    width:viewport.width,height:viewport.height,deviceScaleFactor:1,mobile:viewport.width<=480,
  });
  await command("Page.navigate",{url:pageUrl+"#/"+viewport.route});
  await command("Runtime.evaluate",{expression:"new Promise(resolve=>setTimeout(resolve,1800))",awaitPromise:true});
  if(viewport.step!==undefined)await command("Runtime.evaluate",{expression:`AppNavigation.calibrationStep(${viewport.step})`});
  const contract=await command("Runtime.evaluate",{expression:`(()=>{const original=BodyApp.latest(),route=AppNavigation.current();for(const name of ['records','advanced','calibration','replay','dashboard'])AppNavigation.navigate(name);AppNavigation.navigate(route);return {preserved:original===BodyApp.latest(),rail:document.querySelector('.status-rail').scrollHeight<=document.querySelector('.status-rail').clientHeight,visible:[...document.querySelectorAll('.app-view')].filter(v=>!v.hidden).length}})()`,returnByValue:true});
  if(!contract.result.value.preserved||contract.result.value.visible!==1)throw new Error("Navigation destroyed state or exposed multiple views");
  const result=await command("Runtime.evaluate",{
    expression:"({innerWidth,innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,bodyWidth:document.body.scrollWidth,active:document.body.dataset.route,views:[...document.querySelectorAll('.app-view')].filter(v=>!v.hidden).length,viewHeight:document.querySelector('.app-view:not([hidden])')?.clientHeight,contentHeight:document.querySelector('.app-view:not([hidden])')?.scrollHeight})",
    returnByValue:true,
  });
  const metrics=result.result.value;
  const readability=await command("Runtime.evaluate",{expression:"({smallText:[...document.querySelectorAll('body *')].filter(e=>!e.children.length&&e.textContent.trim()&&e.getClientRects().length&&parseFloat(getComputedStyle(e).fontSize)<13).map(e=>({text:e.textContent.trim().slice(0,25),size:getComputedStyle(e).fontSize})).slice(0,10),controls:(()=>{const e=document.querySelector('#replay-controls');return e?.getClientRects().length?{height:e.clientHeight,content:e.scrollHeight}:null})()})",returnByValue:true});
  metrics.readability=readability.result.value;
  if(metrics.readability.smallText.length)throw new Error("Visible text below 13px: "+JSON.stringify(metrics.readability.smallText));
  const controls=metrics.readability.controls;
  if(viewport.width>900&&controls&&controls.content>controls.height+1)throw new Error("Replay controls overflow vertically");
  if(errors.length)throw new Error(JSON.stringify(errors));
  if(viewport.width>900&&metrics.contentHeight>metrics.viewHeight+1)throw new Error("Desktop active view overflows vertically");
  if(metrics.scrollWidth>metrics.innerWidth||metrics.bodyWidth>metrics.innerWidth) {
    throw new Error(`${viewport.width}x${viewport.height} 出现横向溢出：${JSON.stringify(metrics)}`);
  }
  let clip;
  if(viewport.modelOnly){const rect=await command("Runtime.evaluate",{expression:"(()=>{const r=document.querySelector('.hero-panel').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()",returnByValue:true});clip=rect.result.value;}
  if(viewport.drag){const x=clip.x+clip.width/2,y=clip.y+clip.height/2;await command("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1});await command("Input.dispatchMouseEvent",{type:"mouseMoved",x:x+viewport.drag,y,button:"left",buttons:1});await command("Input.dispatchMouseEvent",{type:"mouseReleased",x:x+viewport.drag,y,button:"left",clickCount:1});await command("Runtime.evaluate",{expression:"new Promise(r=>setTimeout(r,300))",awaitPromise:true});}
  const shot=await command("Page.captureScreenshot",{format:"png",fromSurface:true,captureBeyondViewport:false,...(clip?{clip}:{})});
  const targetPath=path.join(output,viewport.name);
  await fs.writeFile(targetPath,Buffer.from(shot.data,"base64"));
  process.stdout.write(`${viewport.name} ${JSON.stringify(metrics)}\n`);
}
socket.close();
await fetch(`${endpoint}/json/close/${target.id}`);
