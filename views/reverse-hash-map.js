// SPDX-FileCopyrightText: 2023 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const b4a = require("b4a")
const viewName = "reverse-hash-map"
const debug = require("debug")(`core:${viewName}`)
const util = require("../util.js")
const monotonicTimestamp = util.monotonicTimestamp()

function noop () {}

// takes a (sub)level instance
module.exports = function (lvl) {
  const ready = new util.Ready(viewName)

  return {
    transformOps(name, getHash, getKey, msgs) {
      return msgs.map(m => {
        const key = getKey(m)
        const keyIsBuffer = b4a.isBuffer(key)
        return {
          view: name, 
          viewkey: keyIsBuffer ? util.hex(key) : key,
          hash: util.hex(getHash(m))
        }
      })
    },
    map (msgs, next) {
      debug("view.map")

      let ops = []
      let pending = 0
      ready.increment()
      debug(msgs)
      msgs.forEach((msg) => {
        // key scheme
        // <hash>!<mono-ts> => "<viewname><separator><viewkey>"
        // TODO (2023-03-01): check other views for order of `!||~` wrt ranging over timestamp! if at the end less
        // issues than at the beginning
        const key = `${msg.hash}!${monotonicTimestamp()}`
        const value = `${msg.view}!${msg.viewkey}`

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
        debug("ops %O",  ops)
        debug("done. ops.length %d", ops.length)
        lvl.batch(ops, next)
        ready.decrement()
        ready.call()
      }
    },

    api: {
      // returns a Map() which maps view names to a list of keys in that view, where each key has been recorded to reference the queried
      // hash
      getUses (hash, cb) {
        debug("api.getUses for %O", util.hex(hash))
        ready.call(async function () {
          const iter = lvl.values({
            gt: `${util.hex(hash)}!!`,
            lt: `${util.hex(hash)}!~`
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
      del (hash, cb) {
        debug("api.del")
        if (typeof cb === "undefined") { cb = noop }
        ready.call(async function () {
          const iter = lvl.keys({
            gt: `${util.hex(hash)}!!`,
            lt: `${util.hex(hash)}!~`
          })
          // get all the keys we've stored in reverse map
          const keys = await iter.all()
          const ops = keys.map(key => {
            return { type: "del", key }
          })
          // remove keys from index
          lvl.batch(ops, (err) => {
            if (err) { return cb(err) }
            return cb(null)
          })
        })
      }
    }
  }
}
