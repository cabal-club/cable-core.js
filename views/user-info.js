// SPDX-FileCopyrightText: 2023 the cabal-club authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const EventEmitter = require('events').EventEmitter
const b4a = require("b4a")
const viewName = "user-info"
const debug = require("debug")(`core:${viewName}`)
const constants = require("cable.js/constants.js")
const util = require("../util.js")

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
        const key = `latest!${util.hex(msg.publicKey)}`
        const hash = msg.hash

        // this switch case makes sure we find unhandled cases, because they are likely to be either bugs or new
        // functionality that needs to be handled in other parts of the codebase
        switch (msg.key) {
          case "accept-role": 
            // pass
            break
          case "name": 
            // pass
            break
          default:
            throw new Error(`${viewName}: unhandled post/info key (${msg.key})`)
            break
        }

        pending++
        lvl.get(key, function (err) {
          if (err && err.notFound) {
            if (!seen[hash]) events.emit('add', hash)
            // keeps track of the latest key:value pair made by any user, let's us easily get the latest value
            //
            // note: need to track & remove these keys via the reverse hash map in case of delete
            // note 2: this operation resides outside the conditionals above since we occasionally want to reindex the
            // latest value (in case of deletion), and to do so we simply re-put the record, overwriting the old
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
      // return latest post/info hash for all recorded pubkeys
      getLatestInfoHashAllUsers: function (cb) {
        ready(async function () {
          debug("api.getUsers")
          const iter = lvl.values({
            gt: `latest!`,
            lt: `latest!~`
          })
          const hashes = await iter.all()
          debug(hashes)
          cb(null, hashes)
        })
      },
      // return latest post/info hash for specified publicKey
      getLatestInfoHash: function (publicKey, cb) {
        ready(function () {
          // TODO (2023-03-07): consider converting to using a range query with limit: 1 instead
          debug("api.getLatestInfoHash")
          lvl.get(`latest!${util.hex(publicKey)}`, (err, hash) => {
            if (err) { return cb(err, null) }
            return cb(null, hash)
          })
        })
      },
      // this function is needed to fulfilling channel state requests, in terms of getting the latest name hashes
      getLatestInfoHashMany: function (pubkeys, cb) {
        // return latest post/info hash for many pubkeys
        ready(function () {
          debug("api.getLatestInfoHashMany")
          const keys = pubkeys.map(publicKey => {
            return `latest!${util.hex(publicKey)}`
          })
          debug(keys)
          lvl.getMany(keys, (err, hashes) => {
            debug("many name keys (err %O) %O", err, hashes) 
            if (err) { return cb(err, null) }
            // filter out results where where there is no value for one of our queried keys
            const returnedHashes = hashes.filter(hash => typeof hash !== "undefined")
            return cb(null, hashes)
          })
        })
      },
      clearInfo: function (publicKey, cb) {
        if (!cb) { cb = noop }
        // remove the name record for this public key
        ready(function () {
          debug("api.clearInfoHash")
          lvl.del(`latest!${util.hex(publicKey)}`, (err) => {
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

