import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { root, atomicWrite } from './core.js';
const schema = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const referenceTools = [
  {name:'index_document',description:'Index a large reference document. Returns a recovery ref; original stays available. Read code, short results and complete JSON normally.',inputSchema:schema({path:{type:'string'}})},
  {name:'search_document',description:'Find exact passages in an indexed reference. Search results are excerpts; retrieve original when more detail is needed.',inputSchema:schema({ref:{type:'string'},queries:{type:'array',items:{type:'string'},minItems:1,maxItems:8}}),annotations:{readOnlyHint:true}},
  {name:'get_original',description:'Recover retained original without rerunning a command. RTK refs also require the hash shown in its recovery hint. Returns at most 64k characters; use next_offset to continue.',inputSchema:{type:'object',properties:{ref:{type:'string'},hash:{type:'string'},offset:{type:'integer',minimum:0}},required:['ref'],additionalProperties:false},annotations:{readOnlyHint:true}},
];
export function referenceHandler(client, {recall}={}) {
  const directory=path.join(root(),'references'); const indexed=new Set();
  const read=ref=>{
    if (!/^doc:[a-f0-9-]{36}$/.test(ref)) throw new Error('Invalid reference');
    const file=path.join(directory,ref.slice(4)+'.json');
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    if(Date.now()-value.at>7*86400000) throw Object.assign(new Error('Expired reference'),{code:'REFERENCE_EXPIRED'});
    return value;
  };
  return async (name,args) => {
    let value;
    if(name==='index_document') {
      if(typeof args.path!=='string' || indexed.size>=100) throw new Error('Reference limit reached; read source normally');
      const fd=fs.openSync(args.path,'r');let bytes;
      try {
        if(!fs.fstatSync(fd).isFile()) throw new Error('Reference must be a regular text file');
        const buffer=Buffer.alloc(1024*1024+1);let length=0,read;
        while(length<buffer.length&&(read=fs.readSync(fd,buffer,length,buffer.length-length,null))) length+=read;
        if(length>1024*1024) throw new Error('Reference must be under 1 MiB');
        bytes=buffer.subarray(0,length);
      }finally{fs.closeSync(fd)}
      const content=bytes.toString('utf8');
      if(!Buffer.from(content).equals(bytes)) throw new Error('Reference must be UTF-8 text');
      const ref='doc:'+crypto.randomUUID();
      // Preserve original before invoking any optimization engine.
      fs.mkdirSync(directory,{recursive:true,mode:0o700});
      atomicWrite(path.join(directory,ref.slice(4)+'.json'),JSON.stringify({at:Date.now(),content}));
      const result=await client.callTool({name:'ctx_index',arguments:{content,source:ref}});
      if(result.isError) throw new Error('Index unavailable; original source remains unchanged');
      indexed.add(ref);
      const files=fs.readdirSync(directory).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).map(n=>({file:path.join(directory,n),at:fs.statSync(path.join(directory,n)).mtimeMs})).sort((a,b)=>b.at-a.at);
      for(const old of files.slice(100)) fs.rmSync(old.file);
      value={ref,original_chars:content.length,retention:'7 days; latest 100 documents'};
    } else if(name==='search_document') {
      const original=read(args.ref);
      if(!Array.isArray(args.queries)||!args.queries.length||args.queries.length>8||args.queries.some(q=>typeof q!=='string'||!q.trim()||q.length>1000)) throw new Error('Invalid queries');
      // Reindex retained bytes so engine restarts/replacement never require client changes.
      if(!indexed.has(args.ref)) {
        if(indexed.size>=100) throw new Error('Reference limit reached; use get_original');
        const index=await client.callTool({name:'ctx_index',arguments:{content:original.content,source:args.ref}});
        if(index.isError) throw new Error('Index unavailable; use get_original');
        indexed.add(args.ref);
      }
      return client.callTool({name:'ctx_search',arguments:{queries:args.queries,source:args.ref,limit:3}});
    } else if(name==='get_original') {
      const offset=args.offset??0;
      if(!Number.isSafeInteger(offset)||offset<0) throw new Error('Invalid offset');
      let content;
      if(/^rtk:[a-f0-9-]{36}$/.test(args.ref)) {
        if(!/^[a-f0-9]{6,64}$/.test(args.hash||'')) throw new Error('RTK recovery hash required');
        content=await recall(path.join(os.tmpdir(),'agent-context-native-'+args.ref.slice(4)),args.hash);
      } else content=read(args.ref).content;
      value={ref:args.ref,original_chars:content.length,offset,content:content.slice(offset,offset+64000),next_offset:offset+64000<content.length?offset+64000:null};
    } else throw new Error('Unknown tool');
    return {content:[{type:'text',text:JSON.stringify(value)}]};
  };
}
