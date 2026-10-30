"use strict";
(function(root) {
  const COLORS={measured:"#6679ff",online:"#6679ff",initialized:"#6679ff",uninitialized:"#f0b45d",missing:"#46506a",unmeasured:"#46506a",stale:"#f0b45d",disconnected:"#8c5360",conflict:"#ff6d78",invalid:"#ff6d78"};
  function listSegments(frame) {
    const source=frame?.segments||frame?.bones||{};
    return Array.isArray(source)?source:Object.entries(source).map(([slot,value])=>({slot,...value}));
  }
  function vector(value,fallback=[0,0,0]) {return Array.isArray(value)&&value.length===3&&value.every(Number.isFinite)?value:fallback;}
  function segmentEnds(segment,frame) {
    const positions=frame?.positions||frame?.joints||{};
    const resolve=value=>typeof value==="string"?positions[value]:value;
    return [vector(resolve(segment.start||segment.origin||segment.start_position)),vector(resolve(segment.end||segment.tip||segment.end_position))];
  }
  function rotate(v,q) {
    const [w,x,y,z]=q||[1,0,0,0],[a,b,c]=v,tx=2*(y*c-z*b),ty=2*(z*a-x*c),tz=2*(x*b-y*a);
    return [a+w*tx+y*tz-z*ty,b+w*ty+z*tx-x*tz,c+w*tz+x*ty-y*tx];
  }
  function translatePoint(point,offset) {return vector(point).map((value,i)=>value+vector(offset)[i]);}
  function eulerDegrees(q) {
    if(!Array.isArray(q)||q.length!==4||!q.every(Number.isFinite))return null;
    const norm=Math.hypot(...q);if(norm<1e-9)return null;
    const [w,x,y,z]=q.map(value=>value/norm);
    return [Math.atan2(2*(w*x+y*z),1-2*(x*x+y*y)),Math.asin(Math.max(-1,Math.min(1,2*(w*y-z*x)))),Math.atan2(2*(w*z+x*y),1-2*(y*y+z*z))].map(value=>value*180/Math.PI);
  }
  function pointSegmentDistance(p,a,b) {
    const dx=b[0]-a[0],dy=b[1]-a[1],d=dx*dx+dy*dy;
    const t=d?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/d)):0;
    return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
  }
  class BodyView {
    constructor(canvas,{kind="fixed",onSelect=()=>{},anglePanel=null}={}) {
      this.canvas=canvas;this.kind=kind;this.onSelect=onSelect;this.yaw=0;this.elevation=.18;this.zoom=1;this.pan=[0,0];this.trail=[];this.hits=[];this.epoch=null;
      this.anglePanel=anglePanel;this.angleKey=null;this.angleRows=[];
      let drag=null;
      canvas.addEventListener("pointerdown",event=>{drag={x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,pan:event.shiftKey};canvas.setPointerCapture(event.pointerId);});
      canvas.addEventListener("pointermove",event=>{if(!drag)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(drag.pan){this.pan[0]+=dx;this.pan[1]+=dy;}else{this.yaw+=dx*.009;this.elevation=Math.max(-1.2,Math.min(1.2,this.elevation+dy*.009));}drag.x=event.clientX;drag.y=event.clientY;});
      canvas.addEventListener("pointerup",event=>{if(drag&&Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)<5){const box=canvas.getBoundingClientRect(),point=[event.clientX-box.left,event.clientY-box.top];const found=this.hits.map(item=>({...item,d:pointSegmentDistance(point,item.a,item.b)})).sort((a,b)=>a.d-b.d)[0];if(found&&found.d<15)this.onSelect(found.slot,found.device_id);}drag=null;});
      canvas.addEventListener("pointercancel",()=>{drag=null;});
      canvas.addEventListener("wheel",event=>{event.preventDefault();this.setZoom(this.zoom*Math.exp(-event.deltaY*.001));},{passive:false});
    }
    setZoom(value){this.zoom=Math.max(.45,Math.min(2.8,Number(value)||1));return this.zoom;}
    reset(){this.yaw=0;this.elevation=.18;this.zoom=1;this.pan=[0,0];}
    clearTrail(){this.trail=[];}
    draw(frame,{selectedSlot,devices=[],position=[0,0,0],positionSource="off",mode="LIVE",epoch=null}={}) {
      const canvas=this.canvas,box=canvas.getBoundingClientRect();if(!box.width||!box.height)return;
      const dpr=Math.min(root.devicePixelRatio||1,2),w=Math.round(box.width*dpr),h=Math.round(box.height*dpr);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
      const ctx=canvas.getContext("2d");ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,box.width,box.height);this.hits=[];
      if(this.epoch!==epoch){this.trail=[];this.epoch=epoch;}
      // Board cells have their own axes. Avoid painting an unused floor grid
      // beneath every cell on every animation frame.
      if(this.kind==="boards") {this.drawBoards(ctx,box,devices,selectedSlot);this.drawAngles(devices,mode);return;}
      const scale=Math.min(box.width*.80,box.height*.46)*this.zoom,origin=[box.width/2+this.pan[0],box.height*.91+this.pan[1]],rootOffset=this.kind==="translated"?vector(position):[0,0,0];
      const project=p=>root.PoseMath.project(vector(p),this.yaw,this.elevation,origin,scale);
      const line=(a,b,color,width=1,dash=[])=>{ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dash);ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.stroke();ctx.setLineDash([]);};
      for(let i=-2;i<=2;i+=.25){const major=Math.abs(i%1)<.001;line(project([i,-2,0]),project([i,2,0]),major?"rgba(101,116,190,.16)":"rgba(101,116,190,.07)");line(project([-2,i,0]),project([2,i,0]),major?"rgba(101,116,190,.16)":"rgba(101,116,190,.07)");}
      const o=project([0,0,0]);[[.35,0,0],[0,.35,0],[0,0,.35]].forEach((axis,i)=>{const end=project(axis);line(o,end,["#e66354","#279975","#397fd7"][i],2);ctx.fillStyle=["#e66354","#279975","#397fd7"][i];ctx.font="11px system-ui";ctx.fillText(["+X 前","+Y 左","+Z 上"][i],end[0]+4,end[1]);});
      if(this.kind==="translated"&&positionSource!=="off") {
        const previous=this.trail[this.trail.length-1];if(!previous||rootOffset.some((value,i)=>Math.abs(value-previous[i])>.001)){this.trail.push([...rootOffset]);if(this.trail.length>2000)this.trail.shift();}
        for(let i=1;i<this.trail.length;i++)line(project(this.trail[i-1]),project(this.trail[i]),"#d79729",2);
      }
      const segments=listSegments(frame);
      const bySegment=Object.fromEntries(segments.map(segment=>[segment.id||segment.slot,segment]));
      // Paint a soft, neutral mannequin envelope behind the measured skeleton.
      // It follows the same live joint anchors and contains no anatomical detail.
      ctx.save();ctx.lineCap="round";ctx.lineJoin="round";ctx.globalAlpha=.95;ctx.shadowColor="#5b6cff";ctx.shadowBlur=14;
      const torsoIds=["left_upper_arm","right_upper_arm","right_thigh","left_thigh"],torso=torsoIds.map(id=>bySegment[id]).filter(Boolean);
      if(torso.length===4){
        const outline=torso.map(segment=>project(translatePoint(segmentEnds(segment,frame)[0],rootOffset)));
        const fill=ctx.createLinearGradient?.(outline[0][0],outline[0][1],outline[2][0],outline[2][1]);
        if(fill?.addColorStop){fill.addColorStop(0,"#8993bf");fill.addColorStop(.32,"#414d7b");fill.addColorStop(.65,"#222e52");fill.addColorStop(1,"#6776a6");}
        ctx.fillStyle=fill||"#414d7b";ctx.beginPath();const [l,r,hr,hl]=outline;ctx.moveTo(l[0],l[1]);ctx.quadraticCurveTo?.((l[0]+r[0])/2,l[1]-12,r[0],r[1]);ctx.lineTo(r[0],r[1]);ctx.quadraticCurveTo?.(r[0]-.02*scale,(r[1]+hr[1])/2,hr[0],hr[1]);ctx.lineTo(hr[0],hr[1]);ctx.lineTo(hl[0],hl[1]);ctx.quadraticCurveTo?.(l[0]+.02*scale,(l[1]+hl[1])/2,l[0],l[1]);ctx.closePath();ctx.fill();ctx.strokeStyle="rgba(181,197,255,.65)";ctx.lineWidth=1.2;ctx.stroke();
      }
      for(const segment of segments) {
        const slot=segment.slot||segment.id||segment.body_slot,[start,end]=segmentEnds(segment,frame),a=project(translatePoint(start,rootOffset)),b=project(translatePoint(end,rootOffset));
        const torso=/pelvis|torso|chest/.test(slot),upper=/upper_arm|thigh/.test(slot),head=slot==="head";
        if(torso)continue;
        const thigh=/thigh/.test(slot),shank=/shank/.test(slot),width=scale*(head?.075:thigh?.15:shank?.10:upper?.10:.065),gradient=ctx.createLinearGradient?.(a[0]-width/2,a[1],a[0]+width/2,a[1]);
        if(gradient?.addColorStop){gradient.addColorStop(0,"#9ba9d4");gradient.addColorStop(.2,"#65739f");gradient.addColorStop(.65,"#29365b");gradient.addColorStop(1,"#7b8dbd");}
        if(head){ctx.strokeStyle=gradient||"#65739f";ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(a[0]+(b[0]-a[0])*.3,a[1]+(b[1]-a[1])*.3);ctx.stroke();ctx.fillStyle=gradient||"#65739f";ctx.beginPath();ctx.ellipse((a[0]+b[0])/2,(a[1]+b[1])/2-scale*.02,scale*.068,scale*.10,0,0,Math.PI*2);ctx.fill();ctx.strokeStyle="#99abd7";ctx.lineWidth=1;ctx.stroke();continue;}
        ctx.strokeStyle="rgba(186,203,255,.6)";ctx.lineWidth=width+2;ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.stroke();ctx.strokeStyle=gradient||"#53638e";ctx.lineWidth=width;ctx.stroke();
      }
      ctx.restore();
      let segmentIndex=0;
      for(const segment of segments) {
        segmentIndex++;
        const slot=segment.slot||segment.id||segment.body_slot,[start,end]=segmentEnds(segment,frame),a=project(translatePoint(start,rootOffset)),b=project(translatePoint(end,rootOffset)),status=segment.status||segment.state||(segment.measured?"measured":"unmeasured"),selected=slot===selectedSlot;
        const color=COLORS[status]||COLORS[segment.measured?"measured":"unmeasured"];
        // The links between joint anchors are virtual geometry, not additional
        // sampled segments. Connect to the nearest point on the parent bone.
        const parent=bySegment[segment.parent];
        if(selected||segment.measured)line(a,b,selected?"#9b72ff":color,selected?4:2,segment.measured?[]:[5,4]);
        const node=[(a[0]+b[0])/2,(a[1]+b[1])/2];ctx.save();ctx.fillStyle=selected?"#9b72ff":color;ctx.shadowColor=ctx.fillStyle;ctx.shadowBlur=selected?20:12;for(const point of [node]){ctx.beginPath();ctx.arc(point[0],point[1],selected?7:5,0,Math.PI*2);ctx.fill();ctx.strokeStyle="rgba(225,230,255,.8)";ctx.lineWidth=1.5;ctx.stroke();}ctx.restore();
        const center=[(a[0]+b[0])/2,(a[1]+b[1])/2];ctx.save();ctx.fillStyle="rgba(8,12,29,.88)";ctx.strokeStyle="rgba(143,157,255,.72)";ctx.lineWidth=1;ctx.beginPath();ctx.arc(center[0]+10,center[1],8,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle="#eef1ff";ctx.font="9px system-ui";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(String(segmentIndex),center[0]+10,center[1]);ctx.restore();
        this.hits.push({slot,device_id:segment.device_id,a,b});
        if(slot==="head"){const face=rotate([.12,0,0],segment.world_quaternion||[1,0,0,0]),tip=end.map((v,i)=>v+face[i]);line(b,project(translatePoint(tip,rootOffset)),color,3);}
        if(selected){[[.1,0,0],[0,.1,0],[0,0,.1]].forEach((axis,i)=>{const delta=rotate(axis,segment.world_quaternion||[1,0,0,0]);line(a,project(translatePoint(start.map((v,j)=>v+delta[j]),rootOffset)),["#e66354","#279975","#397fd7"][i],2);});}
      }
      ctx.font="12px system-ui";ctx.fillStyle="#8f9ab8";ctx.fillText(this.kind==="fixed"?`中性简化人台 · ${mode==="REPLAY"?"保存姿态回放":"实时姿态"}`:`独立位置来源：${positionSource==="off"?"关闭":positionSource}`,12,23);
      if(!segments.length){ctx.fillText("等待骨架帧；未接入节点不推测动作",12,44);}
      if(this.kind==="translated"){ctx.fillStyle="#f0b45d";ctx.fillText("相机拖动只改变观察视角，不是测量平移",12,box.height-12);}
    }
    drawAngles(devices,mode) {
      const panel=this.anglePanel;if(!panel)return;
      const key=JSON.stringify(devices.map(device=>device.device_id||device.node_id||device.id||"未识别"));
      if(key!==this.angleKey){
        this.angleKey=key;this.angleRows=[];
        const doc=panel.ownerDocument,cards=devices.map(device=>{
          const card=doc.createElement("div"),heading=doc.createElement("div"),name=doc.createElement("strong"),status=doc.createElement("span"),values=doc.createElement("div");
          card.className="board-angle-card";heading.className="board-angle-heading";values.className="board-angle-values";
          name.textContent=device.device_id||device.node_id||device.id||"未识别";heading.append(name,status);
          const outputs=["X 横滚","Y 俯仰","Z 航向"].map((label,index)=>{
            const cell=doc.createElement("div"),title=doc.createElement("span"),output=doc.createElement("strong");
            cell.className="board-angle-axis axis-"+"xyz"[index];title.textContent=label;output.textContent="—";cell.append(title,output);values.append(cell);return output;
          });
          card.append(heading,values);this.angleRows.push({status,outputs});return card;
        });
        if(!cards.length){const empty=doc.createElement("p");empty.className="hint";empty.textContent="等待设备姿态";cards.push(empty);}
        panel.replaceChildren(...cards);
      }
      devices.forEach((device,index)=>{
        const row=this.angleRows[index],angles=eulerDegrees(device.quaternion||device.q);
        const status=!angles?"无有效姿态":mode==="REPLAY"?"回放姿态":device.valid===false||device.connected===false?"离线 / 失鲜 · 最后姿态":device.stability?.calibrating?"零偏校准中":device.stability?.calibrated===false?"零偏未校准 · 姿态可能持续漂移":device.source==="real"?"实时姿态":"模拟姿态";
        if(row.status.textContent!==status)row.status.textContent=status;
        row.outputs.forEach((output,axis)=>{const value=angles?(Math.abs(angles[axis])<.05?0:angles[axis]).toFixed(1)+"°":"—";if(output.textContent!==value)output.textContent=value;});
      });
    }
    drawBoards(ctx,box,devices,selectedSlot) {
      const shown=devices.length?devices:[],columns=shown.length>4?4:shown.length>1?2:1,rows=Math.max(1,Math.ceil(shown.length/columns)),cellW=box.width/columns,cellH=box.height/rows;
      if(!shown.length){ctx.font="13px system-ui";ctx.fillStyle="#9ba6c2";ctx.fillText("暂无设备。模拟设备会显式标识，不计为硬件在线。",18,28);return;}
      shown.forEach((device,index)=>{const cx=(index%columns+.5)*cellW,cy=(Math.floor(index/columns)+.49)*cellH,s=Math.min(cellW*.9,cellH*1.8),q=device.quaternion||device.q||[1,0,0,0],slot=device.body_slot||device.slot,points=[[-.18,-.12,0],[.18,-.12,0],[.18,.12,0],[-.18,.12,0]].map(v=>rotate(v,q)).map(v=>root.PoseMath.project(v,this.yaw,this.elevation,[cx,cy],s));
        ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(...p.slice(0,2)):ctx.moveTo(...p.slice(0,2)));ctx.closePath();ctx.fillStyle=device.source==="real"?"rgba(91,108,255,.42)":"rgba(240,180,93,.32)";ctx.fill();ctx.strokeStyle=slot===selectedSlot?"#9b72ff":"#7183ff";ctx.lineWidth=slot===selectedSlot?3:1.5;ctx.shadowColor=ctx.strokeStyle;ctx.shadowBlur=10;ctx.stroke();ctx.shadowBlur=0;
        [[.25,0,0],[0,.25,0],[0,0,.25]].forEach((axis,i)=>{const tip=root.PoseMath.project(rotate(axis,q),this.yaw,this.elevation,[cx,cy],s);ctx.strokeStyle=["#e66354","#279975","#397fd7"][i];ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(...tip.slice(0,2));ctx.stroke();ctx.fillStyle=["#e66354","#279975","#397fd7"][i];ctx.fillText("s"+"XYZ"[i],tip[0]+3,tip[1]);});
        ctx.font="11px system-ui";ctx.fillStyle="#eef1ff";ctx.textAlign="center";ctx.fillText(String(device.device_id||device.node_id||device.id||"未识别").slice(0,27),cx,(Math.floor(index/columns)+1)*cellH-24);ctx.fillStyle=device.source==="real"?"#9ba6c2":"#f0b45d";ctx.fillText(`${slot||"未绑定"} · ${device.source==="real"?"真实输入":"模拟"}`,cx,(Math.floor(index/columns)+1)*cellH-8);ctx.textAlign="left";
        this.hits.push({slot,device_id:device.device_id||device.node_id||device.id,a:[cx-cellW*.4,cy],b:[cx+cellW*.4,cy]});
      });
    }
  }
  const api={BodyView,listSegments,segmentEnds,rotate,translatePoint,pointSegmentDistance,eulerDegrees};root.BodyView=api;
  if(typeof module!=="undefined")module.exports=api;
})(globalThis);
