/* Offline hardware comparison. Never reads live snapshots or changes fusion. */
"use strict";
(function(root){
  const norm=v=>Math.hypot(...v), finite=v=>typeof v==="number"&&Number.isFinite(v);
  function vector(v,n){if(!Array.isArray(v)||v.length!==n||!v.every(finite))throw Error("向量或四元数无效");return v;}
  function rotate(v,q){vector(v,3);vector(q,4);const n=norm(q);if(n<.5||n>1.5)throw Error("四元数模长异常");const [w,x,y,z]=q.map(a=>a/n),[a,b,c]=v;return [(1-2*y*y-2*z*z)*a+2*(x*y-z*w)*b+2*(x*z+y*w)*c,2*(x*y+z*w)*a+(1-2*x*x-2*z*z)*b+2*(y*z-x*w)*c,2*(x*z-y*w)*a+2*(y*z+x*w)*b+(1-2*x*x-2*y*y)*c];}
  function parseSamples(text){
    const groups={};let count=0;
    for(const line of text.trim().split(/\r?\n/)){
      if(!line.trim())continue;if(++count>200000)throw Error("超过20万条样本，请缩短记录");
      const d=JSON.parse(line).data;if(d?.source!=="real")throw Error("只接受纯实板记录，记录中含模拟输入");
      const raw=d.raw;if(!raw||typeof d.device_id!=="string"||!finite(d.aligned_monotonic)||!Number.isInteger(raw.sequence)||raw.sequence<0||raw.sequence>=2**32||!raw.boot_id||!(raw.sensor_flags&1))throw Error("需要带设备序号、启动标识、对齐时间和有效六轴数据的新版记录");
      vector(d.mapped?.accel,3);vector(d.quaternion,4);
      (groups[d.device_id]??=[]).push({t:d.aligned_monotonic,seq:raw.sequence,boot:raw.boot_id,a:d.mapped.accel,q:d.quaternion});
    }
    for(const list of Object.values(groups))for(let i=1;i<list.length;i++){
      const p=list[i-1],c=list[i];if(p.boot!==c.boot)throw Error("记录中节点发生重启，请分段录制");
      if((c.seq-p.seq+2**32)%2**32!==1||c.t<=p.t||c.t-p.t>.08)throw Error("记录有缺帧、重复帧或超过80ms的间隔，请重新采集完整短段");
    }
    return groups;
  }
  function world(list,yawDeg){const angle=yawDeg*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);return list.map(p=>{const [x,y,z]=rotate(p.a,p.q);return {t:p.t,a:[(c*x-s*y)*9.80665,(s*x+c*y)*9.80665,(z-1)*9.80665]};});}
  function interp(list,t,start){let i=start;while(i+1<list.length&&list[i+1].t<t)i++;if(i+1>=list.length)return [list.at(-1).a,i];const p=list[i],q=list[i+1],u=(t-p.t)/(q.t-p.t);return [p.a.map((v,k)=>v+(q.a[k]-v)*u),i];}
  const transpose=A=>A[0].map((_,j)=>A.map(r=>r[j]));
  const mul=(A,B)=>A.map(r=>B[0].map((_,j)=>r.reduce((s,v,k)=>s+v*B[k][j],0)));
  const add=(A,B)=>A.map((r,i)=>r.map((v,j)=>v+B[i][j]));
  function compare(groups,config){
    const {nodeA,nodeB,yawA=0,yawB=0,initialPosition,initialVelocity,fixes,sigma=.005}=config;
    if(nodeA===nodeB||!groups[nodeA]||!groups[nodeB])throw Error("请选择两个不同的实板节点");
    vector(initialPosition,3);vector(initialVelocity,3);
    if(![yawA,yawB,sigma].every(finite)||sigma<=0)throw Error("噪声标准差需大于零，航向角需为有限数值");
    const a=world(groups[nodeA],yawA),b=world(groups[nodeB],yawB),start=Math.max(a[0].t,b[0].t),end=Math.min(a.at(-1).t,b.at(-1).t),duration=end-start;
    if(duration<1||duration>180)throw Error("两节点重叠时长需为1～180秒");
    if(!Array.isArray(fixes)||!fixes.length)throw Error("请添加实际确认的归位事件");
    let last=0;for(const f of fixes){vector(f.position,3);if(!finite(f.time)||f.time<=last||f.time>duration)throw Error("事件时间须严格递增，且在共同采样区间内");last=f.time;}
    const states=Array.from({length:3},()=>[initialPosition.slice(),initialVelocity.slice(),[0,0,0]]);
    let P=[[.001**2,0,0],[0,.005**2,0],[0,0,.03**2]],ia=0,ib=0,fi=0,t=0;
    const rows=[],events=[];
    // Shared resampling grid plus exact event times. At most 10 ms per step.
    while(t<duration-1e-9){
      const next=Math.min(t+.01,duration,fi<fixes.length?fixes[fi].time:Infinity),dt=next-t;
      const [aa,na]=interp(a,start+(t+next)/2,ia),[ab,nb]=interp(b,start+(t+next)/2,ib);ia=na;ib=nb;
      const acceleration=ab.map((v,k)=>v-aa[k]);
      for(const state of states)for(let k=0;k<3;k++){const ac=acceleration[k]-state[2][k];state[0][k]+=state[1][k]*dt+.5*ac*dt*dt;state[1][k]+=ac*dt;}
      const F=[[1,dt,-.5*dt*dt],[0,1,-dt],[0,0,1]],G=[.5*dt*dt,dt,0],Q=G.map(x=>G.map(y=>x*y*2*.02**2));Q[2][2]+=2*.0002**2*dt;P=add(mul(mul(F,P),transpose(F)),Q);
      t=next;let event=false;
      if(fi<fixes.length&&Math.abs(t-fixes[fi].time)<1e-8){
        event=true;const z=fixes[fi++].position;
        events.push({time:t,position:z.slice(),preResidual:states.map(state=>norm(state[0].map((v,k)=>v-z[k])))});
        states[1][0]=z.slice();
        const K=P.map(r=>r[0]/(P[0][0]+sigma*sigma)),res=z.map((v,k)=>v-states[2][0][k]);
        for(let r=0;r<3;r++)for(let k=0;k<3;k++)states[2][r][k]+=K[r]*res[k];
        const A=[[1-K[0],0,0],[-K[1],1,0],[-K[2],0,1]];
        P=add(mul(mul(A,P),transpose(A)),K.map(x=>K.map(y=>x*y*sigma*sigma)));
      }
      rows.push({time:t,event,positions:states.map(s=>s[0].slice()),velocities:states.map(s=>s[1].slice()),estimatedBias:states[2][2].slice()});
    }
    return {schema:"relative-hardware-comparison/1",config,duration,rows,events,
      preResidualRms:[0,1,2].map(k=>Math.sqrt(events.reduce((s,e)=>s+e.preResidual[k]**2,0)/events.length)),
      warning:"校正事件是输入约束，残差不是独立精度；共同绝对漂移不可观测。两节点时钟和航向需对齐。"};
  }
  root.RelativeValidation={parseSamples,compare,rotate};if(typeof module!=="undefined")module.exports=root.RelativeValidation;
})(globalThis);
