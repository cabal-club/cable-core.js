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

module.exports = {
  timestamp,
  monotonicTimestamp, 
  noop: function() {}
}
