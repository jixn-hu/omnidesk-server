import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { createHash } from 'node:crypto'
import ssh2 from 'ssh2'
import { parseConnectionAddress } from './shared/connection-identity.mjs'
const { Client } = ssh2

const blocked = new BlockList()
export class TargetError extends Error {}
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['224.0.0.0', 3], ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(address, prefix, isIP(address) === 6 ? 'ipv6' : 'ipv4')

export function targetResolver(cidrs = '') {
  const allowed = new BlockList()
  for (const cidr of cidrs.split(',').map(value => value.trim()).filter(Boolean)) {
    const [address, prefix] = cidr.split('/')
    if (!isIP(address) || !/^\d+$/.test(prefix ?? '')) throw new Error('OFFICIAL_TARGET_CIDRS 格式不正确')
    allowed.addSubnet(address, Number(prefix), isIP(address) === 6 ? 'ipv6' : 'ipv4')
  }
  return async (host, port) => {
    const endpoint = parseConnectionAddress(host, port)
    if (endpoint.host.includes('%')) throw new TargetError('共享网关不支持带本机接口标识的 IPv6 地址')
    const addresses = isIP(endpoint.host) ? [{ address: endpoint.host, family: isIP(endpoint.host) }] : await lookup(endpoint.host, { all: true })
    if (!addresses.length || addresses.some(item => {
      const family = item.family === 6 ? 'ipv6' : 'ipv4'
      return blocked.check(item.address, family) && !allowed.check(item.address, family)
    })) throw new TargetError('目标网段未获官方服务管理员许可，请配置 OFFICIAL_TARGET_CIDRS')
    return { host: addresses[0].address, port: endpoint.port }
  }
}

export async function inspectSshKey(endpoint) {
  return await new Promise((resolve, reject) => {
    const client = new Client()
    let finished = false
    const timeout = setTimeout(() => { finished = true; client.destroy(); reject(new TargetError('SSH 主机身份检查超时')) }, 10000)
    const finish = () => { clearTimeout(timeout); client.end() }
    client.on('error', () => { if (!finished) { finished = true; finish(); reject(new TargetError('无法读取 SSH 主机身份，请检查服务端到目标的网络')) } })
    client.connect({ ...endpoint, username: 'omnidesk-host-check', readyTimeout: 10000, hostVerifier: key => {
      if (finished) return false
      finished = true
      const type = key.subarray(4, 4 + key.readUInt32BE(0)).toString('utf8')
      const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
      finish()
      resolve({ fingerprint, key: `${type} ${key.toString('base64')}` })
      return false
    } })
  })
}
