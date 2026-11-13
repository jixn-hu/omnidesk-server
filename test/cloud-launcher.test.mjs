import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createServer} from 'node:net'
import {fork,spawn} from 'node:child_process'
import {once} from 'node:events'
import {setTimeout as delay} from 'node:timers/promises'
const binary=process.env.OMNIDESK_MONITOR_TEST_BINARY,agent=process.env.OMNIDESK_AGENT_TEST_BINARY
async function freePort(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));return port}
test('one launcher supervises both modules and a Windows console Agent reports through the same URL',{skip:!binary||!agent,timeout:30000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'omnidesk-launcher-')),port=await freePort(),monitorPort=await freePort()
 const service=fork(fileURLToPath(new URL('../cloud.mjs',import.meta.url)),[],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,OMNIDESK_CLOUD_DATA:directory,OMNIDESK_MONITOR_BINARY:binary,OMNIDESK_MONITOR_PORT:String(monitorPort),OFFICIAL_PORT:String(port),OFFICIAL_HOST:'127.0.0.1',OFFICIAL_PUBLIC_URL:'',OFFICIAL_REGISTRATION:'true'}})
 let monitorPid
 t.after(async()=>{if(service.connected)service.send('shutdown');if(monitorPid){try{process.kill(monitorPid)}catch{}};if(service.exitCode===null)service.kill()})
 const [ready]=await once(service,'message');assert.equal(ready.type,'ready');monitorPid=ready.monitorPid
 const origin='http://127.0.0.1:'+port
 const api=async(path,token,method='GET',body)=>{const response=await fetch(origin+path,{method,headers:{Connection:'close',...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()}}
 const login=await api('/v1/auth/register',null,'POST',{username:'launcher_qa',password:'Synthetic-launcher-password'});assert.equal(login.status,200)
 assert.equal((await api('/v1/monitor/healthz',login.body.token)).body.service,'omnidesk-monitor')
 const created=await api('/v1/monitor/nodes',login.body.token,'POST',{name:'Windows actual collector',intervalSeconds:5});assert.equal(created.status,201)
 const config=join(directory,'agent.json');writeFileSync(config,JSON.stringify({installationId:'synthetic-windows-installation-id',serverUrl:origin+'/v1/monitor',token:created.body.token,statePath:join(directory,'state.json'),intervalSeconds:5,disableDiscovery:true}))
 const collector=spawn(agent,['-config',config],{stdio:'ignore',windowsHide:true});t.after(()=>collector.kill())
 let metrics
 for(let attempt=0;attempt<150;attempt++){const result=await api('/v1/monitor/nodes',login.body.token);metrics=result.body[0]?.metrics;if(metrics&&!metrics.unavailable?.includes('cpu.usage'))break;await delay(100)}
 assert.equal(metrics?.installationId,'synthetic-windows-installation-id');
 assert(metrics,'missing native Agent report');assert(metrics.memory.total>0);assert(metrics.cpu.cores>0);assert(metrics.disks.length>0);assert(metrics.network.length>0);assert.equal(metrics.intervalSeconds,5)
 assert(Number.isFinite(metrics.cpu.usage));assert(!metrics.unavailable?.includes('cpu.usage'),'second CPU sample did not arrive')
 if(process.platform==='win32')assert.match(metrics.system.os,/Windows/i)
 collector.kill()
 const exited=once(service,'exit');service.send('shutdown');const [code]=await exited;assert.equal(code,0)
})
