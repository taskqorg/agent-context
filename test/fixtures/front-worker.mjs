import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
// Node test discovery loads this fixture without its supervisor IPC.
if(!process.send) process.exit(0);
const version=process.argv[2],owner=crypto.randomUUID(),controlKey=process.env.AGENT_CONTEXT_FRONT_CONTROL||crypto.randomUUID();
const descendant=process.argv[3]==='ignore-stop'?spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}):null;
const health={descendantPid:descendant?.pid,owner,pid:process.pid,version,active:0,compressor:'local-tools',telemetry:true,native_event_protocol:1};
const server=http.createServer((req,res)=>{
 if(req.url==='/agent-context/health')res.end(JSON.stringify(health));
 else if(req.url==='/agent-context/native-event') {if(req.headers['x-agent-context-control']!==controlKey){res.writeHead(403);res.end('{}');}else{res.end('{"accepted":true,"telemetry":true}');}}
 else res.end(version);
});
server.on('upgrade',(req,socket)=>{
 socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n');
 socket.on('data',data=>socket.write(Buffer.concat([Buffer.from(version+':'),data])));
});
server.listen(0,'127.0.0.1',()=>process.send({kind:'ready',version,url:`http://127.0.0.1:${server.address().port}`,controlKey,health:process.argv[3]==='bad-ready'?{...health,owner:'wrong-owner'}:health}));
process.once('disconnect',()=>server.close(()=>process.exit(0)));
process.on('message',message=>{if(message.kind==='stop'&&process.argv[3]!=='ignore-stop')server.close(()=>process.exit(0));});
