"use strict";
(function(root){
  async function extract(buffer,filename){
    const view=new DataView(buffer),bytes=new Uint8Array(buffer),decoder=new TextDecoder();
    let end=buffer.byteLength-22;
    while(end>=Math.max(0,buffer.byteLength-65557)&&view.getUint32(end,true)!==0x06054b50)end--;
    if(end<0)throw new Error("记录 ZIP 不完整");
    let offset=view.getUint32(end+16,true),count=view.getUint16(end+10,true);
    for(let i=0;i<count;i++){
      if(view.getUint32(offset,true)!==0x02014b50)throw new Error("记录 ZIP 目录无效");
      const method=view.getUint16(offset+10,true),size=view.getUint32(offset+20,true),expanded=view.getUint32(offset+24,true),length=view.getUint16(offset+28,true),name=decoder.decode(bytes.slice(offset+46,offset+46+length));
      if(name.endsWith("/"+filename)){
        if(expanded>128*1024*1024)throw new Error("该文件超过浏览器预览限制，请导出 ZIP 后离线分析");
        const local=view.getUint32(offset+42,true),start=local+30+view.getUint16(local+26,true)+view.getUint16(local+28,true),data=bytes.slice(start,start+size);
        if(method===0)return decoder.decode(data);
        if(method!==8)throw new Error("记录压缩格式不受支持");
        const stream=new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return await new Response(stream).text();
      }
      offset+=46+length+view.getUint16(offset+30,true)+view.getUint16(offset+32,true);
    }
    throw new Error("记录缺少 "+filename);
  }
  function toCsv(rows){const quote=value=>'"'+String(value??"").replaceAll('"','""')+'"';return '\ufeff'+["time_s,device_id,source,data_json",...rows.map(row=>[row.time_s,row.data?.device_id,row.data?.source,JSON.stringify(row.data)].map(quote).join(","))].join("\r\n");}
  root.SessionArchive={extract,toCsv};if(typeof module!=="undefined")module.exports=root.SessionArchive;
})(globalThis);
