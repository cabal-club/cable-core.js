const EventEmitter = require('events').EventEmitter
const b4a = require("b4a")
const viewName = "topics"
const debug = require("debug")(`core/${viewName}`)
const constants = require("cable.js/constants.js")

function noop () {}

// takes a (sub)level instance
module.exports = function (lvl) {
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
    // TODO (2023-03-08): either change the key layout or, before calling map, get a map of <channel> -> timestamp of
    // the latest topic message and pass to this index, so that we can make sure we only ever set the newest topic
    // message as the latest topic
    map: function (msgs, next) {
      debug("view.map")
      let ops = []
      unprocessedBatches++
      debug("msgs %O", msgs.length)
      // make sure messages are sorted, as we'll be overwriting older topics set on the same channel
      const sorted = msgs.sort((a, b) => {
        return parseInt(a.timestamp) - parseInt(b.timestamp)
      })
      sorted.forEach(function (msg) {
        if (!sanitize(msg)) return

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
        unprocessedBatches--
        ready()
      }
    },

    api: {
      // returns an object mapping each channel name to the latest topic
      getAllChannelTopics: function (cb) {
        ready(async function () {
          const iter = lvl.entries()
          const entries = await iter.all()
          debug("all topics", entries)
          cb(null, entries)
        })
      },
      clearTopic: function (channel, cb) {
        if (!cb) cb = noop
        ready(function () {
          lvl.del(channel, (err) => {
            if (err) { return cb(err) }
            cb(null)
          })
        })
      },
      getTopic: function (channel, cb) {
        ready(function () {
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

// Returns a well-formed message or null
function sanitize (msg) {
  if (typeof msg !== 'object') return null
  return msg
}

