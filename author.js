const EventEmitter = require('events').EventEmitter
const b4a = require("b4a")
const viewName = "author"
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

        // <mono-ts>!<pubkey>!<post_type-id> -> <hash>
        const key = `${msg.publicKey.toString("hex")}!${msg.postType}!${msg.timestamp}`
        const hash = msg.hash

        // make sure we find unhandled cases, because they are likely to be either bugs or new functionality that needs
        // to be handled in other parts of the codebase
        switch (msg.postType) {
          case constants.TEXT_POST:
          case constants.DELETE_POST:
          case constants.INFO_POST:
          case constants.TOPIC_POST:
          case constants.JOIN_POST:
          case constants.LEAVE_POST:
            // do nothing
            break
          default:
            throw new Error(`${viewName}: unhandled post type (${msg.postType})`)
            break
        }

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
      getAllHashesByAuthor: function (publicKey, cb) {
        // returns all hashes authored by publicKey. can be used to purge database of posts made by a public key
        ready(async function () {
          debug("api.getAllHashesByAuthor")
          const iter = lvl.values({
            reverse: true,
            gt: `${publicKey.toString("hex")}!!`,
            lt: `${publicKey.toString("hex")}!~`
          })
          const hashes = await iter.all()
          cb(null, hashes) 
        })
      },
      getAllHashesByAuthorAndType: function (publicKey, postType, cb) {
        // get all post hashes made by publicKey for the specified postType
        ready(async function () {
          debug("api.getAllHashesByAuthorAndType")
          const iter = lvl.values({
            reverse: true,
            gt: `${publicKey.toString("hex")}!${postType}!!`,
            lt: `${publicKey.toString("hex")}!${postType}!~`
          })
          const hashes = await iter.all()
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

