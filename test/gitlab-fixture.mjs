import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'

export const syntheticClientId = 'qa-gitlab-application'
export const syntheticClientSecret = 'QA-GitLab-secret-not-a-real-credential'
export async function createGitlabFixture() {
  const codes = new Map()
  const tokens = new Map()
  let nextProfile = { sub: '101', preferred_username: 'qa_gitlab' }
  let failure = null
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      if (failure?.path === url.pathname) {
        response.writeHead(failure.status ?? 400, { 'Content-Type': 'application/json' })
        response.end(typeof failure.body === 'string' ? failure.body : JSON.stringify(failure.body))
        return
      }
      if (url.pathname === '/oauth/authorize') {
        assert.equal(url.searchParams.get('client_id'), syntheticClientId)
        assert.equal(url.searchParams.get('response_type'), 'code')
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
        assert.equal(url.searchParams.get('scope'), 'openid profile')
        const code = randomBytes(12).toString('hex')
        codes.set(code, { profile: { ...nextProfile }, challenge: url.searchParams.get('code_challenge'), redirect: url.searchParams.get('redirect_uri') })
        const callback = new URL(url.searchParams.get('redirect_uri'))
        callback.searchParams.set('code', code); callback.searchParams.set('state', url.searchParams.get('state'))
        response.writeHead(302, { Location: callback.href }); response.end(); return
      }
      if (url.pathname === '/oauth/token') {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const parameters = new URLSearchParams(Buffer.concat(chunks).toString())
        assert.equal(parameters.get('client_id'), syntheticClientId)
        assert.equal(parameters.get('client_secret'), syntheticClientSecret)
        assert.equal(parameters.get('grant_type'), 'authorization_code')
        const record = codes.get(parameters.get('code'))
        if (!record) { response.writeHead(400); response.end('{}'); return }
        codes.delete(parameters.get('code'))
        assert.equal(parameters.get('redirect_uri'), record.redirect)
        assert.equal(createHash('sha256').update(parameters.get('code_verifier')).digest('base64url'), record.challenge)
        const token = 'QA-access-token-' + randomBytes(12).toString('hex')
        tokens.set(token, record.profile)
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ access_token: token, token_type: 'Bearer' })); return
      }
      if (url.pathname === '/oauth/userinfo') {
        const profile = tokens.get(request.headers.authorization?.replace(/^Bearer /, ''))
        if (!profile) { response.writeHead(401); response.end('{}'); return }
        const body = Buffer.from(JSON.stringify(profile))
        const split = Math.max(1, body.findIndex(value => value > 127) + 1)
        response.setHeader('Content-Type', 'application/json')
        response.write(body.subarray(0, split))
        setTimeout(() => response.end(body.subarray(split)), 5)
        return
      }
      response.writeHead(404); response.end('{}')
    } catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: error.message })) }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { origin: 'http://127.0.0.1:' + server.address().port, setProfile: profile => { nextProfile = profile }, setFailure: value => { failure = value }, close: () => new Promise(done => server.close(done)) }
}

export async function authorizeGitlab(authorizationUrl, browserCookie) {
  const authorize = await fetch(authorizationUrl, { redirect: 'manual', headers: { Connection: 'close', ...(browserCookie ? { Cookie: browserCookie } : {}) } })
  assert.equal(authorize.status, 302)
  const cookie = authorize.headers.get('set-cookie').split(';')[0]
  const login = await fetch(authorize.headers.get('location'), { redirect: 'manual', headers: { Connection: 'close' } })
  assert.equal(login.status, 302)
  return { cookie, callback: login.headers.get('location') }
}

export async function completeGitlab(authorizationUrl, expectedStatus = 200) {
  const browser = await authorizeGitlab(authorizationUrl)
  const callback = await fetch(browser.callback, { headers: { Cookie: browser.cookie, Connection: 'close' } })
  assert.equal(callback.status, expectedStatus)
  const contents = await callback.text()
  assert(!contents.includes('access_token') && !contents.includes(syntheticClientSecret))
  assert(callback.headers.get('content-security-policy').includes("default-src 'none'"))
  return browser
}
