import fs from "node:fs/promises";
import path from "node:path";

const endpoint=process.argv[2]||"http://127.0.0.1:9228";
const pageUrl=process.argv[3]||"http://127.0.0.1:8000/";
const output=path.resolve(process.argv[4]||"docs/ui/reviews");
const viewports=[
  {name:"dashboard-glass-1920x1080.png",width:1920,height:1080},
  {name:"dashboard-glass-1366x768.png",width:1366,height:768},
  {name:"dashboard-glass-430x932.png",width:430,height:932},
];

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
socket.addEventListener("message",event=>{
  const message=JSON.parse(event.data);
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
  await command("Page.navigate",{url:pageUrl});
  await command("Runtime.evaluate",{expression:"new Promise(resolve=>setTimeout(resolve,1800))",awaitPromise:true});
  const result=await command("Runtime.evaluate",{
    expression:"({innerWidth,innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,bodyWidth:document.body.scrollWidth})",
    returnByValue:true,
  });
  const metrics=result.result.value;
  if(metrics.scrollWidth>metrics.innerWidth||metrics.bodyWidth>metrics.innerWidth) {
    throw new Error(`${viewport.width}x${viewport.height} 出现横向溢出：${JSON.stringify(metrics)}`);
  }
  const shot=await command("Page.captureScreenshot",{format:"png",fromSurface:true,captureBeyondViewport:false});
  const targetPath=path.join(output,viewport.name);
  await fs.writeFile(targetPath,Buffer.from(shot.data,"base64"));
  process.stdout.write(`${viewport.name} ${JSON.stringify(metrics)}\n`);
}
socket.close();
