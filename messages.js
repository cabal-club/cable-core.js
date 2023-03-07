const EventEmitter = require('events').EventEmitter
const b4a = require("b4a")
const viewName = "messages"
const debug = require("debug")(`core/${viewName}`)
const constants = require("../cable/constants.js")

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
      let seen = {}
      let ops = []
      let pending = 0
      unprocessedBatches++
      msgs.forEach(function (msg) {
        // TODO: decide format of input; should we operate on a json object or not?
        if (!sanitize(msg)) return

        /* key scheme
          <mono-ts>!text!<channel> -> <hash>
          <mono-ts>!delete!<channel> -> <hash>
        */
        let key 
        switch (msg.postType) {
          case constants.TEXT_POST:
            key = `${msg.channel}!${msg.timestamp}!text`
            break
          case constants.DELETE_POST:
            key = `${msg.channel}!${msg.timestamp}!delete`
            break
          default:
            throw new Error(`${viewName}: unhandled post type (${msg.postType})`)
            break
        }

        const value = msg.hash

        pending++
        lvl.get(key, function (err) {
          if (err && err.notFound) {
            if (!seen[value]) events.emit('add', value)
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
        unprocessedBatches--
        ready()
      }
    },

    api: {
      getChannelTimeRange: function (channel, timestart, timeend, limit, cb) {
        // get the hashes recorded in the specified time range
        // TODO (2023-02-23): handle special case live streaming behaviour for timeend == 0
        ready(async function () {
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
      del: function (hash, cb) {
        debug("api.del")
        if (typeof cb === "undefined") { cb = noop }
        ready(function () {
          lvl.del(hash, function (err) {
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

