"use strict";
const assert=require("node:assert/strict");
const {build}=require("../web/mannequin.js");
const config=require("../config/body_v1.json"),segments=[],map={};
for(const spec of config.segments){const parent=map[spec.parent],anchor=spec.anchor_at_parent_tip?parent.end:(parent?parent.start:config.root_position),start=spec.anchor_at_parent_tip?[...anchor]:anchor.map((v,i)=>v+spec.anchor[i]),end=start.map((v,i)=>v+spec.direction[i]*spec.length),segment={id:spec.id,start,end,world_quaternion:[1,0,0,0]};map[spec.id]=segment;segments.push(segment);}
const saved=JSON.stringify(segments),faces=build(segments);
assert.ok(faces.length>2000);assert.equal(JSON.stringify(segments),saved);
assert.ok(faces.every(face=>face.points.every(p=>p.length===3&&p.every(Number.isFinite))&&face.normals.every(n=>n.every(Number.isFinite))));
assert.deepEqual(build([]),[]);
const moved=structuredClone(segments);moved.find(s=>s.id==="left_forearm").end[0]+=.3;
assert.notDeepEqual(build(moved),faces);assert.equal(JSON.stringify(segments),saved);
console.log("Mannequin: complete finite surface, live anchor deformation and source immutability passed");
