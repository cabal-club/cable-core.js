const EventEmitter = require('events').EventEmitter
const b4a = require("b4a")
const viewName = "user-info"
const debug = require("debug")(`core/${viewName}`)
const constants = require("../cable/constants.js")

function noop () {}

// takes a (sub)level instance
module.exports = function (lvl, reverseIndex) {
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
        /*
        !user!<mono-ts>!<pubkey>!info!name => latest post/info setting nickname property
        !user!<mono-ts>!<pubkey>!info!<property> in general

        The corresponding user information schema looked like the following for cabal-core:

        user!<mono-ts>!about!<pubkey>
        */
        // TODO: decide format of input; should we operate on a json object or not?
        if (!sanitize(msg)) return

        // TODO (2023-02-28): should we only store the latest value instead? 
        const key = `${msg.timestamp}!${msg.publicKey.toString("hex")}!info!${msg.key}`
        const hash = msg.hash

        // make sure we find unhandled cases, because they are likely to be either bugs or new functionality that needs
        // to be handled in other parts of the codebase
        switch (msg.key) {
          case "name": 
            // pass
            break
          default:
            throw new Error(`${viewName}: unhandled key type (${msg.key})`)
            break
        }

        pending++
        lvl.get(key, function (err) {
          if (err && err.notFound) {
            if (!seen[hash]) events.emit('add', hash)
            ops.push({
              type: 'put',
              key,
              value: hash
            })
          }
          // keeps track of the latest key:value pair made by any user, let's us easily get the latest value
          //
          // note: need to track & remove these keys via the reverse hash map in case of delete
          ops.push({
            type: 'put',
            key: `latest!${msg.publicKey.toString("hex")}!info!${msg.key}`,
            value: hash
          })
          if (!--pending) done()
        })
      })
      if (!pending) done()

      function done () {
        const getHash = (m) => m.value
        const getKey = (m) => m.key
        reverseIndex.map(reverseIndex.transformOps(viewName, getHash, getKey, ops))
        debug("ops %O", ops)
        debug("done. ops.length %d", ops.length)
        lvl.batch(ops, next)
        unprocessedBatches--
        ready()
      }
    },

    api: {
      getLatestNameHash: function (publicKey, cb) {
        // return latest post/info hash for pubkey
        ready(function () {
          debug("api.getLatestNameHash")
          lvl.get(`latest!${publicKey.toString("hex")}!info!name`, (err, hash) => {
            if (err) { return cb(err, null) }
            return cb(null, hash)
          })
        })
      },
      getLatestNameHashMany: function (pubkeys, cb) {
        // return latest post/info hash for pubkey
        ready(function () {
          debug("api.getLatestNameHashMany")
          const keys = pubkeys.map(publicKey => {
            return `latest!${publicKey.toString("hex")}!info!name`
          })
          debug(keys)
          lvl.getMany(keys, (err, hashes) => {
            debug("many name keys (err %O) %O", err, hashes) 
            if (err) { return cb(err, null) }
            return cb(null, hashes)
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

