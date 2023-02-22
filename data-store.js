const EventEmitter = require('events').EventEmitter
const b4a = require("b4a")
const debug = require("debug")("core/data-store")

function noop () {}

// takes a (sub)level instance
module.exports = function (lvl) {
  const events = new EventEmitter()

  // callback processing queue. functions are pushed onto the queue if they are dispatched before the store is ready or
  // there are pending transactions in the pipeline
  let queue = []
  // when unprocessedBatches is at 0 our index has finished processing pending transactions => ok to process queue
  let unprocessedBatches = 0

  // we are ready when:
  // * our underlying level store has opened => lvl.on("ready") -- this is implicit: see done()
  // * we have no pending transactions from initial indexing 
  const ready = (cb) => {
    debug("ready called")
    debug("unprocessedBatches %d", unprocessedBatches)
    if (!cb) cb = noop
    // we can process the queue
    if (unprocessedBatches <= 0) {
      for (let fn of queue) { fn() }
      queue = []
      return cb()
    }
    queue.push(cb)
  }

  return {
    maxBatch: 100,

    map: function (msgs, next) {
      debug("view.map")
      let seen = {}
      let ops = []
      let pending = 0
      unprocessedBatches++
      msgs.forEach(function (msg) {
        // TODO: decide format of input; should we operate on a json object or not?
        if (!sanitize(msg)) return
        // [{buffer: <buffer>, hash: "0x123123"}]
        const key = `${msg.hash}`
        const hash = msg.hash
        const buf = msg.buffer

        pending++
        lvl.get(key, function (err) {
          if (err && err.notFound) {
            if (!seen[hash]) events.emit('add', hash)
            ops.push({
              type: 'put',
              key,
              value: buf
            })
          }
          if (!--pending) done()
        })
      })
      if (!pending) done()

      function done () {
        debug("done. ops.length %d", ops.length)
        lvl.batch(ops, next)
        unprocessedBatches--
        ready()
      }
    },

    api: {
      get: function (hash, cb) {
        debug("api.get")
        /* what we can do if we want to introduce opts:
        
        if (typeof opts === "function") {
          cb = opts
          opts = {}
        }
        if (!opts) { opts = {} }

        */
        ready(function () {
          lvl.get(hash, function (err, buf) {
            if (err) { return cb(err, null) }
            return cb(null, buf)
          })
        })
      },
      getMany: function (hashes, cb) {
        debug("api.getMany")
        const ops = []

        ready(function () {
          lvl.getMany(hashes, function (err, buflist) {
            console.log(err, buflist)
            if (err) { return cb(err, null) }
            return cb(null, buflist)
          })
        })
      },
      put: function (hash, buf, cb) {
        debug("api.put")
        if (typeof cb === "undefined") { cb = noop }
        ready(function () {
            lvl.put(hash, buf, function (err) {
              if (err) { return cb(err) }
              return cb(null)
            })
          })
      },
      del: function (hash, cb) {
        debug("api.del")
        if (typeof cb === "undefined") { cb = noop }
        ready(function () {
            lvl.del(hash, function (err) {
              if (err) { return cb(err) }
              return cb(null)
            })
          })
      },
      events: events
    },

    storeState: function (state, cb) {
      state = state.toString('base64')
      lvl.put('state', state, cb)
    },

    fetchState: function (cb) {
      lvl.get('state', function (err, state) {
        if (err && err.notFound) cb()
        else if (err) cb(err)
        else cb(null, b4a.from(state, 'base64'))
      })
    },
  }
}

// Returns a well-formed message or null
function sanitize (msg) {
  if (typeof msg !== 'object') return null
  return msg
}
