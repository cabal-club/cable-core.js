// SPDX-FileCopyrightText: 2023 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const viewName = "mod:roles"
const debug = require("debug")(`core:${viewName}`)
const util = require("cable-core/util.js")
const monotonicTimestamp = util.monotonicTimestamp()

function noop () {}

// takes a (sub)level instance
module.exports = function (lvl/*, reverseIndex*/) {
  const ready = new util.Ready(viewName)

  return {
    map (msgs, next) {
      debug("view.map")
      let ops = []
      let pending = 0
      ready.increment()
      msgs.forEach((msg) => {
        const ts = monotonicTimestamp(msg.timestamp)

        const keys = []
				// LATEST ROLES          latest!<authorKey>!<recpKey>!<context> => <hash>
        if (msg.isAdmin) {
          keys.push({
            key: `latest!${util.hex(msg.publicKey)}!${msg.channel}!${util.hex(msg.recipient)}`
          })
        }

				// ROLES SINCE TS        all!<monots>!<authorKey>!<recpKey>!<context> => hash
        keys.push({
          key: `all!${ts}!${util.hex(msg.publicKey)}!${msg.channel}!${util.hex(msg.recipient)}`
        })
        const hash = msg.hash

        keys.forEach(item => {
          const {key} = item
          pending++
          lvl.get(key, (err) => {
            // NOTE (2024-01-25): only stores on entry per key (does not overwrite) currently
            if (err && err.notFound) {
              ops.push({
                type: 'put',
                key,
                value: hash
              })
            }
            if (!--pending) done()
          })
        })
      })
      if (!pending) done()

      function done () {
        // const getHash = (m) => m.value
        // const getKey = (m) => m.key
        // reverseIndex.map(reverseIndex.transformOps(viewName, getHash, getKey, ops))
        debug("ops %O", ops)
        debug("done. ops.length %d", ops.length)
        lvl.batch(ops, next)
        ready.decrement()
        ready.call()
      }
    },

    // TODO (2024-01-25): 
    // * support for handling role reassignments of a user for another user
    // * support for deleting / dropping a hash and all the associated keys (basically turning on reverseIndex bits)
    // * a more performant way / scheme for getting only the relevant hashes as determined by local user
    //    maybe this is simply what subtable `latest!<...>` should be??
    api: {
      // first level: only set rows by authors that are recognized as admins
      // second level: only set rows authored *after* they were recognized as admins (not necessary but would be useful + less data to manage)
      // third level: add method for removing records from latest due to them having lost their admin role
      getRelevantRoleHashes (cb) {
        ready.call(async function () {
          debug("api.getRelevantRoleHashes")
          const iter = lvl.values({
            reverse: true,
            gt: `latest!!`,
            lt: `latest!~`
          })
          const hashes = await iter.all()
          cb(null, hashes) 
        })
      },
      getLatestByAuthor (publicKey, cb) {
        // returns all hashes authored by publicKey. can be used to purge database of posts made by a public key
        ready.call(async function () {
          debug("api.getAllHashesByAuthor")
          const iter = lvl.values({
            reverse: true,
            gt: `latest!${util.hex(publicKey)}!`,
            lt: `latest!${util.hex(publicKey)}~`
          })
          const hashes = await iter.all()
          cb(null, hashes) 
        })
      },
      getAllSinceTime (ts, cb) {
        // returns all hashes authored since ts
        ready.call(async function () {
          debug("api.getAllSinceTime")
          const iter = lvl.values({
            reverse: true,
            gt: `all!${ts}!`,
            lt: `all!~`
          })
          const hashes = await iter.all()
          cb(null, hashes) 
        })
      },
      getAllByAuthorSinceTime (publicKey, ts, cb) {
        // returns all hashes authored by publicKey. can be used to purge database of posts made by a public key
        ready.call(async function () {
          debug("api.getAllByAuthorSinceTime")
          const iter = lvl.iterator({
            reverse: true,
            gt: `all!${ts}!`,
            lt: `all!~`
          })
          const hashes = new Set()
          for await (let [key, hash] of iter) {
            if (key.split("!")[2] === publicKey) {
              hashes.add(hash)
            }
          }
          cb(null, Array.from(hashes))
        })
      },
      // demoting an admin means removing all of their applied roles for a given context. in database terms, this necessitates removing all
      // rows associated with them from table `latest`
      demoteAdmin (publicKey, context, cb) {
        ready.call(async function () {
          debug("api.demoteAdmin")
          if (typeof cb === "undefined") { cb = noop }
          // get all keys authored by publicKey to table `latest`
          const iter = lvl.keys({
            reverse: true,
            gt: `latest!${util.hex(publicKey)}!${context}!`,
            lt: `latest!${util.hex(publicKey)}!${context}~`
          })
          // delete 'em
          const keys = await iter.all()
          const batchDel = keys.map(key => { return { type: "del", key } })
          const err = await lvl.batch(batchDel) 
          if (err) { return cb(err) }
          return cb(null)
        })
      }
    }
  }
}
