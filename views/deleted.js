// SPDX-FileCopyrightText: 2023 the cabal-club authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const EventEmitter = require('events').EventEmitter
const b4a = require("b4a")
const viewName = "deleted"
const debug = require("debug")(`core:${viewName}`)
const constants = require("cable.js/constants.js")
const util = require("../util.js")

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
    map: function (msgs, next) {
      debug("view.map")
      let seen = {}
      let ops = []
      let pending = 0
      unprocessedBatches++
      msgs.forEach(function (hash) {
        if (!sanitize(hash)) return

        /* key scheme
          <deleted hash> -> 1
        */
        let key = hash
        const value = 1

        pending++
        lvl.get(key, function (err) {
          if (err && err.notFound) {
            if (!seen[value]) events.emit('add', util.hex(hash))
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
        debug("ops %O", ops)
        debug("done. ops.length %d", ops.length)
        lvl.batch(ops, next)
        unprocessedBatches--
        ready()
      }
    },

    api: {
      isDeleted: function (hash, cb) {
        // checks if a hash has been deleted. if true then the hash has been deleted and must not be persisted or
        // resynced
        ready(function () {
          lvl.get(hash, (err, value) => {
            if (err && err.notFound) { return cb(null, false) }
            if (err) { return cb(err) }
            if (value === 1) { return cb(null, true) }
            return cb(null, false)
          })
        })
      },
      isDeletedMany: function (hashes, cb) {
        // returns an object mapping the queried hashes to a boolean. if corresponding boolean is true then the hash has
        // been deleted and must not be persisted or resynced
        ready(function () {
          lvl.getMany(hashes, (err, values) => {
            if (err) { return cb(err) }
            const result = {}
            // the passed in hashes and the corresponding values have the same index in their respective arrays
            for (let i = 0; i < hashes.length; i++) {
              if (typeof values[i] === "undefined") {
                result[hashes[i]] = false
              } else {
                result[hashes[i]] = true
              }
            }
            cb(null, result)
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
    }
  }
}

// Returns a well-formed message or null
function sanitize (msg) {
  // if (typeof msg !== 'object') return null
  return msg
}

