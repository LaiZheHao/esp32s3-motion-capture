"use strict";
(function(root){
  const ROUTES=["dashboard","calibration","records","trash","replay","advanced"];
  const names={dashboard:"实时总览",calibration:"设备标定",records:"历史记录与导出",trash:"回收站",replay:"姿态回放",advanced:"高级设置"};
  const routeFromHash=hash=>{const value=String(hash||"").replace(/^#\/?/,"");return ROUTES.includes(value)?value:"dashboard";};
  function applyRoute(route,{views,links}){const selected=ROUTES.includes(route)?route:"dashboard";views.forEach(view=>view.hidden=view.dataset.view!==selected);links.forEach(link=>{link.classList.toggle("active",link.dataset.route===selected);link.setAttribute("aria-current",link.dataset.route===selected?"page":"false");});return selected;}
  let active="dashboard",bodyState=null,step=0,items=[],historySelection=null,historyGeneration=0,replayFrames=null,replaySession=null;
  let historyRequest=0,trashRequest=0;
  let trashItems=[];
  let exportingMotion=false, exportingZip=false, replayPreview=null, replayPreviewRequest=0, historyReplayView=null;
  const motionFaces=["+X","-X","+Y","-Y","+Z","-Z"];
  const motionFaceCache="imu-displacement-calibration-faces";
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
    if(active!=="records"&&$("history-replay"))closeHistoryReplay();
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
      selectHistory(items.find(item=>item.id===selected)||items[0]||null,true);
    }catch(error){if(request===historyRequest)list.textContent=error.message;}
  }
  function selectHistory(item, reload=false){
    const changed=historySelection?.id!==item?.id||historySelection?.status!==item?.status;
    historySelection=item;
    const id=item?.id||item?.session;
    const count=item?.counts?.samples??0;
    const duration=Number.isFinite(item?.duration_s)?item.duration_s.toFixed(2)+" 秒":"—";
    const description=item?.description||{};
    $("history-title").textContent=item?sessionLabel(item):"选择一条记录";
    $("history-notes").textContent=description.notes||"";
    $("history-notes").hidden=!description.notes;
    $("history-edit").disabled=!item;
    $("history-edit").onclick=()=>openSessionEdit(item);
    $("history-meta").textContent=item
      ?[sessionTime(item),duration,count+" 个样本",item.calibration_protected?"标定":null].filter(Boolean).join(" · ")
      :"";
    $("history-open").disabled=item?.status!=="complete"||!item.counts?.body_frames;
    $("history-open").onclick=()=>openHistoryReplay(item);
    $("bodyExport").disabled=!item||exportingZip||isRecording(item);
    $("history-measure").disabled=exportingMotion||!items.some(canMeasure);
    $("bodySessions").value=id||"";
    $("bodySessions").dispatchEvent(new Event("change"));
    for(const row of $("history-list").querySelectorAll(".history-item")){
      row.setAttribute("aria-pressed",String(row.dataset.session===id));
    }
    if(changed)closeHistoryReplay();
    if(changed||reload)previewHistory(item);
  }

  function canMeasure(item){
    return item.status==="complete"&&(item.counts?.samples??0)>0
      && (!item.source_types?.length||item.source_types.every(source=>source==="real"));
  }
  function isRecording(item){
    const recording=bodyState?.recording;
    return item&&(recording
      ? recording.session===item.id&&(recording.active||recording.saving)
      : Boolean(item.busy_reason&&item.status!=="complete"));
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
  function sessionLabel(item){
    const data=item.description||{};
    const pieces=[data.title||item.id,data.calibration_method,data.calibration_face&&data.calibration_face+" 朝上"];
    return pieces.filter(Boolean).join(" · ");
  }
  function historyRow(item){
    const row=make("div","history-row"),choose=button("",()=>selectHistory(item)),more=button("⋯",()=>openSessionMenu(item,more));
    choose.textContent=sessionLabel(item);
    choose.title=item.id;
    choose.className="history-item";
    choose.dataset.session=item.id;
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
    const edit=button("编辑会话信息",()=>{menu.hidePopover();openSessionEdit(item);});
    edit.disabled=Boolean(isRecording(item));
    menu.replaceChildren(edit,mark,remove);
    if(reason){const note=make("p","subtle");note.textContent=reason;menu.append(note);}
    menu.showPopover();
    const anchorBox=anchor.getBoundingClientRect(),size=menu.getBoundingClientRect();
    menu.style.left=Math.max(0,Math.min(event?.clientX??anchorBox.left,root.innerWidth-size.width))+"px";
    menu.style.top=Math.max(0,Math.min(event?.clientY??anchorBox.bottom,root.innerHeight-size.height))+"px";
    (edit.disabled?mark:edit).focus();
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
    trashItems=[];
    $("trash-empty").disabled=true;
    $("trash-capacity").textContent="—";
    list.textContent="读取回收站中…";
    try{
      const result=await sessionRequest("/api/body/trash");
      if(request!==trashRequest)return;
      trashItems=result.items;
      $("trash-capacity").textContent=`${trashItems.length} / ${result.limit} 条`;
      $("trash-empty").disabled=!trashItems.length;
      list.replaceChildren();
      if(!trashItems.length)list.textContent="回收站里没有本开发台的会话。";
      for(const item of trashItems){
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
  function confirmEmptyTrash(){
    const trashIds=trashItems.map(item=>item.trash_id);
    if(!trashIds.length)return;
    const dialog=$("trash-empty-dialog"),submit=$("trash-empty-submit"),cancel=$("trash-empty-cancel");
    const status=$("trash-status");
    $("trash-empty-details").textContent=`将永久删除本开发台回收站中的全部 ${trashIds.length} 条会话及其文件。删除后无法还原。`;
    submit.onclick=async()=>{
      submit.disabled=cancel.disabled=true;
      status.textContent="正在清空回收站…";
      try{
        const result=await sessionRequest("/api/body/trash","DELETE",{trash_ids:trashIds});
        status.textContent=`已永久删除 ${result.deleted} 条会话`;
      }catch(error){status.textContent=error.message;}
      finally{
        dialog.close();
        submit.disabled=cancel.disabled=false;
        await refreshTrash();
      }
    };
    dialog.showModal();
    cancel.focus();
  }
  function openSessionEdit(item){
    if(!item)return;
    const dialog=$("history-edit-dialog"),form=$("history-edit-form"),status=$("history-edit-status");
    const description=item.description||{};
    for(const key of ["title","calibration_method","calibration_face","notes"]){
      form.elements.namedItem(key).value=description[key]||"";
    }
    $("history-edit-id").textContent=item.id;
    status.textContent="";
    form.onsubmit=async event=>{
      event.preventDefault();
      const changes=Object.fromEntries(new FormData(form));
      changes.calibration_face||=null;
      const actions=[...form.querySelectorAll("button")];
      actions.forEach(control=>control.disabled=true);
      try{
        await sessionRequest("/api/body/recordings/"+encodeURIComponent(item.id)+"/description","PUT",changes);
        dialog.close();
        await refreshHistory();
      }catch(error){status.textContent=error.message;}
      finally{actions.forEach(control=>control.disabled=false);}
    };
    dialog.showModal();
  }

  async function previewHistory(item){
    const generation=++historyGeneration,status=$("preview-status"),table=$("history-samples");
    const endpoint=$("history-endpoint");
    table.tHead.replaceChildren();
    table.tBodies[0].replaceChildren();
    table.hidden=true;
    endpoint.hidden=true;
    if(!item){status.textContent="从左侧选择一条记录。";return;}
    if(item.status!=="complete"){
      status.textContent="会话完整保存后可解算并预览。";
      return;
    }
    status.textContent="正在读取位移结果…";
    try{
      const result=await sessionRequest("/api/body/recordings/"+encodeURIComponent(item.id)+"/motion-preview");
      if(generation!==historyGeneration)return;
      if(!result.rows.length){
        status.textContent="该会话尚未解算。点击右侧「解算并导出 CSV」选择六面标定，也可只解算并预览。";
        return;
      }
      const header=table.tHead.insertRow();
      for(const title of result.columns){
        const cell=document.createElement("th");
        cell.scope="col";
        cell.textContent=title;
        header.append(cell);
      }
      for(const values of result.rows){
        const row=table.tBodies[0].insertRow();
        for(const value of values)row.insertCell().textContent=value;
      }
      table.hidden=false;
      status.textContent="与导出 CSV 一致，每秒一行。";
      if(result.endpoint){
        const {displacement_m,distance_m,duration_s}=result.endpoint;
        const xyz=displacement_m.map(value=>value.toFixed(3));
        endpoint.textContent=`实际终点（${duration_s.toFixed(3)} s） · X ${xyz[0]} / Y ${xyz[1]} / Z ${xyz[2]} m · 距起点 ${distance_m.toFixed(3)} m`;
        endpoint.hidden=false;
      }
    }catch(error){
      if(generation===historyGeneration)status.textContent=error.message;
    }
  }

  function closeHistoryReplay(){
    replayPreviewRequest++;
    if(replayPreview?.animation)cancelAnimationFrame(replayPreview.animation);
    replayPreview=null;
    $("history-replay").hidden=true;
    $("history-replay-toggle").disabled=true;
    $("history-replay-seek").disabled=true;
  }

  async function openHistoryReplay(item){
    closeHistoryReplay();
    const request=replayPreviewRequest,status=$("history-replay-status");
    const canvas=$("history-replay-canvas");
    $("history-replay").hidden=false;
    canvas.hidden=true;
    $("history-replay-time").textContent="—";
    status.textContent="正在读取保存的姿态…";
    try{
      const response=await fetch("/api/body/recordings/"+encodeURIComponent(item.id)+"/download");
      if(!response.ok)throw new Error("无法读取该会话的保存姿态");
      const text=await root.SessionArchive.extract(await response.arrayBuffer(),"body_frames.jsonl");
      if(request!==replayPreviewRequest)return;
      const frames=text.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
      if(!frames.length)throw new Error("该会话没有保存的姿态帧。");
      const duration=frames.at(-1).time_s;
      historyReplayView??=new root.BodyView.BodyView(canvas,{kind:"boards"});
      historyReplayView.reset();
      replayPreview={frames,duration,view:historyReplayView,playing:false,time:0};
      const kind=$("history-replay-kind");
      const measured=frames.some(frame=>frame.data.body_frame?.segments?.some(segment=>segment.measured));
      kind.value=measured?"fixed":"boards";
      kind.options[1].disabled=!measured;
      const seek=$("history-replay-seek");
      seek.max=duration;
      $("history-replay-toggle").disabled=seek.disabled=false;
      canvas.hidden=false;
      status.textContent=sessionLabel(item);
      drawHistoryReplay();
    }catch(error){
      if(request===replayPreviewRequest)status.textContent=error.message;
    }
  }

  function drawHistoryReplay(){
    const replay=replayPreview;
    if(!replay)return;
    let lo=0,hi=replay.frames.length;
    while(lo<hi){
      const mid=(lo+hi)>>1;
      if(replay.frames[mid].time_s<=replay.time)lo=mid+1;
      else hi=mid;
    }
    const frame=replay.frames[Math.max(0,lo-1)].data;
    replay.view.kind=$("history-replay-kind").value;
    replay.view.draw(frame.body_frame,{devices:frame.devices||[],mode:"REPLAY"});
    $("history-replay-seek").value=replay.time;
    $("history-replay-time").textContent=`${replay.time.toFixed(2)} / ${replay.duration.toFixed(2)} s`;
    $("history-replay-toggle").textContent=replay.playing?"暂停":"播放";
  }

  function toggleHistoryReplay(){
    const replay=replayPreview;
    if(!replay)return;
    replay.playing=!replay.playing;
    if(replay.playing){
      if(replay.time>=replay.duration)replay.time=0;
      replay.started=performance.now()-replay.time*1000;
      const next=now=>{
        if(replayPreview!==replay||!replay.playing)return;
        replay.time=Math.min(replay.duration,(now-replay.started)/1000);
        replay.playing=replay.time<replay.duration;
        drawHistoryReplay();
        if(replay.playing)replay.animation=requestAnimationFrame(next);
      };
      replay.animation=requestAnimationFrame(next);
    }else cancelAnimationFrame(replay.animation);
    drawHistoryReplay();
  }

  function downloadFile(blob, filename){
    const url=URL.createObjectURL(blob),link=document.createElement("a");
    link.href=url;
    link.download=filename;
    link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  async function exportHistoryZip(){
    const id=historySelection?.id;
    if(!id||exportingZip)return;
    const status=$("history-export-status");
    exportingZip=true;
    $("bodyExport").disabled=true;
    status.textContent="正在准备完整 ZIP…";
    try{
      const response=await fetch("/api/body/recordings/"+encodeURIComponent(id)+"/download");
      if(!response.ok)throw new Error("导出失败，请确认会话已停止并完整保存");
      downloadFile(await response.blob(),id+".zip");
      status.textContent="完整 ZIP 已交给浏览器保存";
    }catch(error){status.textContent=error.message;}
    finally{
      exportingZip=false;
      $("bodyExport").disabled=!historySelection||isRecording(historySelection);
    }
  }

  function selectOptions(select, list, placeholder, preferred){
    select.replaceChildren(new Option(placeholder,""));
    for(const item of list){
      const label=sessionLabel(item)+(item.calibration_protected?"（标定）":"")
        +(item.description?.title?" · "+item.id:"");
      select.add(new Option(label,item.id));
    }
    if(list.some(item=>item.id===preferred))select.value=preferred;
  }

  function updateMotionFaces(preferred){
    const session=$("history-measure-session").value;
    const eligible=items.filter(item=>canMeasure(item)&&item.id!==session);
    const options=[...eligible.filter(item=>item.calibration_protected),
      ...eligible.filter(item=>!item.calibration_protected)];
    document.querySelectorAll("#history-measure-faces select").forEach(select=>{
      const face=select.dataset.face;
      const taggedForFace=options.filter(item=>item.description?.calibration_face===face);
      const available=options.filter(item=>!item.description?.calibration_face||item.description.calibration_face===face);
      const selected=(preferred||{})[face]||select.value;
      selectOptions(select,available,"选择静置会话",selected);
      if(!select.value&&taggedForFace.length===1)select.value=taggedForFace[0].id;
    });
  }

  function openMotionExport(){
    if(exportingMotion)return;
    const dialog=$("history-measure-dialog"), select=$("history-measure-session");
    const eligible=items.filter(canMeasure);
    const motions=[...eligible.filter(item=>!item.calibration_protected),
      ...eligible.filter(item=>item.calibration_protected)];
    selectOptions(select,motions,"选择一条动作记录",historySelection?.id);
    if(!select.value&&motions.length===1)select.value=motions[0].id;
    let saved={};
    try{saved=JSON.parse(localStorage.getItem(motionFaceCache)||"{}")||{};}catch{}
    updateMotionFaces(saved);
    $("history-measure-error").textContent="";
    dialog.showModal();
    select.focus();
  }

  async function exportMeasuredMotion(event){
    event.preventDefault();
    if(exportingMotion)return;
    const form=event.currentTarget,dialog=$("history-measure-dialog"),error=$("history-measure-error");
    const id=$("history-measure-session").value;
    const faces=Object.fromEntries([...$("history-measure-faces").querySelectorAll("select")]
      .map(select=>[select.dataset.face,select.value]));
    if(!id||Object.values(faces).some(value=>!value)||new Set(Object.values(faces)).size!==motionFaces.length){
      error.textContent="请选择一条动作，以及六条不同方向的静置记录。";
      return;
    }
    const download=event.submitter?.value!=="preview";
    const start_still=$("history-measure-start").valueAsNumber,end_still=$("history-measure-end").valueAsNumber;
    exportingMotion=true;
    const controls=[...form.querySelectorAll("button, select, input")];
    controls.forEach(control=>control.disabled=true);
    error.textContent="正在解算所选记录…";
    try{
      const result=await sessionRequest("/api/body/recordings/"+encodeURIComponent(id)+"/measure-motion",
        "POST",{faces,start_still,end_still});
      try{localStorage.setItem(motionFaceCache,JSON.stringify(faces));}catch{}
      if(download)downloadFile(new Blob(["\ufeff",result.csv],{type:"text/csv;charset=utf-8"}),
        id+"-single_node_motion.csv");
      const position=result.summary.displacement_m.map(value=>value.toFixed(3));
      $("history-export-status").textContent=`${id} · 终点 X ${position[0]} / Y ${position[1]} / Z ${position[2]} m · ${download?"已提交 CSV 下载":"已生成预览"}`;
      dialog.close();
      await refreshHistory();
      const measured=items.find(item=>item.id===id);
      if(measured&&active==="records")selectHistory(measured);
    }catch(failure){error.textContent=failure.message;}
    finally{
      exportingMotion=false;
      controls.forEach(control=>control.disabled=false);
      $("history-measure").disabled=!items.some(canMeasure);
    }
  }
  function update(state){bodyState=state;
    $("bodyExport").disabled=!historySelection||exportingZip||isRecording(historySelection);
    $("history-edit").disabled=!historySelection||isRecording(historySelection);
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
    const records=$("view-records");
    records.innerHTML=`
      <div class="records-layout">
        <aside class="glass record-browser">
          <h2>动作会话</h2>
          <div id="history-list"></div>
        </aside>
        <section class="glass record-preview">
          <h2>数据预览</h2>
          <p id="history-title">选择一条记录</p>
          <p id="history-meta" class="subtle"></p>
          <p id="history-notes" class="subtle" hidden></p>
          <div class="buttons"><button id="history-open" disabled>打开姿态回放 →</button>
            <button id="history-edit" disabled>编辑会话信息</button></div>
          <p id="preview-status" role="status"></p>
          <p id="history-endpoint" hidden></p>
          <div class="tableScroll">
            <table id="history-samples" class="values" aria-label="位移结果预览" hidden>
              <thead></thead><tbody></tbody>
            </table>
          </div>
        </section>
        <aside class="glass record-export">
          <h2>导出数据</h2>
          <button id="history-measure" class="primary" disabled>解算并导出 CSV</button>
          <p>选一条动作和六面标定，生成单节点位移结果。</p>
          <button id="bodyExport" disabled>导出完整 ZIP</button>
          <p>包含所选会话的原始采样、骨架帧和配置。</p>
          <p id="history-export-status" role="status"></p>
          <section id="history-replay" class="history-replay" hidden>
            <div class="section-heading"><h3>姿态回放</h3><button id="history-replay-close" type="button">关闭</button></div>
            <p id="history-replay-status" role="status"></p>
            <canvas id="history-replay-canvas" aria-label="保存的板卡姿态" hidden></canvas>
            <div class="buttons"><button id="history-replay-toggle" type="button" disabled>播放</button>
              <output id="history-replay-time">—</output>
              <select id="history-replay-kind" aria-label="姿态视图">
                <option value="boards">板卡姿态</option><option value="fixed">人体姿态</option>
              </select></div>
            <input id="history-replay-seek" type="range" min="0" step="0.01" aria-label="回放时间" disabled>
          </section>
        </aside>
      </div>`;
    const measurement=make("dialog","session-measure",`
      <form id="history-measure-form">
        <h2 id="history-measure-title">解算并导出 CSV</h2>
        <label>动作会话<select id="history-measure-session" required></select></label>
        <fieldset id="history-measure-faces"><legend>六面静置标定</legend></fieldset>
        <div class="measure-fields">
          <label>起点静置（秒）<input id="history-measure-start" type="number" value="1" min="0.5" max="5" step="any" required></label>
          <label>终点静置（秒）<input id="history-measure-end" type="number" value="1" min="0.5" max="5" step="any" required></label>
        </div>
        <p id="history-measure-error" role="status"></p>
        <div class="buttons"><button id="history-measure-cancel" type="button">取消</button><button type="submit" value="preview">只解算并预览</button><button class="primary" type="submit" value="download">解算并下载</button></div>
      </form>`);
    measurement.id="history-measure-dialog";
    measurement.setAttribute("aria-labelledby","history-measure-title");
    main.append(measurement);
    for(const face of motionFaces){
      const label=make("label","",face+" 朝上");
      const select=document.createElement("select");
      select.dataset.face=face;
      select.required=true;
      label.append(select);
      $("history-measure-faces").append(label);
    }
    $("history-measure-session").onchange=()=>updateMotionFaces();
    $("history-measure").onclick=openMotionExport;
    $("history-measure-form").onsubmit=exportMeasuredMotion;
    $("history-measure-cancel").onclick=()=>measurement.close();
    measurement.oncancel=event=>{if(exportingMotion)event.preventDefault();};
    $("bodyExport").onclick=exportHistoryZip;
    $("history-replay-close").onclick=closeHistoryReplay;
    $("history-replay-toggle").onclick=toggleHistoryReplay;
    $("history-replay-kind").onchange=drawHistoryReplay;
    $("history-replay-seek").oninput=event=>{
      if(!replayPreview)return;
      replayPreview.time=event.target.valueAsNumber;
      if(replayPreview.playing)replayPreview.started=performance.now()-replayPreview.time*1000;
      drawHistoryReplay();
    };
    const edit=make("dialog","session-measure",`
      <form id="history-edit-form">
        <h2 id="history-edit-title">编辑会话信息</h2>
        <p id="history-edit-id" class="subtle"></p>
        <label>显示名称<input name="title" maxlength="80"></label>
        <label>标定方法<input name="calibration_method" maxlength="80" placeholder="例如：Wi-Fi 六面静置"></label>
        <label>原始轴朝向<select name="calibration_face"><option value="">未指定</option>
          ${motionFaces.map(face=>`<option value="${face}">${face} 朝上</option>`).join("")}</select></label>
        <label>备注<textarea name="notes" maxlength="1000" rows="3"></textarea></label>
        <p id="history-edit-status" role="status"></p>
        <div class="buttons"><button id="history-edit-cancel" type="button">取消</button>
          <button type="submit" class="primary">保存</button></div>
      </form>`);
    edit.id="history-edit-dialog";
    edit.setAttribute("aria-labelledby","history-edit-title");
    main.append(edit);
    $("history-edit-cancel").onclick=()=>edit.close();
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
    const emptyTrashButton=button("一键清空",confirmEmptyTrash);
    emptyTrashButton.id="trash-empty";
    emptyTrashButton.disabled=true;
    $("trash-tools").append(button("返回历史记录",()=>navigate("records")),button("刷新回收站",refreshTrash),emptyTrashButton);
    const emptyTrashDialog=make("dialog","session-delete",'<h2 id="trash-empty-title">一键清空回收站</h2><p id="trash-empty-details"></p><div class="buttons"><button id="trash-empty-cancel" type="button">取消</button><button id="trash-empty-submit" type="button">永久删除</button></div>');
    emptyTrashDialog.id="trash-empty-dialog";
    emptyTrashDialog.setAttribute("aria-labelledby","trash-empty-title");
    emptyTrashDialog.setAttribute("aria-describedby","trash-empty-details");
    main.append(emptyTrashDialog);
    $("trash-empty-cancel").onclick=()=>emptyTrashDialog.close();
    emptyTrashDialog.oncancel=event=>{if($("trash-empty-submit").disabled)event.preventDefault();};
    records.querySelector(".record-browser").append(button("刷新会话",refreshHistory));
    const legacy=$("recordDialog");
    const legacyPanel=make("details","legacy-records","<summary>旧版 CSV 记录</summary>");
    while(legacy.firstChild)legacyPanel.append(legacy.firstChild);
    legacy.replaceWith(legacyPanel);
    legacyPanel.id="recordDialog";
    legacyPanel.showModal=()=>{navigate("records");legacyPanel.open=true;};
    legacyPanel.close=()=>{legacyPanel.open=false;};
    records.querySelector(".record-preview").append(legacyPanel);
    $("closeDialog").hidden=true;
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
