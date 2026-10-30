"use strict";
(function(root){
  const ROUTES=["dashboard","calibration","records","replay","advanced"];
  const names={dashboard:"实时总览",calibration:"设备标定",records:"历史记录与导出",replay:"姿态回放",advanced:"高级设置"};
  const routeFromHash=hash=>{const value=String(hash||"").replace(/^#\/?/,"");return ROUTES.includes(value)?value:"dashboard";};
  function applyRoute(route,{views,links}){const selected=ROUTES.includes(route)?route:"dashboard";views.forEach(view=>view.hidden=view.dataset.view!==selected);links.forEach(link=>{link.classList.toggle("active",link.dataset.route===selected);link.setAttribute("aria-current",link.dataset.route===selected?"page":"false");});return selected;}
  let active="dashboard",bodyState=null,step=0,items=[],historySelection=null,archive=null,historyGeneration=0,replayFrames=null,replaySession=null;
  const $=id=>document.getElementById(id);
  function navigate(route){active=routeFromHash("#/"+route);root.location.hash="/"+active;render();return active;}
  function render(){
    active=applyRoute(routeFromHash(root.location.hash),{views:[...document.querySelectorAll(".app-view")],links:[...document.querySelectorAll("[data-route]")]});
    document.body.dataset.route=active;document.querySelector("h1").textContent=names[active];
    const hero=document.querySelector(".hero-panel"),charts=$("telemetry");
    if(active==="dashboard"){$("overview").insertBefore(hero,document.querySelector(".status-rail"));$("view-dashboard").append(charts);}
    if(active==="calibration")$("calibration-model").append(hero);
    if(active==="replay"){$("replay-model").append(hero);$("replay-charts").append(charts);}
    hero.querySelector("h2").textContent=active==="replay"?"保存姿态回放":"实时人体姿态";
    charts.querySelector("h2").textContent=active==="replay"?"保存传感器曲线":"实时传感器曲线";
    if(active==="records"){refreshHistory();root.refreshLegacySessions?.();}
    document.dispatchEvent(new CustomEvent("app-route-change",{detail:{route:active}}));
  }
  function make(tag,className,html=""){const element=document.createElement(tag);element.className=className;element.innerHTML=html;return element;}
  function button(text,action){const b=make("button","",text);b.type="button";b.onclick=action;return b;}
  function calibrationStep(index){step=index;document.querySelectorAll("[data-step]").forEach(b=>{b.classList.toggle("active",Number(b.dataset.step)===step);b.setAttribute("aria-selected",String(Number(b.dataset.step)===step));});
    document.querySelectorAll(".cal-step-content").forEach((p,i)=>p.hidden=i!==step);
  }
  async function refreshHistory(){
    const list=$("history-list");list.textContent="读取记录中…";
    try{const response=await fetch("/api/body/recordings");if(!response.ok)throw new Error("读取会话失败");items=(await response.json()).items||[];list.replaceChildren();
      if(!items.length){list.textContent="尚无动作记录。连接设备后，在总览开始记录。";return;}
      items.forEach(item=>{const id=item.id||item.session;const b=button(id,()=>selectHistory(item));b.className="history-item";list.append(b);});selectHistory(items.find(i=>(i.id||i.session)===$("bodySessions").value)||items[0]);
    }catch(error){list.textContent=error.message;}
  }
  function selectHistory(item){historySelection=item;archive=null;historyGeneration++;const id=item.id||item.session;$("history-title").textContent=id;$("history-meta").textContent=JSON.stringify({状态:item.status||"未知",开始时间:new Date(item.started_unix*1000).toLocaleString(),时长秒:item.duration_s??"—",采样数:item.counts?.samples??0,骨架帧:item.counts?.body_frames??0,来源:item.source_types||[],事件:item.counts?.events??0},null,2);$("bodySessions").value=id;$("bodySessions").dispatchEvent(new Event("change"));
    const activeRecording=bodyState?.recording?.active&&bodyState.recording.session===id;
    $("bodyExport").disabled=activeRecording;$("bodyExport").onclick=async()=>{const b=$("bodyExport");b.disabled=true;b.setAttribute("aria-busy","true");$("preview-status").textContent="正在准备完整 ZIP…";try{const response=await fetch(`/api/body/recordings/${encodeURIComponent(id)}/download`);if(!response.ok)throw new Error("导出失败，请确认会话已停止并完整保存");const url=URL.createObjectURL(await response.blob()),link=document.createElement("a");link.href=url;link.download=id+".zip";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$("preview-status").textContent="完整 ZIP 已交给浏览器保存";}catch(error){$("preview-status").textContent=error.message;}finally{b.disabled=false;b.removeAttribute("aria-busy");}};
    $("history-open").disabled=activeRecording;$("history-open").onclick=()=>{$("bodyReplayOpen").click();navigate("replay");};
    $("history-preview").disabled=activeRecording;$("history-csv").disabled=activeRecording;
  }
  async function loadArchive(){if(archive)return archive;const id=historySelection?.id||historySelection?.session;if(!id)throw new Error("请先选择会话");const response=await fetch(`/api/body/recordings/${encodeURIComponent(id)}/download`);if(!response.ok)throw new Error("无法读取记录，请先停止录制");const buffer=await response.arrayBuffer();return buffer;}
  async function previewHistory(csv=false){const generation=historyGeneration,b=csv?$("history-csv"):$("history-preview");b.disabled=true;b.setAttribute("aria-busy","true");$("preview-status").textContent="读取保存数据中…";try{const buffer=await loadArchive();if(generation!==historyGeneration)return;archive=buffer;const text=await root.SessionArchive.extract(buffer,csv?"samples.jsonl":"body_frames.jsonl");if(generation!==historyGeneration)return;const rows=text.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
      if(csv){const url=URL.createObjectURL(new Blob([root.SessionArchive.toCsv(rows)],{type:"text/csv;charset=utf-8"})),link=document.createElement("a");link.href=url;link.download=(historySelection.id||historySelection.session)+"-samples.csv";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
      else{const stride=Math.max(1,Math.ceil(rows.length/400)),shown=rows.filter((_,i)=>i%stride===0);["accel","gyro","mag"].forEach((key,index)=>{const canvas=$("history-chart-"+index),ctx=canvas.getContext("2d"),box=canvas.getBoundingClientRect();canvas.width=box.width*2;canvas.height=box.height*2;ctx.scale(2,2);const samples=shown.map(row=>row.data.selected_node||row.data.devices?.[0]).map(d=>d?.[key]||[0,0,0]);let range=Math.max(.01,...samples.flat().map(Math.abs));["#ff6573","#49e39e","#617cff"].forEach((color,axis)=>{ctx.strokeStyle=color;ctx.beginPath();samples.forEach((s,i)=>{const x=i*box.width/Math.max(1,samples.length-1),y=box.height/2-s[axis]/range*(box.height*.4);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();});});}
      $("preview-status").textContent=csv?`已导出 ${rows.length} 条原始采样（data_json 保留全部字段）`:`已显示保存帧曲线 · ${rows.length} 帧 · 预览最多 400 点`;
    }catch(error){$("preview-status").textContent=error.message;}finally{b.disabled=false;b.removeAttribute("aria-busy");}}
  function update(state){bodyState=state;
    const devices=state.devices||[],real=devices.filter(d=>d.valid&&d.source==="real"),selected=devices.find(d=>d.device_id===state.selected_device_id);
    $("connection-summary").textContent=real.length?`${real.length} 个硬件节点有效`:"等待连接设备";
    $("replay-source").textContent=state.mode==="REPLAY"?`保存姿态 · ${state.replay?.session||""}`:"尚未载入会话，请从历史记录选择";
    $("view-replay").classList.toggle("awaiting-replay",state.mode!=="REPLAY");
    document.querySelectorAll("[data-replay-action]").forEach(b=>b.disabled=state.mode!=="REPLAY");
    if(state.mode==="REPLAY"&&state.replay?.session){
      if(replaySession!==state.replay.session){replaySession=state.replay.session;replayFrames=null;loadReplaySeries(replaySession);}
      if(replayFrames){const time=state.replay.time_s||0;let lo=0,hi=replayFrames.length;while(lo<hi){const mid=(lo+hi)>>1;if(replayFrames[mid].time_s<=time)lo=mid+1;else hi=mid;}root.renderRecordedSeries?.(replayFrames.slice(Math.max(0,lo-400),lo).map(row=>row.data.devices?.find(d=>d.device_id===state.selected_device_id)||row.data.selected_node||row.data.devices?.[0]).filter(Boolean));}
    }else if(replaySession){replaySession=null;replayFrames=null;root.renderRecordedSeries?.([]);}
    $("calibration-summary").textContent=`已初始化 ${devices.filter(d=>d.initialized).length} / ${devices.length} · ${state.direction_calibration?.phase||"等待标定"}`;
    $("single-node-title").textContent=selected?`${selected.device_id} · ${selected.body_slot||"未绑定"}`:"先从物理设备列表选择节点";
    document.querySelectorAll(".body-slot strong").forEach(el=>{el.title=el.textContent;el.textContent=el.textContent.replace(/（.*?）/g,"");});
    for(const [name,transport] of [["usb","serial"],["wifi","wifi"]]){const endpoints=(state.endpoints||[]).filter(e=>e.transport===transport);$(name+"-status").textContent=endpoints.some(e=>e.connected)?"已连接":endpoints.some(e=>e.status==="connecting")?"连接中…":"未连接";}
  }
  async function loadReplaySeries(session){try{const response=await fetch(`/api/body/recordings/${encodeURIComponent(session)}/download`);if(!response.ok)throw new Error("无法读取回放曲线");const text=await root.SessionArchive.extract(await response.arrayBuffer(),"body_frames.jsonl");if(replaySession===session)replayFrames=text.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(replaySession===session)$("replay-source").textContent="姿态可回放；曲线未加载："+error.message;}}
  function start(){
    const main=document.querySelector("main");main.className="view-stack";
    ROUTES.forEach(route=>{const v=make("section","app-view");v.id="view-"+route;v.dataset.view=route;main.append(v);});
    const nav=document.querySelector(".nav-links");nav.replaceChildren();["⌂","◎","▤","▷","⚙"].forEach((icon,i)=>{const route=ROUTES[i],label=["总览","标定","记录","回放","高级"][i],b=button(`<span class="nav-icon">${icon}</span><span>${label}</span>`,()=>navigate(route));b.className="nav-item";b.title=names[route];b.dataset.route=route;nav.append(b);});
    document.querySelector(".brand-mark").href="#/dashboard";
    $("view-dashboard").append($("overview"),$("telemetry"));
    const connection=$("devices"),left=document.querySelector(".device-rail"),summary=make("section","glass compact-card connection-summary",'<span class="kicker">DEVICE</span><h2>设备</h2><p id="connection-summary">等待连接设备</p><button id="usb-connect">♧ USB <span id="usb-status">未连接</span> ›</button><button id="wifi-connect">◉ Wi-Fi <span id="wifi-status">未连接</span> ›</button>');left.prepend(summary);
    const cal=$("view-calibration");cal.innerHTML='<div class="cal-stepper glass" role="tablist"></div><div class="calibration-grid"><div id="calibration-model"></div><div class="calibration-content glass"><div class="cal-step-content"></div><div class="cal-step-content"></div><div class="cal-step-content"></div><div class="cal-step-content"></div><div class="cal-step-content"></div></div></div>';
    ["连接设备","绑定节点","静置校准","方向标定","完成验证"].forEach((label,i)=>{const b=button(`<b>${i+1}</b>${label}`,()=>calibrationStep(i));b.dataset.step=i;b.setAttribute("role","tab");cal.querySelector(".cal-stepper").append(b);});
    const panels=cal.querySelectorAll(".cal-step-content");panels[0].append(connection);panels[1].append($("devices-workspace"));
    const calibrationCard=document.querySelector(".calibration-card"),status=document.querySelector(".status-rail");
    const calibrationSummary=make("section","glass status-card",'<span class="kicker">CALIBRATION</span><h2>标定状态</h2><div class="calibration-progress"><i class="done">1</i><b></b><i>2</i><b></b><i>3</i><b></b><i>4</i></div><p id="calibration-summary">等待标定</p>');calibrationSummary.append(button("进入设备标定 →",()=>navigate("calibration")));status.append(calibrationSummary);
    panels[2].innerHTML='<h2>静置零偏校准</h2><p class="subtle">选择需要重新标定的物理节点，放稳后采集。当前节点的采集与其他设备分开保存。</p><h3 id="single-node-title">先选择节点</h3>';
    const chooser=make("div","cal-node-selector","<label>当前物理节点</label>");chooser.append($("bodyDevice"));cal.insertBefore(chooser,cal.querySelector(".calibration-grid"));
    panels[2].append(calibrationCard,button("单节点重新标定 / 详细检测",()=>$("singleNodeCalibration").showModal()));
    panels[3].append($("calibration-workspace"));panels[4].innerHTML='<h2>完成与动作验证</h2><p>请依次前举、侧举、屈肘并检查人台响应。未完成的节点保持未标定提示。</p>';panels[4].append(button("返回实时总览",()=>navigate("dashboard")));
    panels[4].append(document.querySelector(".simple-init-row"));
    const dialog=make("dialog","single-node-dialog");dialog.id="singleNodeCalibration";dialog.append(button("关闭 ×",()=>dialog.close()),document.querySelector(".selected-device-card"));
    const singleActions=make("div","buttons");[["重新采集零偏","calibrate"],["取消采样","cancelCalibration"],["重置当前节点参考","bodyRewear"]].forEach(([text,id])=>{const b=button(text,()=>$(id).click());b.dataset.proxy=id;singleActions.append(b);});dialog.append(singleActions,make("p","subtle",'<span data-mirror="calibration">等待选择节点</span>'),button("重做方向标定 →",()=>{dialog.close();calibrationStep(3);}));
    dialog.append(make("p","subtle","方向标定沿用选定的上臂 / 前臂 / 手范围；请核对参与节点。"));panels[2].append(dialog);
    const sensors=make("div","single-node-sensors");["ax","ay","az","gx","gy","gz","mx","my","mz"].forEach((id,index)=>{const label=["加速度 X / g","加速度 Y / g","加速度 Z / g","角速度 X / °/s","角速度 Y / °/s","角速度 Z / °/s","磁场 X / mG","磁场 Y / mG","磁场 Z / mG"][index];const cell=make("div","",label+`<strong data-mirror="${id}">—</strong>`);sensors.append(cell);});dialog.append(sensors);
    const deviceSummary=make("section","glass status-card",'<span class="kicker">DEVICE STATE</span><h2>设备状态</h2><div class="transport-tiles"><div>♧ USB<strong data-mirror="usb-status">未连接</strong></div><div>◉ Wi-Fi<strong data-mirror="wifi-status">未连接</strong></div></div>');deviceSummary.append(button("设备与节点详情 →",()=>{navigate("calibration");calibrationStep(1);}));status.append(deviceSummary);
    // Keep quality, transport and calibration in reference order.
    status.insertBefore(deviceSummary,calibrationSummary);
    $("usb-connect").onclick=()=>{navigate("calibration");calibrationStep(0);$("transport").value="serial";$("transport").dispatchEvent(new Event("change"));};
    $("wifi-connect").onclick=()=>{navigate("calibration");calibrationStep(0);$("transport").value="wifi";$("transport").dispatchEvent(new Event("change"));};
    const records=$("view-records");records.innerHTML='<div class="page-heading"><span class="kicker">SESSION LIBRARY</span><h2>历史记录与数据导出</h2><p>完整采样、实际骨架帧与设备配置</p></div><div class="records-layout"><aside class="glass record-browser"><h2>动作会话</h2><div id="history-list"></div></aside><section class="glass record-preview"><span class="kicker">SELECTED SESSION</span><h2 id="history-title">选择一条记录</h2><pre id="history-meta">尚无会话详情</pre><button id="history-open" class="primary" disabled>打开姿态回放 →</button><h3>旧版 CSV 记录</h3></section><aside class="glass record-export"><h2>导出数据</h2><p>ZIP 包含全部原始采样、骨架帧、事件及配置。</p><button id="bodyExport" class="primary" disabled>导出完整 ZIP</button><p class="subtle">正在记录的会话须停止保存后才能导出。</p></aside></div>';
    const preview=make("div","history-charts",'<button id="history-preview" disabled>预览保存曲线</button><p id="preview-status" role="status">选择会话后读取曲线</p><label>加速度 / g<canvas id="history-chart-0"></canvas></label><label>角速度 / °/s<canvas id="history-chart-1"></canvas></label><label>磁场 / mG<canvas id="history-chart-2"></canvas></label>');records.querySelector(".record-preview").append(preview);$("history-preview").onclick=()=>previewHistory();
    const csvButton=button("导出原始采样 CSV",()=>previewHistory(true));csvButton.id="history-csv";csvButton.disabled=true;records.querySelector(".record-export").append(csvButton);records.querySelector(".record-browser").append(button("刷新会话",refreshHistory));
    const legacy=$("recordDialog"),legacyPanel=make("div","legacy-records");while(legacy.firstChild)legacyPanel.append(legacy.firstChild);legacy.replaceWith(legacyPanel);legacyPanel.id="recordDialog";legacyPanel.showModal=()=>navigate("records");legacyPanel.close=()=>{};records.querySelector(".record-preview").append(legacyPanel);$("closeDialog").hidden=true;
    const replay=$("view-replay");replay.innerHTML='<div class="page-heading"><span class="kicker">POSE REPLAY</span><h2>姿态回放</h2><p id="replay-source">尚未载入会话，请从历史记录选择</p></div><div id="replay-model"></div><div id="replay-controls" class="glass"></div><div id="replay-charts"></div>';
    const controls=$("replay-controls");["bodyRefreshSessions","bodySessions","bodyReplayOpen","bodyReplayPlay","bodyReplayPause","bodyReplayClose","bodyReplaySeek","bodyReplayTime"].forEach(id=>controls.append($(id)));
    controls.append(button("选择历史记录",()=>navigate("records")));replay.append($("playback"));
    const previousFrame=button("前一帧",()=>seekDelta(-1/30)),nextFrame=button("后一帧",()=>seekDelta(1/30));previousFrame.dataset.replayAction="step";nextFrame.dataset.replayAction="step";controls.append(previousFrame,nextFrame);
    const speed=make("label","","播放速度<select id=\"replay-speed\"><option value=\"0.5\">0.5×</option><option value=\"1\" selected>1×</option><option value=\"2\">2×</option></select>");controls.append(speed);
    let speedTimer=null,speedTime=0,speedWall=0;
    function seekDelta(delta){if(bodyState?.mode!=="REPLAY")return;root.BodyApp.command("replay_pause");root.BodyApp.command("replay_seek",{time_s:Math.max(0,Math.min(bodyState.replay.duration,bodyState.replay.time_s+delta))});}
    function stopSpeed(){clearInterval(speedTimer);speedTimer=null;}
    function speedPlay(){stopSpeed();const rate=Number($("replay-speed").value);if(rate===1){root.BodyApp.command("replay_play");return;}if(bodyState?.mode!=="REPLAY")return;root.BodyApp.command("replay_pause");speedTime=bodyState.replay.time_s;speedWall=performance.now();speedTimer=setInterval(()=>{if(bodyState?.mode!=="REPLAY"){stopSpeed();return;}const time=Math.min(bodyState.replay.duration,speedTime+(performance.now()-speedWall)/1000*rate);root.BodyApp.command("replay_seek",{time_s:time});if(time>=bodyState.replay.duration)stopSpeed();},100);}
    // Attach after the body controller has installed the original handlers.
    root.addEventListener("load",()=>{$("bodyReplayPlay").onclick=speedPlay;const pause=$("bodyReplayPause").onclick,close=$("bodyReplayClose").onclick;$("bodyReplayPause").onclick=()=>{stopSpeed();pause();};$("bodyReplayClose").onclick=()=>{stopSpeed();close();};$("replay-speed").onchange=()=>{if(speedTimer||bodyState?.replay?.playing)speedPlay();};$("bodyReplaySeek").addEventListener("input",stopSpeed);});
    $("view-advanced").append($("advanced"));
    $("recording").append(button("历史记录 / 导出",()=>navigate("records")));
    document.querySelector("footer").hidden=true;
    calibrationStep(0);root.addEventListener("hashchange",render);render();
    // Mirror only presentation text; original status elements stay owned by controllers.
    new MutationObserver(()=>{document.querySelectorAll("[data-mirror]").forEach(el=>{const text=$(el.dataset.mirror).textContent;if(el.textContent!==text)el.textContent=text;});document.querySelectorAll("[data-proxy]").forEach(el=>{const disabled=$(el.dataset.proxy).disabled;if(el.disabled!==disabled)el.disabled=disabled;});}).observe(main,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["disabled"]});
  }
  const api={routeFromHash,applyRoute,navigate,current:()=>active,update,refreshHistory,start,calibrationStep};root.AppNavigation=api;
  if(typeof module!=="undefined")module.exports=api;
  if(root.document)start();
})(globalThis);
