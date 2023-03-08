const EventEmitter = require('events').EventEmitter
const b4a = require("b4a")
const viewName = "user-info"
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
        if (!sanitize(msg)) return

        // TODO (2023-03-07): values stored under this scheme are currently unused. but could be used in preference to
        // the latest scheme and reduce need for reindexing this when deletes happen
        const key = `info!${msg.key}!${msg.publicKey.toString("hex")}!${msg.timestamp}`
        const hash = msg.hash

        // this switch case makes sure we find unhandled cases, because they are likely to be either bugs or new
        // functionality that needs to be handled in other parts of the codebase
        switch (msg.key) {
          case "name": 
            // pass
            break
          default:
            throw new Error(`${viewName}: unhandled key type (${msg.key})`)
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
          // keeps track of the latest key:value pair made by any user, let's us easily get the latest value
          //
          // note: need to track & remove these keys via the reverse hash map in case of delete
          // note 2: this operation resides outside the conditionals above since we occasionally want to reindex the
          // latest value (in case of deletion), and to do so we simply re-put the record, overwriting the old
          ops.push({
            type: 'put',
            key: `latest!info!${msg.key}!${msg.publicKey.toString("hex")}`,
            value: hash
          })
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
      // return latest post/info name-setting hash for all recorded pubkeys
      getAllNameHashes: function (cb) {
        ready(async function () {
          debug("api.getUsers")
          const iter = lvl.values({
            gt: `latest!info!name!!`,
            lt: `latest!info!name!~`
          })
          const hashes = await iter.all()
          debug(hashes)
          cb(null, hashes)
        })
      },
      // return latest post/info name-setting hash for specified publicKey
      getLatestNameHash: function (publicKey, cb) {
        ready(function () {
          // TODO (2023-03-07): consider converting to using a range query with limit: 1 instead
          debug("api.getLatestNameHash")
          lvl.get(`latest!info!name!${publicKey.toString("hex")}`, (err, hash) => {
            if (err) { return cb(err, null) }
            return cb(null, hash)
          })
        })
      },
      // this function is needed to fulfilling channel state requests, in terms of getting the latest name hashes
      getLatestNameHashMany: function (pubkeys, cb) {
        // return latest post/info hash for many pubkeys
        ready(function () {
          debug("api.getLatestNameHashMany")
          const keys = pubkeys.map(publicKey => {
            return `latest!info!name!${publicKey.toString("hex")}`
          })
          debug(keys)
          lvl.getMany(keys, (err, hashes) => {
            debug("many name keys (err %O) %O", err, hashes) 
            if (err) { return cb(err, null) }
            return cb(null, hashes)
          })
        })
      },
      clearName: function (publicKey, cb) {
        if (!cb) { cb = noop }
        // remove the name record for this public key
        ready(function () {
          debug("api.clearNameHash")
          lvl.del(`latest!info!name!${publicKey.toString("hex")}`, (err) => {
            if (err) { return cb(er) }
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

