import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'

export function instruction(...elements) {
  return serialize(elements)
}

function serialize(elements, utf16 = false) {
  return elements.map(value => { const text = String(value); return `${utf16 ? text.length : [...text].length}.${text}` }).join(',') + ';'
}

export class InstructionReader {
  buffer = ''
  constructor(onInstruction, maximum = 4 * 1024 * 1024, utf16 = false) { this.onInstruction = onInstruction; this.maximum = maximum; this.utf16 = utf16 }
  receive(chunk) {
    this.buffer += chunk
    if (this.buffer.length > this.maximum) throw new Error('协议数据超出限制')
    for (;;) {
      let position = 0
      const elements = []
      for (;;) {
        const dot = this.buffer.indexOf('.', position)
        if (dot === -1) return
        const lengthText = this.buffer.slice(position, dot)
        if (!/^\d{1,8}$/.test(lengthText)) throw new Error('协议长度无效')
        const length = Number(lengthText)
        if (length > this.maximum) throw new Error('协议元素超出限制')
        const start = dot + 1
        let end = start
        for (let count = 0; count < length; count++) {
          if (end >= this.buffer.length) return
          end += !this.utf16 && this.buffer.codePointAt(end) > 0xffff ? 2 : 1
        }
        if (end >= this.buffer.length) return
        const separator = this.buffer[end]
        if (separator !== ',' && separator !== ';') throw new Error('协议分隔符无效')
        elements.push(this.buffer.slice(start, end))
        if (elements.length > 256) throw new Error('协议参数过多')
        position = end + 1
        if (separator === ';') {
          this.buffer = this.buffer.slice(position)
          this.onInstruction(elements)
          break
        }
      }
      if (!this.buffer) return
    }
  }
}

export function startGateway(websocket, { metadata, credential, hostKey, endpoint, dimensions, guacd, stillAuthorized, onClose }) {
  let ready = false
  let closed = false
  let connected = false
  const send = (...elements) => { if (websocket.readyState === 1) websocket.send(serialize(elements, true)) }
  const socket = connect(guacd.port, guacd.host)
  socket.setEncoding('utf8')
  const close = () => {
    if (closed) return
    closed = true
    clearTimeout(timeout)
    clearInterval(authorizationTimer)
    socket.destroy()
    websocket.close()
    onClose?.()
  }
  const fail = message => { send('error', message, '519'); close() }
  const timeout = setTimeout(() => fail('共享连接建立超时，请联系服务器共享者'), 25000)
  const authorizationTimer = setInterval(() => { if (!stillAuthorized()) fail('登录已失效或共享已撤销') }, 15000)
  socket.on('connect', () => socket.write(instruction('select', metadata.kind)))
  const parser = new InstructionReader(elements => {
    const [opcode, ...argumentsList] = elements
    if (opcode === 'args' && !connected) {
      connected = true
      const parameters = {
        hostname: endpoint.host, port: String(endpoint.port), username: metadata.username,
        password: metadata.authMethod === 'privateKey' ? '' : credential.secret,
        'private-key': metadata.authMethod === 'privateKey' ? credential.secret : '',
        passphrase: credential.passphrase ?? '', domain: metadata.domain ?? '',
        security: 'nla', 'ignore-cert': metadata.ignoreCertificate === false ? 'false' : 'true',
        'host-key': hostKey ? `${endpoint.port === 22 ? endpoint.host : `[${endpoint.host}]:${endpoint.port}`} ${hostKey}` : '',
        'enable-sftp': 'false', 'enable-drive': 'false', 'enable-printing': 'false',
        'disable-audio': 'true', 'enable-audio-input': 'false', 'resize-method': 'display-update',
        'color-depth': '32', 'server-alive-interval': '15', 'font-size': '13',
        'enable-wallpaper': 'false', 'enable-theming': 'false'
      }
      socket.write(instruction('size', dimensions.width, dimensions.height, 96))
      socket.write(instruction('audio') + instruction('video') + instruction('image', 'image/png', 'image/jpeg'))
      socket.write(instruction('connect', ...argumentsList.map(name => name.startsWith('VERSION_') ? 'VERSION_1_5_0' : parameters[name] ?? '')))
    } else if (opcode === 'ready' && connected && !ready) {
      ready = true
      clearTimeout(timeout)
      send('', randomUUID())
    } else if (opcode === 'error') {
      fail('共享服务器连接失败，请共享者检查账号、凭据、证书和网关日志')
    } else if (ready && !['args', 'require', 'connect', 'ready'].includes(opcode)) {
      if (websocket.bufferedAmount > 8 * 1024 * 1024) return fail('网络处理过慢，共享会话已断开，请重试')
      send(...elements)
    }
  })
  socket.on('data', chunk => { try { parser.receive(chunk) } catch { fail('远程网关返回无效数据') } })
  socket.on('error', () => fail('共享网关不可用，请确认 guacd 已启动并可访问目标服务器'))
  socket.on('close', close)
  const clientParser = new InstructionReader(elements => {
    const [opcode] = elements
    if (opcode === '') { if (elements[1] === 'ping') send(...elements); return }
    if (!ready) return
    if (!['sync', 'size', 'mouse', 'key', 'ack', 'blob', 'end', 'clipboard', 'disconnect'].includes(opcode)) return fail('共享连接不支持此操作')
    if (opcode === 'size' && (elements.length !== 3 || elements.slice(1).some(value => !/^\d+$/.test(value) || Number(value) < 200 || Number(value) > 8192))) return fail('窗口尺寸无效')
    if (socket.writableLength > 1024 * 1024) return fail('共享会话输入过快')
    socket.write(instruction(...elements))
  }, 128 * 1024, true)
  websocket.on('message', (data, binary) => { if (binary) return fail('共享连接协议无效'); try { clientParser.receive(data.toString('utf8')) } catch { fail('共享连接输入无效') } })
  websocket.on('error', close)
  websocket.on('close', close)
  return close
}
