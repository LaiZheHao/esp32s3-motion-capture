"use strict";
const $ = id => document.getElementById(id);
const histories = {accel: [], gyro: [], mag: []};
const colors = ["#ff6573", "#49e39e", "#617cff"];
let socket, latest = null, orientation = [1,0,0,0], lastFrame = null, online = false;
let replay = null, replayIndex = 0, playing = false, playStart = 0, playOffset = 0;
let catalogItems = [], activeSession = null;
let lastCoordinateKey = null;
let savedSerialDevice = null, serialSelectionLoaded = false;
let scenePosition=[0,0,0],sceneSigns=[1,1,1],poseTrail=[],lastPoseEpoch=null,lastTrailFrame=null;
let viewYaw = -.6, viewElevation = .45, viewScale = 1, dragging = null;
const format = (v, places = 2) => Number.isFinite(v) ? v.toFixed(places) : "—";
function canvasSize(canvas) {
  const box = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  const width = Math.round(box.width*dpr), height = Math.round(box.height*dpr);
  if (canvas.width !== width || canvas.height !== height) {canvas.width=width;canvas.height=height;}
  const ctx=canvas.getContext("2d");ctx.setTransform(dpr,0,0,dpr,0,0);
  return {ctx,width:box.width,height:box.height};
}
function rotate(v,q) {
  return PoseMath.rotate(v,q);
}
function euler(q) {
  const [w,x,y,z]=q;
  return [Math.atan2(2*(w*x+y*z),1-2*(x*x+y*y)),Math.asin(Math.max(-1,Math.min(1,2*(w*y-z*x)))),Math.atan2(2*(w*z+x*y),1-2*(y*y+z*z))].map(v=>v*180/Math.PI);
}
function drawPose() {
  if($("poseCanvas").getClientRects?.().length===0)return;
  const {ctx,width,height}=canvasSize($("poseCanvas"));ctx.clearRect(0,0,width,height);
  const range=Math.max(.1,Math.min(20,Number($("sceneRange").value)||1)),scale=Math.min(width,height)*.42*viewScale/range;
  const center=$("followPose").checked?scenePosition:[0,0,0];
  const project=v=>PoseMath.project(v,viewYaw,viewElevation,[width/2,height*.57],scale,center);
  function line(a,b,color){ctx.strokeStyle=color;ctx.beginPath();ctx.moveTo(...a.slice(0,2));ctx.lineTo(...b.slice(0,2));ctx.stroke();}
  const spacing=range<=.5?.05:range<=2?.1:range<=5?.5:1,span=Math.ceil(range*1.5/spacing)*spacing;
  ctx.lineWidth=1;for(let i=-span;i<=span+spacing*.1;i+=spacing){line(project([i,-span,0]),project([i,span,0]),"rgba(111,126,187,.13)");line(project([-span,i,0]),project([span,i,0]),"rgba(111,126,187,.13)");}
  const worldOrigin=project([0,0,0]);ctx.lineWidth=2;
  [[range*.65,0,0],[0,range*.65,0],[0,0,range*.65]].forEach((v,i)=>{const tip=project(v);line(worldOrigin,tip,colors[i]);ctx.fillStyle=colors[i];ctx.font="bold 13px system-ui";ctx.fillText("XYZ"[i],tip[0]+5,tip[1]);});
  ctx.fillStyle="#dfe4ff";ctx.beginPath();ctx.arc(worldOrigin[0],worldOrigin[1],3,0,Math.PI*2);ctx.fill();ctx.fillText("O",worldOrigin[0]+5,worldOrigin[1]+14);
  if($("showTrail").checked&&poseTrail.length>1){ctx.lineWidth=2;ctx.strokeStyle="#e7a039";ctx.beginPath();poseTrail.forEach((p,i)=>{const v=project(p);i?ctx.lineTo(v[0],v[1]):ctx.moveTo(v[0],v[1]);});ctx.stroke();}
  const vertices=[[-.24,-.16,-.035],[.24,-.16,-.035],[.24,.16,-.035],[-.24,.16,-.035],[-.24,-.16,.035],[.24,-.16,.035],[.24,.16,.035],[-.24,.16,.035]].map(v=>project(PoseMath.worldVertex(v,orientation,scenePosition,sceneSigns)));
  const faces=[[0,1,2,3],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]].map((ids,i)=>({ids,i,depth:ids.reduce((s,j)=>s+vertices[j][2],0)/4})).sort((a,b)=>a.depth-b.depth);
  for(const face of faces){ctx.beginPath();face.ids.forEach((j,i)=>i?ctx.lineTo(...vertices[j].slice(0,2)):ctx.moveTo(...vertices[j].slice(0,2)));ctx.closePath();ctx.fillStyle=face.i===1?"rgba(104,120,255,.55)":"rgba(91,108,255,.28)";ctx.fill();ctx.strokeStyle="#7e8bff";ctx.stroke();}
  const origin=project(scenePosition);ctx.lineWidth=3;
  [[.32,0,0],[0,.32,0],[0,0,.32]].forEach((v,i)=>{const tip=project(PoseMath.worldVertex(v,orientation,scenePosition,sceneSigns));line(origin,tip,colors[i]);ctx.fillStyle=colors[i];ctx.font="bold 12px system-ui";ctx.fillText("b"+"XYZ"[i],tip[0]+5,tip[1]);});
  ctx.font="12px system-ui";ctx.fillStyle="#9ba6c2";ctx.fillText(replay?"位姿与轨迹回放":(online?"实时位姿 · 位置为惯性估算":"等待真实数据"),14,24);ctx.fillText(`网格 ${spacing.toFixed(2)} m · 轨迹 ${poseTrail.length} 点`,14,43);
}
function drawChart(canvas, samples) {
  if(canvas.getClientRects?.().length===0)return;
  const {ctx,width,height}=canvasSize(canvas);ctx.clearRect(0,0,width,height);
  let min=Infinity,max=-Infinity;for(const sample of samples)for(const v of sample){min=Math.min(min,v);max=Math.max(max,v);}
  if(!samples.length){min=-1;max=1;}if(max-min<.01){min-=.5;max+=.5;}const pad=(max-min)*.1;min-=pad;max+=pad;
  ctx.font="14px system-ui";ctx.fillStyle="#aab6cf";ctx.fillText(format(max,1),0,15);ctx.fillText(format(min,1),0,height-5);
  ctx.lineWidth=1;ctx.strokeStyle="rgba(122,135,184,.14)";for(let j=0;j<4;j++){const y=8+j*(height-16)/3;ctx.beginPath();ctx.moveTo(48,y);ctx.lineTo(width,y);ctx.stroke();}
  for(let axis=0;axis<3;axis++){ctx.strokeStyle=colors[axis];ctx.shadowColor=colors[axis];ctx.shadowBlur=4;ctx.lineWidth=1.5;ctx.beginPath();samples.forEach((v,i)=>{const x=48+i*(width-50)/Math.max(1,samples.length-1),y=height-8-(v[axis]-min)/(max-min)*(height-16);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();ctx.shadowBlur=0;}
}
function addHistory(node){for(const key of Object.keys(histories)){histories[key].push(node[key]);if(histories[key].length>400)histories[key].shift();}}
function clearHistory(){for(const key of Object.keys(histories))histories[key].length=0;lastFrame=null;}
window.renderRecordedSeries=nodes=>{for(const key of Object.keys(histories))histories[key]=nodes.map(node=>node[key]||[0,0,0]);};
function renderNode(node) {
  orientation=node.quaternion;const angles=node.euler||euler(orientation);
  ["roll","pitch","yaw"].forEach((id,i)=>$(id).textContent=format(angles[i],1)+"°");
  [["a",node.accel],["g",node.gyro],["m",node.mag]].forEach(([prefix,v])=>"xyz".split("").forEach((axis,i)=>$(prefix+axis).textContent=format(v[i],prefix==="a"?4:2)));
  $("nodeId").textContent=node.node_id||node.id;
}
function renderMotion(motion) {
  const phases={idle:"未开始",initializing:"静置初始化",measuring:"估算中",stopped:"已停止"};
  $("motionPhase").textContent=motion?(motion.quality==="stationary_constraint"?"停稳锁定":phases[motion.phase]||motion.phase):"记录无位移数据";
  $("motionMessage").textContent=motion?.message||"这份旧记录未保存位移估算";
  ["dx","dy","dz"].forEach((id,i)=>$(id).textContent=motion?format(motion.position[i],4):"—");
  scenePosition=motion?.position||[0,0,0];
  ["poseX","poseY","poseZ"].forEach((id,i)=>$(id).textContent=motion?format(scenePosition[i],3):"—");
  $("distance").textContent=motion?format(motion.distance,4):"—";
  $("speed").textContent=motion?format(motion.speed,4):"—";
  $("motionElapsed").textContent=motion?format(motion.elapsed_s,2):"—";
  $("linearAccel").textContent=motion?"线性加速度 XYZ / m/s²："+motion.linear_accel.map(v=>format(v,3)).join(", "):"线性加速度：—";
  $("poseQuality").textContent=motion?.phase!=="measuring"?"位置未在积分："+(motion?.message||"该记录仅有姿态"):
    motion.zupt===false?"静止修正已关闭：停下后不会自动清零残余速度；需要停稳锁定请暂停后启用静止修正。":
    motion.quality==="stationary_constraint"?"停稳锁定生效：速度已归零、位置保持。姿态继续实时显示；不是回到真实位置。":"惯性位置估算：等待原始传感器静稳窗口；匀速/恒定加速平移仍可能被误判。";
  $("restDiagnostics").textContent=Number.isFinite(motion?.accel_std_g)?`静止检测：窗口 ${format(motion.rest_window_s,2)} s · 加速度波动 ${format(motion.accel_std_g,4)} g · 角速度窗口峰值 ${format(motion.gyro_peak_dps,2)} °/s · 速度归零 ${motion.zupt_count} 次`:
    "此记录未保存窗口波动数值；停稳状态以记录字段为准，旧记录无法追溯。";
  if(motion?.sampling_gaps)$("poseQuality").textContent+=` 已跳过 ${motion.sampling_gaps} 次采样缺口，最近 ${format(motion.last_gap_s,2)} 秒；缺口内的运动无法恢复。`;
}
function appendPoseTrail(position){const previous=poseTrail[poseTrail.length-1];if(previous&&previous.reduce((s,v,i)=>s+(v-position[i])**2,0)<1e-8)return;poseTrail.push([...position]);if(poseTrail.length>2000)poseTrail.shift();}
function coordinateInputs(settings){"XYZ".split("").forEach((axis,i)=>{$("map"+axis).value=settings.sensor_axes[i];$("sign"+axis).value=settings.displacement_signs[i];});}
function send(action,extra={}){if(window.BodyApp){window.BodyApp.command(action,extra);return;}if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({action,...extra}));}
function update(data) {
  latest=data;const stats=data.stats,node=data.nodes[0];if(!node)return;
  online=!!node.valid;$("message").textContent=stats.message;
  const coordinateKey=JSON.stringify(data.coordinates);
  if(coordinateKey!==lastCoordinateKey){coordinateInputs(data.coordinates);if(lastCoordinateKey!==null)clearHistory();lastCoordinateKey=coordinateKey;}
  if(!replay)sceneSigns=data.coordinates.displacement_signs;
  if(!replay&&data.pose.epoch!==lastPoseEpoch){poseTrail=[];lastTrailFrame=null;lastPoseEpoch=data.pose.epoch;}
  $("coordinateSummary").textContent=data.coordinates.sensor_axes.join(" / ");
  ["mapX","mapY","mapZ","signX","signY","signZ","applyCoordinates","defaultCoordinates"].forEach(id=>$(id).disabled=stats.recording||stats.calibrating||!!replay);
  const motionActive=data.motion.active;
  $("startMotion").disabled=!online||!!replay||stats.calibrating||motionActive||stats.recording;
  $("stopMotion").disabled=!!replay||!motionActive;$("resetMotion").disabled=!!replay||stats.recording;
  $("motionDuration").disabled=$("motionZupt").disabled=$("driftMode").disabled=motionActive||!!replay||stats.recording;
  if(motionActive){$("motionDuration").value=String(data.motion.duration_s);$("motionZupt").checked=data.motion.zupt;$("driftMode").value=data.motion.drift_mode;}
  if(!replay)renderMotion(data.motion);
  if(!replay&&online&&lastTrailFrame!==stats.valid_frames&&data.motion.phase==="measuring"){appendPoseTrail(scenePosition);lastTrailFrame=stats.valid_frames;}
  $("nodeState").textContent=online?"真实节点在线":"等待 / 数据超时";$("nodeState").classList.toggle("online",online);
  $("connect").textContent=stats.serial_status==="connected"||stats.serial_status==="connecting"?"断开设备":"连接设备";
  const locked=stats.serial_status==="connected"||stats.serial_status==="connecting";
  ["transport","host","tcpPort","serialPort"].forEach(id=>$(id).disabled=locked);
  $("zero").disabled=!online||!!replay||stats.recording;$("calibrate").disabled=!online||stats.calibrating||!!replay||stats.recording;
  $("record").disabled=!!replay||stats.calibrating||data.motion.phase==="initializing"||(!online&&!stats.recording);$("record").textContent=stats.recording?"停止记录":"开始记录";
  $("rate").textContent=format(stats.frame_rate,1)+" Hz";
  $("lossLabel").firstChild.textContent=stats.loss_method==="sequence"?"序号缺帧率":"间隔估算缺帧率";
  $("loss").textContent=format(stats.estimated_loss_rate)+"%";$("invalid").textContent=stats.invalid_frames;
  $("sequence").textContent=stats.sequence??(stats.valid_frames?"旧协议":"等待数据");$("deviceTime").textContent=stats.device_us==null?"—":format(stats.device_us/1e6,3)+" s";
  $("sensorStatus").textContent=`六轴 ${(stats.sensor_flags&1)?"正常":"未收到"} · 磁力计 ${(stats.sensor_flags&2)?"正常":"无效 / 未收到"} · 重复帧 ${stats.duplicate_frames} · 设备重启 ${stats.device_restarts}`;
  $("calibration").textContent=stats.calibration_message+"；零偏 °/s："+stats.gyro_bias.map(v=>format(v,3)).join(", ");
  $("recordStatus").textContent=stats.recording?`记录中 ${stats.record_duration_s.toFixed(1)} s · ${stats.record_rows} 样本`:(stats.record_path?`已保存：${stats.record_path}`:"原始数据与姿态逐样本记录；曲线约 20 Hz 刷新。");
  if(!replay&&stats.valid_frames){renderNode(node);$("temperature").textContent=`ICM 温度 ${format(node.temperature)} °C · LIS 温度原始值 ${format(node.aux_temperature,0)}`;if(online&&lastFrame!==stats.valid_frames){addHistory(node);lastFrame=stats.valid_frames;}}
  else if(!replay){["roll","pitch","yaw","ax","ay","az","gx","gy","gz","mx","my","mz"].forEach(id=>$(id).textContent="—");$("temperature").textContent="温度 —";}
}
function connectSocket(){socket=new WebSocket(`${location.protocol==="https:"?"wss":"ws"}://${location.host}/ws`);socket.onopen=()=>{$("socketState").textContent="接收服务在线";$("socketState").className="badge online";$("connect").disabled=false;};socket.onmessage=e=>{try{update(JSON.parse(e.data));}catch(error){console.error(error);}};socket.onclose=()=>{$("socketState").textContent="服务断开，正在重连";$("socketState").className="badge error";$("connect").disabled=true;setTimeout(connectSocket,1500);};}
function transportInputs(){const wifi=$("transport").value==="wifi";$("hostField").hidden=$("portField").hidden=!wifi;$("serialField").hidden=$("refreshPorts").hidden=wifi;}
$("transport").onchange=transportInputs;
$("connect").onclick=()=>{if(["connected","connecting"].includes(latest?.stats.serial_status)){send("disconnect");return;}if($("transport").value==="serial"&&!$("serialPort").value){alert("请选择实际连接板子的 USB 串口，不能使用空选项。");return;}clearHistory();const config={transport:$("transport").value,host:$("host").value.trim(),tcp_port:Number($("tcpPort").value),device:$("serialPort").value};try{localStorage.setItem("imu-connection",JSON.stringify(config));}catch{}send("connect",config);};
$("zero").onclick=()=>send("zero");$("calibrate").onclick=()=>send("calibrate");$("record").onclick=()=>send(latest?.stats.recording?"stop_recording":"start_recording");
$("startMotion").onclick=()=>send("start_motion",{duration_s:Number($("motionDuration").value),zupt:$("motionZupt").checked,drift_mode:$("driftMode").value});
$("stopMotion").onclick=()=>send("stop_motion");$("resetMotion").onclick=()=>send("reset_motion");
$("applyCoordinates").onclick=()=>send("set_coordinates",{coordinates:{sensor_axes:"XYZ".split("").map(axis=>$("map"+axis).value),displacement_signs:"XYZ".split("").map(axis=>Number($("sign"+axis).value))}});
$("defaultCoordinates").onclick=()=>{const defaults={sensor_axes:["+X","+Y","+Z"],displacement_signs:[1,1,1]};coordinateInputs(defaults);send("set_coordinates",{coordinates:defaults});};
async function refreshPorts(){const button=$("refreshPorts");if(button.disabled)return;button.disabled=true;button.textContent="读取中…";try{const result=await fetch("/api/ports");if(!result.ok)throw new Error("读取串口列表失败");const data=await result.json(),desired=serialSelectionLoaded?$("serialPort").value:savedSerialDevice;serialSelectionLoaded=true;$("serialPort").replaceChildren();$("serialPort").add(new Option(desired?`${desired} 不在列表中，请重新选择`:"请选择板子的 USB 串口",""));data.items.forEach(p=>$("serialPort").add(new Option(`${p.device} · ${p.description}`,p.device)));if(desired){$("serialPort").value=data.items.some(p=>p.device===desired)?desired:"";}else{const usb=data.items.filter(p=>/USB|CP210|CH34|Espressif/i.test(p.description));$("serialPort").value=usb.length===1?usb[0].device:"";}}catch(error){$("message").textContent=error.message;window.BodyApp?.notify(error.message,"error");}finally{button.disabled=false;button.textContent="刷新串口";}}
$("refreshPorts").onclick=refreshPorts;
const poseCanvas=$("poseCanvas");poseCanvas.onpointerdown=e=>{dragging=[e.clientX,e.clientY];poseCanvas.setPointerCapture(e.pointerId);};poseCanvas.onpointermove=e=>{if(!dragging)return;viewYaw+=(e.clientX-dragging[0])*.01;viewElevation=Math.max(-1.3,Math.min(1.3,viewElevation+(e.clientY-dragging[1])*.01));dragging=[e.clientX,e.clientY];};poseCanvas.onpointerup=poseCanvas.onpointercancel=()=>dragging=null;$("poseZoom").oninput=()=>{viewScale=Number($("poseZoom").value);};$("viewReset").onclick=()=>{viewYaw=-.6;viewElevation=.45;viewScale=1;$("poseZoom").value=1;};
$("clearTrail").onclick=()=>poseTrail=[];
async function fetchJson(url){const response=await fetch(url);if(!response.ok){let message="请求失败";try{message=(await response.json()).detail||message;}catch{}throw new Error(message);}return response.json();}
function selectedItem(){return catalogItems.find(item=>item.id===$("sessions").value);}
window.refreshLegacySessions=async()=>{try{const data=await fetchJson("/api/recordings");catalogItems=data.items.filter(item=>item.files?.some(file=>file.name==="imu-data.csv")||item.kind==="legacy_jsonl");activeSession=data.active?.split(/[\\/]/).pop();$("sessions").replaceChildren();catalogItems.forEach(item=>$("sessions").add(new Option(item.id,item.id)));updateSession();}catch(error){$("sessionInfo").textContent=error.message;}};
function updateSession(){const item=selectedItem(),active=item?.id===activeSession;$("preview").disabled=!item||item.kind!=="csv_session";$("download").disabled=!item||active;$("loadReplay").disabled=!item||active||item.kind!=="csv_session"||latest?.stats.recording;$("sessionInfo").textContent=active?"当前记录中，请停止记录后回放或导出":"回放最多显示 5000 个均匀抽取的样本；ZIP 导出保留完整数据。";}
$("records").onclick=async()=>{try{const data=await fetchJson("/api/recordings");catalogItems=data.items;activeSession=data.active?.split(/[\\/]/).pop();$("sessions").replaceChildren();catalogItems.forEach(item=>$("sessions").add(new Option(item.id+(item.id===activeSession?"（记录中）":""),item.id)));updateSession();$("recordDialog").showModal();}catch(error){alert(error.message);}};
$("closeDialog").onclick=()=>$("recordDialog").close();$("sessions").onchange=updateSession;
$("preview").onclick=async()=>{try{const data=await fetchJson(`/api/recordings/${encodeURIComponent($("sessions").value)}/preview?file=imu-data.csv&limit=100`),table=$("previewTable");table.replaceChildren();const head=document.createElement("thead"),body=document.createElement("tbody"),tr=document.createElement("tr");data.header.forEach(v=>{const th=document.createElement("th");th.textContent=v;tr.append(th);});head.append(tr);data.rows.forEach(row=>{const tr=document.createElement("tr");row.forEach(v=>{const td=document.createElement("td");td.textContent=v;tr.append(td);});body.append(tr);});table.append(head,body);$("sessionInfo").textContent=`共 ${data.total_rows} 行；显示前 ${data.rows.length} 行`;}catch(error){alert(error.message);}};
$("download").onclick=()=>{const id=$("sessions").value;if(id&&id!==activeSession)location.href=`/api/recordings/${encodeURIComponent(id)}/download`;};
function showReplay(index){replayIndex=Math.max(0,Math.min(replay.frames.length-1,index));const frame=replay.frames[replayIndex];renderNode(frame);renderMotion(frame.motion);sceneSigns=frame.axis_signs||[1,1,1];poseTrail=replay.frames.slice(Math.max(0,replayIndex-1999),replayIndex+1).filter(f=>f.motion).map(f=>f.motion.position);$("seek").value=replayIndex;$("playTime").textContent=`${format(frame.timestamp-replay.frames[0].timestamp,1)} / ${format(replay.duration_s,1)} s`;for(const key of Object.keys(histories))histories[key]=replay.frames.slice(Math.max(0,replayIndex-399),replayIndex+1).map(f=>f[key]);}
$("loadReplay").onclick=async()=>{try{if(latest?.stats.recording)throw new Error("请先停止记录");const data=await fetchJson(`/api/recordings/${encodeURIComponent($("sessions").value)}/replay`);if(!data.frames.length)throw new Error("该记录没有可回放样本");replay=data;playing=false;$("play").textContent="播放";$("playback").hidden=false;$("seek").max=replay.frames.length-1;$("playTitle").textContent=$("sessions").value;$("playSummary").textContent=`${data.total_rows} 样本 · ${format(data.duration_s,1)} 秒 · 原始峰值角速度模长 ${format(data.peak_gyro_dps)} °/s · 回放抽取间隔 ${data.stride} 样本`;$ ("recordDialog").close();showReplay(0);if(latest)update(latest);}catch(error){alert(error.message);}};
$("play").onclick=()=>{if(!replay)return;if(playing){playing=false;$("play").textContent="播放";}else{if(replayIndex===replay.frames.length-1)showReplay(0);playing=true;playStart=performance.now();playOffset=replay.frames[replayIndex].timestamp;$("play").textContent="暂停";}};
$("seek").oninput=()=>{playing=false;$("play").textContent="播放";showReplay(Number($("seek").value));};$("exitReplay").onclick=()=>{replay=null;playing=false;$("playback").hidden=true;clearHistory();poseTrail=[];lastTrailFrame=null;if(latest)update(latest);};
let chartLastDraw=-Infinity;
function animate(now){if(replay&&playing){const target=playOffset+(now-playStart)/1000;let index=replayIndex;while(index+1<replay.frames.length&&replay.frames[index+1].timestamp<=target)index++;if(index!==replayIndex)showReplay(index);if(index===replay.frames.length-1){playing=false;$("play").textContent="播放";}}drawPose();if(now-chartLastDraw>=100){drawChart($("accChart"),histories.accel);drawChart($("gyroChart"),histories.gyro);drawChart($("magChart"),histories.mag);chartLastDraw=now;}if(latest){const timestamp=latest.latest_packet_at;$("age").textContent=timestamp?Math.max(0,Date.now()-timestamp*1000).toFixed(0)+" ms":"—";}requestAnimationFrame(animate);}
window.setBodyDisplayPose=device=>{orientation=device.quaternion||orientation;};
try{const saved=JSON.parse(localStorage.getItem("imu-connection"));if(saved){$("transport").value=saved.transport;$("host").value=saved.host;$("tcpPort").value=saved.tcp_port;savedSerialDevice=saved.device||null;}}catch{}
// The unified body controller owns all connections and model sources. The
// legacy websocket is retained only for a page without the body workspace.
window.renderBodyDiagnostic=function(device,state) {
  const replaying=state.mode==="REPLAY",recording=!!state.recording?.active,quality=device?.quality||{},stability=device?.stability||{};
  online=!!device?.valid;replay=null;
  const identity=device?.device_id||device?.node_id||device?.id||null;
  if(window._diagnosticDevice!==identity){clearHistory();poseTrail=[];lastTrailFrame=null;window._diagnosticDevice=identity;}
  $("nodeId").textContent=identity||"未选择设备";
  $("nodeState").textContent=!device?"等待选择设备":`${device.source==="real"?"真实":"模拟"} · ${online?"有效":"失鲜 / 未连接"}${replaying?" · 回放":""}`;
  $("nodeState").classList.toggle("online",online);
  for(const id of ["zero","calibrate","startMotion","stopMotion","resetMotion","applyCoordinates","defaultCoordinates"]){$(id).disabled=!device||recording||replaying;}
  $("record").disabled=replaying||(!device&&!recording);$("record").textContent=recording?"停止完整动作记录":"开始完整动作记录";
  $("recordStatus").textContent=recording?`动作记录中：${state.recording.session||""}`:"完整动作会话入口位于下方；包括全部骨架帧，不采用抽样预览替代回放。";
  $("connect").textContent="连接 / 添加端点";$("connect").disabled=!window.BodyApp?.connected;
  for(const id of ["transport","host","tcpPort","serialPort"]){$(id).disabled=false;}
  $("rate").textContent=format(quality.rate_hz??quality.frame_rate??device?.rate_hz??0,1)+" Hz";
  const validFrames=quality.valid_frames??device?.frames??0,missing=quality.missing_frames??0;
  $("lossLabel").firstChild.textContent="序号缺帧率";
  $("loss").textContent=device?.sequence==null&&quality.sequence==null?"—":format(100*missing/Math.max(1,validFrames+missing))+"%";
  $("invalid").textContent=quality.invalid_frames??device?.invalid_frames??0;
  $("sequence").textContent=quality.sequence??device?.sequence??"旧协议 / 无数据";
  const deviceUs=quality.device_us??device?.device_us;$("deviceTime").textContent=deviceUs==null?"—":format(deviceUs/1e6,3)+" s";
  const age=quality.age_ms??(Number.isFinite(device?.age_s)?device.age_s*1000:null);$("age").textContent=Number.isFinite(age)?format(age,0)+" ms":"—";
  $("sensorStatus").textContent=device?`设备会话 ${device.boot_id??"旧协议未知"} · 重复 ${quality.duplicates??quality.duplicate_frames??0} · 缺帧 ${missing} · 重启 ${quality.restarts??quality.device_restarts??0} · ${stability.magnetic_message||"磁场质量待检查"}`:"传感器状态 —";
  $("calibration").textContent=(stability.message||"陀螺零偏未校准；与站姿安装参考分开")+"；零偏 °/s："+(stability.gyro_bias_dps||stability.bias||[0,0,0]).map(value=>format(value,3)).join(", ");
  if(device){const node={...device,node_id:identity,quaternion:device.quaternion||device.q||[1,0,0,0],accel:device.accel||[0,0,0],gyro:device.gyro||[0,0,0],mag:device.mag||[0,0,0],euler:device.euler_deg};renderNode(node);$("temperature").textContent=`ICM 温度 ${format(device.temperature)} °C · LIS 温度原始值 ${format(device.aux_temperature,0)}`;const frameKey=`${identity}:${validFrames}:${quality.sequence??device.sequence??""}:${state.mode}`;if(lastFrame!==frameKey){addHistory(node);lastFrame=frameKey;}}
  else{orientation=[1,0,0,0];["roll","pitch","yaw","ax","ay","az","gx","gy","gz","mx","my","mz"].forEach(id=>$(id).textContent="—");$("temperature").textContent="温度 —";}
  renderMotion(device?.motion||null);
  $("poseQuality").textContent="选中设备的独立诊断视图。位置估算是实验路径，不驱动固定根部骨架；观察视角拖动不代表测量平移。";
  const settings=device?.coordinates||state.coordinates;if(settings?.sensor_axes){coordinateInputs(settings);$("coordinateSummary").textContent=settings.sensor_axes.join(" / ");sceneSigns=settings.displacement_signs||[1,1,1];}
};
transportInputs();refreshPorts();if(!$("bodyFixed"))connectSocket();requestAnimationFrame(animate);
