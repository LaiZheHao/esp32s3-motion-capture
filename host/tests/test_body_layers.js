"use strict";
const assert=require("node:assert/strict");
globalThis.PoseMath=require("../web/pose_math.js");
const mannequin=require("../web/mannequin.js"),originalDraw=mannequin.draw,events=[];
mannequin.draw=()=>events.push("glass");
const {BodyView}=require("../web/body_view.js");
const context=new Proxy({}, {get(target,key){if(key in target)return target[key];return (...args)=>{if(key==="stroke")events.push("stroke:"+target.strokeStyle);if(key==="fill")events.push("fill:"+target.fillStyle);if(key==="fillText")events.push("label:"+args[0]);};}});
const canvas={addEventListener(){},getBoundingClientRect(){return {width:800,height:600};},getContext(){return context;}};
const frame={segments:[{id:"pelvis",start:[0,0,1],end:[0,0,1.48],status:"unmeasured"},{id:"right_forearm",parent:"pelvis",start:[0,-.22,1.15],end:[0,-.22,.89],measured:true,status:"online"}]};
const saved=JSON.stringify(frame);
try{new BodyView(canvas).draw(frame,{selectedSlot:"right_forearm"});
 const shell=events.indexOf("glass"),bone=events.indexOf("stroke:#b3c5e8"),core=events.indexOf("fill:#f6f8ff"),label=events.indexOf("label:2");
 assert.ok(bone>=0&&bone<shell,"internal skeleton must be behind the glass shell");
 assert.ok(core>shell&&label>shell,"sensor cores and independent labels must be above glass");
 assert.equal(JSON.stringify(frame),saved);
}finally{mannequin.draw=originalDraw;}
console.log("Body layers: skeleton below glass, sensor cores/labels above glass, source unchanged passed");
