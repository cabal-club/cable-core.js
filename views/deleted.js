// SPDX-FileCopyrightText: 2023 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const b4a = require("b4a")
const viewName = "deleted"
const debug = require("debug")(`core:${viewName}`)
const constants = require("cable.js/constants.js")
const util = require("../util.js")

function noop () {}

// takes a (sub)level instance
module.exports = function (lvl) {
  const ready = new util.Ready(viewName)

  return {
    map (msgs, next) {
      debug("view.map")
      let seen = {}
      let ops = []
      let pending = 0
      ready.increment()
      msgs.forEach((hash) => {
        /* key scheme
          <deleted hash> -> 1
        */
        let key = hash
        const value = 1

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
        debug("ops %O", ops)
        debug("done. ops.length %d", ops.length)
        lvl.batch(ops, next)
        ready.decrement()
        ready.call()
      }
    },

    api: {
      isDeleted (hash, cb) {
        // checks if a hash has been deleted. if true then the hash has been deleted and must not be persisted or
        // resynced
        ready.call(() => {
          lvl.get(hash, (err, value) => {
            if (err && err.notFound) { return cb(null, false) }
            if (err) { return cb(err) }
            if (value === 1) { return cb(null, true) }
            return cb(null, false)
          })
        })
      },
      isDeletedMany (hashes, cb) {
        // returns an object mapping the queried hashes to a boolean. if corresponding boolean is true then the hash has
        // been deleted and must not be persisted or resynced
        ready.call(() => {
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
      del (hash, cb) {
        debug("api.del")
        if (typeof cb === "undefined") { cb = noop }
        ready.call(() => {
          lvl.del(hash, (err) => {
            if (err) { return cb(err) }
            return cb(null)
          })
        })
      }
    }
  }
}
