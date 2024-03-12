// SPDX-FileCopyrightText: 2023 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const b4a = require("b4a")
const { hex, Ready } = require("../util.js")
const viewName = "data-store"
const debug = require("debug")(`core:${viewName}`)

function noop () {}

// takes a (sub)level instance
module.exports = function (lvl, reverseIndex) {
  const ready = new Ready(viewName)

  return {
    // TODO (2023-02-23): rethink usage of `view.map` given that kappa-views are not a necessary part of the dependencies atm
    map (msgs, next) {
      debug("view.map")

      let ops = []
      let pending = 0
      ready.increment()
      msgs.forEach((msg) => {
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
        ready.decrement()
        ready.call()
      }
    },

    api: {
      get (hash, cb) {
        debug("api.get")
        ready.call(() => {
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

        ready.call(() => {
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
        ready.call(() => {
          lvl.del(hex(hash), (err) => {
            if (err) { return cb(err) }
            return cb(null)
          })
        })
      }
    }
  }
}
