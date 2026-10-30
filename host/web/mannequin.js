"use strict";
// Procedural surface illustration. All anchors come from the received skeleton;
// no imported mesh, bitmap, physics or inferred joint motion is used.
(function(root){
  const add=(a,b)=>a.map((v,i)=>v+b[i]),sub=(a,b)=>a.map((v,i)=>v-b[i]),mul=(a,k)=>a.map(v=>v*k);
  const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const unit=a=>mul(a,1/(Math.hypot(...a)||1));
  function rotate(v,q=[1,0,0,0]){const [w,x,y,z]=q,t=mul(cross([x,y,z],v),2);return add(v,add(mul(t,w),cross([x,y,z],t)));}
  function interpolate(profile,t){const k=Math.min(profile.length-2,Math.floor(t*(profile.length-1))),f=t*(profile.length-1)-k,a=profile[Math.max(0,k-1)],b=profile[k],c=profile[k+1],d=profile[Math.min(profile.length-1,k+2)];return Math.max(.001,.5*((2*b)+(-a+c)*f+(2*a-5*b+4*c-d)*f*f+(-a+3*b-3*c+d)*f*f*f));}
  function build(segments){
    const map=Object.fromEntries(segments.map(s=>[s.id||s.slot,s])),faces=[];
    function surface(rings,sides=20){
      const normals=rings.map((ring,j)=>ring.map((p,i)=>unit(cross(sub(ring[(i+1)%sides],ring[(i+sides-1)%sides]),sub(rings[Math.min(rings.length-1,j+1)][i],rings[Math.max(0,j-1)][i])))));
      for(let j=1;j<rings.length;j++)for(let i=0;i<sides;i++){
        const next=(i+1)%sides,points=[rings[j-1][i],rings[j-1][next],rings[j][next],rings[j][i]];
        const normal=unit(cross(sub(points[1],points[0]),sub(points[3],points[0])));
        faces.push({points,normal,normals:[normals[j-1][i],normals[j-1][next],normals[j][next],normals[j][i]]});
      }
    }
    function tube(a,b,profile,depth=1,sides=20,steps=12){
      const axis=unit(sub(b,a)),u=unit(cross(axis,Math.abs(axis[0])<.8?[1,0,0]:[0,1,0])),v=unit(cross(axis,u)),rings=[];
      for(let j=0;j<=steps;j++){const t=j/steps,r=interpolate(profile,t),center=add(a,mul(sub(b,a),t));rings.push(Array.from({length:sides},(_,i)=>{const angle=i/sides*2*Math.PI;return add(center,add(mul(u,r*Math.cos(angle)),mul(v,r*depth*Math.sin(angle))));}));}
      surface(rings,sides);
    }
    const pelvis=map.pelvis;
    if(pelvis){
      const base=pelvis.start,q=pelvis.world_quaternion||[1,0,0,0],rows=[[-.075,.038,.05],[-.045,.115,.087],[.015,.16,.105],[.085,.158,.105],[.16,.132,.09],[.24,.145,.105],[.33,.18,.115],[.41,.205,.105],[.455,.21,.085],[.49,.155,.068],[.525,.056,.052]],rings=[];
      // Elliptical trunk sections form one uninterrupted pelvis/waist/shoulder surface.
      for(let k=0;k<rows.length-1;k++)for(let j=0;j<3;j++){const f=j/3,t=(k+f)/(rows.length-1),row=[rows[k][0]*(1-f)+rows[k+1][0]*f,interpolate(rows.map(r=>r[1]),t),interpolate(rows.map(r=>r[2]),t)];rings.push(Array.from({length:28},(_,i)=>{const angle=i/28*Math.PI*2;return add(base,rotate([row[2]*Math.cos(angle),row[1]*Math.sin(angle),row[0]],q));}));}
      const row=rows.at(-1);rings.push(Array.from({length:28},(_,i)=>add(base,rotate([row[2]*Math.cos(i/28*Math.PI*2),row[1]*Math.sin(i/28*Math.PI*2),row[0]],q))));surface(rings,28);
      const neck=map.head?.start||add(base,rotate([0,0,.55],q));tube(add(base,rotate([0,0,.49],q)),add(neck,rotate([0,0,.07],q)),[.053,.048,.046],.9);
    }
    for(const segment of segments){
      const id=segment.id||segment.slot,a=segment.start,b=segment.end;if(!a||!b||id==="pelvis")continue;
      if(id==="head"){
        const q=segment.world_quaternion||[1,0,0,0],length=Math.hypot(...sub(b,a)),center=add(a,mul(sub(b,a),.54)),rings=[],sides=28;
        for(let j=0;j<=22;j++){const phi=-Math.PI/2+j/22*Math.PI,ring=Math.max(.003,Math.cos(phi)),jaw=phi<-.15?.79+.21*(phi+Math.PI/2)/(Math.PI/2-.15):1;
          rings.push(Array.from({length:sides},(_,i)=>{const theta=i/sides*2*Math.PI;let x=.084*ring*Math.cos(theta),y=.077*ring*Math.sin(theta)*jaw,z=length*.54*Math.sin(phi);const nose=Math.max(0,Math.cos(theta))**18*Math.exp(-(((phi+.07)/.22)**2))*.018;x+=nose;return add(center,rotate([x,y,z],q));}));}surface(rings,sides);
      }else if(id.includes("upper_arm"))tube(a,b,[.025,.052,.052,.045,.036,.032],1.05);
      else if(id.includes("forearm"))tube(a,b,[.031,.039,.037,.029,.022,.021],.95);
      else if(id.includes("thigh"))tube(a,b,[.072,.086,.079,.068,.052,.044],1.12);
      else if(id.includes("shank"))tube(a,b,[.042,.052,.057,.048,.032,.025],1.1);
      else if(id.includes("hand")){
        const delta=sub(b,a),palmEnd=add(a,mul(delta,.61));tube(a,palmEnd,[.021,.033,.035,.029],.5);
        const side=rotate([0,1,0],segment.world_quaternion),axis=unit(delta);
        for(let finger=0;finger<4;finger++){const spread=(finger-1.5)*.016,start=add(add(a,mul(delta,.53)),mul(side,spread)),end=add(add(a,mul(delta,.95-Math.abs(finger-1.3)*.09)),mul(side,spread*1.22));tube(start,end,[.008,.008,.006,.002],.8,10,6);}
        tube(add(a,mul(delta,.21)),add(add(a,mul(delta,.65)),mul(side,.047)),[.012,.011,.006,.002],.8,12,6);
      }else if(id.includes("foot")){
        const delta=sub(b,a),q=segment.world_quaternion,down=rotate([0,0,-.04],q),toe=add(add(a,mul(delta,.82)),down);tube(add(a,mul(down,.15)),toe,[.026,.041,.047,.043,.024,.005],.65,20,12);
      }
    }
    return faces;
  }
  function paint(ctx,segments,project,{yaw=0,elevation=.18,offset=[0,0,0]}={}){
    const light=unit([.65,.5,.9]),view=[Math.cos(elevation)*Math.cos(yaw),Math.cos(elevation)*Math.sin(yaw),Math.sin(elevation)];
    const projected=build(segments).map(face=>{const points=face.points.map(p=>project(add(p,offset))),depth=points.reduce((sum,p)=>sum+p[2],0)/4;return {...face,points,depth};}).sort((a,b)=>a.depth-b.depth);
    if(root.OffscreenCanvas&&projected.length){
      // Interpolate vertex lighting per pixel and depth-test the surface. This
      // removes visible polygon bands and incorrect limb/torso intersections.
      const points=projected.flatMap(face=>face.points),left=Math.floor(Math.min(...points.map(p=>p[0])))-2,top=Math.floor(Math.min(...points.map(p=>p[1])))-2,right=Math.ceil(Math.max(...points.map(p=>p[0])))+2,bottom=Math.ceil(Math.max(...points.map(p=>p[1])))+2;
      const resolution=Math.min(1.6,1200/Math.max(1,bottom-top)),width=Math.max(1,Math.ceil((right-left)*resolution)),height=Math.max(1,Math.ceil((bottom-top)*resolution));
      const buffer=new OffscreenCanvas(width,height),target=buffer.getContext("2d"),pixels=target.createImageData(width,height),depths=new Float32Array(width*height).fill(-Infinity),half=unit(add(light,view));
      const shade=normal=>{let n=normal;if(dot(n,view)<0)n=mul(n,-1);const diffuse=Math.max(0,dot(n,light)),rim=(1-Math.abs(dot(n,view)))**4,spec=Math.max(0,dot(n,half))**24,k=.55+.5*diffuse+.25*rim;return [77,90,137].map((v,i)=>Math.min(255,v*k+rim*[57,67,108][i]+spec*40));};
      for(const face of projected){const vertices=face.points.map((p,i)=>[(p[0]-left)*resolution,(p[1]-top)*resolution,p[2],...shade(face.normals[i])]);
        for(const indices of [[0,1,2],[0,2,3]]){const [a,b,c]=indices.map(i=>vertices[i]),den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);if(Math.abs(den)<1e-8)continue;
          const x0=Math.max(0,Math.floor(Math.min(a[0],b[0],c[0]))),x1=Math.min(width-1,Math.ceil(Math.max(a[0],b[0],c[0]))),y0=Math.max(0,Math.floor(Math.min(a[1],b[1],c[1]))),y1=Math.min(height-1,Math.ceil(Math.max(a[1],b[1],c[1])));
          for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const u=((b[1]-c[1])*(x+.5-c[0])+(c[0]-b[0])*(y+.5-c[1]))/den,v=((c[1]-a[1])*(x+.5-c[0])+(a[0]-c[0])*(y+.5-c[1]))/den,w=1-u-v;if(u<-.001||v<-.001||w<-.001)continue;const index=y*width+x,z=u*a[2]+v*b[2]+w*c[2];if(z<depths[index])continue;depths[index]=z;const pixel=index*4;for(let channel=0;channel<3;channel++)pixels.data[pixel+channel]=u*a[channel+3]+v*b[channel+3]+w*c[channel+3];pixels.data[pixel+3]=255;}
        }
      }
      target.putImageData(pixels,0,0);ctx.drawImage(buffer,left,top,right-left,bottom-top);return projected.length;
    }
    ctx.save();ctx.lineJoin="round";ctx.lineWidth=.65;
    for(const face of projected){
      // Two-sided soft shading avoids holes where adjacent articulated surfaces overlap.
      const colors=face.normals.map((normal,index)=>{let n=normal;if(dot(n,view)<0)n=mul(n,-1);const diffuse=Math.max(0,dot(n,light)),rim=(1-Math.abs(dot(n,view)))**4,spec=Math.max(0,dot(n,unit(add(light,view))))**24,shade=.55+.5*diffuse+.25*rim;const rgb=[77,90,137].map((v,i)=>Math.round(Math.min(255,v*shade+rim*[57,67,108][i]+spec*40)));return {point:face.points[index],brightness:rgb[0],color:`rgb(${rgb.join(",")})`};}).sort((a,b)=>a.brightness-b.brightness);
      const low=colors[0],high=colors.at(-1),gradient=ctx.createLinearGradient?.(low.point[0],low.point[1],high.point[0],high.point[1]);
      if(gradient?.addColorStop){gradient.addColorStop(0,low.color);gradient.addColorStop(1,high.color);}
      ctx.fillStyle=ctx.strokeStyle=gradient||low.color;ctx.beginPath();face.points.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath();ctx.fill();ctx.stroke();
    }
    ctx.restore();return projected.length;
  }
  const caches=new WeakMap();
  function draw(ctx,segments,project,options={}){
    if(!root.OffscreenCanvas||!ctx.canvas)return paint(ctx,segments,project,options);
    const width=ctx.canvas.width,height=ctx.canvas.height,transform=ctx.getTransform();
    const key=JSON.stringify([width,height,options,project([0,0,0]),project([1,1,1]),segments.map(s=>[s.id||s.slot,s.start,s.end,s.world_quaternion])]);
    let cached=caches.get(ctx);
    if(!cached||cached.key!==key){const canvas=new OffscreenCanvas(width,height),buffer=canvas.getContext("2d");buffer.setTransform(transform);const faces=paint(buffer,segments,project,options);cached={key,canvas,faces};caches.set(ctx,cached);}
    ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(cached.canvas,0,0);ctx.restore();return cached.faces;
  }
  root.MotionMannequin={build,draw};if(typeof module!=="undefined")module.exports=root.MotionMannequin;
})(globalThis);
