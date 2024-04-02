// SPDX-FileCopyrightText: 2023 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const b4a = require("b4a")
const viewName = "blocked"
const debug = require("debug")(`core:${viewName}`)
const constants = require("cable.js/constants.js")
const util = require("../util.js")
// view keys, differentiate the two tables in this view
const BLOCKS = "B"
const BLOCKED_BY = "Y"

function noop () {}

// takes a (sub)level instance
module.exports = function (lvl) {
  const ready = new util.Ready(viewName)

  return {
    map (msgs, next) {
      debug("view.map %d msgs", msgs)
      let ops = []
      let pending = 0
      ready.increment()
      msgs.forEach((post) => {
        /* key scheme
          ${BLOCKS}!<hex(blocker.publicKey)>!<hex(blocked.publicKey)> -> 1
          ${BLOCKED_BY}!<hex(blocked.publicKey)>!<hex(blocker.publicKey)> -> 1
        */
        const removeBlock = post.postType === constants.UNBLOCK_POST
        const value = 1
        const records = []
        // a single post/block or post/unblock can block many peers at once, so prepare many records
        const authorHex = util.hex(post.publicKey)
        post.recipients.forEach(recp => {
          const recpHex = util.hex(recp)
          records.push(`${BLOCKS}!${authorHex}!${recpHex}`)
          records.push(`${BLOCKED_BY}!${recpHex}!${authorHex}`)
        })

        records.forEach(key => {
          pending++
          lvl.get(key, (err) => {
            if (removeBlock && err === null) {
              ops.push({
                type: 'del',
                key
              })
            }
            if (!removeBlock && err && err.notFound) {
              ops.push({
                type: 'put',
                key,
                value
              })
            }
            if (!--pending) done()
          })
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
      // returns a list of public keys which the queried key blocks
      getBlocks (pubkey, cb) {
        // checks if a hash has been deleted. if true then the hash has been deleted and must not be persisted or
        // resynced
        const pubkeyHex = util.hex(pubkey)
        ready.call(async () => {
          debug("getBlocks(%s)", pubkeyHex)
          const keys = await lvl.keys({
            gt: `${BLOCKS}!${pubkeyHex}!`,
            lt: `${BLOCKS}!${pubkeyHex}!~`
          }).all()
          const all = await lvl.keys({
            gt: `${BLOCKS}!`,
            lt: `${BLOCKS}!~`
          }).all()
          debug("all blocks %O", all)
          const blockedKeys = keys.map(k => b4a.from(k.split("!")[2], "hex"))
          debug("blocked keys %O", blockedKeys)
          cb(null, blockedKeys)
        })
      },
      // returns a list of public keys which block the queried key
      getUsersBlockingKey (pubkey, cb) {
        const pubkeyHex = util.hex(pubkey)
        debug("getUsersBlockingKey (%s)", pubkeyHex)
        ready.call(async () => {
          const keys = await lvl.keys({
            gt: `${BLOCKED_BY}!${pubkeyHex}!`,
            lt: `${BLOCKED_BY}!${pubkeyHex}!~`
          }).all()
          debug("blocked by keys %O", keys)
          const blockers = keys.map(k => b4a.from(k.split("!")[2], "hex"))
          cb(null, blockers)
        })
      }
      // del (hash, cb) {
      //   debug("api.del")
      //   if (typeof cb === "undefined") { cb = noop }
      //   ready.call(() => {
      //     lvl.del(hash, (err) => {
      //       if (err) { return cb(err) }
      //       return cb(null)
      //     })
      //   })
      // }
    }
  }
}
