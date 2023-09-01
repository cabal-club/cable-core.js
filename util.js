// SPDX-FileCopyrightText: 2023 the cabal-club authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const b4a = require("b4a")

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
      return "channel list request"
    case 7:
      return "channel list response"
    default:
      return "unknown"
  }
}

function hex (input) {
  if (typeof input === "string") { return input }
  return b4a.toString(input, "hex")
}


module.exports = {
  timestamp,
  monotonicTimestamp, 
  noop: function() {},
  humanizeMessageType,
  humanizePostType,
  hex
}
