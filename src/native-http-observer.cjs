const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {syncBuiltinESMExports}=require('node:module');
// Only protobuf framing lengths are inspected; attribute values remain opaque.
function spans(buffer){
 const walk=(start,end,visit)=>{let p=start;const number=()=>{let value=0,m=1;for(let n=0;n<8;n++){if(p>=end)throw 0;const b=buffer[p++];value+=(b&127)*m;if(!Number.isSafeInteger(value))throw 0;if(!(b&128))return value;m*=128;}throw 0;};
  while(p<end){const tag=number(),field=Math.floor(tag/8),wire=tag%8;if(!field)throw 0;if(wire===2){const length=number(),at=p;p+=length;if(p>end)throw 0;visit(field,at,p);}else if(wire===0)number();else if(wire===1)p+=8;else if(wire===5)p+=4;else throw 0;if(p>end)throw 0;}
 };
 let count=0,max=0;try{walk(0,buffer.length,(f,a,b)=>{if(f===1)walk(a,b,(f,a,b)=>{if(f===2)walk(a,b,(f,a,b)=>{if(f===2){count++;max=Math.max(max,b-a);}});});});return {count,max};}catch{return null;}
}
module.exports={spans};
const file=process.env.AGENT_CONTEXT_NATIVE_OBSERVER_FILE,port=process.env.AGENT_CONTEXT_NATIVE_OBSERVER_PORT;
let allowed=false;
try{const d=path.dirname(file);allowed=path.basename(file)==='transport.json'&&/^snapshot-[A-Za-z0-9]+$/.test(path.basename(d))&&path.basename(path.dirname(d))==='native-hook-outbox'&&!fs.lstatSync(d).isSymbolicLink()&&fs.statSync(d).isDirectory()&&/^\d{1,5}$/.test(port)&&+port>0&&+port<=65535;}catch{}
if(allowed){
 let count=0,maxBody=null,maxSpan=null,maxSpans=null,last=null,failed=null,timed=null;
 const ms=r=>Math.max(0,Math.round(performance.now()-r.start));
 const size=(chunk,encoding)=>typeof chunk==='string'?Buffer.byteLength(chunk,typeof encoding==='string'?encoding:'utf8'):chunk?.byteLength||0;
 const original=http.request;http.request=function(...args){const req=original.apply(this,args);
  if(req.method!=='POST'||req.path!=='/api/public/otel/v1/traces'||req.getHeader('host')!=='127.0.0.1:'+port)return req;
  const r={start:performance.now(),body:0,finish:null,response:null,status:null,duration:null,timeout:false,socket:null,socketStart:0};count++;last=r;
  const add=(chunk,encoding)=>{try{r.body+=size(chunk,encoding);maxBody=Math.max(maxBody||0,r.body);}catch{}};
  const write=req.write,end=req.end;req.write=function(...args){add(args[0],args[1]);return write.apply(this,args);};
  req.end=function(...args){try{if(r.body===0&&Buffer.isBuffer(args[0])&&req.getHeader('content-type')==='application/x-protobuf'&&!req.getHeader('content-encoding')){const p=spans(args[0]);if(p){maxSpan=Math.max(maxSpan||0,p.max);maxSpans=Math.max(maxSpans||0,p.count);}}}catch{}add(args[0],args[1]);return end.apply(this,args);};
  req.once('socket',socket=>{r.socket=socket;r.socketStart=socket.bytesWritten;});
  req.once('finish',()=>{r.finish=ms(r);});req.once('timeout',()=>{r.timeout=true;timed=r;});
  req.once('response',res=>{r.response=ms(r);r.status=res.statusCode;if(res.statusCode>=400)failed=r;});
  req.once('error',()=>{failed=r;});req.once('close',()=>{r.duration=ms(r);r.written=r.socket?Math.max(0,r.socket.bytesWritten-r.socketStart):null;});return req;
 };
 syncBuiltinESMExports();
 process.once('exit',()=>{try{const r=timed||failed||last;const value={schema:1,sdkRequests:count,sdkMaxBodyBytes:maxBody,sdkMaxSpanBytes:maxSpan,sdkMaxSpans:maxSpans,sdkRequestFinishMs:r?.finish??null,sdkResponseMs:r?.response??null,sdkResponseStatus:r?.status??null,sdkRequestMs:r?(r.duration??ms(r)):null,sdkTimedOut:r?.timeout??null,sdkSocketWrittenBytes:r?.written??null};fs.writeFileSync(file,JSON.stringify(value),{mode:0o600,flag:'wx'});}catch{}});
}
