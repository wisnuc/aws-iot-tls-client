const path = require('path')
const fs = require('fs')
const child = require('child_process')
const { Duplex } = require('stream')
const net = require('net')
const crypto = require('crypto')

const { createHash, createHmac, createSign, createCipheriv,
  createDecipheriv, publicEncrypt, randomFillSync } = crypto

/** ContentType **/
const CHANGE_CIPHER_SPEC = 20
const ALERT = 21
const HANDSHAKE = 22
const APPLICATION_DATA = 23

/**
content type for TLS record layer
@readonly
@enum {number} - 1 byte
*/
const CT = {
  CHANGE_CIPHER_SPEC: 20,
  ALERT: 21,
  HANDSHAKE: 22,
  APPLICATION_DATA: 23
}

/** HandshakeType **/
const HELLO_REQUEST = 0
const CLIENT_HELLO = 1
const SERVER_HELLO = 2
const CERTIFICATE = 11
const SERVER_KEY_EXCHANGE = 12
const CERTIFICATE_REQUEST = 13
const SERVER_HELLO_DONE = 14
const CERTIFICATE_VERIFY = 15
const CLIENT_KEY_EXCHANGE = 16
const FINISHED = 20

/** 
Alert Description 
@readonly
@enum {number} - 1 byte
*/
const AD = {
  CLOSE_NOTIFY: 0,
  UNEXPECTED_MESSAGE: 10,
  BAD_RECORD_MAC: 20,
  DECRYPTION_FAILED_RESERVED: 21,
  RECORD_OVERFLOW: 22,
  DECOMPRESSION_FAILURE: 30,
  HANDSHAKE_FAILURE: 40,
  NO_CERTIFICATE_RESERVED: 41,
  BAD_CERTIFICATE: 42,
  UNSUPPORTED_CERTIFICATE: 43,
  CERTIFICATE_REVOKED: 44,
  CERTIFICATE_EXPIRED: 45,
  CERTIFICATE_UNKNOWN: 46,
  ILLEGAL_PARAMETER: 47,
  UNKNOWN_CA: 48,
  ACCESS_DENIED: 49,
  DECODE_ERROR: 50,
  DECRYPT_ERROR: 51,
  EXPORT_RESTRICTION_RESERVED: 60,
  PROTOCOL_VERSION: 70,
  INSUFFICIENT_SECURITY: 71,
  INTERNAL_ERROR: 80,
  USER_CANCELED: 90,
  NO_RENEGOTIATION: 100,
  UNSUPPORTED_EXTENSION: 110
}

// K combinator
const K = x => y => x

// constants
const TLSVersion = Buffer.from([0x03, 0x03])
const AES_128_CBC_SHA = Buffer.from([0x00, 0x2f])
const RSA_PKCS1_SHA256 = Buffer.from([0x04, 0x01])
const RSA_PKCS1_PADDING = crypto.constants.RSA_PKCS1_PADDING

// buffer manipulate
const UInt8 = i => Buffer.from([i])
const UInt16 = i => Buffer.from([i >> 8, i])
const UInt24 = i => Buffer.from([i >> 16, i >> 8, i])
const readUInt24 = buf => buf[0] * 65536 + buf[1] * 256 + buf[2]
const Prepend8 = b => Buffer.concat([UInt8(b.length), b])
const Prepend16 = b => Buffer.concat([UInt16(b.length), b])
const Prepend24 = b => Buffer.concat([UInt24(b.length), b])
const randomBuffer = size => randomFillSync(Buffer.alloc(size))

// digest functions
const SHA256 = data => createHash('sha256').update(data).digest()
const HMAC1 = (key, data) => createHmac('sha1', key).update(data).digest()
const HMAC256 = (key, data) => createHmac('sha256', key).update(data).digest()

// cipher factory
const CIPHER = (algorithm, key, iv, data) => {
  let c = createCipheriv(algorithm, key, iv).setAutoPadding(false)
  return Buffer.concat([iv, c.update(data), c.final()])
}

// decipher factory
const DECIPHER = (algorithm, key, data) => {
  let iv = data.slice(0, 16)
  let d = createDecipheriv(algorithm, key, iv).setAutoPadding(false)
  return Buffer.concat([d.update(data.slice(16)), d.final()])
}

// psuedo random function for key generation and expansion
const PRF256 = (secret, label, seed, length) => {
  seed = Buffer.concat([Buffer.from(label, 'binary'), seed])
  let P_HASH = Buffer.alloc(0)
  for (let A = Buffer.from(seed); P_HASH.length < length;
    A = HMAC256(secret, A),
    P_HASH = Buffer.concat([P_HASH, HMAC256(secret, Buffer.concat([A, seed]))])) {}
  return P_HASH.slice(0, length)
}

// sequence number using big int
const createSequenceNumber = () => {
  let buf = Buffer.alloc(8)
  return () => {
    let r = Buffer.from(buf)
    buf.writeUInt32BE(buf.readUInt32BE(4) + 1, 4)
    if (buf.readUInt32BE(4) === 0) {
      buf.writeUInt32BE(buf.readUInt32BE(0) + 1, 0)
      if (buf.readUInt32BE(0) === 0) throw new Error('sequence number overflow')
    }
    return r
  }
}

//
const createCipher = (key, macKey, counter) => {
  const SN = createSequenceNumber()
  return (type, data) => {
    let iv = SHA256((++counter).toString()).slice(0, 16)
    let tbs = Buffer.concat([SN(), UInt8(type), TLSVersion, Prepend16(data)])
    let mac = HMAC1(macKey, tbs)
    let len = 16 - (data.length + mac.length) % 16
    let pad = Buffer.alloc(len, len - 1)
    return CIPHER('aes-128-cbc', key, iv, Buffer.concat([data, mac, pad]))
  }
}

const createDecipher = (key, macKey) => {
  const SN = createSequenceNumber()
  return (type, data) => {
    let dec = DECIPHER('aes-128-cbc', key, data)
    let len = dec[dec.length - 1] + 1
    if (dec.length < len) throw new Error('bad padding')
    let pad = dec.slice(dec.length - len)
    if (!pad.equals(Buffer.alloc(len, len - 1))) throw new Error('bad padding')
    data = dec.slice(0, dec.length - len - 20)
    let smac = dec.slice(dec.length - len - 20, dec.length - len)
    let tbs = Buffer.concat([SN(), UInt8(type), TLSVersion, Prepend16(data)])
    let cmac = HMAC1(macKey, tbs)
    if (!smac.equals(cmac)) throw new Error('mac mismatch')
    return data
  }
}

class State {
  constructor (ctx) {
    this.ctx = (ctx instanceof State) ? ctx.ctx : ctx
  }

  exit () { }

  setState (NextState, ...args) {
    let p
    for (p = Object.getPrototypeOf(this);
      !(NextState.prototype instanceof p.constructor);
      p.hasOwnProperty('exit') && p.exit.apply(this),
      p = Object.getPrototypeOf(p));

    this.ctx.state = new NextState(this, ...args)

    let qs = []
    for (let q = NextState.prototype;
      q !== p;
      q.hasOwnProperty('enter') && qs.unshift(q),
      q = Object.getPrototypeOf(q));

    qs.forEach(q => q.enter.apply(this.ctx.state))
  }

  static init (ctx, InitState, ...args) {
    ctx.state = new InitState(ctx, ...args)

    let qs = []
    for (let q = InitState.prototype;
      q !== State.prototype;
      q.hasOwnProperty('enter') && qs.unshift(q),
      q = Object.getPrototypeOf(q));

    qs.forEach(q => q.enter.apply(ctx.state))
  }

  write (type, data) {
    this.ctx.socketWrite(type, data)
  }

  handleChangeCipherSpec (data) {
    throw new Error('unexpected change cipher spec')
  }

  handleAlert (data) {
    console.log('server alert', data)
  }

  handleHandshake (data) {
    throw new Error('unexpected handshake')
  }

  handleApplicationData (data) {
    throw new Error('unexpected application data')
  }
}

class HandshakeState extends State {
  constructor (ctx) {
    super(ctx)
    if (ctx instanceof HandshakeState) {
      this.hs = ctx.hs
    } else {
      this.hs = {
        buffer: [],
        sessionId: 0,
        clientRandom: randomBuffer(32),
        preMasterSecret: Buffer.concat([TLSVersion, randomBuffer(46)]),
        masterSecret: null,

        push (data) {
          this.buffer.push(data)
        },
        tbs () {
          return Buffer.concat(this.buffer)
        },
        digest () {
          return SHA256(this.tbs())
        },
        deriveKeys () {
          this.masterSecret = PRF256(this.preMasterSecret, 'master secret',
            Buffer.concat([this.clientRandom, this.serverRandom]), 48)

          let keys = PRF256(this.masterSecret, 'key expansion',
            Buffer.concat([this.serverRandom, this.clientRandom]), 2 * (20 + 16) + 16)

          this.clientWriteMacKey = keys.slice(0, 20)
          this.serverWriteMacKey = keys.slice(20, 40)
          this.clientWriteKey = keys.slice(40, 56)
          this.serverWriteKey = keys.slice(56, 72)
          this.iv = Array.from(keys.slice(72)).reduce((sum, c, i) =>
            (sum + BigInt(c) << (BigInt(8) * BigInt(i))), BigInt(0))
        },
        clientVerifyData () {
          return PRF256(this.masterSecret, 'client finished', this.digest(), 12)
        },
        serverVerifyData () {
          return PRF256(this.masterSecret, 'server finished', this.digest(), 12)
        }
      }
    }
  }

  write (type, data) {
    data = Buffer.concat([UInt8(type), Prepend24(data)])
    this.hs.push(data)
    super.write(HANDSHAKE, data)
  }

  changeCipherSpec () {
    this.hs.deriveKeys()
    super.write(CT.CHANGE_CIPHER_SPEC, Buffer.from([1]))
    this.ctx.createCipher(this.hs.clientWriteKey, this.hs.clientWriteMacKey, this.hs.iv)
  }

  serverChangeCipherSpec () {
    this.ctx.createDecipher(this.hs.serverWriteKey, this.hs.serverWriteMacKey)
  }

  handleHandshake (data) {
    if (data[0] === HELLO_REQUEST) return
    if (data[0] !== FINISHED) this.hs.push(data)
    switch (data[0]) {
      case SERVER_HELLO:
        this.handleServerHello(data.slice(4))
        break
      case CERTIFICATE:
        this.handleCertificate(data.slice(4))
        break
      case CERTIFICATE_REQUEST:
        this.handleCertificateRequest(data.slice(4))
        break
      case SERVER_HELLO_DONE:
        this.handleServerHelloDone(data.slice(4))
        break
      case FINISHED:
        this.handleFinished(data.slice(4))
        break
      default:
        throw new Error('unsupported handshake message type')
    }
  }
}

class ServerHello extends HandshakeState {
  enter () {
    this.write(CLIENT_HELLO, Buffer.concat([
      TLSVersion,
      this.hs.clientRandom,
      Buffer.from([0]), // session_id
      Buffer.from([0x00, 0x02, 0x00, 0x2f]), // cipher_suites
      Buffer.from([0x01, 0x00]) // compression_methods
    ]))
  }

  handleServerHello (data) {
    const shift = size => K(data.slice(0, size))(data = data.slice(size))
    if (!shift(2).equals(TLSVersion)) throw new Error('unsupported tls version')
    this.hs.serverRandom = shift(32)
    this.hs.sessionId = shift(shift(1)[0])
    if (!shift(2).equals(AES_128_CBC_SHA)) throw new Error('unsupported cipher suite')
    if (shift(1)[0] !== 0) throw new Error('unsupported compression')
    // ignore remaining bytes
    this.setState(ServerCertificate)
  }
}

class ServerCertificate extends HandshakeState {
  handleCertificate (data) {
    const shift = size => K(data.slice(0, size))(data = data.slice(size))
    if (data.length < 3 ||
      readUInt24(shift(3)) !== data.length) throw new Error('invalid message length')

    this.hs.serverCertificates = []
    while (data.length) {
      if (data.length < 3 ||
        readUInt24(data) + 3 > data.length) throw new Error('invalid cert length')
      this.hs.serverCertificates.push(shift(readUInt24(shift(3))))
    }

    // verify server certificates are deferred to

    let input = this.hs.serverCertificates[0]
    let cmd = 'openssl x509 -inform der -noout -pubkey'
    this.hs.serverPublicKey = child.execSync(cmd, { input })
    this.setState(CertificateRequest)
  }
}

class CertificateRequest extends HandshakeState {
  handleCertificateRequest (data) {
    const shift = size => K(data.slice(0, size))(data = data.slice(size))

    if (data.length < 1 || data[0] + 1 > data.length) throw new Error('invalid length')
    this.hs.certificateTypes = Array.from(shift(shift(1)[0]))

    if (data.length < 2 || data.readUInt16BE() % 2 ||
      data.readUInt16BE() + 2 > data.length) throw new Error('invalid length')
    this.hs.signatureAlgorithms = Array
      .from(shift(shift(2).readUInt16BE()))
      .reduce((acc, c, i, arr) => (i % 2) ? [...acc, arr[i - 1] * 256 + c] : acc, [])
    // ignore distinguished names
    this.setState(ServerHelloDone)
  }
}

class ServerHelloDone extends HandshakeState {
  handleServerHelloDone (data) {
    if (data.length) throw new Error('invalid server hello done')
    this.write(CERTIFICATE, Prepend24(Buffer.concat([
      ...this.ctx.getClientCertificates().map(c => Prepend24(c))])))
    this.write(CLIENT_KEY_EXCHANGE, Prepend16(publicEncrypt({
      key: this.hs.serverPublicKey,
      padding: RSA_PKCS1_PADDING
    }, this.hs.preMasterSecret)))
    this.setState(VerifyServerCertificate)
  }
}

class VerifyServerCertificate extends HandshakeState {
  enter () {
    this.ctx.verifyServerCertificates(this.hs.serverCertificates)
  }

  serverCertificatesVerified () {
    this.setState(CertificateVerify)
  }
}

class CertificateVerify extends HandshakeState {
  enter () {
    this.ctx.signHandshakeMessages(this.hs.tbs())
  }

  handshakeMessagesSigned (algorithm, signature) {
    this.write(CERTIFICATE_VERIFY, Buffer.concat([algorithm, Prepend16(signature)]))
    this.changeCipherSpec()
    this.write(FINISHED, this.hs.clientVerifyData())
    this.setState(ChangeCipherSpec)
  }
}

class ChangeCipherSpec extends HandshakeState {
  handleChangeCipherSpec () {
    this.serverChangeCipherSpec()
    this.setState(ServerFinished)
  }
}

class ServerFinished extends HandshakeState {
  handleFinished (data) {
    if (!data.equals(this.hs.serverVerifyData())) { throw new Error('verify data mismatch') }
    this.setState(Established)
  }
}

class Established extends State {
  enter () {
    this.ctx.emit('connect')
  }

  _write (data, _, callback) {
    this.ctx.socketWrite(APPLICATION_DATA, data, callback)
  }

  _read (size) {

  }

  handleApplicationData (data) {
    this.ctx.push(data)
  }
}

class TLS extends Duplex {
  constructor (socket, opts) {
    super()
    this.opts = opts
    this.finished = false

    this.socket = socket
    this.data = Buffer.alloc(0)
    this.fragment = Buffer.alloc(0)
    this.fragmentType = 255
    this.cipher = null
    this.decipher = null

    try {
      const onData = data => {
        try {
          this.handleSocketData(data)
        } catch (e) {
          console.log(e)
        }
      }

      const onError = err => {
      }

      const onClose = () => {
      }

      socket.on('data', onData)
      socket.on('error', onError)
      socket.on('close', onClose)

      State.init(this, ServerHello)
    } catch (e) {
      console.log(e)
    }
  }

  // fragment is plain text
  handleFragment (type, fragment) {
    const shift = size =>
      K(this.fragment.slice(0, size))(this.fragment = this.fragment.slice(size))

    if (this.fragment.length) {
      if (this.fragmentType !== type) throw new Error('fragment type mismatch')
      this.fragment = Buffer.concat([this.fragment, fragment])
    } else {
      this.fragment = fragment
      this.fragmentType = type
    }

    while (this.fragment.length) {
      switch (type) {
        case CT.CHANGE_CIPHER_SPEC:
          if (this.fragment[0] !== 1) throw new Error('bad change ciper spec')
          this.state.handleChangeCipherSpec(shift(1))
          break
        case ALERT:
          if (this.fragment.length < 2) return
          this.state.handleAlert(shift(2))
          break
        case HANDSHAKE:
          if (this.fragment.length < 4) return
          // let length = this.fragment.readUInt32BE() & 0xffffff
          let length = readUInt24(this.fragment.slice(1))
          if (this.fragment.length < 4 + length) return
          this.state.handleHandshake(shift(4 + length))
          break
        case APPLICATION_DATA:
          this.state.handleApplicationData(shift(this.fragment.length))
          break
        default: {
          throw new Error('exception')
        }
      }
    }
  }

  handleSocketData (data) {
    this.data = Buffer.concat([this.data, data])
    while (this.data.length >= 5) {
      let type = this.data[0]
      if (type < 20 || type > 23) throw new Error('unknown content type')
      let version = this.data.readUInt16BE(1)
      if (version !== 0x0303) throw new Error('unsupported protocol version')
      let length = this.data.readUInt16BE(3)
      if (this.data.length < 5 + length) break
      let fragment = this.data.slice(5, 5 + length)
      this.data = this.data.slice(5 + length)
      if (this.decipher) fragment = this.decipher(type, fragment)
      this.handleFragment(type, fragment)
    }
  }

  getClientCertificates () {
    return this.opts.clientCertificates
  }

  verifyServerCertificates (certificates) {
    let ca = this.opts.ca
    let pems = certificates
      .map(c => c.toString('base64'))
      .map(c => `-----BEGIN CERTIFICATE-----\n${c}\n-----END CERTIFICATE-----`)

    let cert = pems.shift()
    pems.reverse()
    pems.unshift(ca)
    let bundle = pems.join('\n')
    let cmd = `openssl verify -CAfile <(echo -e \"${bundle}\")`
    let openssl = child.exec(cmd, { shell: '/bin/bash' }, (err, stdout) => {
      console.log(err, stdout)
      this.state.serverCertificatesVerified()
    })
    openssl.stdin.write(cert)
    openssl.stdin.end()
  }

  signHandshakeMessages (tbs) {
    let key = this.opts.clientPrivateKey
    if (typeof key === 'function') {
      try {
        key(tbs, (err, data) => {
          try {
            if (err) throw err
            this.state.handshakeMessagesSigned(algorithm, signature)
          } catch (e) {
          }
        })
      } catch (e) {
      }
    } else {
      let signature = createSign('sha256').update(tbs).sign(key)
      this.state.handshakeMessagesSigned(RSA_PKCS1_SHA256, signature)
    }
  }

  createCipher (key, macKey, counter) {
    this.cipher = createCipher(key, macKey, counter)
  }

  createDecipher (key, macKey) {
    this.decipher = createDecipher(key, macKey)
  }

  socketWrite (type, data, callback) {
    if (this.cipher) data = this.cipher(type, data)
    let record = Buffer.concat([UInt8(type), TLSVersion, Prepend16(data)])
    this.socket.write(record, callback)
  }

  _write (...args) {
    this.state._write(...args)
  }

  _read (size) {
    this.state._read(size)
  }

  static createConnection (opts, callback) {
    if (typeof opts !== 'object' || !opts) throw new Error('bad options')

    const socket = new net.Socket()
    socket.once('error', err => {
      socket.removeAllListeners('connect').on('error', () => {})
      callback(err)
    })

    socket.once('connect', () => {
      socket.removeAllListeners('error')
      const tls = new TLS(socket, opts)
      tls.once('error', err => {
        tls.removeAllListeners('connect').on('error', () => {})
        callback(err)
      })

      tls.once('connect', () => {
        tls.removeAllListeners('error')
        callback(null, tls)
      })
    })

    socket.connect(opts.port, opts.host)
  }
}

module.exports = TLS