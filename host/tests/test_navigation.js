"use strict";
const assert=require("node:assert/strict");
const {routeFromHash,applyRoute}=require("../web/navigation.js");
assert.equal(routeFromHash("#/records"),"records");
assert.equal(routeFromHash("#/unknown"),"dashboard");
assert.equal(routeFromHash("#overview"),"dashboard");
const views=["dashboard","calibration","records","replay","advanced"].map(view=>({dataset:{view},hidden:false}));
const links=views.map(view=>({dataset:{route:view.dataset.view},classList:{toggle(_,value){this.active=value;}},setAttribute(){}}));
for(const route of ["replay","calibration","records","dashboard","advanced","dashboard"]){applyRoute(route,{views,links});assert.deepEqual(views.filter(v=>!v.hidden).map(v=>v.dataset.view),[route]);assert.equal(links.filter(l=>l.classList.active).length,1);}
console.log("Navigation: exclusive views, normalization and repeated route changes passed");
