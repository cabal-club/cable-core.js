// SPDX-FileCopyrightText: 2023 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const EventEmitter = require('events').EventEmitter
const b4a = require("b4a")
const viewName = "user-info"
const debug = require("debug")(`core:${viewName}`)
const constants = require("cable.js/constants.js")
const util = require("../util.js")

const KEY_ROLE_OPT_OUT = `ro`
function noop () {}

// takes a (sub)level instance
module.exports = function (lvl, reverseIndex) {
  const ready = new util.Ready(viewName)
  const events = new EventEmitter()

  return {
    map: (msgs, next) => {
      debug("view.map")
      debug("incoming msgs %O", msgs)
      let ops = []
      let pending = 0
      ready.increment()
      msgs.forEach((msg) => {
        const hash = msg.hash

        const keys = []
        keys.push(`latest!${util.hex(msg.publicKey)}`)
        keys.push(`${KEY_ROLE_OPT_OUT}!${util.hex(msg.publicKey)}`)

        keys.forEach(key => {
          pending++
          lvl.get(key, (err, val) => {
            switch (key.split("!")[0]) {
              case "latest":
                if (err && err.notFound) {
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
                break
              case KEY_ROLE_OPT_OUT:
                // two cases: 
                // 1: someone is making a decision on whether to accept roles, 
                // 2: they previously made a decision (opted out) and their latest post impicitly opts them back in
                if (msg.info.has("accept-role") || (!err && !msg.info.has("accept-role"))) {
                  let acceptRoleValue

                  if (!msg.info.has("accept-role")) {
                    acceptRoleValue = constants.INFO_DEFAULT_ACCEPT_ROLE
                  } else {
                    acceptRoleValue = msg.info.get("accept-role")
                  }

                  // index key tracking role opt out for this user existed AND they are now opting back in
                  if (!err && acceptRoleValue === 1) {
                    const ts = parseInt(val)
                    // the post/info doing the opt in is newer than what was previously stored
                    if (msg.timestamp > ts) {
                      // delete the opt out key from index and announce opting in
                      events.emit('role-opt-in', { publicKey: msg.publicKey })
                      ops.push({
                        type: 'del',
                        key
                      })
                    }
                  } else if (err && err.notFound && acceptRoleValue === 0) {
                    // the opt out key was not previously set for this user AND they are explicitly opting-out
                    ops.push({
                      type: 'put',
                      key,
                      value: msg.timestamp
                    })
                    events.emit('role-opt-out', { publicKey: msg.publicKey })
                  }
                }
                break
              default:
                debug("unknown table %s", key)
            }
            if (!--pending) done()
          })
        })
      })
      if (!pending) done()

      function done () {
        const getHash = (m) => m.value
        const getKey = (m) => m.key
        reverseIndex.map(reverseIndex.transformOps(viewName, getHash, getKey, ops.filter(o => o.key.startsWith("latest"))))
        debug("ops %O", ops)
        debug("done. ops.length %d", ops.length)
        lvl.batch(ops, next)
        ready.decrement()
        ready.call()
      }
    },

    api: {
      getRoleOptOutAllUsers (cb) {
        ready.call(async function () {
          debug("api.getRoleOptOutAllUsers")
          const iter = lvl.keys({
            gt: `${KEY_ROLE_OPT_OUT}!`,
            lt: `${KEY_ROLE_OPT_OUT}!~`
          })
          const keyStrings = await iter.all()
          debug(keyStrings)
          const keys = keyStrings.map(str => b4a.from(str.split("!")[1], "hex"))
          cb(null, keys)
        })
      },
      // return latest post/info hash for all recorded pubkeys
      getLatestInfoHashAllUsers (cb) {
        ready.call(async function () {
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
      getLatestInfoHash (publicKey, cb) {
        ready.call(() => {
          // TODO (2023-03-07): consider converting to using a range query with limit: 1 instead
          debug("api.getLatestInfoHash")
          lvl.get(`latest!${util.hex(publicKey)}`, (err, hash) => {
            if (err) { return cb(err, null) }
            return cb(null, hash)
          })
        })
      },
      // this function is needed to fulfilling channel state requests, in terms of getting the latest name hashes
      getLatestInfoHashMany (pubkeys, cb) {
        // return latest post/info hash for many pubkeys
        ready.call(() => {
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
      clearInfo (publicKey, cb) {
        if (!cb) { cb = noop }
        // remove the name record for this public key
        ready.call(() => {
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
