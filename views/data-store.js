// SPDX-FileCopyrightText: 2023 the cabal-club authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const EventEmitter = require('events').EventEmitter
const b4a = require("b4a")
const { hex } = require("../util.js")
const viewName = "data-store"
const debug = require("debug")(`core:${viewName}`)

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

    // TODO (2023-02-23): rethink usage of `view.map` given that kappa-views are not a necessary part of the dependencies atm
    map: function (msgs, next) {
      debug("view.map")

      let seen = {}
      let ops = []
      let pending = 0
      unprocessedBatches++
      msgs.forEach(function (msg) {
        if (!sanitize(msg)) return
        // use hex-encoded strings as keys to help deduplicate posts 
        const key = hex(msg.hash)
        const value = msg.buf

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
        const getHash = (m) => m.key
        const getKey = (m) => hex(m.key)
        reverseIndex.map(reverseIndex.transformOps(viewName, getHash, getKey, ops))
        debug("ops %O",  ops)
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
          lvl.get(hex(hash), function (err, buf) {
            if (err) { return cb(err, null) }
            if (typeof buf === "undefined") {
              return cb(null, null)
            }
            return cb(null, buf)
          })
        })
      },
      // tries to get a list of hashes. if a a hash, with index `i`, is not found, then the corresponding index `i` in the
      // returned results will be set to null
      getMany: function (hashes, cb) {
        const hexHashes = hashes.map(hex)
        debug("api.getMany %O", hexHashes)
        const ops = []

        ready(function () {
          lvl.getMany(hexHashes, function (err, buflist) {
            if (err) { return cb(err, null) }
            return cb(null, buflist.map(b => {
              if (typeof b === "undefined") {
                return null
              }
              return b
            }))
          })
        })
      },
      del: function (hash, cb) {
        debug("api.del")
        if (typeof cb === "undefined") { cb = noop }
        ready(function () {
          lvl.del(hex(hash), function (err) {
            if (err) { return cb(err) }
            return cb(null)
          })
        })
      },
      events: events
    },

    storeState: function (state, cb) {
      state = b4a.toString(state, 'base64')
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
