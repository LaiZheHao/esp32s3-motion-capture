"use strict";
(() => {
  const $ = id => document.getElementById(id);
  let state = null, pending = false, lastSolution = null;
  const degrees = q => {
    const [w,x,y,z]=q, d=180/Math.PI;
    return [Math.atan2(2*(w*x+y*z),1-2*(x*x+y*y))*d,
      Math.asin(Math.max(-1,Math.min(1,2*(w*y-z*x))))*d,
      Math.atan2(2*(w*z+x*y),1-2*(y*y+z*z))*d];
  };
  function draw(solution, fresh) {
    const c=$("arm"), scale=window.devicePixelRatio||1, box=c.getBoundingClientRect();
    c.width=Math.round(box.width*scale);c.height=Math.round(box.height*scale);
    const ctx=c.getContext("2d");ctx.scale(scale,scale);
    const w=box.width,h=box.height;
    ctx.font="14px system-ui";ctx.fillStyle="#587080";
    if(!solution){ctx.fillText("等待两节点在线并建立佩戴参考",20,32);return;}
    const view=$("view").value;
    const project = v => view==="side"?[v[0],v[2]]:view==="front"?[-v[1],v[2]]:[v[0],v[1]];
    const unit=Math.min(w*.72,h*.73)/Math.max(.56,...(state?.lengths||[.3,.26]).map(x=>x*2));
    const point=v=>{const [x,y]=project(v);return[w*.42+x*unit,h*.27-y*unit];};
    const origin=point([0,0,0]);ctx.strokeStyle="#dce7ed";ctx.lineWidth=1;
    for(let i=-6;i<=6;i++){const y=origin[1]+i*.1*unit;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
    function bone(points,color,dash){ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=6;ctx.setLineDash(dash);points.forEach((v,i)=>{const [x,y]=point(v);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();ctx.setLineDash([]);for(const v of points){const [x,y]=point(v);ctx.beginPath();ctx.arc(x,y,6,0,2*Math.PI);ctx.fillStyle=color;ctx.fill();}}
    ctx.globalAlpha=fresh?1:.35;
    bone([solution.shoulder,solution.elbow,solution.raw_wrist],"#ad5b10",[8,5]);
    if($("constraint").checked)bone([solution.shoulder,solution.elbow,solution.constrained_wrist],"#007d81",[]);
    ctx.globalAlpha=1;ctx.fillStyle="#17354a";
    for(const [label,v] of [["肩",solution.shoulder],["肘",solution.elbow],["腕（原始）",solution.raw_wrist]]){const [x,y]=point(v);ctx.fillText(label,x+10,y-8);}
    ctx.fillStyle=fresh?"#587080":"#9a400a";
    ctx.fillText(fresh?"网格间距 10 cm · 肩部固定":"数据失鲜：保持最后姿态，未继续积分",15,h-15);
  }
  function render(s){
    state=s;
    for(const role of ["upper","fore"]){const n=s.nodes[role];
      $(role+"State").textContent=n.valid?(n.rest?"在线 · VQF 判定静止":"在线 · 尚未判定静止"):(n.connected?"等待静置校准或新帧":"未连接："+(n.message||"等待串口"));
      $(role+"Angles").textContent=n.valid&&n.quaternion?degrees(n.quaternion).map((v,i)=>["X","Y","Z"][i]+" "+v.toFixed(1)+"°").join(" / "):"—";
      $(role+"Detail").textContent=[n.device||n.expected,n.firmware||"",`姿态帧 ${n.frames} · 缺帧 ${n.missing} · 异常 ${n.invalid}`,n.age_s===null?"":`距最新帧 ${Math.round(n.age_s*1000)}ms`].join(" · ");
    }
    $("status").textContent=s.calibrated&&!s.valid?"数据失鲜：暂停骨架更新。"+s.message:s.message;
    $("status").className=s.calibrated&&!s.valid?"warning":"";
    $("reference").disabled=s.calibrating||!Object.values(s.nodes).every(n=>n.valid&&n.rest);
    if(!s.calibrated){lastSolution=null;$("armMetrics").textContent="佩戴并采集中立姿态后显示";$("constraintMetrics").textContent="";$("wrist").textContent="";}
    if(s.solution){lastSolution=s.solution;const a=s.solution;
      $("armMetrics").textContent=`肘部弯曲 ${a.flexion_deg.toFixed(1)}° · 约束屈肘 ${a.limited_hinge_deg.toFixed(1)}°`;
      $("constraintMetrics").textContent=`约束移除旋转 ${a.removed_rotation_deg.toFixed(1)}° · 腕位置修改 ${(a.wrist_difference_m*100).toFixed(1)} cm`+(a.hinge_singular?" · 轴投影奇异，请回到中立姿态":"");
      $("wrist").textContent="原始腕位置 X/Y/Z（相对肩部，m）："+a.raw_wrist.map(v=>v.toFixed(3)).join(" / ");
    }
    $("timing").textContent=`显示延迟 ${s.display_delay_s*1000} ms · 最新接收时间差 ${s.latest_arrival_skew_s===null?"—":(s.latest_arrival_skew_s*1000).toFixed(1)+" ms"}（不等于采样同步误差）`+(s.capture?.dropped?` · 记录丢弃 ${s.capture.dropped} 条`:"")+(s.capture?.error?" · 记录失败："+s.capture.error:"");
    draw(lastSolution,!!s.solution);
  }
  $("reference").onclick=async()=>{try{$("requestError").textContent="";const r=await fetch("/reference",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({lengths:[Number($("upperLength").value)/100,Number($("foreLength").value)/100]})});if(!r.ok)throw Error(await r.text());}catch(e){$("requestError").textContent=e.message;}};
  for(const id of ["constraint","view"])$(id).onchange=()=>draw(lastSolution,!!state?.solution);
  window.addEventListener("resize",()=>draw(lastSolution,!!state?.solution));
  async function poll(){if(pending)return;pending=true;try{const r=await fetch("/api",{cache:"no-store"});if(!r.ok)throw Error("HTTP "+r.status);render(await r.json());}catch(e){$("status").textContent="连接中断："+e.message;$("reference").disabled=true;for(const role of ["upper","fore"]){$(role+"State").textContent="服务连接中断";$(role+"Angles").textContent="—";}state=null;draw(lastSolution,false);}finally{pending=false;}}
  poll();setInterval(poll,40);
})();
