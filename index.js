const http = require('http')
const stackman = require('stackman')()

function sendData(data, port) {
  const options = {
    hostname: `localhost`,
    port: port,
    path: '/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  }

  return new Promise((resolve, reject) => {
    const req = http.request(options, resolve)
    if (dump.timeout !== null) {
      req.setTimeout(dump.timeout)
    }

    req.on('error', e => {
      reject(e)
    })

    req.write(data)
    req.end()
  })
}

function sendClear(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}/clear`, resolve)
    if (dump.timeout !== null) {
      req.setTimeout(dump.timeout)
    }

    req.on('error', e => {
      reject(e)
    })
  })
}

// Serialize requests even if they are not awaited.
const queue = []

function consume() {
  if (queue.length === 0) {
    return
  }

  const item = queue[0]
  let promise
  if (item.clear) {
    promise = sendClear(item.port)
  } else {
    promise = sendData(item.data, item.port)
  }

  return promise
    .then(() => {
      item.resolve()
      queue.shift()
      consume()
    })
    .catch(e => {
      item.reject()
      queue.shift()
      consume()
    })
}

function getConstructorName(obj) {
  const ctor = obj && obj.constructor && obj.constructor.name
  if (ctor) {
    return ctor
  }

  const str = (obj.prototype ? obj.prototype.constructor : obj.constructor).toString()
  const match = str.match(/function\s(\w*)/)
  if (!match) {
    return 'Function'
  }

  const cname = match[1]
  const aliases = ['', 'anonymous', 'Anonymous']
  return aliases.indexOf(cname) > -1 ? 'Function' : cname
}

function simplify(value) {
  if (typeof value === 'undefined' || value === null) {
    return null
  }

  const ctor = value.constructor
  if (ctor === Number
    || ctor === String
    || ctor === Boolean
    || ctor === Symbol) {
    return value.valueOf()
  } else {
    return value
  }
}

function convertToObject(value) {
  value = simplify(value)
  if (Array.isArray(value) || value instanceof Set) {
    return { value: getJSON(value) }
  } else if (value && typeof value === 'object') {
    return getJSON(value)
  } else {
    return { value }
  }
}

function getJSON(obj) {
  if (obj && obj.$getJSON) {
    const result = obj.$getJSON()
    if (typeof result !== 'undefined') {
      return result
    }
  }

  obj = simplify(obj)

  if (typeof obj === 'number'
    || typeof obj === 'string'
    || typeof obj === 'boolean') {
    return obj
  }

  if (obj instanceof Date) {
    return {
      $type: 'Date, node.js',
      utc: obj.toUTCString()
    }
  }

  if (obj instanceof RegExp) {
    return {
      $type: 'RegExp, node.js',
      pattern: obj.toString()
    }
  }

  if (typeof obj === 'symbol') {
    const str = obj.toString()
    const key = str.substring(7, str.length - 1)
    if (key.length) {
      return {
        $type: 'Symbol, node.js',
        key
      }
    } else {
      return {
        $type: 'Symbol, node.js'
      }
    }
  }

  const isSet = obj instanceof Set
  if (Array.isArray(obj) || isSet) {
    let values
    if (isSet) {
      values = Array.from(obj)
    } else {
      values = obj
    }

    if (values.some(item => item && typeof item === 'object')) {
      let exemplar = {}
      values.forEach(item => {
        Object.keys(convertToObject(item)).forEach(key => {
          exemplar[key] = null
        })
      })

      const [first, ...rest] = values
      exemplar = {
        ...exemplar,
        ...convertToObject(first),
        $type: 'Object, node.js'
      }

      values = [exemplar, ...rest.map(convertToObject)]
    }

    return {
      $type: isSet ? 'Set, node.js' : 'Array, node.js',
      $values: values
    }
  }

  if (obj && typeof obj === 'object') {
    return Object.keys(obj).reduce((acc, key) => {
      acc[key] = getJSON(obj[key])
      return acc
    }, { $type: getConstructorName(obj) + ', node.js' })
  }

  // Everything else is itself.
  return obj
}

function enqueue(value, title, source) {
  return new Promise((resolve, reject) => {
    queue.push({
      resolve,
      reject,
      port: dump.port,
      data: JSON.stringify({
        $type: 'DumpContainer, node.js',
        $value: value,
        title,
        source
      }) // store a snapshot of current state
    })

    if (queue.length === 1) {
      consume()
    }
  })
}

function trimLine(line, accessor) {
  if (typeof line !== 'string') {
    return ''
  }

  line = line.trim()
  let index = line.indexOf('await ')
  if (index === 0) {
    line = line.substr(6).trim()
  }

  if (accessor) {
    index = line.indexOf('.' + accessor)
    if (index !== -1) {
      line = line.substr(0, index)
    }

    line = line.trim()
  }

  return line
}

function lineOf(trace, accessor) {
  return new Promise((resolve, reject) => {
    if (!trace && !trace.stack) {
      return reject()
    }

    stackman.callsites(trace, { sourcemap: dump.sourcemaps }, (error, callsites) => {
      if (error) {
        return reject(error)
      }

      const site = callsites[1]
      if (!site) {
        return reject()
      }

      site.sourceContext(1, (error, result) => {
        if (error) {
          return reject(error)
        }

        resolve(trimLine(result.line, accessor))
      })
    })
  })
}

function dumpInternal(data, title, accessor, trace) {
  if (dump.console) {
    if (dump.console.data) {
      dump.console.data(data, title)
    } else {
      if (title) {
        console.log(title)
      }

      console.log(data)
    }

    return Promise.resolve()
  }

  const value = getJSON(data)
  if (!dump.source || !trace) {
    return enqueue(value, title)
  }

  return lineOf(trace, accessor)
    .then(source => {
      if (typeof dump.source === 'function') {
        source = dump.source(source, accessor)
      }

      return enqueue(value, title, source)
    })
    .catch(() => {
      return enqueue(value, title)
    })
}

function dump(data, title) {
  return dumpInternal(data, title, null, new Error())
}

dump.clear = function clear() {
  if (dump.console) {
    if (dump.console.clear) {
      dump.console.clear()
    }

    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    if (queue.length > 1) {
      const items = queue.splice(1, queue.length - 1)
      items.forEach(item => item.resolve())
    }

    queue.push({
      resolve,
      reject,
      port: dump.port,
      clear: true
    })

    if (queue.length === 1) {
      consume()
    }
  })
}

dump.html = function html(htmlString, title) {
  if (typeof htmlString !== 'string') {
    throw new Error('Invalid HTML string.')
  }

  if (dump.console) {
    if (dump.console.html) {
      dump.console.html(htmlString, title)
    } else {
      console.log(htmlString)
    }

    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    queue.push({
      resolve,
      reject,
      port: dump.port,
      data: JSON.stringify({
        $type: 'DumpContainer, node.js',
        $value: {
          $type: 'html',
          $html: htmlString
        },
        title
      })
    })

    if (queue.length === 1) {
      consume()
    }
  })
}

function hook(proto, name, getter) {
  const descriptor = getter
    ? {
      get: function dump() {
        const simple = simplify(this)
        dumpInternal(simple, null, name, new Error())
        return simple
      },
      enumerable: false,
      configurable: true
    } : {
      value: function dump(title) {
        const simple = simplify(this)
        dumpInternal(simple, title, name, new Error())
        return simple
      },
      enumerable: false,
      configurable: true,
      writable: true
    }

  Object.defineProperty(proto, name, descriptor)
}

function hookAll(name, getter) {
  hook(Object.prototype, name, getter)
  hook(Number.prototype, name, getter)
  hook(String.prototype, name, getter)
  hook(Boolean.prototype, name, getter)
  hook(Symbol.prototype, name, getter)
}

dump.port = 5255
dump.source = true
dump.console = false
dump.timeout = null
dump.sourcemaps = false
dump.hook = function (name, getter = false) {
  if (typeof name !== 'string') {
    return
  }

  hookAll(name, getter)
}

dump.hook('dump')
module.exports = dump
