"use strict";
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const math=require('../web/pose_math.js');
globalThis.PoseMath=math;
const {BodyView}=require('../web/body_view.js');
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const near=(a,b)=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-10,`${a} != ${b}`));
for(const yaw of [-Math.PI,-.65,0,Math.PI/2,2.4])for(const el of [-1.2,0,.35,1.2]){
  const {right,up,toward}=math.cameraBasis(yaw,el);
  near(cross(right,up),toward); // determinant +1, never a reflection
  for(const axis of [right,up,toward])assert.ok(Math.abs(dot(axis,axis)-1)<1e-10);
  near(math.project(right,yaw,el),[1,0,0]);
  near(math.project(up,yaw,el),[0,-1,0]);
  near(math.project(toward,yaw,el),[0,0,1]);
}
// Front camera (+X): anatomical left (+Y) appears on screen right.
assert.ok(math.project([0,.22,1],0,.35)[0]>math.project([0,-.22,1],0,.35)[0]);
// Positive right-hand yaw turns forward to anatomical left; front raise is -Y.
const h=Math.SQRT1_2;
near(math.rotate([1,0,0],[h,0,0,h]),[0,1,0]);
near(math.rotate([0,0,-1],[h,0,-h,0]),[1,0,0]);
near(math.rotate([0,0,-1],[h,-h,0,0]),[0,-1,0]);
for(const signs of [[-1,1,1],[1,-1,1],[-1,-1,-1]]){
  const axes=[[1,0,0],[0,1,0],[0,0,1]].map(v=>math.worldVertex(v,[1,0,0,0],[0,0,0],signs));
  near(cross(axes[0],axes[1]),axes[2]);
}
// Exercise actual shipped canvas paths, rather than only helper formulas.
const points=[];
const ctx=new Proxy({},{get:(_,key)=>key==='moveTo'||key==='lineTo'?((...p)=>{assert.equal(p.length,2);points.push(p);}):(()=>{})});
const canvas={addEventListener(){},getBoundingClientRect(){return {width:800,height:600};},getContext(){return ctx;}};
for(const kind of ['fixed','translated','boards']){
  const view=new BodyView(canvas,{kind});
  view.draw({segments:[{id:'right_upper_arm',start:[0,-.22,1.45],end:[0,-.22,1.15],measured:true}]},
    {selectedSlot:'right_upper_arm',devices:[{device_id:'offline',body_slot:'right_upper_arm',source:'simulation',quaternion:[1,0,0,0]}]});
}
assert.ok(points.length>0);
const handlers={},interactiveCanvas={...canvas,addEventListener(name,handler){handlers[name]=handler;},setPointerCapture(){}};
const interactive=new BodyView(interactiveCanvas);
handlers.pointerdown({clientX:100,clientY:100,pointerId:1,shiftKey:false});
handlers.pointermove({clientX:150,clientY:120});handlers.pointerup({clientX:150,clientY:120});
assert.notEqual(interactive.yaw,0);assert.notEqual(interactive.elevation,.18);
handlers.wheel({deltaY:-100,preventDefault(){}});assert.ok(interactive.zoom>1);
const immutable={segments:[{id:"head",start:[0,0,1.55],end:[0,0,1.77]}]},saved=JSON.stringify(immutable);
interactive.draw(immutable);assert.equal(JSON.stringify(immutable),saved);
interactive.reset();assert.equal(interactive.yaw,0);assert.equal(interactive.zoom,1);
for(const name of ['body_view.js','app.js','wifi_monitor.html'])assert.match(fs.readFileSync(path.join(__dirname,'../web',name),'utf8'),/(?:PoseMath|root\.PoseMath)\.project\(/);
console.log('Scene coordinates: camera determinant +1, front/left/up, signed movement, legacy mirrors, all canvas paths passed');
