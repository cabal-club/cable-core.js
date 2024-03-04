const EventEmitter = require('events').EventEmitter
// const b4a = require("b4a")
const viewName = "mod:actions"
const debug = require("debug")(`core:${viewName}`)
const b4a = require("b4a")
const util = require("cable-core/util.js")
const monotonicTimestamp = util.monotonicTimestamp()
const constants = require("cable.js/constants.js")

function noop () {}

// table prefixes
const PREFIX_RELEVANT   = "r"    // short for relevant
const PREFIX_APPLIED    = "a"     // short for applied
const PREFIX_TIME_INDEX = "t"  // short for time

// table "column" namespaces
const CHANNEL_NAMESPACE = "c"  // short for channel
const USER_NAMESPACE    = "u"     // short for user
const POSTS_NAMESPACE   = "p"    // short for posts

const APPLIED_USER_KEY = (recipient, channel, type) =>        `${PREFIX_APPLIED}!${USER_NAMESPACE}!${util.hex(recipient)}!${channel}!${type}`
const APPLIED_CHANNEL_KEY = (name) =>        `${PREFIX_APPLIED}!${CHANNEL_NAMESPACE}!${name}`
const APPLIED_POST_KEY = (postHash, type) => `${PREFIX_APPLIED}!${POSTS_NAMESPACE}!${util.hex(postHash)}!${type}`

const RELEVANT_USER_KEY = (p, recipient, channel, type) =>           `${PREFIX_RELEVANT}!${USER_NAMESPACE}!${util.hex(p.publicKey)}!${util.hex(recipient)}!${channel}!${type}`
const RELEVANT_CHANNEL_KEY = (p, name) =>        `${PREFIX_RELEVANT}!${CHANNEL_NAMESPACE}!${util.hex(p.publicKey)}!${name}`
const RELEVANT_POST_KEY = (p, postHash, type) => `${PREFIX_RELEVANT}!${POSTS_NAMESPACE}!${util.hex(p.publicKey)}!${util.hex(postHash)}!${type}`

// indexes `PREFIX_RELEVANT` by timestamp
const TIME_KEY = (time, context) => `${PREFIX_TIME_INDEX}!${monotonicTimestamp(time)}!${context}`

// store values as a combination of posthash (of the mod action), author pubkey, and timestamp. that way we don't need to query any other
// index to figure out what to do in the various situations of determining the relevancy and precedence
const assembleValue = (p) => `${util.hex(p.postHash)}!${util.hex(p.publicKey)}!${p.timestamp}`
function splitValue(val) {
  const [postHash, publicKey, ts] = val.split("!")
  return {
    postHash,
    publicKey,
    timestamp: parseInt(ts)
  }
}

// determine which of the two values is the latest. returns true if the incoming value is newer than the previous value
function determineLatest (previous, incoming, fn) {
  // fn is unused for determineLatest, but used for determineApplied (which has the same signature).
  // greatest timestamp wins. an incoming action breaks a tie and is preferentially applied
  // TODO (2024-02-12): use links instead to break ties?
  if (incoming.timestamp >= previous.timestamp) {
    return true
  }
  return false
}

// determine which of the two values should be applied. returns true if the incoming value should be applied, false otherwise
function determineApplied (previous, incoming, getLocalKey) {
  const localKeyHex = util.hex(getLocalKey())
  // local precedence
  const prevKeyHex = util.hex(previous.publicKey)
  const incKeyHex = util.hex(incoming.publicKey)
  if (prevKeyHex !== localKeyHex && incKeyHex === localKeyHex) {
    return true
  }
  if (prevKeyHex === localKeyHex && incKeyHex !== localKeyHex) {
    return false
  }
  return determineLatest(previous, incoming)
}

// events.emit("apply-action", { post })
// events.emit("delete-irrelevant", { hash })

// "isApplicable" signals that it is an action that should be regarded applicable (e.g. came from a moderation
// authority whose authority in regards to this action-in-time was valid, or did not *target* a moderation authority)

function pushUser(entries, post, type) {
  // TODO (2024-02-20): since block doesn't have a channel (it is for the entire cabal) we stuff the cabal-context
  // sentinel value into its place
  //
  // but how does this affect querying (if at all) later on?
  //
  // for sync purposes we should probably just keep blocks entirely separate, as we always want to return all blocks
  let channel = post.channel ? post.channel : constants.CABAL_CONTEXT
  for (const recipient of post.recipients) {
    if (post.isApplicable) {
      entries.push({ key: APPLIED_USER_KEY(recipient, channel, type), value: post.postHash })
    }
    const relevantKey = RELEVANT_USER_KEY(post, recipient, channel, type)
    entries.push({ key: relevantKey, value: post.postHash })
    entries.push({ key: TIME_KEY(post.timestamp, channel), value: relevantKey })
  }
}

function pushChannel(entries, post, type) {
  if (post.isApplicable) {
    entries.push({ key: APPLIED_CHANNEL_KEY(post.channel), value: post.postHash })
  }
  const relevantKey = RELEVANT_CHANNEL_KEY(post, post.channel)
  entries.push({ key: relevantKey, value: post.postHash })
  entries.push({ key: TIME_KEY(post.timestamp, post.channel), value: relevantKey })
}

function pushPost(entries, post, type) {
  for (const recipient of post.recipients) {
    if (post.isApplicable) {
      entries.push({ key: APPLIED_POST_KEY(recipient, type), value: post.postHash })
    }
    const relevantKey = RELEVANT_POST_KEY(post, recipient, type)
    entries.push({ key: relevantKey, value: post.postHash })
    entries.push({ key: TIME_KEY(post.timestamp, post.channel), value: relevantKey })
  }
}

const BLOCK_GROUP = 1
const HIDE_GROUP = 2
const DROP_GROUP = 3

function getComparator(key) {
  let comparisonFn
  const namespace = key.split("!")[0]
  switch (namespace) {
    case PREFIX_APPLIED:
      comparisonFn = determineApplied
      break
    case PREFIX_RELEVANT:
      comparisonFn = determineLatest
      break
    case PREFIX_TIME_INDEX:
      // doesn't matter, all keys should be unique and we will have hit `continue` above in that case
      comparisonFn = () => { return true }
      break
    default: 
      // should never happen: wreck havoc if it does so we can fix the cause
      return null
  }
  return comparisonFn
}

// takes a (sub)level instance
// getLocalKey() is a sync(?) function that returns the local user's public key, used for comparisons where we ensure
// local user precedence
module.exports = function (lvl, getLocalKey, /*, reverseIndex*/) {
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

  const conditionallyEmitApplyEvt = (key, post) => {
    switch (key.split("!")[0]) {
      case PREFIX_APPLIED:
        debug("emit apply-action %s", post.postHash)
        events.emit("apply-action", { post })
        break
    }
  }

  return {
    // TODO (2024-02-xx): * edit incoming post before calling .map() by adding a field "isApplicable: bool" i.e. authored by
    // one of our mod authorities and the time of authoring was after they'd acceded to the role
    map (posts, next) {
      debug("view.map")
      let seen = {}
      let ops = []
      let pending = 0
      unprocessedBatches++

      // we preprocess incoming posts into a map of arrays, each array identified by the key they intend to write to
      const keyedPosts = new Map()

      debug("incoming posts %O", posts)
      posts.forEach((post) => {
        const entries = []
        let droppingUser = false
        switch (post.action) {
          /* concerns user */
          case constants.ACTION_DROP_USER:
          case constants.ACTION_UNDROP_USER:
            droppingUser = true
          case constants.ACTION_BLOCK_USER:
          case constants.ACTION_UNBLOCK_USER:
            // check if a drop/undrop is occurring as well
            pushUser(entries, post, BLOCK_GROUP)
            if (droppingUser) {
              // if drop also occured we also push an additional entry to track
              pushUser(entries, post, DROP_GROUP)
            }
            break
          case constants.ACTION_HIDE_USER:
          case constants.ACTION_UNHIDE_USER:
            pushUser(entries, post, HIDE_GROUP)
            break
          /* concerns channel */
          case constants.ACTION_DROP_CHANNEL:
          case constants.ACTION_UNDROP_CHANNEL:
            pushChannel(entries, post, DROP_GROUP)
            break
          /* concerns posts */
          case constants.ACTION_HIDE_POST:
          case constants.ACTION_UNHIDE_POST:
            pushPost(entries, post, HIDE_GROUP)
            break
          case constants.ACTION_DROP_POST:
          case constants.ACTION_UNDROP_POST:
            pushPost(entries, post, DROP_GROUP)
          default:
        }

        entries.forEach(entry => {
          const key = entry.key
          if (!keyedPosts.has(key)) {
            keyedPosts.set(key, [])
          }
          let value = entry.value
          if (b4a.isBuffer(value) || !value.startsWith(PREFIX_RELEVANT)) {
            value = assembleValue(post)
          } else {
          }
          keyedPosts.get(key).push({ post, value })
        })
      })

      // convert keyedPosts from key:[arr of vals] to key:val
      for (const key of keyedPosts.keys()) {
        const arr = keyedPosts.get(key)
        if (arr.length === 1) {
          keyedPosts.set(key, arr[0])
          continue 
        }

        const comparisonFn = getComparator(key)
        const reducedValue = arr.reduce((acc, current) => {
          if (comparisonFn(acc.post, current.post, getLocalKey)) {
            return current
          }
          return acc
        })
        keyedPosts.set(key, reducedValue)
      }

      for (const [key, entry] of keyedPosts) {
        const post = entry.post
        const hash = post.postHash
        const value = entry.value
        pending++
        // no previously stored value -> no comparison required before writing to key
        lvl.get(key, (err, storedCompositeVal) => {
          if (err && err.notFound) {
            conditionallyEmitApplyEvt(key, post)
            debug("key '%s' was not found, putting record", key)
            ops.push({
              type: 'put',
              key,
              value
            })
          } else {
            const prev = splitValue(storedCompositeVal)
            const comparisonFn = getComparator(key)
            // comparator returns true if post was later/more relevant to store than the previously stored value -> 
            // in which case we overwrite the old val
            if (comparisonFn(prev, post, getLocalKey)) {
              debug("incoming post was more relevant than prev, storing")
              // let it be known that one of the incoming posts should be applied to the moderation system
              conditionallyEmitApplyEvt(key, post)

              // the queried key existed and it was of type PREFIX_RELEVANT. this implies we will have an obsolete entry
              // in table PREFIX_TIME_INDEX unless we do something, which is precisely what we take care of in the block
              // below - using the timestamp from the previously stored value indexed by PREFIX_RELEVANT to summon up
              // the corresponding time-indexed key in PREFIX_TIME_INDEX and then, finally, after verifying that it was indeed
              // the entry we sought, deleting it
              if (key.startsWith(PREFIX_RELEVANT)) {
                ++pending
                const targetTimestamp = parseInt(prev.timestamp)
                const iter = lvl.iterator({
                  reverse: true,
                  limit: 1,
                  gt: `${PREFIX_TIME_INDEX}!${targetTimestamp}!`,
                  lt: `${PREFIX_TIME_INDEX}!~`
                })
                iter.all().then(entries => {
                  if (key === entries[0][1]) {
                    ops.push({
                      type: "del",
                      key: entries[0][0] // remove the now-obsolete PREFIX_TIME_INDEX key
                    })
                  }
                  if (!--pending) done()
                })
                // the previously authored post by this author is now considered obsolete and we don't need to store it,
                // signal this fact outwards
                events.emit("remove-obsolete", { hash: prev.postHash })
              }
              ops.push({
                type: 'put',
                key,
                value
              })
            }
          }
          if (!--pending) done()
        })
      }

      if (!pending) done()

      function done () {
        // TODO (2024-02-08): perfrom one invocation of reverseIndex.map for each 'table'?
        // note: be careful when doing cleanup via a reverse index - we already signal in here that
        // we should remove from the blob-store posts considered obsolete. 
        //
        // we do not want to remove the *new* value stored at e.g. table relevant as a result
        //
        // const getHash = (p) => splitValue(p.value).postHash
        // const getKey = (p) => p.key
        // reverseIndex.map(reverseIndex.transformOps(viewName, getHash, getKey, ops))
        debug("ops %O", ops)
        debug("ops applied %O", ops.filter(op => op.key.startsWith(PREFIX_APPLIED)))
        debug("done. ops.length %d", ops.length)
        lvl.batch(ops, next)
        unprocessedBatches--
        ready()
      }
    },

    // TODO (2024-02-08): 
    // * support for deleting / dropping a hash and all the associated keys (basically turning on reverseIndex bits)
    api: {
      getAllApplied (cb) {
        ready(async function () {
          debug("api.getAllApplied")
          const iter = lvl.values({
            reverse: true,
            gt: `${PREFIX_APPLIED}!!`,
            lt: `${PREFIX_APPLIED}!~`
          })
          const values = await iter.all()
          const hashes = values.map(encoded => splitValue(encoded).postHash)
          const deduped = Array.from(new Set(hashes))
          cb(null, deduped) 
        })
      },
      getAllRelevantSince (tsSince, cb) {
        ready(async function () {
          debug("api.getAllRelevantSince")
          // we use "time!<context>!<ts>" to index "relevant!"-index keys by timestamp. 
          const iter = lvl.values({
            reverse: true,
            gt: `${PREFIX_TIME_INDEX}!${tsSince}!`,
            lt: `${PREFIX_TIME_INDEX}!~`
          })
          const values = await iter.all()
          const hashes = await lvl.getMany(values)
          // split out the hash values from the composite key, and run it through Set to make sure we only return unique
          // hashes
          const deduped = Array.from(new Set(hashes.map(encoded => splitValue(encoded).postHash)))
          cb(null, deduped)
        })
      },
      getRelevantbyContextsSince (tsSince, validContexts, cb) {
        ready(async function () {
          debug("api.getAllRelevantSince")
          // we use "time!<context>!<ts>" to index "relevant!"-index keys by timestamp. 
          //
          // the "time" table stores as value, not a post hash, but a key into table "relevant".
          // in map() above, we remove obsolete time entries from the table when "relevant" is updated 
          const iter = lvl.iterator({
            reverse: true,
            gt: `${PREFIX_TIME_INDEX}!${tsSince}!`,
            lt: `${PREFIX_TIME_INDEX}!~`
          })
          const contexts = new Set(validContexts)
          contexts.add(constants.CABAL_CONTEXT)
          const entries = await iter.all()
          // filter out the values that were not tagged with one of the contexts (channels) 
          // the function caller was interested in
          const values = entries.filter(e => {
            return contexts.has(e[0].split("!")[2])
          }).map(e => e[1])
          const hashes = await lvl.getMany(values)
          // split out the hash values from the composite key, and run it through Set to make 
          // sure we only return unique hashes
          const deduped = Array.from(new Set(hashes.map(encoded => splitValue(encoded).postHash)))
          cb(null, deduped)
        })
      },
      events: events
    }
  }
}
