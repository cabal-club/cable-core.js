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

// a little bit about this view, which enables us to answer channel state requests.
//
// to answer a channel state request we want to return the LATEST...
//
// * channel topic
// * ONE OF post/{join, leave} for each historic member
// * ONE post/info for each historic member
// 
// we also want to support deletes such that if the latest post of any post/{topic,leave,join} is deleted, then we can
// trivially get the new-latest hash and return it in a hash response

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
            key = `member!${msg.channel}!${util.hex(msg.publicKey)}!${ts}`
            break
          case constants.INFO_POST:
            key = `info!${msg.channel}!${util.hex(msg.publicKey)}!${ts}`
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
      getLatestState (historicPublicKeys, channel, cb) {
        // return the latest channel topic +f or each known pubkey in channel, the latest info (i.e. user name) and membership change         
        ready.call(async function () {
          debug("api.getLatestState")
          const opts = { reverse: true , limit: 1 }
          const ts = `${util.timestamp()}`
          // for each unique public key which has a history associated with this channel, we will get their latest...
          //
          // 1. post/join OR post/leave hash (memberPromises)
          // 2. post/info hash (infoPromises)

          const hexPublicKeys = historicPublicKeys.map(util.hex)
          const constructPromisesArray = (viewName) => {
            return hexPublicKeys.map(async (publicKeyHex) => {
              debug({
                ...opts,
                lt: `${viewName}!${channel}!${publicKeyHex}!${ts}`,
                gt: `${viewName}!${channel}!${publicKeyHex}!!`
              })
              return await lvl.values({
                ...opts,
                lt: `${viewName}!${channel}!${publicKeyHex}!${ts}`,
                gt: `${viewName}!${channel}!${publicKeyHex}!!`
              }).all()
            })
          }
          
          // iterate within <member> namespace
          const memberPromises = constructPromisesArray("member") 
          // iterate within <info> namespace
          const infoPromises = constructPromisesArray("info") 

          const topic = lvl.values({
            ...opts,
            lt: `topic!${channel}!${ts}`,
            gt: `topic!${channel}!!`
          })
          const hashes = [
            (await Promise.all(memberPromises)).flat(),
            (await Promise.all(infoPromises)).flat(),
            await topic.all()
          ].flatMap(entry => entry) 
          debug("hashes [%s]", channel, hashes)
          cb(null, hashes)
        })
      },
      getLatestMembershipHash (channel, publicKey, cb) {
        // return latest post/join or post/leave hash authored by publicKey in channel
        ready.call(async function () {
          debug("api.getLatestMembership")
          const publicKeyHex = util.hex(publicKey)
          const opts = {
            lt: `member!${channel}!${publicKeyHex}!${util.timestamp()}`,
            gt: `member!${channel}!${publicKeyHex}!!`,
            reverse: true,
            limit: 1
          }

          debug("%O", opts)
          const hashes = await lvl.values(opts).all()
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
          const opts = {
            lt: `topic!${channel}!${util.timestamp()}`,
            gt: `topic!${channel}!!`,
            reverse: true,
            limit: 1
          }
          debug("%O", opts)
          const hashes = await lvl.values(opts).all()
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
