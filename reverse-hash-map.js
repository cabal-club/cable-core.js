const EventEmitter = require('events').EventEmitter
const b4a = require("b4a")
const viewName = "reverse-hash-map"
const debug = require("debug")(`core/${viewName}`)
const timestamp = require("monotonic-timestamp")

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

    transformOps(name, getHash, getKey, msgs) {
      return msgs.map(m => {
        const key = getKey(m)
        const keyIsBuffer = b4a.isBuffer(key)
        return {
          view: name, 
          viewkey: keyIsBuffer ? key.toString("hex") : key,
          hash: getHash(m).toString("hex")
        }
      })
    },
    // TODO (2023-02-23): rethink usage of `view.map` given that kappa-views are not a necessary part of the dependencies atm
    map: function (msgs, next) {
      debug("view.map")

      let seen = {}
      let ops = []
      let pending = 0
      unprocessedBatches++
      debug(msgs)
      msgs.forEach(function (msg) {
        // TODO: decide format of input; should we operate on a json object or not? 
        if (!sanitize(msg)) return
        // key scheme
        // <hash>!<mono-ts> => "<viewname><separator><viewkey>"
        // TODO (2023-03-01): check other views for order of `!||~` wrt ranging over timestamp! if at the end less
        // issues than at the beginning
        const key = `${msg.hash}!${timestamp()}`
        const value = `${msg.view}!${msg.viewkey}`

        pending++
        lvl.get(key, function (err) {
          if (err && err.notFound) {
            if (!seen[key]) events.emit('add', key)
            ops.push({
              type: 'put',
              key,
              value
            })
          }
          if (!--pending) done()
        })
      })
      if (!pending) done()

      function done () {
        debug("ops %O",  ops)
        debug("done. ops.length %d", ops.length)
        lvl.batch(ops, next)
        unprocessedBatches--
        ready()
      }
    },

    api: {
      // returns a Map() which maps view names to a list of keys in that view, where each key has been recorded to reference the queried
      // hash
      getUses: function (hash, cb) {
        debug("api.getUses for %O", hash.toString("hex"))
        ready(async function () {
          const iter = lvl.values({
            gt: `${hash.toString("hex")}!!`,
            lt: `${hash.toString("hex")}!~`
          })
          const values = await iter.all()
          const usesMap = new Map()
          values.forEach(v => {
            const sepIndex = v.indexOf("!")
            const viewName = v.slice(0, sepIndex)
            const viewKey = v.slice(sepIndex+1)
            // maintain a list of uses for the particular view, as one view may have multiple keys that reference a
            // given hash
            if (!usesMap.has(viewName)) { usesMap.set(viewName, []) }
            usesMap.get(viewName).push(viewKey)
          })
          cb(null, usesMap)
        })
      },
      // remove all traces of this hash being indexed in the reverse map
      del: function (hash, cb) {
        debug("api.del")
        // TODO (2023-03-01)
        if (typeof cb === "undefined") { cb = noop }
        ready(async function () {
          const iter = lvl.keys({
            gt: `${hash.toString("hex")}!!`,
            lt: `${hash.toString("hex")}!~`
          })
          // get all the keys we've stored in reverse map
          const keys = await iter.all()
          const ops = keys.map(key => {
            return { type: "del", key }
          })
          // remove keys from index
          lvl.batch(ops, function (err) {
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
