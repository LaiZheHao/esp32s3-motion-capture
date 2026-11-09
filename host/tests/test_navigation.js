"use strict";
const assert=require("node:assert/strict");
const {routeFromHash,applyRoute}=require("../web/navigation.js");
assert.equal(routeFromHash("#/records"),"records");
assert.equal(routeFromHash("#/trash"),"trash");
assert.equal(routeFromHash("#/unknown"),"dashboard");
assert.equal(routeFromHash("#overview"),"dashboard");
const views=["dashboard","calibration","records","trash","replay","advanced"].map(view=>({dataset:{view},hidden:false}));
const links=views.map(view=>({dataset:{route:view.dataset.view},classList:{toggle(_,value){this.active=value;}},setAttribute(){}}));
for(const route of ["replay","calibration","records","trash","records","dashboard","advanced","dashboard"]){applyRoute(route,{views,links});assert.deepEqual(views.filter(v=>!v.hidden).map(v=>v.dataset.view),[route]);assert.equal(links.filter(l=>l.classList.active).length,1);}
console.log("Navigation: exclusive views, normalization and repeated route changes passed");
// Exercise the shipped status renderer with the backend's endpoint schema.
const navigation=require("../web/navigation.js"),previousDocument=global.document,elements=new Map();
global.document={getElementById(id){if(!elements.has(id))elements.set(id,{textContent:"",classList:{toggle(){}}});return elements.get(id);},querySelectorAll(){return [];}};
function statuses(endpoints){navigation.update({mode:"LIVE",devices:[],endpoints});return [elements.get("usb-status").textContent,elements.get("wifi-status").textContent];}
try{
  assert.deepEqual(statuses([]),["未连接","未连接"]);
  assert.deepEqual(statuses([{transport:"serial",status:"connected"},{transport:"wifi",status:"error"}]),["已连接","未连接"]);
  assert.deepEqual(statuses([{transport:"serial",status:"closed"},{transport:"wifi",status:"connecting"}]),["未连接","连接中…"]);
  assert.deepEqual(statuses([{transport:"serial",status:"connecting"},{transport:"wifi",status:"connected"},{transport:"wifi",status:"disconnected"}]),["连接中…","已连接"]);
  assert.deepEqual(statuses([{transport:"wifi",status:"disconnected",connected:true}]),["未连接","未连接"],"explicit status overrides an obsolete boolean");
  assert.deepEqual(statuses([{transport:"wifi",connected:true}]),["未连接","已连接"],"legacy boolean-only state remains supported");
}finally{if(previousDocument===undefined)delete global.document;else global.document=previousDocument;}
console.log("Connection badges: backend status, transport isolation, reconnect, multiple endpoints and legacy fallback passed");
