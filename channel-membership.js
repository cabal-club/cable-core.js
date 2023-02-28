const EventEmitter = require('events').EventEmitter
const b4a = require("b4a")
const debug = require("debug")("core/channel-membership")
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
      let pending = 0
      unprocessedBatches++
      msgs.forEach(function (msg) {
        // TODO: decide format of input; should we operate on a json object or not?
        if (!sanitize(msg)) return

        // key schema
        // <publicKey>!<channel! -> 1 or 0
        const key = `${msg.publicKey.toString("hex")}!${msg.channel}`
        let value
        let variableKey = ""
        switch (msg.postType) {
          case constants.JOIN_POST:
            value = 1
            break
          case constants.LEAVE_POST:
            value = 0
            break
          default:
            throw new Error(`channel-membership: unhandled post type (${msg.postType})`)
            break
        }

        pending++
        ops.push({
          type: 'put',
          key,
          value
        })
        if (!--pending) done()
      })
      if (!pending) done()

      function done () {
        debug("ops %O", ops)
        debug("done. ops.length %d", ops.length)
        lvl.batch(ops, next)
        unprocessedBatches--
        ready()
      }
    },

    api: {
      getChannelNames: function (offset, limit, cb) {
        ready(async function () {
          const iter = lvl.keys()
          const keys = await iter.all()
          const names = keys.map(k => {
            return k.slice(k.indexOf("!")+1)
          })
          names.sort()
          if (limit === 0) { limit = names.length }
          cb(null, names.slice(offset, limit))
        })
      },
      isInChannel: function (channel, publicKey, cb) {
        ready(function () {
          lvl.get(`${publicKey.toString("hex")}!${channel}`, (err, value) => {
            if (err && err.notFound ) { return cb(null, false) }
            if (err ) { return cb(err) }
            cb(null, parseInt(value) === 1)
          })
        })
      },
      getHistoricMembership: function (publicKey, cb) {
        // return set of channel names that pubkey is in according to our local knowledge
        // also includes channels that have been joined previously but are marked as left
        ready(async function () {
          debug("api.getJoinedChannels")
          const iter = lvl.iterator({
            reverse: true,
            gt: `${publicKey.toString("hex")}!!`,
            lt: `${publicKey.toString("hex")}!~`
          })
          const entries = await iter.all()
          const joined = entries.map(e => {
            return e[0].slice(e[0].indexOf("!")+1)
          })
          joined.sort()
          cb(null, joined)
        })
      },
      getJoinedChannels: function (publicKey, cb) {
        // return set of channel names that pubkey is in according to our local knowledge
        ready(async function () {
          debug("api.getJoinedChannels")
          const iter = lvl.iterator({
            reverse: true,
            gt: `${publicKey.toString("hex")}!!`,
            lt: `${publicKey.toString("hex")}!~`
          })
          const entries = await iter.all()
          const joined = []
          entries.forEach(e => {
            // channel joined
            if (e[1] === 1) { 
              const channel = e[0].slice(e[0].indexOf("!")+1)
              joined.push(channel) 
            }
          })
          joined.sort()
          cb(null, joined)
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

