const EventEmitter = require('events').EventEmitter
const b4a = require("b4a")
const viewName = "topics"
const debug = require("debug")(`core/${viewName}`)
const constants = require("../cable/constants.js")

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
    maxBatch: 100,

    map: function (msgs, next) {
      debug("view.map")
      let seen = {}
      let ops = []
      unprocessedBatches++
      debug("msgs %O", msgs.length)
      msgs.forEach(function (msg) {
        // TODO: decide format of input; should we operate on a json object or not?
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
    },

    storeState: function (state, cb) {
      state = state.toString('base64')
      lvl.put('state', state, cb)
    },

    fetchState: function (cb) {
      lvl.get('state', function (err, state) {
        if (err && err.notFound) cb()
        else if (err) cb(err)
        else cb(null, b4a.from(state, 'base64'))
      })
    },
  }
}

// Returns a well-formed message or null
function sanitize (msg) {
  if (typeof msg !== 'object') return null
  return msg
}

