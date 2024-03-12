// SPDX-FileCopyrightText: 2023 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const b4a = require("b4a")
const cable = require("cable.js")
const constants = require("cable.js/constants.js")

// returns a timestamp in UNIX Time form
function timestamp () {
  return +(new Date())
}

// for use in indexes to ensure that we never have any collisions with non-monotonic timestamps.
// takes a timestamp, and if that timestamp has been seen, returns a unique monotonic timestamp
function monotonicTimestamp () {
  this.seen = {}
  // TODO (2023-03-01): maintain a fixed length on seen dictionary
  // list of keys that may be sorted to trim this.seen length once max reached
  // this.keys = []
  const pad = (n) => {
    const str = `${n}`
    return `${'0'.repeat(3-str.length)}${str}`
  }

  return (ts) => {
    if (typeof ts === "undefined") {
      ts = timestamp()
    }
    const key = `${ts}`
    let ret = key
    if (this.seen[key]) {
      const prev = this.seen[key]
      const str = `${prev[prev.length - 1]}`
      const index = str.indexOf(".")
      if (index < 0) {
        ret = `${ts}.${pad(1)}`
      } else {
        const i = parseInt(str.slice(index+1))
        ret = `${ts}.${pad(i+1)}`
      }
    }
    if (!this.seen[key]) { 
      this.seen[key] = [] 
      // this.keys.push(key)
    }
    this.seen[key].push(ret)
    return ret
  }
}

function humanizeMessageType(msgtype) {
  switch (msgtype) {
    case 0:
      return "hash response"
    case 1:
      return "post response"
    case 2:
      return "post request"
    case 3:
      return "cancel request"
    case 4:
      return "channel time range request"
    case 5:
      return "channel state request"
    case 6:
      return "channel list request"
    case 7:
      return "channel list response"
    default:
      return "unknown"
  }
}

function humanizePostType(posttype) {
  switch (posttype) {
    case 0:
      return "post/text"
    case 1:
      return "post/delete"
    case 2:
      return "post/info"
    case 3:
      return "post/topic"
    case 4:
      return "post/join"
    case 5:
      return "post/leave"
    case 6:
      return "post/role"
    case 7:
      return "post/moderation"
    case 8:
      return "post/block"
    case 9:
      return "post/unblock"
    default:
      return "unknown"
  }
}

function hex (input) {
  if (typeof input === "string") { return input }
  return b4a.toString(input, "hex")
}

/* used by moderation tests and functionality */
function getRole(map, role) {
  const keys = new Set()
  for (let [recipient, roleObj] of map) {
    if (roleObj.role === role) { keys.add(recipient); }
  }
  return keys
}

function getSmallestValidTime (tracker, cabal, author) {
  const trackerTime = tracker.getRoleValidSince(author)
  const cabalTime = cabal.getRoleValidSince(author)
  if (trackerTime === -1 || trackerTime > cabalTime) { 
    return cabalTime
  }
  return trackerTime
}

function _getContext (obj) {
  // block/unblock don't have a channel, they act on the entire cabal context
  if ((obj.postType === constants.BLOCK_POST || obj.postType === constants.UNBLOCK_POST) || obj.channel.length === 0) {
    return constants.CABAL_CONTEXT
  } 
  return obj.channel
}

function determineAuthority (localKp, buf, roles, authorityTest) {
  const obj = cable.parsePost(buf)
  // if the context for the post doesn't exist, for some reason, use the cabal context
  let authorityMap 
  const context = _getContext(obj)
  if (roles.has(context)) {
    authorityMap = roles.get(context)
  } else {
    authorityMap = roles.get(constants.CABAL_CONTEXT)
  }

  if (!authorityMap) {
    return b4a.equals(obj.publicKey, localKp.publicKey)
  }

  const role_ts = authorityMap.get(hex(obj.publicKey))
  return (role_ts && authorityTest(obj, role_ts))
}

const testIsModAuthority  = (obj, role_ts) => role_ts.role !== constants.USER_FLAG && obj.timestamp >= role_ts.since
const testIsAdmin         = (obj, role_ts) => role_ts.role === constants.ADMIN_FLAG && obj.timestamp >= role_ts.since

function isApplicable (localKp, buf, roles) {
  return determineAuthority(localKp, buf, roles, testIsModAuthority)
}

function isAdmin (localKp, buf, roles) {
  return determineAuthority(localKp, buf, roles, testIsAdmin)
}

class Ready {
  // callback processing queue. functions are pushed onto the queue if they are dispatched before the store is ready or
  // there are pending transactions in the pipeline
  queue = []
  // when unprocessedBatches is at 0 our index has finished processing pending transactions => ok to process queue
  unprocessedBatches = 0

  constructor(viewName) {
    this.debug = require("debug")(`core:${viewName}:ready`)
  }

  increment() {
    this.unprocessedBatches++
  }
  decrement() {
    this.unprocessedBatches--
  }
  
  call (cb) {
    this.debug("ready called")
    this.debug("unprocessedBatches %d", this.unprocessedBatches)
    if (!cb) cb = function () {}
    // we can process the queue
    if (this.unprocessedBatches <= 0) {
      for (let fn of this.queue) { fn() }
      this.queue = []
      return cb()
    }
    this.queue.push(cb)
  }
}

module.exports = {
  timestamp,
  monotonicTimestamp, 
  noop: function() {},
  humanizeMessageType,
  humanizePostType,
  hex,
  getRole,
  getSmallestValidTime, 
  Ready,
  isAdmin,
  isApplicable
}
