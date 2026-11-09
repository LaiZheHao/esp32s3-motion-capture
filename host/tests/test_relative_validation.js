"use strict";
const assert=require("assert");
const {compare,parseSamples}=require("../web/relative_validation_math.js");
function fixture(bias=0){const groups={A:[],B:[]};for(let i=0;i<=1000;i++)for(const id of ["A","B"])groups[id].push({t:100+i*.01,a:[id==="B"?bias/9.80665:0,0,1],q:[1,0,0,0]});return groups;}
const config={nodeA:"A",nodeB:"B",initialPosition:[.5,0,0],initialVelocity:[.2,0,0],fixes:[2,4,6,8].map(t=>({time:t,position:[.5+.2*t,0,0]}))};
const moving=compare(fixture(),config);
assert(moving.rows.every(r=>Math.abs(r.positions[2][0]-(.5+.2*r.time))<1e-8));
assert(moving.rows.every(r=>Math.abs(r.velocities[2][0]-.2)<1e-8),"position fixes must preserve nonzero velocity");
const biased=compare(fixture(.02),{...config,initialVelocity:[0,0,0],fixes:[2,4,6,8].map(t=>({time:t,position:[.5,0,0]}))});
assert(biased.preResidualRms[2]<biased.preResidualRms[1]);
assert(biased.preResidualRms[1]<biased.preResidualRms[0]);
assert(Math.abs(biased.rows.at(-1).estimatedBias[0]-.02)<.004);
assert.throws(()=>compare(fixture(),{...config,fixes:[{time:20,position:[0,0,0]}]}),/时间/);
assert.throws(()=>compare(fixture(),{...config,nodeB:"A"}),/不同/);
function line(seq,source="real",boot="boot1"){return JSON.stringify({data:{source,device_id:"A",aligned_monotonic:100+seq*.01,raw:{sequence:seq,boot_id:boot,sensor_flags:1},mapped:{accel:[0,0,1]},quaternion:[1,0,0,0]}});}
assert.equal(parseSamples([line(1),line(2)].join("\n")).A.length,2);
assert.throws(()=>parseSamples([line(1),line(3)].join("\n")),/缺帧/);
assert.throws(()=>parseSamples([line(1),line(2,"real","boot2")].join("\n")),/重启/);
assert.throws(()=>parseSamples(line(1,"simulation_sensor")),/实板/);
console.log("Relative validation: moving position fixes preserve velocity, bias estimation improves drift, invalid/partial records rejected");
