// SPDX-FileCopyrightText: 2023 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const b4a = require("b4a")
const viewName = "channel-membership"
const debug = require("debug")(`core:${viewName}`)
const constants = require("cable.js/constants.js")
const util = require("../util.js")

function noop () {}

const SENTINEL_USER = "x".repeat(64)

function getChannelFromKey (e) {
  return e.slice(0, e.indexOf("!"))
}
function getPublicKeyFromKey (e) {
  const key = e.slice(e.indexOf("!") + 1)
  if (key === SENTINEL_USER) { return "" }
  return key
}

// takes a (sub)level instance
module.exports = function (lvl) {
  const ready = new util.Ready(viewName)

  return {
    // TODO (2023-03-08): either change the key layout or, before calling map, get a map of <pubkey:channel> ->
    // timestamp of the latest post|leave message for channel and pass to this index, so that we can make sure we only
    // ever set latest membership correctly
    map (msgs, next) {
      debug("view.map")
      let ops = []
      ready.increment()
      const sorted = msgs.sort((a, b) => {
        return parseInt(a.timestamp) - parseInt(b.timestamp)
      })
      sorted.forEach((msg) => {
        // key schema
        // <channel>!<publicKey> -> 1 or 0
        // 1 = joined, 0 = left. no record for a key means no recorded interaction between channel & publicKey
        //
        // note: to record channels received as part of a channel list response, we also have a special case of entry we
        // index, where the key scheme will be: <channel>!<x.repeat(32)>: 0
        if (msg.publicKey === "sentinel") {
          ops.push({
            key: `${msg.channel}!${SENTINEL_USER}`,
            value: 0,
            type: "put"
          })
          return
        }
        const key = `${msg.channel}!${util.hex(msg.publicKey)}`
        let value
        let variableKey = ""
        switch (msg.postType) {
          // writing to a channel is interpreted as a signal to join that channel
          case constants.TEXT_POST:
          // setting a channel topic is interpreted as an implicit signal to have joined that channel
          case constants.TOPIC_POST:
          case constants.JOIN_POST:
            value = 1
            break
          case constants.LEAVE_POST:
            value = 0
            break
          default:
            throw new Error(`${viewName}: unhandled post type (${msg.postType})`)
            break
        }

        ops.push({
          type: 'put',
          key,
          value
        })
      })
      done()

      function done () {
        debug("ops %O", ops)
        debug("done. ops.length %d", ops.length)
        lvl.batch(ops, next)
        ready.decrement()
        ready.call()
      }
    },

    api: {
      getChannelNames (offset, limit, cb) {
        ready.call(async function () {
          const iter = lvl.keys()
          const keys = await iter.all()
          let channels = keys.map(getChannelFromKey)
          channels = Array.from(new Set(channels))
          channels.sort()
          if (limit === 0) { limit = channels.length }
          cb(null, channels.slice(offset, limit))
        })
      },
      clearMembership (channel, publicKey, cb) {
        if (!cb) { cb = noop }
        ready.call(() => {
          lvl.del(`${channel}!${util.hex(publicKey)}`, (err) => {
            if (err && err.notFound ) { return cb(null) }
            if (err ) { return cb(err) }
            cb(null)
          })
        })
      },
      isInChannel (channel, publicKey, cb) {
        ready.call(() => {
          lvl.get(`${channel}!${util.hex(publicKey)}`, (err, value) => {
            if (err && err.notFound ) { return cb(null, false) }
            if (err ) { return cb(err) }
            cb(null, parseInt(value) === 1)
          })
        })
      },
      getHistoricUsers (channel, cb) {
        // return set of channel names that pubkey is in according to our local knowledge
        // also includes channels that have been joined previously but are marked as left
        ready.call(async function () {
          debug("api.getHistoricUsers")
          const iter = lvl.iterator({
            reverse: true,
            gt: `${channel}!!`,
            lt: `${channel}!~`
          })
          const entries = await iter.all()
          const pubkeys = new Map()
          debug("entries", entries)
          const joined = entries.map(e => {
            const pubkey = getPublicKeyFromKey(e[0])
            // indicates usage of SENTINEL_USER: skip
            if (pubkey === "") { return }
            debug("pubkey %s", pubkey)
            pubkeys.set(pubkey, b4a.from(pubkey, "hex"))
          })
          cb(null, Array.from(pubkeys.values()))
        })
      },
      getHistoricMembership (publicKey, cb) {
        // return set of channel names that pubkey is in according to our local knowledge
        // also includes channels that have been joined previously but are marked as left
        // 
        // TODO (2023-03-07): write test to confirm this yields expected result for multiple channels with multiple
        // users
        ready.call(async function () {
          debug("api.getHistoricMembership")
          debug({
            gt: `!!${util.hex(publicKey)}`,
            lt: `~!${util.hex(publicKey)}`
          })
          const iter = lvl.iterator({
            reverse: true,
            gt: `!!${util.hex(publicKey)}`,
            lt: `~!${util.hex(publicKey)}`
          })
          const entries = await iter.all()
          debug("entries", entries)
          let channels = entries.map(e => {
            return getChannelFromKey(e[0])
          })
          channels = Array.from(new Set(channels))
          channels.sort()
          cb(null, channels)
        })
      },
      getUsersInChannel (channel, cb) {
        if (!cb) { cb = noop }
        ready.call(async function () {
          debug("api.getUsersInChannel")
          const iter = lvl.iterator({
            gt: `${channel}!!`,
            lt: `${channel}!~`
          })
          const entries = await iter.all()
          const pubkeys = []
          entries.forEach(e => {
            // channel joined
            if (e[1] === 1) { 
              const key = getPublicKeyFromKey(e[0])
              // indicates usage of SENTINEL_USER: skip
              if (key === "") { return }
              pubkeys.push(key)
            }
          })
          debug("public keys", pubkeys)
          cb(null, Array.from(new Set(pubkeys)))
        })
      },
      getJoinedChannels (publicKey, cb) {
        // return set of channel names that pubkey is in according to our local knowledge
        // TODO (2023-03-07): write test to confirm this yields expected result for multiple channels with multiple
        // users
        ready.call(async function () {
          debug("api.getJoinedChannels")
          const iter = lvl.iterator({
            reverse: true,
            gt: `!!${util.hex(publicKey)}`,
            lt: `~!${util.hex(publicKey)}`
          })
          const entries = await iter.all()
          const joined = new Set()
          entries.forEach(e => {
            // channel joined
            if (e[1] === 1) { 
              const channel = getChannelFromKey(e[0])
              joined.add(channel) 
            }
          })
          const uniqueChannels = Array.from(joined).sort()
          cb(null, uniqueChannels)
        })
      }
    }
  }
}
