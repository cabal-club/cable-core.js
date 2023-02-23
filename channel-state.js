/*
!state!<mono-ts>!<channel>!member!<pubkey> -> <hash>
!state!<mono-ts>!<channel>!name!<pubkey> -> <hash>
!state!<mono-ts>!<channel>!topic -> <hash>
*/

const EventEmitter = require('events').EventEmitter
const b4a = require("b4a")
const debug = require("debug")("core/channel-state")
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
        /* channel state can have different types of messages. should they all be handled in the same view? or should we
         * have one view for each type of channel state?
        !state!<mono-ts>!<channel>!member!<pubkey> -> <hash>
        !state!<mono-ts>!<channel>!name!<pubkey> -> <hash>
        !state!<mono-ts>!<channel>!topic -> <hash>
        */ 
        // TODO: decide format of input; should we operate on a json object or not?
        if (!sanitize(msg)) return

        const fixedKey = `historic!${msg.timestamp}!${msg.channel}`
        let variableKey = ""
        switch (msg.postType) {
          case constants.JOIN_POST:
          case constants.LEAVE_POST:
            variableKey = `!member!${msg.publicKey.toString("hex")}`
            break
          case constants.INFO_POST:
            variableKey = `!name!${msg.publicKey.toString("hex")}`
            break
          case constants.TOPIC_POST:
            variableKey = `!topic`
            break
          default:
            throw new Error(`channel-state: unhandled post type (${msg.postType})`)
            break
        }

        const key = fixedKey + variableKey
        const hash = msg.hash

        pending++
        lvl.get(key, function (err) {
          if (err && err.notFound) {
            if (!seen[hash]) events.emit('add', hash)
            ops.push({
              type: 'put',
              key,
              value: hash
            })
          }
          // keeps track of the latest hash made by any user, let's us easily range over the latest channel state.
          // overwrites old ones
          ops.push({
            type: 'put',
            key: `latest!${msg.channel}${variableKey}`,
            value: hash
          })
          if (!--pending) done()
        })
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
      getLatestState: function (channel, cb) {
        // return the latest topic set on channel + latest name and membership change for each known pubkey in channel
        ready(async function () {
          debug("api.getLatestState")
          const iter = lvl.values({
            reverse: true,
            gt: `latest!${channel}!`,
            lt: `latest!${channel}~`
          })
          const hashes = await iter.all()
          cb(null, hashes) // only return one hash
        })
      },
      getLatestNameHash: function (channel, publicKey, cb) {
        // return latest post/info hash for pubkey
        ready(function () {
          debug("api.getLatestNameHash")
          lvl.get(`latest!${channel}!name!${publicKey.toString("hex")}`, (err, hash) => {
            if (err) { return cb(err, null) }
            return cb(null, hash)
          })
        })
      },
      getLatestMembershipHash: function (channel, publicKey, cb) {
        // return latest post/join or post/leave hash authored by publicKey in channel
        ready(function () {
          debug("api.getLatestMembership")
          lvl.get(`latest!${channel}!member!${publicKey.toString("hex")}`, (err, hash) => {
            if (err) { return cb(err, null) }
            return cb(null, hash)
          })
        })
      },
      getLatestTopicHash: function (channel, cb) {
        // return latest post/topic hash
        ready(function () {
          debug("api.getLatestNameHash")
          lvl.get(`latest!${channel}!topic`, (err, hash) => {
            if (err) { return cb(err, null) }
            return cb(null, hash)
          })
        })
      },
      getHistoricState: function (cb) {
        ready(async function () {
          debug("api.getHistoricState")
          const iter = lvl.values({
            gt: `historic!!${channel}!!`,
            lt: `historic!~${channel}!~`
          })
          const hashes = await iter.all()
          cb(hashes)
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

