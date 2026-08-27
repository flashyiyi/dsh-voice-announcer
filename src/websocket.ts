/**
 * 零依赖 WebSocket 客户端（RFC 6455，客户端视角）。
 * 用于 edge-tts 合成：Node 原生 WebSocket（undici）无法携带自定义
 * 请求头（Origin/User-Agent/MUID），微软服务端会拒绝握手，故自研
 * 最小实现 —— https Upgrade 握手 + 帧收发（发送带 mask、接收无 mask）。
 */
import { createHash, randomBytes } from 'node:crypto'
import { request } from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 最小事件模型（与插件原有 StreamSocket 接口对齐）。 */
export interface WsEventMap {
  open: () => void
  message: (event: { data: string | Buffer }) => void
  close: () => void
  error: (event: { message: string }) => void
}

export interface WsSocket {
  send(data: string | Uint8Array): void
  close(): void
  addEventListener<K extends keyof WsEventMap>(type: K, listener: WsEventMap[K]): void
}

const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/** 客户端帧（必须 mask）。 */
function buildClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4)
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4]
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, mask, masked])
}

/**
 * 建立 WebSocket 连接（自定义 headers 握手）。
 * 事件：open / message({data: string|Buffer}) / close / error。
 */
export function createWebSocket(url: URL, headers: Record<string, string>): WsSocket {
  const listeners: { [K in keyof WsEventMap]?: WsEventMap[K][] } = {}
  const emit = <K extends keyof WsEventMap>(type: K, ...args: Parameters<WsEventMap[K]>): void => {
    for (const listener of listeners[type] ?? []) (listener as (...a: never[]) => void)(...args as never[])
  }
  const key = randomBytes(16).toString('base64')
  // https.request 只接受 https: 协议；wss: 与 https: 底层同为 TLS，仅协议名不同
  const httpUrl = new URL(url.href)
  httpUrl.protocol = 'https:'
  const req = request(httpUrl, {
    method: 'GET',
    headers: {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      ...headers,
    },
  })
  let socket: Duplex | undefined
  // 分片重组缓冲
  let buffer = Buffer.alloc(0)
  let partialOpcode = 0
  let partialChunks: Buffer[] = []
  let closed = false

  const handleFrame = (fin: boolean, opcode: number, payload: Buffer): void => {
    if (opcode === OP_PING) {
      // 回 pong（原样载荷）
      if (socket) socket.write(buildClientFrame(OP_PONG, payload))
      return
    }
    if (opcode === OP_PONG) return
    if (opcode === OP_CLOSE) {
      try { socket?.end() } catch { /* 忽略 */ }
      return
    }
    if (opcode === 0x0) {
      // continuation：追加分片
      partialChunks.push(payload)
      if (fin) {
        const data = Buffer.concat(partialChunks)
        emit(partialOpcode === OP_TEXT ? 'message' : 'message', { data: partialOpcode === OP_TEXT ? data.toString('utf8') : data })
        partialOpcode = 0
        partialChunks = []
      }
      return
    }
    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (!fin) {
        partialOpcode = opcode
        partialChunks = [payload]
        return
      }
      emit('message', { data: opcode === OP_TEXT ? payload.toString('utf8') : payload })
      return
    }
    // 未知 opcode 忽略
  }

  req.on('upgrade', (res: IncomingMessage, sock: Duplex) => {
    // 校验 Sec-WebSocket-Accept（可选但稳妥）
    const accept = res.headers['sec-websocket-accept']
    const expected = createHash('sha1').update(key + WS_GUID).digest('base64')
    if (typeof accept !== 'string' || accept !== expected) {
      emit('error', { message: 'WebSocket 握手校验失败（Sec-WebSocket-Accept 不匹配）。' })
      try { sock.destroy() } catch { /* 忽略 */ }
      return
    }
    socket = sock
    sock.on('data', (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      while (buffer.length >= 2) {
        const b0 = buffer[0]
        const b1 = buffer[1]
        const fin = (b0 & 0x80) !== 0
        const opcode = b0 & 0x0f
        const masked = (b1 & 0x80) !== 0
        let len = b1 & 0x7f
        let offset = 2
        if (len === 126) {
          if (buffer.length < 4) break
          len = buffer.readUInt16BE(2)
          offset = 4
        } else if (len === 127) {
          if (buffer.length < 10) break
          len = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }
        let maskKey: Buffer | undefined
        if (masked) {
          if (buffer.length < offset + 4) break
          maskKey = buffer.subarray(offset, offset + 4)
          offset += 4
        }
        if (buffer.length < offset + len) break
        let payload = buffer.subarray(offset, offset + len)
        buffer = buffer.subarray(offset + len)
        if (maskKey) {
          const unmasked = Buffer.alloc(payload.length)
          for (let i = 0; i < payload.length; i += 1) unmasked[i] = payload[i] ^ maskKey[i % 4]
          payload = unmasked
        }
        handleFrame(fin, opcode, payload)
      }
    })
    sock.on('error', (err: Error) => emit('error', { message: err.message }))
    sock.on('close', () => {
      if (!closed) {
        closed = true
        emit('close')
      }
    })
    emit('open')
  })
  req.on('error', (err: Error) => {
    if (!closed) {
      closed = true
      emit('error', { message: err.message })
      emit('close')
    }
  })
  req.end()

  return {
    send(data: string | Uint8Array): void {
      const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
      const frame = buildClientFrame(OP_TEXT, payload)
      if (socket && !socket.destroyed) socket.write(frame)
    },
    close(): void {
      try {
        if (socket && !socket.destroyed) {
          socket.write(buildClientFrame(OP_CLOSE, Buffer.alloc(0)))
          socket.end()
        } else {
          req.destroy()
        }
      } catch { /* 忽略 */ }
      if (!closed) {
        closed = true
        emit('close')
      }
    },
    addEventListener<K extends keyof WsEventMap>(type: K, listener: WsEventMap[K]): void {
      ;(listeners[type] ??= []).push(listener)
    },
  }
}
