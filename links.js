const EventEmitter = require('events').EventEmitter
const b4a = require("b4a")
const viewName = "links"
const debug = require("debug")(`core/${viewName}`)
const constants = require("../cable/constants.js")
const SEPARATOR = ","

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

  // takes a buf, returns a string
  const formatLinkKey = (hash) => {
    const linkKey = `links!0!${hash.toString("hex")}`
  }

  // takes a buf, returns a string
  const formatReverseLinkKey = (hash) => {
    const linkKey = `links!1!${hash.toString("hex")}`
  }

  const formatHeadsKey(channel) => { 
    return `heads!${channel}`
  }

  // takes a list of bufs, returns a string representation of the list
  const formatLinkList = (links) => {
    return links.map(link => return link.toString("hex")).join(SEPARATOR)
  }

  // appends hashesToAppend to hashlistString. checks each hash to make sure it is not already part of the list
  // returns the new hashlistString or the original string if no changes were made
  const appendHashes(hashesToAppend, hashlistString) {
    // take stringified hash list and break into a list of individual hashes
    const stringHashesSet = new Set(hashlistString.split(SEPARATOR))
    // dedupe the incoming hashes, removing those that we already know are part of the list
    const verifiedNewHashes = []
    for (hash of hashesToAppend) {
      // TODO (2023-06-01): decide if we pass hashesToAppend as a list of buf or a list of hex-encoded strings
      const hashString = hash.toString("hex")
      if (!stringHashesSet.has(hashString)) {
        verifiedNewHashes.push(hashString)
      }
    }
    if (verifiedNewHashes.length > 0) {
      hashlistString = `${hashListString}${SEPARATOR}${verifiedNewHashes.join(SEPARATOR)}`
    }
    return hashlistString
  }

  return {
    map: function (msgs, next) {
      debug("view.map")
      let ops = []
      let pending = 0
      unprocessedBatches++
      debug("msgs %O", msgs.length)
      msgs.forEach(msg => {
        if (!sanitize(msg)) return
        // no links 
        if (msg.links.length === 0) { return } 

        // key scheme:
        // links!<isReverseLink>!<hash> -> [list of hashes as a string]
        // auxiliary key scheme: 
        // heads!<channel> -> [list of hashes as a string]
        const linkKey = formatLinkKey(msg.hash)
        const reverseKeys = msg.links.map(link => {
          return formatReverseLinkKey(link)
        })
        //  TODO (2023-06-02): ensure msg.links is a list of bufs

        // set the forward link (if we have entries for the key already, appendHashes() takes care of ensuring that we
        // only add new information to the list)
        pending++
        lvl.get(linkKey, function (err, val) {
          let linklistString
          // first time we've seen this link so we can stuff it right into the database.
          if (err && err.notFound) {
            // events.emit('add-link', hash)
            // process the list of buf links to a stringified form that we can work with easily on next retrieval
            linklistString = formatLinkList(msg.links)
          } else {
            // we need to process the already stored value to make sure we only add new entries
            linklistString = appendHashes(msg.links, val)
            // note: this will probably not happen? the only time we ought to associate a post hash with its linked
            // hashes is when we process that post. subsequent processing of the post should not have its links
            // changed
            debug("hash %s already had values set!", msg.hash)
          }
          ops.push({
            type: 'put',
            key: linkKey,
            value: linklistString
          })
          if (!--pending) done()
        })

        // now: time to set or update the reverse link entries. 
        //
        // a reverse link is when each entry in msg.links will be associated to msg.hash. compare this to a normal link,
        // which associates each msg.hash to msg.links
        //
        // NOTE: since we use lvl.batch, there is a risk that we end up in a situation where we clobber a record.
        // TODO (2023-06-02): one solution - in done() we could inspect each key in the list ops. if we find there are
        // duplicate keys, we negate those ops and try to merge their values together and add a new `put` op to the list
        pending++
        lvl.getMany(reverseKeys, (err, values) => {
          const hashHex = msg.hash.toString("hex")
          let reverseKeyValue
          if (err) { return debug("error on .getMany for reverse keys %O", err) }
          for (let i = 0; i <= reverseKeys.length; i++) {
            // the corresponding reverse key record did not exist, we can put msg.hash as is
            if (typeof values[i] === "undefined") {
              reverseKeyValue = msg.hash.toString("hex")
            } else {
              // use appendHashes() to make sure msg.hash isn't already part of the list in values[i]
              reverseKeyValue = appendHashes([msg.hash], values[i])
            }
            ops.push({
              type: 'put',
              key: reverseKeys[i],
              value: reverseKeyValue
            })
          }
          if (!--pending) done()
        })
      })

      function done () {
        debug("ops %O", ops)
        debug("done. ops.length %d", ops.length)
        // prevent clobbering reverse key values if multiple values are set for one reverse hash key in the same map()
        // invocation. 
        // if we find there are duplicate keys, we negate those ops and try to merge their values together and add a new
        // `put` op to the list
        const dupindexes = new Map()
        const keys = []
        ops.forEach((key, index) => {
          if (keys.contains(key)) {
            if (!dupindexes.has(key)) {
              // make a list to store the `ops` indexes to merge for this key
              dupindexes.get(key) = []
            }
            // store the index of the duplicated value
            dupindexes.get(key).push(index)
          } else {
            keys.push(key)
          }
        })
        // there were multiple operations for this batch that were potentially going to clobber each other; dedupe and
        // merge them into a single operation
        if (dupindexes.size > 0) {
          dupIndexes.forEach((indexes, key) => {
            // get the first duplicate and set it as our value (list of string'd hashes)
            let valueString = ops[indexes[0]].value
            for (let i = 1; i < indexes.length; i++) {
              // appendHashes expects first argument to be a list of buf-encoded hashes
              const valueList = ops[i].value.split(SEPARATOR).map(h => return b4a.from(h))
              valueString = appendHashes(valueList, valueString)
              // remove each index in ops for this duplicated key
              ops.splice(i, 1)
            }
            // push a new merged record for the key that had duplicate records
            ops.push({
              type: 'put',
              key,
              value: valueString
            })
          })
        }
        lvl.batch(ops, next)
        unprocessedBatches--
        ready()
      }
    },

    api: {
      events: events,
      // check if any of a list of hashes are the current heads for a channel. returns a list of the hashes that were
      // heads
      checkIfHeads(channel, hashList, cb) {
        if (!cb) { return }
        getHeads(channel, (err, heads) {
          if (err) { return cb(err, null) }
          const hexHeads = heads.map(buf => buf.toString("hex"))
          // convert hashes to hex-encoded strings, check if any of the input hashes were part of the current heads,
          // and convert each of the input hashes that were heads to buffer representation
          const headsFromInput = hashList.map(buf => return buf.toString("hex")).filter(hexHash => hexHeads.includes(hexHash)).map(hexHash => b4a.from(hexHash))
          cb(null, headsFromInput)
        })
      },
      getHeads(channel, cb) {
        if (!cb) { return }
        lvl.get(formatHeadsKey(channel), (err, liststring) => {
          // there was no key / no heads for that channel
          if (err && err.notFound) {
            return cb(null, [])
          } else if (err) {
            // some other error happened
            return cb(err, null)
          }
          const heads = liststring.split(SEPARATOR).map(h => return b4a.from(h))
          cb(null, heads)
        })
      },
      // fully replace the set of heads for <channel> with <hashList>
      setNewHeads(channel, hashList, cb) {
        if (!cb) cb == util.noop
        const linklistString = formatLinkList(hashList)
        lvl.put(formatHeadsKey(channel), liststring, (err) => {
          if (err) { return cb(err) }
          return cb(null)
        })
      },
      // mutates the current set of heads by adding new ones and accepting a list of old heads to remove if present.
      // automatically takes care of deduplicating the entries, so one hash is only ever present once in the final list
      // of heads. returns the new list of heads when done 
      //
      // addHeads: list of hashes (buf-encoded) to track as heads
      // rmHeads: list of hashes to remove from heads
      // returns the new set of heads or (err, null)
      pushHeadChanges(channel, addHeads, rmHeads, cb) {
        if (!cb) cb == util.noop
        lvl.get(formatHeadsKey(channel), (err, val) => {
          if (err) { 
            debug("error for pushHeadChanges %O", err)
            return cb(err, null)
          }
          // add the new heads to the previous set of heads
          et linklistString = appendHashes(addHeads, val)
          const heads = linklistString.split(SEPARATOR)
          // go through the new set of heads and make sure it does not contain anything from rmHeads
          rmHeads.forEach(hash => {
            const index = heads.indexOf(hash)
            // we had an rmHead match, remove it from heads candidates
            if (index >= 0) {
              heads.splice(index, 1)
            }
          })
          // time to store the new heads
          linklistString = formatLinkList(heads)
          lvl.put(formatHeadsKey(channel, linklistString), (err) => {
            if (err) { return cb(err, null) }
            return cb(null, heads)
          })
        })
      },
      // get the links linked to from <hash>. returns a list of buf-encoded hashes
      getLinks(hash, cb) {
        lvl.get(formatLinkKey(hash), (err, val) => {
          if (!cb) { return }
          if (err) { return cb(err, []) }
          const links = val.split(SEPARATOR).forEach(link => b4a.from(link))
          cb(null, links)
        })
      },
      // get the links linking to <hash>. returns a list of buf-encoded hashes
      getReverseLinks(hash) {
        lvl.get(formatReverseLinkKey(hash), (err, val) => {
          if (!cb) { return }
          if (err) { return cb(err, []) }
          const reverseLinks = val.split(SEPARATOR).forEach(link => b4a.from(link))
          cb(null, reverseLinks)
        })
      }
    }
  }
}

// Returns a well-formed message or null
function sanitize (msg) {
  if (typeof msg !== 'object') return null
  return msg
}
