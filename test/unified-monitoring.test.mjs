import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, writeFileSync, readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import {createServer} from 'node:net'
import {once} from 'node:events'
import {setTimeout as delay} from 'node:timers/promises'
import {createOfficialServer} from '../server.mjs'

const executable=process.env.OMNIDESK_MONITOR_TEST_BINARY
async function fixture(t,options={}){
 const directory=mkdtempSync(join(tmpdir(),'omnidesk-unified-'))
 const allocation=createServer();allocation.listen(0,'127.0.0.1');await once(allocation,'listening');const port=allocation.address().port;await new Promise(r=>allocation.close(r))
 const token='synthetic-internal-admin-token-at-least-24',monitorUrl='http://127.0.0.1:'+port
 const child=spawn(executable,['-listen','127.0.0.1:'+port,'-data',join(directory,'monitor.db')],{windowsHide:true,stdio:'ignore',env:{...process.env,OMNIDESK_ADMIN_TOKEN:token,OMNIDESK_ADMIN_TOKEN_FILE:''}})
 t.after(()=>{child.kill()})
 for(let i=0;;i++){try{if((await fetch(monitorUrl+'/healthz')).ok)break}catch{};if(i>100)throw new Error('monitor did not start');await delay(50)}
 const account=createOfficialServer({directory:join(directory,'account'),registration:true,monitorUrl,monitorToken:token,...options});account.server.listen(0,'127.0.0.1');await once(account.server,'listening');t.after(()=>account.close())
 const origin='http://127.0.0.1:'+account.server.address().port
 const api=async(path,session,method='GET',body,extra={})=>{const r=await fetch(origin+path,{method,headers:{Connection:'close',...(session?{Authorization:'Bearer '+session}:{}),...(body?{'Content-Type':'application/json'}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()}}
 const register=async username=>(await api('/v1/auth/register',null,'POST',{username,password:'Synthetic-test-password-2026'})).body
 const a=await register('account_a'),b=await register('account_b')
 return {api,a,b,monitorUrl,token,origin}
}
test('one cloud URL isolates accounts, nodes, tokens and raw database exports',{skip:!executable},async t=>{
 const {api,a,b}=await fixture(t)
 assert.equal((await api('/v1/monitor/nodes')).status,401)
 const first=await api('/v1/monitor/nodes',a.token,'POST',{name:'A Windows',intervalSeconds:600})
 assert.equal(first.status,201);const {node,token}=first.body
 assert.equal(node.intervalSeconds,600)
 const second=await api('/v1/monitor/nodes',b.token,'POST',{name:'B Linux'})
 assert.equal(second.status,201);assert.equal(second.body.node.intervalSeconds,60)
 assert.deepEqual((await api('/v1/monitor/nodes',a.token)).body.map(n=>n.name),['A Windows'])
 assert.deepEqual((await api('/v1/monitor/nodes',b.token)).body.map(n=>n.name),['B Linux'])
 for(const [suffix,method,body] of [['/history?hours=1','GET'],['','PUT',{name:'stolen'}],['','DELETE'],['/token','POST'],['/probe','POST']]) assert.equal((await api('/v1/monitor/nodes/'+node.id+suffix,b.token,method,body,{'X-OmniDesk-User':a.user.id,'X-OmniDesk-Admin':'true'})).status,404)
 assert.equal((await api('/v1/monitor/backup',a.token)).status,403)
 assert.equal((await api('/v1/monitor/unclaimed',b.token)).status,404)
 assert.equal((await api('/v1/monitor/nodes',token)).status,401)
 const now=Date.now();const metrics={timestamp:now,intervalSeconds:60,system:{os:'Windows'},cpu:{usage:4,cores:2,loadAvg:[0,0,0],perCore:[4,4]},memory:{usagePercent:10},network:[],disks:[]}
 const report={epoch:'synthetic-epoch',sequence:1,timestamp:now,upload:0,download:0,metrics}
 assert.equal((await api('/v1/monitor/v1/reports',token,'POST',report)).status,401)
 const accepted=await api('/v1/monitor/reports',token,'POST',report)
 assert.equal(accepted.status,200);assert.equal(accepted.body.intervalSeconds,600)
 const probe=await api('/v1/monitor/nodes/'+node.id+'/probe',a.token,'POST');assert.equal(probe.status,200);const command=await api('/v1/monitor/reports',token,'POST',report);assert.equal(command.body.refreshId,probe.body.requestId)
 assert.equal((await api('/v1/monitor/reports',token,'POST',report)).status,200)
 assert.equal((await api('/v1/monitor/nodes',a.token)).body[0].metrics.system.os,'Windows')
 assert.equal((await api('/v1/monitor/nodes',b.token)).body[0].metrics,undefined)
 assert.equal((await api('/v1/monitor/nodes/'+node.id,a.token,'PUT',{name:'A Windows',asset:node.asset,intervalSeconds:301})).status,200)
 assert.equal((await api('/v1/monitor/nodes/'+node.id,a.token,'PUT',{name:'A Windows',asset:node.asset,intervalSeconds:4})).status,400)
 assert.equal((await api('/v1/logout',a.token,'POST')).status,200)
 assert.equal((await api('/v1/monitor/nodes',a.token)).status,401)
 assert.equal((await api('/v1/monitor/reports',token,'POST',report)).status,200,'agent reporting survives user logout')
})
test('legacy nodes are explicitly claimed by an administrator without changing their token',{skip:!executable},async t=>{
 const {api,a,b,monitorUrl,token}=await fixture(t)
 const response=await fetch(monitorUrl+'/v1/nodes',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({name:'legacy fixture'})});const legacy=await response.json()
 assert.equal((await api('/v1/monitor/nodes',a.token)).body.length,0)
 assert.equal((await api('/v1/monitor/unclaimed',a.token)).body[0].id,legacy.node.id)
 assert.equal((await api('/v1/monitor/nodes/'+legacy.node.id+'/claim',b.token,'POST')).status,404)
 assert.equal((await api('/v1/monitor/nodes/'+legacy.node.id+'/claim',a.token,'POST')).status,200)
 assert.equal((await api('/v1/monitor/nodes/'+legacy.node.id+'/claim',a.token,'POST')).status,404)
 assert.equal((await api('/v1/monitor/nodes',a.token)).body[0].id,legacy.node.id)
 assert.equal((await api('/v1/monitor/nodes',b.token)).body.length,0)
})

test('Windows download tickets are fixed, session/node scoped, expiring and repeatable',{skip:!executable},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'omnidesk-windows-assets-'))
 const binary=Buffer.from('MZsynthetic-agent-never-execute')
 writeFileSync(join(directory,'omnidesk-monitor-agent-windows-amd64.exe'),binary)
 writeFileSync(join(directory,'install-windows.ps1'),readFileSync(new URL('../assets/monitor-agent/install-windows.ps1',import.meta.url)))
 let clock=Date.now()
 const {api,a,b,origin}=await fixture(t,{windowsAgentDirectory:directory,installNow:()=>clock})
 const created=(await api('/v1/monitor/nodes',a.token,'POST',{name:'Windows fixture',intervalSeconds:77})).body
 const body={nodeId:created.node.id,token:created.token,serverUrl:origin+'/v1/monitor',intervalSeconds:77}
 const issue=()=>api('/v1/monitor/install/windows',a.token,'POST',body)
 const download=(ticket,method='GET')=>fetch(origin+'/v1/monitor/install/windows/download',{method,headers:{'X-OmniDesk-Install':ticket,Connection:'close'}})
 assert.equal((await api('/v1/monitor/install/windows',null,'POST',body)).status,401)
 assert.equal((await api('/v1/monitor/install/windows',b.token,'POST',body)).status,404)
 for(const invalid of [{nodeId:'bad'},{token:'wrong-node-token-at-least-24'},{serverUrl:origin+'/other'},{serverUrl:'https://u:p@example.test/v1/monitor'},{serverUrl:origin+'/v1/monitor?q=1'},{intervalSeconds:4}]) {
  const response=await api('/v1/monitor/install/windows',a.token,'POST',{...body,...invalid})
  assert([400,403].includes(response.status))
 }
 assert.equal((await api('/v1/monitor/install/windows',a.token,'POST',{...body,script:'x'.repeat(5000)})).status,413)
 const first=await issue();assert.equal(first.status,201)
 const replacement=await issue();assert.equal(replacement.status,201)
 assert.equal((await download(first.body.ticket)).status,410,'regeneration revokes previous ticket')
 assert.equal((await download(replacement.body.ticket,'HEAD')).status,405,'HEAD must not consume a download ticket')
 const bytes=Buffer.from(await (await download(replacement.body.ticket)).arrayBuffer())
 assert.equal(createHash('sha256').update(bytes).digest('hex'),replacement.body.sha256)
 const match=/FromBase64String\('([^']+)'\)/.exec(bytes.toString())
 const bundle=JSON.parse(Buffer.from(match[1],'base64').toString())
 assert.equal(bundle.config.serverUrl,origin+'/v1/monitor');assert.equal(bundle.config.token,created.token)
 assert.equal(bundle.config.intervalSeconds,77);assert.equal(bundle.config.installationId,replacement.body.installationId)
 assert.equal(bundle.sha256,createHash('sha256').update(binary).digest('hex'))
 assert.deepEqual(Buffer.from(bundle.binary,'base64'),binary)
 assert(!JSON.stringify(bundle).includes(a.token),'user session must never enter the installer')
 assert.equal((await download(replacement.body.ticket)).status,200,'successful downloads remain retryable')
 const concurrent=(await issue()).body
 const statuses=await Promise.all([download(concurrent.ticket),download(concurrent.ticket)]).then(values=>values.map(x=>x.status).sort())
 assert.deepEqual(statuses,[200,200])
 const expired=(await issue()).body;clock+=15*60*1000+1
 assert.equal((await download(expired.ticket)).status,410);clock=Date.now()
 const rotated=(await issue()).body;const newToken=(await api('/v1/monitor/nodes/'+body.nodeId+'/token',a.token,'POST')).body.token
 assert.equal((await download(rotated.ticket)).status,410,'token rotation invalidates pending downloads')
 body.token=newToken
 const deleted=(await issue()).body
 await api('/v1/monitor/nodes/'+body.nodeId,a.token,'DELETE')
 assert.equal((await download(deleted.ticket)).status,410,'deleting a node invalidates pending downloads')
 const next=(await api('/v1/monitor/nodes',a.token,'POST',{name:'logout fixture'})).body
 body.nodeId=next.node.id;body.token=next.token
 const loggedOut=(await issue()).body
 await api('/v1/logout',a.token,'POST')
 assert.equal((await download(loggedOut.ticket)).status,410,'logout revokes pending downloads')
 assert.equal((await download('malformed')).status,410)
})
