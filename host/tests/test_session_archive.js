"use strict";
const assert=require("node:assert/strict");
const zlib=require("node:zlib");
const {extract}=require("../web/session_archive.js");
function archive(method){const name=Buffer.from("session/samples.jsonl"),source=Buffer.from('{"data":{"device_id":"node_a"}}\n'),payload=method===8?zlib.deflateRawSync(source):source;
 const local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(name.length,26);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(method,10);central.writeUInt32LE(payload.length,20);central.writeUInt32LE(source.length,24);central.writeUInt16LE(name.length,28);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,10);end.writeUInt32LE(30+name.length+payload.length,16);return Buffer.concat([local,name,payload,central,name,end]);}
(async()=>{for(const method of [0,8]){const zip=archive(method);const buffer=zip.buffer.slice(zip.byteOffset,zip.byteOffset+zip.length);assert.match(await extract(buffer,"samples.jsonl"),/node_a/);await assert.rejects(()=>extract(buffer,"missing.jsonl"),/缺少/);}console.log("Session archive: stored/deflated ZIP and missing files passed");})();
