'use strict'

const EventEmitter = require('events')
const Websocket    = require('ws')
const request      = require('request')
const log4js       = require('log4js')
const fs           = require('fs')

function noop() { }


try {
  log4js.configure('./log4js.json')
} catch (e) {
  console.error('载入log4js日志输出配置错误: ', e)
  process.exit(1);
}

const log = log4js.getLogger('app')

class Test extends EventEmitter {

  constructor(url) {
    super()
    this.url              = url
    this._event           = new EventEmitter()
    this.connected        = false
    this._autoRetry       = false
    this._disconnectCount = 0
    this.ws               = {}
    this.start()
  }

  async start() {
    if (this.ws instanceof Websocket && this.ws.readyState === this.ws.OPEN) {
      this.ws.close()
    }
    this.ws = null
    this.ws = new Websocket(this.url)
      .on('message', (msg) => {
        this.emit('msg', msg)
      })
      .on('open', () => {
        this.connected = true
        this.emit('open')
      })
      .on('close', () => {
        let disconnect = false
        if (this.connected) {
          this._disconnectCount++
          disconnect = true
        }
        this.connected = false
        this.emit('close', disconnect)
        if (this.autoRetry) {
          this.start()
        }
      })
      .on('ping', () => {
        this.emit('ping')
      })
      .on('pong', () => {
        this.emit('pong')
      })
      .on('error', (e) => {
        this.emit('error', e)
      })
    setTimeout(() => {
      this.emit('newStart')
    }, 200);
  }

  get autoRetry() {
    return this._autoRetry
  }

  set autoRetry(open) {
    this._autoRetry = !!open
  }

  get disconnectCount() {
    return this._disconnectCount
  }

  async send(msg) {
    if (this.connected && (this.ws instanceof Websocket)) {
      if (typeof msg !== 'string') {
        msg = JSON.stringify(msg)
      }
      this.ws.send(msg)
    }
  }
  ping() {
    if (this.connected && (this.ws instanceof Websocket)) {
      this.ws.ping(noop)
    }
  }
  pong() {
    if (this.connected && (this.ws instanceof Websocket)) {
      this.ws.pong(noop)
    }
  }
}


/**
 * 发送推送通知
 *
 * @param {any} desp
 * @param {any} key
 */
function notify(title, desp, key) {
  const requestData = { text: `服务端运行状态监测 ${title}`, desp: desp }
  // const url         = `http://sc.ftqq.com/${key}.send`
  const url = `http://swan.botorange.com/wechat/swan/${key}.send`
  request({ url: url, qs: requestData }, (err, res, body) => {
    if (err) {
      log.error(`request to server jiang err! msg is ${err.message}`)
    } else {
      if (res.statusCode === 200) {
        let jsonStr = JSON.parse(body)
        log.debug(`#SWAN Return: ${JSON.stringify(jsonStr)}`)
      }
    }
  })
}

async function checkServer(server) {
  const url = `http://${server}`
  return new Promise((resolve, reject) => {
    request({ url: url }, (err, res, body) => {
      if (err) {
        reject(err)
      } else {
        resolve(body)
      }
    })
  })
}

function newTest(server, key) {
  const obj  = new Test(`ws://${server}/test`)
  const test = {
    obj,
    url         : server,
    lastTime    : 0,
    connectCount: 0,
    downTime    : 0,
    lastWarnTime: 0,
    lastPing    : 0,
    maxHeart    : 0,
    connect     : false,
    sendDownWarn: false
  }
  obj.autoRetry = true
  obj
    .on('open', () => {
      const time = test.downTime ? (Date.now() - test.downTime) / 1000 : 0

      test.lastTime     = Date.now()
      test.lastPing     = 0
      test.connect      = true
      test.sendDownWarn = false
      test.downTime     = 0
      test.lastWarnTime = 0
      test.maxHeart     = 0
      test.connectCount++
      log.info('[%s] 第 %d 次连接服务器成功。%s', test.url, test.connectCount, test.connectCount > 1 ? `离上次掉线间隔了 ${time} 秒` : '')
      obj.send({
        type : 'user',
        cmd  : 'init',
        cmdId: Date.now() + '@test',
      })
    })
    .on('close', () => {
      if (!test.downTime) {
        test.downTime = Date.now()
      }
      if (!test.lastWarnTime) {
        test.lastWarnTime = Date.now()
      }
      if (test.connect) {
        test.connect = false

        const str = test.lastTime ? `上次在线 ${(Date.now() - test.lastTime) / 1000} 秒` : ''
        log.info('[%s] 第 %d 次与服务器连接断开！现在将重试连接服务器。%s', test.url, test.connectCount, str)
        notify(test.url, `连接断开 ${obj.disconnectCount} 次！${str}`, key)
      } else {
        const time  = (Date.now() - test.downTime) / 1000      //服务器挂掉
        const time2 = (Date.now() - test.lastWarnTime) / 1000  //离上次推送警告时间
        if (time > 30 || time2 > 60 * 10) {
          if (!test.sendDownWarn) {
            notify(test.url, `已无法连接 ${time} 秒！`, key)
            test.lastWarnTime = Date.now()
          }
          test.sendDownWarn = true
          log.warn('[%s] 服务端无法连接 %d 秒', test.url, time)
        }
      }
    })
    .on('msg', msg => {
      log.debug('[%s] recv msg: %s', test.url, msg)
    })
    .on('ping', () => {
      const time = (Date.now() - test.lastPing) / 1000
      if (test.lastPing > 0) {
        if (time > test.maxHeart) {
          test.maxHeart = time
        }
        if (time > 27) {
          notify(test.url, `心跳间隔达到 ${time} 秒！`, key)
          log.warn('[%s] 服务端心跳间隔 %d 秒', test.url, time)
        }
        log.debug('[%s] 服务端心跳间隔 %d 秒', test.url, time)
      }
      test.lastPing = Date.now()
    })
    .on('error', e => {
      log.error('[%s] Error:', test.url, e.message)
      notify(test.url, `Error: ${e.message}`, key)
      setTimeout(() => {
        log.info('[%s] 从Error出延时重试', test.url)
        obj.start()
      }, 1000 * 60 * 10);
    })
    .on('newStart', async () => {
      await checkServer(test.url)
        .then(body => {
          log.info('[%s] checkServer ret:', test.url, body)
        })
        .catch(e => {
          log.error('[%s] checkServer Error:', test.url, e.message)
          notify(test.url, `checkServer Error: ${e.message}`, key)
        })
    })
  return test
}

const config = {
  servers: [],   //服务器列表，ip:port
  key    : ''    //推送key
}

const CONFIGFILE = './config.json'

try {
  const tmpBuf = fs.readFileSync(CONFIGFILE)
  Object.assign(config, JSON.parse(String(tmpBuf)))
  log.info('载入配置参数')
} catch (e) {
  log.warn('没有在本地发现配置参数或解析数据失败！如首次登录请忽略！')
}

const testArr = []

for (const server of config.servers) {
  log.info('现在创建 %s 的测试实例', server)
  testArr.push(newTest(server, config.key))
}

process.on('uncaughtException', e => {
  notify('', 'uncaughtException: \n' + JSON.stringify(e, null, 2), config.key)
  log.error('uncaughtException:', e)
})

process.on('unhandledRejection', e => {
  notify('', 'unhandledRejection: \n' + JSON.stringify(e, null, 2), config.key)
  log.error('unhandledRejection:', e)
})


