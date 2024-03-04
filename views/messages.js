// SPDX-FileCopyrightText: 2023 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const b4a = require("b4a")
const viewName = "messages"
const debug = require("debug")(`core:${viewName}`)
const constants = require("cable.js/constants.js")
const util = require("../util.js")
const monotonicTimestamp = util.monotonicTimestamp()

function noop () {}

// takes a (sub)level instance
module.exports = function (lvl, reverseIndex) {
  const ready = new util.Ready(viewName)

  return {
    map (msgs, next) {
      debug("view.map")
      let ops = []
      let pending = 0
      ready.increment()
      msgs.forEach((msg) => {
        /* key scheme
          <mono-ts>!text!<channel> -> <hash>
          <mono-ts>!delete!<channel> -> <hash>
        */
        let key 
        // makes sure the timestamp we persist is one we have never seen before
        // TODO (2023-03-16): take a moment to consider impact on view queries wrt <123123.001> as a timestamp in the database
        const ts = monotonicTimestamp(msg.timestamp)
        switch (msg.postType) {
          case constants.TEXT_POST:
            key = `${msg.channel}!${ts}!text`
            break
          case constants.DELETE_POST:
            key = `${msg.channel}!${ts}!delete`
            break
          default:
            throw new Error(`${viewName}: unhandled post type (${msg.postType})`)
            break
        }

        const value = msg.hash

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
        const getHash = (m) => m.value
        const getKey = (m) => m.key
        reverseIndex.map(reverseIndex.transformOps(viewName, getHash, getKey, ops))
        debug("ops %O", ops)
        debug("done. ops.length %d", ops.length)
        lvl.batch(ops, next)
        ready.decrement()
        ready.call()
      }
    },

    api: {
      getChannelTimeRange (channel, timestart, timeend, limit, cb) {
        // level's "unlimited" value is -1, not 0
        if (limit === 0) { limit = -1 }
        // get the hashes recorded in the specified time range
        ready.call(async function () {
          debug("api.getChannelTimeRange")
          if (timeend === 0) {
            timeend = util.timestamp()
          }
          debug("ctr opts %O", {
            gt: `${channel}!${timestart}`,
            lt: `${channel}!${timeend}`
          })
          const iter = lvl.values({
            reverse: true,
            limit,
            gt: `${channel}!${timestart}`,
            lt: `${channel}!${timeend}`
          })
          const hashes = await iter.all()
          debug("ctr hashes %O", hashes)
          cb(null, hashes) // only return one hash
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
