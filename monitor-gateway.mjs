// The monitoring backend is private; every user request is scoped by the account session.
export function registerMonitoring({ application, authenticate, route, url, token, fetcher = fetch }) {
 const available = !!url && !!token
 const forward = async (request,response,agent=false) => {
  if (!available) return response.status(503).json({error:'云端尚未启用监控模块'})
  const suffix = request.url.replace(/^\/v1(?=\/)/,'')
  const path = suffix.startsWith('/healthz') ? suffix : '/v1' + suffix
  const headers = { 'Content-Type':'application/json', Authorization: agent ? request.headers.authorization ?? '' : 'Bearer ' + token }
  if (!agent) { headers['X-OmniDesk-User']=request.account.id; headers['X-OmniDesk-Admin']=String(request.account.role === 'admin') }
  const bytes = ['GET','HEAD'].includes(request.method) ? undefined : JSON.stringify(request.body ?? {})
  if (bytes && Buffer.byteLength(bytes)>1024*1024) return response.status(413).json({error:'监控请求过大'})
  try {
   const upstream=await fetcher(url.replace(/\/$/,'')+path,{method:request.method,headers,body:bytes,redirect:'error',signal:AbortSignal.timeout(15000)})
   const reader=upstream.body?.getReader(); const chunks=[]; let size=0
   if(reader) try { for (;;) { const item=await reader.read(); if(item.done)break; size+=item.value.length; if(size>24*1024*1024) { await reader.cancel(); throw new Error('oversize') }; chunks.push(item.value) } } finally { reader.releaseLock() }
   response.status(upstream.status).type('application/json').send(Buffer.concat(chunks))
  } catch { response.status(502).json({error:'监控模块暂时不可用，请稍后重试'}) }
 }
 // Agent authentication is per-node, independent of user-session expiration.
 application.post('/v1/monitor/reports',route((req,res)=> {
  const original=req.url; req.url='/reports'; return forward(req,res,true).finally(()=>{req.url=original})
 }))
 application.use('/v1/monitor',authenticate,route((req,res)=>forward(req,res)))
}
