"use strict";
(function(root){
  const ROUTES=["dashboard","calibration","records","trash","replay","advanced"];
  const names={dashboard:"实时总览",calibration:"设备标定",records:"历史记录与导出",trash:"回收站",replay:"姿态回放",advanced:"高级设置"};
  const routeFromHash=hash=>{const value=String(hash||"").replace(/^#\/?/,"");return ROUTES.includes(value)?value:"dashboard";};
  function applyRoute(route,{views,links}){const selected=ROUTES.includes(route)?route:"dashboard";views.forEach(view=>view.hidden=view.dataset.view!==selected);links.forEach(link=>{link.classList.toggle("active",link.dataset.route===selected);link.setAttribute("aria-current",link.dataset.route===selected?"page":"false");});return selected;}
  let active="dashboard",bodyState=null,step=0,items=[],historySelection=null,archive=null,historyGeneration=0,replayFrames=null,replaySession=null;
  let historyRequest=0,trashRequest=0;
  const $=id=>document.getElementById(id);
  function navigate(route){
    const next=routeFromHash("#/"+route),hash="#/"+next;
    if(root.location.hash!==hash)root.history.pushState(null,"",hash);
    render();
    return active;
  }
  function render(){
    if($("history-menu")?.matches(":popover-open"))$("history-menu").hidePopover();
    active=applyRoute(routeFromHash(root.location.hash),{views:[...document.querySelectorAll(".app-view")],links:[...document.querySelectorAll("[data-route]")]});
    document.body.dataset.route=active;document.querySelector("h1").textContent=names[active];
    const hero=document.querySelector(".hero-panel"),charts=$("telemetry");
    if(active==="dashboard"){$("overview").insertBefore(hero,document.querySelector(".status-rail"));$("view-dashboard").append(charts);}
    if(active==="calibration")$("calibration-model").append(hero);
    if(active==="replay"){$("replay-model").append(hero);$("replay-charts").append(charts);}
    hero.querySelector("h2").textContent=active==="replay"?"保存姿态回放":"实时人体姿态";
    charts.querySelector("h2").textContent=active==="replay"?"保存传感器曲线":"实时传感器曲线";
    if(active==="records"){refreshHistory();root.refreshLegacySessions?.();}
    if(active==="trash")refreshTrash();
    document.dispatchEvent(new CustomEvent("app-route-change",{detail:{route:active}}));
  }
  function make(tag,className,html=""){const element=document.createElement(tag);element.className=className;element.innerHTML=html;return element;}
  function button(text,action){const b=make("button","",text);b.type="button";b.onclick=action;return b;}
  function calibrationStep(index){step=index;document.querySelectorAll("[data-step]").forEach(b=>{b.classList.toggle("active",Number(b.dataset.step)===step);b.setAttribute("aria-selected",String(Number(b.dataset.step)===step));});
    document.querySelectorAll(".cal-step-content").forEach((p,i)=>p.hidden=i!==step);
  }
  async function refreshHistory(){
    const request=++historyRequest,list=$("history-list");
    try{
      const result=await sessionRequest("/api/body/recordings");
      if(request!==historyRequest)return;
      items=result.items||[];
      $("history-capacity").textContent=`${items.length} / ${result.limit} 条`;
      list.replaceChildren();
      for(const protectedGroup of [false,true]){
        const group=items.filter(item=>Boolean(item.calibration_protected)===protectedGroup);
        if(!group.length)continue;
        list.append(make("h3","history-group",protectedGroup?"标定":"动作会话"));
        group.forEach(item=>list.append(historyRow(item)));
      }
      if(!items.length)list.textContent="尚无动作记录。连接设备后，在总览开始记录。";
      const selected=historySelection?.id||$("bodySessions").value;
      selectHistory(items.find(item=>item.id===selected)||items[0]||null);
    }catch(error){if(request===historyRequest)list.textContent=error.message;}
  }
  function selectHistory(item){
    if(historySelection?.id!==item?.id){
      archive=null;historyGeneration++;
      for(let i=0;i<3;i++){
        const canvas=$("history-chart-"+i);
        canvas.getContext("2d").clearRect(0,0,canvas.width,canvas.height);
      }
      $("preview-status").textContent="选择会话后读取曲线";
    }
    historySelection=item;
    if(!item){
      $("history-title").textContent="选择一条记录";$("history-meta").textContent="尚无会话详情";
      for(const id of ["history-open","history-preview","history-csv","bodyExport"])$(id).disabled=true;
      return;
    }
    const id=item.id||item.session;$("history-title").textContent=id;$("history-meta").textContent=JSON.stringify({状态:item.status||"未知",开始时间:sessionTime(item),时长秒:item.duration_s??"—",采样数:item.counts?.samples??0,标定保护:item.calibration_protected?"已启用":"—",引用测量:item.referenced_by||[],骨架帧:item.counts?.body_frames??0,来源:item.source_types||[],事件:item.counts?.events??0},null,2);$("bodySessions").value=id;$("bodySessions").dispatchEvent(new Event("change"));
    const activeRecording=bodyState?.recording?.active&&bodyState.recording.session===id;
    $("bodyExport").disabled=activeRecording;$("bodyExport").onclick=async()=>{const b=$("bodyExport");b.disabled=true;b.setAttribute("aria-busy","true");$("preview-status").textContent="正在准备完整 ZIP…";try{const response=await fetch(`/api/body/recordings/${encodeURIComponent(id)}/download`);if(!response.ok)throw new Error("导出失败，请确认会话已停止并完整保存");const url=URL.createObjectURL(await response.blob()),link=document.createElement("a");link.href=url;link.download=id+".zip";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$("preview-status").textContent="完整 ZIP 已交给浏览器保存";}catch(error){$("preview-status").textContent=error.message;}finally{b.disabled=false;b.removeAttribute("aria-busy");}};
    $("history-open").disabled=activeRecording;$("history-open").onclick=()=>{$("bodyReplayOpen").click();navigate("replay");};
    $("history-preview").disabled=activeRecording;$("history-csv").disabled=activeRecording;
  }
  async function sessionRequest(url,method="GET",data){
    const options={method};
    if(data!==undefined){options.headers={"Content-Type":"application/json"};options.body=JSON.stringify(data);}
    const response=await fetch(url,options);
    if(response.status===204)return null;
    const result=await response.json();
    if(!response.ok)throw new Error(typeof result.detail==="string"?result.detail:"会话操作失败");
    return result;
  }
  function sessionTime(item){
    return Number.isFinite(item.started_unix)?new Date(item.started_unix*1000).toLocaleString():"未知";
  }
  function historyRow(item){
    const row=make("div","history-row"),choose=button("",()=>selectHistory(item)),more=button("⋯",()=>openSessionMenu(item,more));
    choose.textContent=item.id;
    choose.className="history-item";
    more.className="history-more";
    more.setAttribute("aria-label",item.id+" 的操作");
    more.setAttribute("aria-controls","history-menu");
    more.setAttribute("aria-haspopup","true");
    row.oncontextmenu=event=>{event.preventDefault();openSessionMenu(item,more,event);};
    row.append(choose,more);
    return row;
  }
  function busyReason(item){
    if(!bodyState)return item.busy_reason;
    const recording=bodyState.recording;
    if(recording?.session===item.id&&(recording.active||recording.saving))return "请先停止录制并等待保存完成";
    if(bodyState.replay?.session===item.id)return "请先退出该会话的回放";
    return null;
  }
  function openSessionMenu(item,anchor,event){
    const menu=$("history-menu");
    if(menu.matches(":popover-open"))menu.hidePopover();
    const busy=busyReason(item);
    const reason=busy||(item.calibration_protected?"请先解除标定保护":null);
    const remove=button("删除记录",()=>{menu.hidePopover();confirmRecycle(item);});
    const mark=button(item.calibration_protected?"解除标定保护":"标记为标定",async()=>{
      menu.hidePopover();
      try{
        await sessionRequest(`/api/body/recordings/${encodeURIComponent(item.id)}/calibration`,"PUT",{protected:!item.calibration_protected});
        await refreshHistory();
        $("history-status").textContent=item.calibration_protected?"已解除标定保护":"已标记为标定";
      }catch(error){$("history-status").textContent=error.message;}
    });
    remove.disabled=Boolean(reason);mark.disabled=Boolean(busy);
    menu.replaceChildren(remove,mark);
    if(reason){const note=make("p","subtle");note.textContent=reason;menu.append(note);}
    menu.showPopover();
    const anchorBox=anchor.getBoundingClientRect(),size=menu.getBoundingClientRect();
    menu.style.left=Math.max(0,Math.min(event?.clientX??anchorBox.left,root.innerWidth-size.width))+"px";
    menu.style.top=Math.max(0,Math.min(event?.clientY??anchorBox.bottom,root.innerHeight-size.height))+"px";
    (remove.disabled?mark:remove).focus();
  }
  function confirmRecycle(item){
    const dialog=$("history-delete"),submit=$("history-delete-submit"),cancel=$("history-delete-cancel");
    $("history-delete-details").textContent=`会话 ${item.id}，录制于 ${sessionTime(item)}，共 ${item.counts?.samples??0} 个样本。`;
    $("history-delete-reference").textContent=item.referenced_by?.length?`以下测量复算会用到它：${item.referenced_by.join("、")}`:"";
    $("history-delete-error").textContent="";
    submit.onclick=async()=>{
      submit.disabled=cancel.disabled=true;
      try{
        await sessionRequest(`/api/body/recordings/${encodeURIComponent(item.id)}`,"DELETE");
        dialog.close();
        $("bodyRefreshSessions").click();
        await refreshHistory();
        $("history-status").textContent="已移入 Windows 回收站";
      }catch(error){$("history-delete-error").textContent=error.message;}
      finally{submit.disabled=cancel.disabled=false;}
    };
    dialog.showModal();
    cancel.focus();
  }
  async function refreshTrash(){
    const request=++trashRequest,list=$("trash-list");
    list.textContent="读取回收站中…";
    try{
      const result=await sessionRequest("/api/body/trash");
      if(request!==trashRequest)return;
      $("trash-capacity").textContent=`${result.items.length} / ${result.limit} 条`;
      list.replaceChildren();
      if(!result.items.length)list.textContent="回收站里没有本开发台的会话。";
      for(const item of result.items){
        const row=make("div","trash-row"),info=make("div",""),title=make("strong",""),detail=make("p","subtle");
        title.textContent=item.id;
        const deleted=item.deleted_at?new Date(item.deleted_at).toLocaleString():"未知";
        detail.textContent=`录制于 ${sessionTime(item)} · ${item.counts?.samples??"未知"} 个样本 · 移入于 ${deleted}`;
        const restore=button("还原",async()=>{
          restore.disabled=true;
          try{
            await sessionRequest(`/api/body/trash/${encodeURIComponent(item.trash_id)}/restore`,"PUT");
            $("bodyRefreshSessions").click();
            $("trash-status").textContent=`已还原 ${item.id}`;
            await refreshTrash();
          }catch(error){$("trash-status").textContent=error.message;restore.disabled=false;}
        });
        info.append(title,detail);row.append(info,restore);list.append(row);
      }
    }catch(error){if(request===trashRequest)list.textContent=error.message;}
  }
  async function loadArchive(){if(archive)return archive;const id=historySelection?.id||historySelection?.session;if(!id)throw new Error("请先选择会话");const response=await fetch(`/api/body/recordings/${encodeURIComponent(id)}/download`);if(!response.ok)throw new Error("无法读取记录，请先停止录制");const buffer=await response.arrayBuffer();return buffer;}
  async function previewHistory(){const generation=historyGeneration,b=$("history-preview");b.disabled=true;b.setAttribute("aria-busy","true");$("preview-status").textContent="读取保存数据中…";try{const buffer=await loadArchive();if(generation!==historyGeneration)return;archive=buffer;const text=await root.SessionArchive.extract(buffer,"body_frames.jsonl");if(generation!==historyGeneration)return;const rows=text.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
      const stride=Math.max(1,Math.ceil(rows.length/400)),shown=rows.filter((_,i)=>i%stride===0);["accel","gyro","mag"].forEach((key,index)=>{const canvas=$("history-chart-"+index),ctx=canvas.getContext("2d"),box=canvas.getBoundingClientRect();canvas.width=box.width*2;canvas.height=box.height*2;ctx.scale(2,2);const samples=shown.map(row=>row.data.selected_node||row.data.devices?.[0]).map(d=>d?.[key]||[0,0,0]);let range=Math.max(.01,...samples.flat().map(Math.abs));["#ff6573","#49e39e","#617cff"].forEach((color,axis)=>{ctx.strokeStyle=color;ctx.beginPath();samples.forEach((s,i)=>{const x=i*box.width/Math.max(1,samples.length-1),y=box.height/2-s[axis]/range*(box.height*.4);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();});});
      $("preview-status").textContent=`已显示保存帧曲线 · ${rows.length} 帧 · 预览最多 400 点`;
    }catch(error){$("preview-status").textContent=error.message;}finally{b.disabled=false;b.removeAttribute("aria-busy");}}
  async function exportMotionCsv(){
    const id=historySelection?.id||historySelection?.session;
    if(!id)return;
    const button=$("history-csv"),status=$("preview-status");
    button.disabled=true;
    button.setAttribute("aria-busy","true");
    try{
      const response=await fetch(`/api/body/recordings/${encodeURIComponent(id)}/motion-csv`);
      if(!response.ok)throw new Error("无法读取单节点结果，请确认已运行位移测量工具并重启开发台加载新版");
      const url=URL.createObjectURL(await response.blob()),link=document.createElement("a");
      link.href=url;
      link.download=id+"-single_node_motion.csv";
      link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
      status.textContent="已导出单节点运动结果 CSV";
    }catch(error){status.textContent=error.message;}
    finally{button.disabled=false;button.removeAttribute("aria-busy");}
  }
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
    for(const [name,transport] of [["usb","serial"],["wifi","wifi"]]){const endpoints=(state.endpoints||[]).filter(e=>e.transport===transport);$(name+"-status").textContent=endpoints.some(e=>e.status==="connected"||(e.status==null&&e.connected===true))?"已连接":endpoints.some(e=>e.status==="connecting")?"连接中…":"未连接";}
  }
  async function loadReplaySeries(session){try{const response=await fetch(`/api/body/recordings/${encodeURIComponent(session)}/download`);if(!response.ok)throw new Error("无法读取回放曲线");const text=await root.SessionArchive.extract(await response.arrayBuffer(),"body_frames.jsonl");if(replaySession===session)replayFrames=text.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(replaySession===session)$("replay-source").textContent="姿态可回放；曲线未加载："+error.message;}}
  function start(){
    const main=document.querySelector("main");main.className="view-stack";
    ROUTES.forEach(route=>{const v=make("section","app-view");v.id="view-"+route;v.dataset.view=route;main.append(v);});
    const nav=document.querySelector(".nav-links");nav.replaceChildren();["⌂","◎","▤","♲","▷","⚙"].forEach((icon,i)=>{const route=ROUTES[i],label=["总览","标定","记录","回收站","回放","高级"][i],b=button(`<span class="nav-icon">${icon}</span><span>${label}</span>`,()=>navigate(route));b.className="nav-item";b.title=names[route];b.dataset.route=route;nav.append(b);});
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
    const historyTools=make("div","session-tools",'<span id="history-capacity" class="badge">—</span><p id="history-status" class="subtle" role="status"></p>');
    historyTools.insertBefore(button("打开回收站",()=>navigate("trash")),historyTools.lastChild);
    records.querySelector(".record-browser").insertBefore(historyTools,$("history-list"));
    const menu=make("div","session-menu");
    menu.id="history-menu";
    menu.setAttribute("popover","auto");
    main.append(menu);
    const deleteDialog=make("dialog","session-delete",'<h2 id="history-delete-title">删除记录</h2><p id="history-delete-details"></p><p>整个会话将移入 Windows 回收站，包含原始采样、CSV 和测量摘要。</p><p id="history-delete-reference"></p><p id="history-delete-error" class="subtle" role="alert"></p><div class="buttons"><button id="history-delete-cancel" type="button">取消</button><button id="history-delete-submit" type="button">移入回收站</button></div>');
    deleteDialog.id="history-delete";
    deleteDialog.setAttribute("aria-labelledby","history-delete-title");
    main.append(deleteDialog);
    $("history-delete-cancel").onclick=()=>deleteDialog.close();
    deleteDialog.oncancel=event=>{if($("history-delete-submit").disabled)event.preventDefault();};
    const trash=$("view-trash");
    trash.innerHTML='<div class="page-heading"><h2>回收站</h2><p>本开发台移入 Windows 回收站的会话</p></div><section class="glass trash-panel"><div id="trash-tools" class="session-tools"><span id="trash-capacity" class="badge">—</span></div><p id="trash-status" class="subtle" role="status"></p><div id="trash-list"></div></section>';
    $("trash-tools").append(button("返回历史记录",()=>navigate("records")),button("刷新回收站",refreshTrash));
    const preview=make("div","history-charts",'<button id="history-preview" disabled>预览保存曲线</button><p id="preview-status" role="status">选择会话后读取曲线</p><label>加速度 / g<canvas id="history-chart-0"></canvas></label><label>角速度 / °/s<canvas id="history-chart-1"></canvas></label><label>磁场 / mG<canvas id="history-chart-2"></canvas></label>');records.querySelector(".record-preview").append(preview);$("history-preview").onclick=previewHistory;
    const csvButton=button("导出单节点运动结果 CSV",exportMotionCsv);csvButton.id="history-csv";csvButton.disabled=true;records.querySelector(".record-export").append(csvButton);records.querySelector(".record-browser").append(button("刷新会话",refreshHistory));
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
