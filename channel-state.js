const EventEmitter = require('events').EventEmitter
const b4a = require("b4a")
const viewName = "channel-state"
const debug = require("debug")(`core/${viewName}`)
const constants = require("../cable/constants.js")
const util = require("./util.js")

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
    maxBatch: 100,

    map: function (msgs, next) {
      debug("view.map")
      let seen = {}
      let ops = []
      let pending = 0
      unprocessedBatches++
      msgs.forEach(function (msg) {
        if (!sanitize(msg)) return

        let key
        switch (msg.postType) {
          case constants.JOIN_POST:
          case constants.LEAVE_POST:
            key = `member!${msg.channel}!${msg.timestamp}!${msg.publicKey.toString("hex")}`
            break
          case constants.INFO_POST:
            key = `name!${msg.channel}!${msg.timestamp}!${msg.publicKey.toString("hex")}`
            break
          case constants.TOPIC_POST:
            key = `topic!${msg.channel}!${msg.timestamp}`
            break
          default:
            throw new Error(`${viewName}: unhandled post type (${msg.postType})`)
            break
        }

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
          cb(null, hashes) // only return one hash
        })
      },
      getLatestNameHash: function (channel, publicKey, cb) {
        // return latest post/info hash for pubkey
        ready(async function () {
          debug("api.getLatestNameHash")
          const iter = lvl.values({
            lt: `name!${channel}!${util.timestamp()}!${publicKey.toString("hex")}`,
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
            lt: `member!${channel}!${util.timestamp()}!${publicKey.toString("hex")}`,
            reverse: true,
            limit: 1
          })
          const iter = lvl.values({
            lt: `member!${channel}!${util.timestamp()}!${publicKey.toString("hex")}`,
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
      getHistoricState: function (channel, cb) {
        if (!cb) cb = noop
        ready(async function () {
          debug("api.getHistoricState")
          const iter = lvl.iterator()
          const hashes = await iter.all()
          debug("historic", hashes)
          cb(null, hashes)
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

