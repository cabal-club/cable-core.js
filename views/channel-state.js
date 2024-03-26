// SPDX-FileCopyrightText: 2023 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const b4a = require("b4a")
const viewName = "channel-state"
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
        let key

        debug("map incoming: %O", msg)


        const ts = monotonicTimestamp(msg.timestamp)
        switch (msg.postType) {
          case constants.JOIN_POST:
          case constants.LEAVE_POST:
            key = `member!${msg.channel}!${ts}!${util.hex(msg.publicKey)}`
            break
          case constants.INFO_POST:
            key = `name!${msg.channel}!${ts}!${util.hex(msg.publicKey)}`
            break
          case constants.TOPIC_POST:
            key = `topic!${msg.channel}!${ts}`
            break
          default:
            throw new Error(`${viewName}: unhandled post type (${msg.postType})`)
            break
        }

        const hash = msg.hash
        // column `seen!<hash> => <hash>` makes sure using a mono-ts does not create multiple keys when lazily indexing
        // potentially (but not necessarily) new messages
        const seenKey = `seen!${util.hex(hash)}`

        pending++
        lvl.get(seenKey, (err) => {
          if (err && err.notFound) {
            // remember this hash as having been processed
            ops.push({
              type: 'put',
              key: seenKey,
              value: hash
            })
            // also persist the actual key we care about
            ops.push({
              type: 'put',
              key,
              value: hash
            })
          } else {
            debug("already seen hash %O for key %s", hash, key)
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
      getLatestState (channel, cb) {
        // return the latest topic set on channel + latest name and membership change for each known pubkey in channel
        ready.call(async function () {
          debug("api.getLatestState")
          const opts = { reverse: true /*, limit: 1 */}
          const ts = `${util.timestamp()}`
          // TODO (2024-03-25): due to the index construction, this call gets *all historic* member hashes. would need
          // to do two passes to get the latest per public key: 
          //
          // the plan for tomorrow, 2024-03-25:
          //
          // * change the key scheme for member! to be the following
          // * check tests
          // * change this function accordingly
          // * change any other member querying functions accordingly
          // * sketch up user joining scenario for cable-cli testing
          // * check impact in cable-cli using scenario

          /* alternate key scheme for member

             member!<channel>!<publicKey>!<ts>

             alternative 1:
             1) get keys for `member!{channel}!~`, splice out publicKey for each key and put into a set
             2) iterate over public key set, order by reverse and set limit:1 and get values for `member!{channel}!{publicKey}!~`
         */
          const member = lvl.values({
            ...opts,
            lt: `member!${channel}!${ts}`,
            gt: `member!${channel}!!`
          })
          debug({
            lt: `member!${channel}!${ts}`,
            gt: `member!${channel}!!`
          })

          const members = new Map()
          // only iterate over keys within <name> namespace
          const name = lvl.values({
            ...opts,
            lt: `name!${channel}!${ts}`,
            gt: `name!${channel}!!`
          })
          const topic = lvl.values({
            ...opts,
            limit: 1, // get the latest topic post
            lt: `topic!${channel}!${ts}`,
            gt: `topic!${channel}!!`
          })
          const hashes = [
            await name.all(), 
            await topic.all(), 
            await member.all()
          ].flatMap(entry => entry)
          debug("hashes [%s]", channel, hashes)
          cb(null, hashes)
        })
      },
      // TODO (2023-04-20): remove this file's getLatestInfoHash function when user-info.js has a latestNameHash operating without latest key
      getLatestInfoHash (channel, publicKey, cb) {
        // return latest post/info hash for pubkey
        ready.call(async function () {
          debug("api.getLatestInfoHash")
          const iter = lvl.values({
            lt: `name!${channel}!${util.timestamp()}!${util.hex(publicKey)}`,
            gt: "name!!",
            reverse: true,
            limit: 1
          })
          const hashes = await iter.all()
          if (!hashes || hashes.length === 0) {
             return cb(new Error("channel state's latest name returned no hashes"), null)
          }
          cb(null, hashes[0])
        })
      },
      getLatestMembershipHash (channel, publicKey, cb) {
        // return latest post/join or post/leave hash authored by publicKey in channel
        ready.call(async function () {
          debug("api.getLatestMembership")
          debug("%O", {
            lt: `member!${channel}!${util.timestamp()}!${util.hex(publicKey)}`,
            reverse: true,
            limit: 1
          })
          const iter = lvl.values({
            lt: `member!${channel}!${util.timestamp()}!${util.hex(publicKey)}`,
            // gt:
            reverse: true,
            limit: 1
          })
          const hashes = await iter.all()
          if (!hashes || hashes.length === 0) {
             return cb(new Error("channel state's latest membership returned no hashes"), null)
          }
          debug("hashes", hashes)
          cb(null, hashes[0])
        })
      },
      getLatestTopicHash (channel, cb) {
        // return latest post/topic hash
        ready.call(async function () {
          debug("api.getLatestTopicHash")
          debug("%O", {
            lt: `topic!${channel}!${util.timestamp()}`,
            reverse: true,
            limit: 1
          })
          const iter = lvl.values({
            lt: `topic!${channel}!${util.timestamp()}`,
            gt: "name!",
            reverse: true,
            limit: 1
          })
          const hashes = await iter.all()
          if (!hashes || hashes.length === 0) {
             return cb(new Error("channel state's latest topic returned no hashes"), null)
          }
          cb(null, hashes[0])
        })
      },
      del (key, cb) {
        debug("api.del on key %O", key)
        if (typeof cb === "undefined") { cb = noop }
        if (key === "undefined" || typeof key === "undefined") {  
          debug("api.del received a key that was undefined, returning early")
          return cb(new Error("undefined key"))
        }
        ready.call(() => {
          lvl.del(key, (err) => {
            if (err) { return cb(err) }
            return cb(null)
          })
        })
      }
    }
  }
}
