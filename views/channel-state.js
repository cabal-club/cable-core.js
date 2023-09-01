// SPDX-FileCopyrightText: 2023 the cabal-club authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const EventEmitter = require('events').EventEmitter
const b4a = require("b4a")
const viewName = "channel-state"
const debug = require("debug")(`core/${viewName}`)
const constants = require("cable.js/constants.js")
const util = require("../util.js")
const monotonicTimestamp = util.monotonicTimestamp()

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
    map: function (msgs, next) {
      debug("view.map")
      let ops = []
      let pending = 0
      unprocessedBatches++
      msgs.forEach(function (msg) {
        if (!sanitize(msg)) return

        let key

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
        lvl.get(seenKey, function (err) {
          if (err && err.notFound) {
            events.emit('add', hash)
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
        unprocessedBatches--
        ready()
      }
    },

    api: {
      getLatestState: function (channel, cb) {
        // return the latest topic set on channel + latest name and membership change for each known pubkey in channel
        ready(async function () {
          debug("api.getLatestState")
          const opts = { reverse: true, limit: 1}
          const ts = `${util.timestamp()}`
          const member = lvl.values({
            ...opts,
            lt: `member!${channel}!${ts}`,
            gt: `member!${channel}!!`
          })
          debug({
            lt: `member!${channel}!${ts}`,
            gt: `member!${channel}!!`
          })
          // only iterate over keys within <name> namespace
          const name = lvl.values({
            ...opts,
            lt: `name!${channel}!${ts}`,
            gt: `name!${channel}!!`
          })
          const topic = lvl.values({
            ...opts,
            lt: `topic!${channel}!${ts}`,
            gt: `topic!${channel}!!`
          })
          const hashes = [
            await name.all(), 
            await topic.all(), 
            await member.all()
          ].flatMap(entry => entry)
          debug("hashes", hashes)
          cb(null, hashes)
        })
      },
      // TODO (2023-04-20): remove this file's getLatestNameHash function when user-info.js has a latestNameHash operating without latest key
      getLatestNameHash: function (channel, publicKey, cb) {
        // return latest post/info hash for pubkey
        ready(async function () {
          debug("api.getLatestNameHash")
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
      getLatestMembershipHash: function (channel, publicKey, cb) {
        // return latest post/join or post/leave hash authored by publicKey in channel
        ready(async function () {
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
      getLatestTopicHash: function (channel, cb) {
        // return latest post/topic hash
        ready(async function () {
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
      del: function (key, cb) {
        debug("api.del on key %O", key)
        if (typeof cb === "undefined") { cb = noop }
        if (key === "undefined" || typeof key === "undefined") {  
          debug("api.del received a key that was undefined, returning early")
          return cb(new Error("undefined key"))
        }
        ready(function () {
          lvl.del(key, function (err) {
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
  if (typeof msg !== 'object') return null
  return msg
}

