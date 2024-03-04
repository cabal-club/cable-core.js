// SPDX-FileCopyrightText: 2023 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const b4a = require("b4a")
const { hex } = require("../util.js")
const viewName = "data-store"
const debug = require("debug")(`core:${viewName}`)

function noop () {}

// takes a (sub)level instance
module.exports = function (lvl, reverseIndex) {
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
    // TODO (2023-02-23): rethink usage of `view.map` given that kappa-views are not a necessary part of the dependencies atm
    map (msgs, next) {
      debug("view.map")

      let ops = []
      let pending = 0
      unprocessedBatches++
      msgs.forEach((msg) => {
        if (!sanitize(msg)) return
        // use hex-encoded strings as keys to help deduplicate posts 
        const key = hex(msg.hash)
        const value = msg.buf

        pending++
        lvl.get(key, (err) => {
          if (err && err.notFound) {
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
      get (hash, cb) {
        debug("api.get")
        /* what we can do if we want to introduce opts:

        if (typeof opts === "function") {
          cb = opts
          opts = {}
        }
        if (!opts) { opts = {} }
*/
        ready(() => {
          lvl.get(hex(hash), (err, buf) => {
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
      getMany (hashes, cb) {
        const hexHashes = hashes.map(hex)
        debug("api.getMany %O", hexHashes)
        const ops = []

        ready(() => {
          lvl.getMany(hexHashes, (err, buflist) => {
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
      del (hash, cb) {
        debug("api.del")
        if (typeof cb === "undefined") { cb = noop }
        ready(() => {
          lvl.del(hex(hash), (err) => {
            if (err) { return cb(err) }
            return cb(null)
          })
        })
      }
    }
  }
}

// Returns a well-formed message or null
function sanitize (msg) {
  if (typeof msg !== 'object') return null
  return msg
}
