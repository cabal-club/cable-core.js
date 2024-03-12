// SPDX-FileCopyrightText: 2023 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const b4a = require("b4a")
const viewName = "author"
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
        const ts = monotonicTimestamp(msg.timestamp)
        // <pubkey>!<post_type-id>!<mono-ts> -> <hash>
        const key = `${util.hex(msg.publicKey)}!${msg.postType}!${ts}`
        const hash = msg.hash

        // make sure we find unhandled cases, because they are likely to be either bugs or new functionality that needs
        // to be handled in other parts of the codebase
        switch (msg.postType) {
          case constants.TEXT_POST:
          case constants.DELETE_POST:
          case constants.INFO_POST:
          case constants.TOPIC_POST:
          case constants.JOIN_POST:
          case constants.LEAVE_POST:
          case constants.ROLE_POST:
          case constants.MODERATION_POST:
          case constants.BLOCK_POST:
          case constants.UNBLOCK_POST:
            // do nothing
            break
          default:
            throw new Error(`${viewName}: unhandled post type (${msg.postType})`)
            break
        }

        pending++
        lvl.get(key, (err) => {
          if (err && err.notFound) {
            ops.push({
              type: 'put',
              key,
              value: hash
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
      // returns a list of all known public keys
      getUniquePublicKeys (cb) {
        if (!cb) return
        ready.call(async function () {
          debug("api.getUniquePublicKeys")
          const iter = lvl.keys()
          const viewkeys = await iter.all()
          const keys = viewkeys.map(key => {
            const index = key.indexOf("!")
            return key.slice(0, index)
          })
          const set = new Set(keys)
          debug("unique set %O", set)
          cb(null, Array.from(set).map(hex => b4a.from(hex, "hex")))
        })
      },
      getAllHashesByAuthor (publicKey, cb) {
        // returns all hashes authored by publicKey. can be used to purge database of posts made by a public key
        ready.call(async function () {
          debug("api.getAllHashesByAuthor")
          const iter = lvl.values({
            reverse: true,
            gt: `${util.hex(publicKey)}!!`,
            lt: `${util.hex(publicKey)}!~`
          })
          const hashes = await iter.all()
          cb(null, hashes) 
        })
      },
      getAllHashesByAuthorAndType (publicKey, postType, cb) {
        // get all post hashes made by publicKey for the specified postType
        ready.call(async function () {
          debug("api.getAllHashesByAuthorAndType")
          const iter = lvl.values({
            reverse: true,
            gt: `${util.hex(publicKey)}!${postType}!!`,
            lt: `${util.hex(publicKey)}!${postType}!~`
          })
          const hashes = await iter.all()
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
