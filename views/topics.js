// SPDX-FileCopyrightText: 2023 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const EventEmitter = require('events').EventEmitter
const b4a = require("b4a")
const viewName = "topics"
const debug = require("debug")(`core:${viewName}`)
const constants = require("cable.js/constants.js")
const { Ready } = require("../util.js")

function noop () {}

// takes a (sub)level instance
module.exports = function (lvl) {
  const events = new EventEmitter()
  const ready = new Ready(viewName)

  return {
    // TODO (2023-03-08): either change the key layout or, before calling map, get a map of <channel> -> timestamp of
    // the latest topic message and pass to this index, so that we can make sure we only ever set the newest topic
    // message as the latest topic
    map: (msgs, next) => {
      debug("view.map")
      let ops = []
      ready.increment()
      debug("msgs %O", msgs.length)
      // make sure messages are sorted, as we'll be overwriting older topics set on the same channel
      const sorted = msgs.sort((a, b) => {
        return parseInt(a.timestamp) - parseInt(b.timestamp)
      })
      sorted.forEach((msg) => {
        // key schema
        // <channel> -> <topic>
        const key = msg.channel
        const value = msg.topic
        switch (msg.postType) {
          case constants.TOPIC_POST:
            break
          default:
            throw new Error(`${viewName}: unhandled post type (${msg.postType})`)
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
      // returns an object mapping each channel name to the latest topic
      getAllChannelTopics (cb) {
        ready.call(async function () {
          const iter = lvl.entries()
          const entries = await iter.all()
          debug("all topics", entries)
          cb(null, entries)
        })
      },
      clearTopic (channel, cb) {
        if (!cb) cb = noop
        ready.call(() => {
          lvl.del(channel, (err) => {
            if (err) { return cb(err) }
            cb(null)
          })
        })
      },
      getTopic (channel, cb) {
        ready.call(() => {
          debug("get topic", channel)
          lvl.get(channel, (err, value) => {
            if (err && err.notFound ) { return cb(null, null) }
            if (err ) { return cb(err) }
            cb(null, value)
          })
        })
      },
      events: events
    }
  }
}
