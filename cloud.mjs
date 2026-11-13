import { spawn } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createOfficialServer } from './server.mjs'

const directory=resolve(process.env.OMNIDESK_CLOUD_DATA ?? '/data')
mkdirSync(directory,{recursive:true,mode:0o700})
const tokenFile=join(directory,'monitor-internal-token')
if(!existsSync(tokenFile)) writeFileSync(tokenFile,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'})
const token=readFileSync(tokenFile,'utf8').trim()
if(token.length<24) throw new Error('内部监控令牌文件损坏，请保留原文件并检查')
const monitorPort=Number(process.env.OMNIDESK_MONITOR_PORT ?? 18088)
const monitorUrl='http://127.0.0.1:'+monitorPort
const child=spawn(process.env.OMNIDESK_MONITOR_BINARY ?? '/app/omnidesk-monitor-server',['-listen','127.0.0.1:'+monitorPort,'-data',join(directory,'monitor','monitor.db')],{stdio:'inherit',windowsHide:true,env:{...process.env,OMNIDESK_ADMIN_TOKEN:token,OMNIDESK_ADMIN_TOKEN_FILE:''}})
let stopping=false
let account
async function stop(code=0) { if(stopping)return; stopping=true; child.kill('SIGTERM'); if(account) await account.close(); if(process.connected)process.disconnect(); process.exitCode=code }
child.once('error',()=>{console.error('无法启动监控模块'); void stop(1)})
child.once('exit',()=>{if(!stopping){console.error('监控模块已停止'); void stop(1)}})
if(process.send) process.on('message',message=>{if(message==='shutdown')void stop()})
for(const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>void stop())
try {
 let ready=false
 for(let attempt=0;attempt<100 && !stopping;attempt++) { try { const r=await fetch(monitorUrl+'/healthz',{signal:AbortSignal.timeout(1000)}); if(r.ok){ready=true;break} }catch{}; await delay(200) }
 if(!ready) throw new Error('监控模块启动超时')
 if(!stopping) { account=createOfficialServer({directory:join(directory,'account'),monitorUrl,monitorToken:token}); account.server.once('error',()=>{console.error('统一云端监听失败');void stop(1)}); account.server.listen(Number(process.env.OFFICIAL_PORT ?? 47830),process.env.OFFICIAL_HOST ?? '0.0.0.0',()=>{console.log('OmniDesk 统一云端已启动');if(process.send)process.send({type:'ready',monitorPid:child.pid})}) }
} catch(error) { console.error(error.message); await stop(1) }
