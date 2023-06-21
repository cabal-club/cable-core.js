// node core dependencies
const EventEmitter = require('events').EventEmitter
// external dependencies
const b4a = require("b4a")
const storedebug = require("debug")("core/store")
const coredebug = require("debug")("core/")
const eventdebug = require("debug")("core/event-manager")
const livedebug = require("debug")("core/live")
// external database dependencies
const { Level } = require("level")
const { MemoryLevel } = require("memory-level")
// internal dependencies
const cable = require("../cable/index.js")
const crypto = require("../cable/cryptography.js")
const constants = require("../cable/constants.js")
const util = require("./util.js")
// materialized views and indices
const createDatastore = require("./data-store.js")
const createChannelStateView = require("./channel-state.js")
const createChannelMembershipView = require("./channel-membership.js")
const createTopicView = require("./topics.js")
const createUserInfoView = require("./user-info.js")
const createAuthorView = require("./author.js")
const createMessagesView = require("./messages.js")
const createDeletedView = require("./deleted.js")
const createReverseMapView = require("./reverse-hash-map.js")
const createLinksView = require("./links.js")
// aliases
const TEXT_POST = cable.TEXT_POST
const DELETE_POST = cable.DELETE_POST
const INFO_POST = cable.INFO_POST
const TOPIC_POST = cable.TOPIC_POST
const JOIN_POST = cable.JOIN_POST
const LEAVE_POST = cable.LEAVE_POST

// database interactions
class CableStore extends EventEmitter {
  // TODO (2023-02-23): ensure proper handling of duplicates in views that index hashes

  // TODO (2023-03-01): in all indexes, ensure that we never have any collisions with non-monotonic timestamps 

  // TODO (2023-03-01): do an error checking pass in all views, in particular the views that have async functions
  
  // TODO (2023-03-02): look over lexicographic sort with regard to keyspace layout in each view

  // TODO (2023-04-21): what shape should progressive history pruning take? how do we, for example, successively forget
  // posts to stay within a hard boundary of say persisting max 100k posts on disk?

  // TODO (2023-04-21): what should the mechanism look like which makes sure we have some post/info history (say keep
  // the last 2 posts) while making sure all others are continually scrubbed?

  // TODO (2023-04-21): restoring after a crash needs to be implemented. attempt an idea which acts as a companion index
  // to reverseHashMap and the data store. if posts are in data store, but not fully indexed in all other views, they
  // should remain in this companion index. once a post has been fully indexed, it is removed from the companion index
  // (which acts as a sentinel of sorts)

  // TODO (2023-04-21): should we forget about users (wrt channel-state) if they have left a channel and we no longer
  // persist any of their messages in said channel? the core concern is that channel state request requires sending the
  // latest post/info of **ex-members** which means that over time responses to a channel-state request will just grow
  // and grow in size
  constructor(opts) {
    super()

    if (!opts) { opts = { temp: true } }

    this._db = new Level("data")
    if (opts.temp) {
      this._db = new MemoryLevel("data")
    }

    // reverseMapView maps which views have stored a particular hash. using this view we can removes those entries in
    // other views if needed e.g.  when a delete happens, when a peer has been blocked and their contents removed, or we are truncating the local database to save space
    // note: this view is used by many of the other views which only stores a cable post hash, so it must be initialized
    // before other views
    this.reverseMapView = createReverseMapView(this._db.sublevel("reverse-hash-map", { valueEncoding: "json" }))

    // this.blobs stores binary representations of message payloads by their hashes
    this.blobs = createDatastore(this._db.sublevel("data-store", { valueEncoding: "binary" }), this.reverseMapView)
    this.channelStateView = createChannelStateView(this._db.sublevel("channel-state", { valueEncoding: "binary" }), this.reverseMapView)
    this.channelMembershipView = createChannelMembershipView(this._db.sublevel("channel-membership", { valueEncoding: "json" }))
    this.topicView = createTopicView(this._db.sublevel("topics", { valueEncoding: "json" }))
    this.userInfoView = createUserInfoView(this._db.sublevel("user-info", { valueEncoding: "binary" }), this.reverseMapView)
    this.authorView = createAuthorView(this._db.sublevel("author", { valueEncoding: "binary" }), this.reverseMapView)
    this.messagesView = createMessagesView(this._db.sublevel("messages", { valueEncoding: "binary" }), this.reverseMapView)
    this.deletedView = createDeletedView(this._db.sublevel("deleted", { valueEncoding: "binary" }))
    this.linksView = createLinksView(this._db.sublevel("links", { valueEncoding: "json" }))

    // used primarily when processing an accepted delete request to delete entries in other views with the results from a reverse hash map query.
    // however all views have been added to this map for sake of completeness
    this._viewsMap = {
      "reverse-hash-map": this.reverseMapView,
      "data-store": this.blobs,
      "channel-state": this.channelStateView,
      "channel-membership": this.channelMembershipView,
      "user-info": this.userInfoView,
      "author": this.authorView,
      "messages": this.messagesView,
      "deleted": this.deletedView,
      "links": this.linksView,
    }
  }

  _storeNewPost(buf, hash, done) {
    let promises = []
    let p
    // store each new post by associating its hash to the binary post payload
    p = new Promise((res, rej) => {
      this.blobs.map([{hash, buf}], (err) => {
        if (err !== null) {
          storedebug("blobs (error: %o)", err) 
        } else {
          storedebug("blobs", err) 
        }
        res()
      })
    })
    promises.push(p)
    const obj = cable.parsePost(buf)

    // index posts made by author's public key and type of post
    p = new Promise((res, rej) => {
      this.authorView.map([{...obj, hash}], (err) => {
        if (err !== null) {
          storedebug("author (error: %o)", err) 
        } else {
          storedebug("author") 
        }
        res()
      })
    })
    promises.push(p)

    // index links information for the post: which links it has (if any), and reverse map those links as well to the
    // hash of this post
    p = new Promise((res, rej) => {
      this.linksView.map([{links: obj.links, hash}], (err) => {
        if (err) { 
          storedebug("storeNewPosts:links - error %O", err) 
        } else {
          storedebug("storeNewPosts:links") 
        }
        res()
      })
    })
    promises.push(p)

    Promise.all(promises).then(done)
  }

  // storage methods
  // function `done` implements a kind of synching mechanism for each storage method, such that a collection of
  // promises can be assembled, with a Promise.all(done) firing when all <view>.map invocations have finished processing
  // indexing operations

  join(buf, done) {
    if (!done) { done = util.noop }
    let promises = []
    let p

    const hash = crypto.hash(buf)
    const obj = JOIN_POST.toJSON(buf)

    p = new Promise((res, rej) => {
      this._storeNewPost(buf, hash, res)
    })
    promises.push(p)

    p = new Promise((res, rej) => {
      this.channelStateView.map([{ ...obj, hash}], res)
    })
    promises.push(p)

    p = new Promise((res, rej) => {
      this.channelMembershipView.map([obj], res)
    })
    promises.push(p)

    Promise.all(promises).then(() => {
      this._emitStoredPost(hash, buf, obj.channel)
      done()
    })
  }

  leave(buf, done) {
    if (!done) { done = util.noop }
    let promises = []
    let p

    const hash = crypto.hash(buf)
    const obj = LEAVE_POST.toJSON(buf)
    
    p = new Promise((res, rej) => {
      this._storeNewPost(buf, hash, res)
    })
    promises.push(p)

    p = new Promise((res, rej) => {
      this.channelStateView.map([{ ...obj, hash}], res)
    })
    promises.push(p)

    p = new Promise((res, rej) => {
      this.channelMembershipView.map([obj], res)
    })
    promises.push(p)

    Promise.all(promises).then(() => {
      this._emitStoredPost(hash, buf, obj.channel)
      done()
    })
  }

  del(buf, done) {
    if (!done) { done = util.noop }

    // the hash of the post/delete message
    const hash = crypto.hash(buf)
    // note: obj.hash is hash of the deleted post (not of the post/delete!)
    const obj = DELETE_POST.toJSON(buf)
    
    // persist the post/delete buffer
    const prom = new Promise((res, rej) => {
      this._storeNewPost(buf, hash, res)
    })

    prom.then(() => {
      let processed = 0
      // create a self-contained loop of deletions, where each related batch of deletions is performed in unison
      obj.hashes.forEach(hashToDelete => {
        deleteHash(hashToDelete, () => {
          processed++
          // signal done when all hashes to delete have been processed
          if (processed >= obj.hashes.length) {
            done()
          }
        })
      })
    })

    const deleteHash = (hashToDelete, finished) => {
      const promises = []
      let p
      this.blobs.api.get(hashToDelete, async (err, retrievedBuf) => {
        if (err) {
          storedebug("delete err'd", err)
          return finished()
        }
        const post = cable.parsePost(retrievedBuf)
        storedebug("post to delete %O", post)
        let channels = []
        
        // TODO (2023-04-21): write a test to verify the following behaviour:
        // 1. set a post/info
        // 2. set another post/info
        // 3. join 2-3 channels
        // 4. delete the latest post/info
        // 5. name should be regarded as updated to the first post/info name in all joined channels
        //
        // post/info is the only post type (as of 2023-04) that does not record channel information, and we need to know
        // which channels in which to record a delete. we can get this info by querying the channel membership view for
        // the publicKey that deleted a post/info, which returns the channels they have belonged to (incl current
        // membership)
        if (post.postType === constants.INFO_POST) {
          const channelProm = new Promise((channelRes, channelRej) => {
            this.channelMembershipView.api.getHistoricMembership(post.publicKey, (err, channels) => {
              if (err) {
                storedebug("deleteHash err'd during getHistoricMembership", err)
              }
              channelRes(channels)
            })
          })
          channels = await channelProm
        } else {
          channels = [post.channel]
        }
        const affectedPublicKey = post.publicKey
        // record the post/delete in the messages view for each relevant channel
        channels.forEach(channel => {
          p = new Promise((res, rej) => {
            this.messagesView.map([{ ...obj, channel, hash}], res)
          })
          promises.push(p)
        })

        // delete the targeted post in the data store using obj.hash
        p = new Promise((res, rej) => {
          this.blobs.api.del(hashToDelete, res)
        })
        promises.push(p)

        // record hash of deleted post in deletedView
        p = new Promise((res, rej) => {
          this.deletedView.map([hashToDelete], res)
        })
        promises.push(p)

        // remove hash from indices that reference it
        this.reverseMapView.api.getUses(hashToDelete, (err, uses) => {
          // go through each index and delete the entry referencing this hash
          for (let [viewName, viewKeys] of uses) {
            viewKeys.forEach(key => {
              storedebug("delete %s in %s", key, viewName)
              this._viewsMap[viewName].api.del(key)
            })
          }
          // finally, remove the related entries in the reverse hash map
          this.reverseMapView.api.del(hashToDelete)

          // when reindexing finishes, this function receives the new latest post hash and emits it to comply with
          // correct live query behaviour wrt channel state request's `future` flag. what to do with the emitted data
          // is handled by event consumers (e.g. CableCore)
          const hashReceiver = (res) => {
            if (res) {
              // emit hash to signal reindex returned a new latest hash for channel after deleting the prior latest
              this.emit("channel-state-replacement", { postType: res.postType, channel: res.channel, hash: res.hash })
            }
          }

          // reindex accreted views if they were likely to be impacted e.g. reindex channel topic view if channel topic
          // was deleted
          // note: if what was deleted was a post/info that necessitates updating all channels that identity is or has been a member of
          channels.forEach(channel => {
            p = new Promise((res, rej) => {
              switch (post.postType) {
                case constants.JOIN_POST:
                case constants.LEAVE_POST:
                  this._reindexChannelMembership(channel, affectedPublicKey, hashReceiver, res)
                  break
                case constants.INFO_POST:
                  this._reindexInfoName(channel, affectedPublicKey, hashReceiver, res)
                  break
                case constants.TOPIC_POST:
                  this._reindexTopic(channel, hashReceiver, res)
                  break
                default:
                  res()
              }
            })
            promises.push(p)
          })
          Promise.all(promises).then(() => {
            // finally: emit 'store-post' event for the post/delete that were stored, one per relevant channel
            channels.forEach(channel => {
              this._emitStoredPost(hash, buf, channel)
            })
            finished()
          })
        })
      })
    }
  }

  // reindex an accreted view by re-putting a cablegram using its hash 
  _reindexHash (hash, mappingFunction, done) {
    storedebug("reindexHash %O", hash)
    this.blobs.api.get(hash, (err, buf) => {
      if (err) { 
        storedebug("reindexHash could not find hash %O, returning early", hash)
        return done() 
      }
      storedebug("reindex with hash - blobs: err %O buf %O", err, buf)
      const obj = cable.parsePost(buf)
      mappingFunction([obj], done)
    })
  }

  _reindexInfoName (channel, publicKey, sendHash, done) {
    this.channelStateView.api.getLatestNameHash(channel, publicKey, (err, hash) => {
      storedebug("latest name err", err)
      storedebug("latest name hash", hash)
      if (err && err.notFound) {
        this.userInfoView.api.clearName(publicKey)
        sendHash(null)
        return done()
      }
      this._reindexHash(hash, this.userInfoView.map, done)
      sendHash({channel, hash, postType: constants.INFO_POST})
    })
  }

  _reindexTopic (channel, sendHash, done) {
    this.channelStateView.api.getLatestTopicHash(channel, (err, hash) => {
      storedebug("latest topic err", err)
      storedebug("latest topic hash", hash)
      if (err && err.notFound) {
        this.topicView.api.clearTopic(channel)
        sendHash(null)
        return done()
      }
      this._reindexHash(hash, this.topicView.map, done)
      sendHash({channel, hash, postType: constants.TOPIC_POST })
    })
  }

  _reindexChannelMembership (channel, publicKey, sendHash, done) {
    storedebug("reindex channel membership in %s for %s", channel, publicKey.toString("hex"))
    this.channelStateView.api.getLatestMembershipHash(channel, publicKey, (err, hash) => {
      storedebug("membership hash %O err %O", hash, err)
      // the only membership record for the given channel was deleted: clear membership information regarding channel
      if (!hash || (err && err.notFound)) {
        this.channelMembershipView.api.clearMembership(channel, publicKey)
        sendHash(null)
        return done()
      }
      // we had prior membership information for channel, get the post and update the index
      this._reindexHash(hash, this.channelMembershipView.map, done)
      // look up the post by its hash get the exact post type. this doesn't really matter when responding to a live
      // channel state request, since we just care if it was either a JOIN_POST or LEAVE_POST, but it's good to be
      // correct in case this sees unexpected use somewhere else down the line
      this.blobs.api.get((err, buf) => {
        if (err || !buf) { 
          storedebug("reindex channel membership: could not get post associated with hash %O, returning early (err %O)", hash, err)
          return 
        }
        const obj = cable.parsePost(buf)
        sendHash({channel, hash, postType: obj.postType })
      })
    })
  }

  topic(buf, done) {
    if (!done) { done = util.noop }
    const promises = []
    let p

    const hash = crypto.hash(buf)
    const obj = TOPIC_POST.toJSON(buf)

    p = new Promise((res, rej) => {
      this._storeNewPost(buf, hash, res)
    })
    promises.push(p)
    
    p = new Promise((res, rej) => {
      this.channelStateView.map([{ ...obj, hash}], res)
    })
    promises.push(p)

    p = new Promise((res, rej) => {
      this.topicView.map([obj], res)
    })
    promises.push(p)

    // handle implicit channel membership behaviour (posting to a channel one is not a member of)
    p = new Promise((res, rej) => {
      // check if pubkey is a member of said channel
      this.channelMembershipView.api.isInChannel(obj.channel, obj.publicKey, (err, isChannelMember) => {
        // if not a member, and they posted a post/topic, register that as an intent to join that channel as a member
        if (!err && !isChannelMember) {
          this.channelMembershipView.map([obj], res)
          return
        }
        res()
      })
    })
    promises.push(p)

    Promise.all(promises).then(() => {
      this._emitStoredPost(hash, buf, obj.channel)
      done()
    })
  }

  text(buf, done) {
    if (!done) { done = util.noop }
    const promises = []
    let p

    const hash = crypto.hash(buf)
    const obj = TEXT_POST.toJSON(buf)
    
    p = new Promise((res, rej) => {
      this._storeNewPost(buf, hash, res)
    })
    promises.push(p)
    
    p = new Promise((res, rej) => {
      this.messagesView.map([{ ...obj, hash}], res)
    })
    promises.push(p)

    // handle implicit channel membership behaviour (posting to a channel one is not a member of)
    p = new Promise((res, rej) => {
      this.channelMembershipView.api.isInChannel(obj.channel, obj.publicKey, (err, isChannelMember) => {
        // if not a member, and they posted a post/text, register that as an intent to join that channel as a member
        if (!err && !isChannelMember) {
          this.channelMembershipView.map([obj], res)
          return
        }
        res()
      })
    })
    promises.push(p)

    Promise.all(promises).then(() => {
      this._emitStoredPost(hash, buf, obj.channel)
      done()
    })
  }


  info(buf, done) {
    if (!done) { done = util.noop }
    const promises = []
    let p

    const hash = crypto.hash(buf)
    const obj = INFO_POST.toJSON(buf)

    p = new Promise((res, rej) => {
      this._storeNewPost(buf, hash, res)
    })
    promises.push(p)
    
    p = new Promise((res, rej) => {
      this.userInfoView.map([{ ...obj, hash}], res)
    })
    promises.push(p)
    // channel state view keeps track of info posts that set the name
    if (obj.key === "name") {
      // if we're setting a post/info:name via core.setNick() we are not passed a channel. so to do
      // this correctly, for how the channel state index looks like right now, we need to get a list of channels that the
      // user is in and post the update to each of those channels
      this.channelMembershipView.api.getHistoricMembership(obj.publicKey, (err, channels) => {
        const channelStateMessages = []
        channels.forEach(channel => {
          storedebug("info: each channel %s", channel)
          channelStateMessages.push({...obj, hash, channel})
        })
        storedebug(channelStateMessages)
        p = new Promise((res, rej) => {
          this.channelStateView.map(channelStateMessages, res)
        })
        promises.push(p)
      
        // emit 'store-post' for each channel indexes have been confirmed to be updated
        Promise.all(promises).then(() => {
          channels.forEach(channel => {
            this._emitStoredPost(hash, buf, channel)
          })
          done()
        })
      })
    }
  }

  _emitStoredPost(hash, buf, channel) {
    const obj = cable.parsePost(buf)
    if (channel) {
      this.emit("store-post", { hash, timestamp: obj.timestamp, channel, postType: obj.postType })
    } else { // probably a post/info, which has no channel membership information
      this.emit("store-post", { hash, timestamp: obj.timestamp, channel: null, postType: obj.postType })
    }
  }

  // get data by list of hashes
  getData(hashes, cb) {
    this.blobs.api.getMany(hashes, cb)
  }
  // get hashes by channel name + channel time range
  getChannelTimeRange(channel, start, end, limit, cb) {
    this.messagesView.api.getChannelTimeRange(channel, start, end, limit, cb)
  }
  getTopic(channel, cb) {
    this.topicView.api.getTopic(channel, cb)
  }
}

// an abstraction that keeps track of all event listeners. reasoning behind it is that event listeners have historically been:
// 1. many in cabal pursuits
// 2. hard to keep track of, track down, and manage correctly (a source of leaks)
class EventsManager {
  // TODO (2023-04-24): return a singleton instance?
  
  constructor (opts) {
    if (!opts) { opts = {} }
    // stores the following:
    // this.sources["store:<event>"] = { listener: eventListener, source: eventSource, eventName: eventName }
    this.sources = new Map()
  }

  _id(className, eventName) {
    return `${className}:${eventName}`
  }

  // register() argument example:
  //
  //                  {v eventSource}                          {v eventListener     }
  // register("store", this.store, "channel-state-replacement", () => {/* do stuff */})
  //         {^ className}        {^ eventName               }
  //
  register(className, eventSource, eventName, eventListener) {
    const id = this._id(className, eventName)
    if (this.sources.has(id)) { return }
    eventdebug("register new listener %s", id)
    this.sources.set(id, { source: eventSource, listener: eventListener })
    eventSource.on(eventName, eventListener)
  }

  // removes all event listeners registered on className
  deregisterAll(className) {
    eventdebug("deregister all events on %s", className)
    const subset = []
    for (const key of this.sources.keys()) {
      if (key.startsWith(className)) {
        subset.push(key)
      }
    }

    subset.forEach(id => {
      const index = id.indexOf(":")
      const className = id.slice(0, index)
      const eventName = id.slice(index+1)
      this.deregister(className, eventName)
    })
  }

  deregister(className, eventName) {
    const id = this._id(className, eventName)
    if (!this.sources.has(id)) { return }
    const { source, listener } = this.sources.get(id)
    eventdebug("deregister listener %s", id)
    source.removeEventListener(eventName, listener)
    this.sources.delete(id)
  }
}

class CableCore extends EventEmitter {
  constructor(opts) {
    super()
    if (!opts) { opts = {} }
    if (!opts.storage) {}
    if (!opts.network) {}
    // assert if we are passed a keypair while starting lib and if format is correct (if not we generate a new kp)
    const validKeypair = (
      opts.kp && opts.kp.publicKey && opts.kp.secretKey && 
      b4a.isBuffer(opts.kp.publicKey) && 
      opts.kp.publicKey.length === constants.PUBLICKEY_SIZE && 
      b4a.isBuffer(opts.kp.secretKey) && 
      opts.kp.secretKey.length === constants.SECRETKEY_SIZE
    )
    if (validKeypair) {
      this.kp = opts.kp
      coredebug("using opts.kp as keypair")
    } else {
      this.kp = crypto.generateKeypair()
      coredebug("generated new keypair")
    }

    this.events = new EventsManager()

    this.store = new CableStore()
    /* used as: 
     * store a join message:
     * store.join(buf) 
    */

    // keeps tracks of each set of head per channel (or context in case of posts w/o channel info)
    this.heads = new Map() 
    this.store.linksView.api.getAllKnownHeads((err, headsMap) => {
      if (err) {
        coredebug("experienced an error getting known heads: %O", err)
        return
      }
      this.heads = headsMap
    })
    // tracks still ongoing requests 
    this.requestsMap = new Map()
    // tracks which hashes we have explicitly requested in a 'request for hash' request
    this.requestedHashes = new Map()
    // tracks "live" requests: requests that have asked for future posts, as they are produced
    this.liveQueries = new Map()
    // expedient way to go from a reqid to the relevant channel name
    this.liveQueries.set("reqid-to-channels", new Map())
    this._defaultTTL = 0

    this.events.register("store", this.store, "channel-state-replacement", ({ channel, postType, hash }) => {
      livedebug("channel-state-replacement evt (channel: %s, postType %i, hash %O)", channel, postType, hash)
      // set timestamp to -1 because we don't have it when producing a channel-state-replacement, 
      // and timestamp only matters for correctly sending hash responses for channel time range requests 
      // (i.e. not applicable for channel state requests)
      this._sendLiveHashResponse(channel, postType, [hash], -1)
    })

    this.events.register("store", this.store, "store-post", ({ channel, timestamp, hash, postType }) => {
      livedebug("store post evt, post type: %i", postType)
      this._sendLiveHashResponse(channel, postType, [hash], timestamp)
    })

    this.events.register("core", this, "live-request-ended", (reqidHex) => {
      livedebug("live query concluded for %s", reqidHex)
      this._sendConcludingHashResponse(b4a.from(reqidHex, "hex"))
    })

    this.swarm = null // i.e. the network of connections with other cab[a]l[e] peers

    /* event sources */
    this.posts = null// n.b. in original cabal-core the name for this was `this.messages`
    // posts events:
    //  add - emit(channel, post, hash)
    //  remove - emit(channel, hash)
    this.channels = null
    // channels events:
    //  add - emit(channel)
    //  join - emit(channel, pubkey)
    //  leave - emit(channel, pubkey)
    //  topic - emit(channel, topic)
    //  archive - emit(channel)
    this.network = null
    // network events:
    //  connection 
    //  join - emit(peer)
    //  leave - emit(peer)
  }

  // this function is part of "live query" behaviour of the channel state request (when future = 1) 
  // and the channel time range request (when timeEnd = 0)
  // note: `timestamp` === -1 if event channel-state-replacement called this function (the timestamp only matters for
  // channel time range request, which will always set it)
  _sendLiveHashResponse(channel, postType, hashes, timestamp) {
    const reqidList = this._getLiveRequests(channel)
    reqidList.forEach(reqid => {
      const requestInfo = this.requestsMap.get(reqid.toString("hex"))
      const reqType = requestInfo.obj.msgType
      if (reqType === constants.CHANNEL_STATE_REQUEST) {
        // channel state request only sends hash responses for:
        // post/topic
        // post/info
        // post/join
        // post/leave
        switch (postType) {
          case constants.TOPIC_POST:
          case constants.INFO_POST:
          case constants.JOIN_POST:
          case constants.LEAVE_POST:
            // we want to continue in these cases
            break
          default: 
            // the post that was emitted wasn't relevant for request type; skip
            return
        }
      } else if (reqType === constants.TIME_RANGE_REQUEST) {
        // channel time range request only sends hash responses for:
        // post/text
        // post/delete
        switch (postType) {
          // we want to continue in these cases
          case constants.TEXT_POST:
          case constants.DELETE_POST:
            break
          default:
            // the post that was emitted wasn't relevant for request type; skip
            return
        }
        // the time start boundary set by the channel time range request 
        const timeStart = requestInfo.obj.timeStart
        // we only want to emit a live hash response if the stored post's timestamp >= timeStart; 
        // it wasn't, return early and avoid dispatching a response
        if (timestamp < timeStart) { return }
      } else {
        // no matches, skip to next loop
        return
      }
      const response = cable.HASH_RESPONSE.create(reqid, hashes)
      this.dispatchResponse(response)
      this._updateLiveStateRequest(channel, reqid, hashes.length)
      livedebug("dispatch response %O", response)
    })
  }

  _sendConcludingHashResponse (reqid) {
    // a concluding hash response is a signal to others that we've finished with this request, and regard it as ended on
    // our side
    const response = cable.HASH_RESPONSE.create(reqid, [])
    coredebug("send concluding hash response for %O", reqid)
    this.dispatchResponse(response)
    this._removeRequest(reqid)
  }

  hash (buf) {
    if (b4a.isBuffer(buf)) {
      return crypto.hash(buf)
    }
    return null
  }

  // get the latest links for the given context. with `links` peers have a way to partially order message history
  // without relying on claimed timestamps
  _links(channel) {
    if (!channel) {
      coredebug("_links() called without channel info - what context do we use?")
      return []
    }
    if (this.heads.has(channel)) {
      return this.heads.get(channel)
    }
    // no links -> return an empty array
    return []
  }

  /* methods that produce cablegrams, and which we store in our database */
	// post/text
	postText(channel, text, done) {
    if (!done) { done = util.noop }
    const links = this._links(channel)
    const buf = TEXT_POST.create(this.kp.publicKey, this.kp.secretKey, links, channel, util.timestamp(), text)
    const bufHash = this.hash(buf)
    this.store.text(buf, () => {
      // we're storing a new post we have *just* created -> we *know* this is our latest heads for the specified channel
      this.store.linksView.api.setNewHeads(channel, [bufHash], () => {
        // update the newest heads
        this.heads.set(channel, [bufHash])
        done()
      })
    })
    return buf
  }

	// post/info key=name
	setNick(name, done) {
    if (!done) { done = util.noop }
    // TODO (2023-06-11): decide what to do wrt context for post/info
    const links = this._links()
    const buf = INFO_POST.create(this.kp.publicKey, this.kp.secretKey, links, util.timestamp(), "name", name)
    this.store.info(buf, done)
    return buf
  }

	// post/topic
	setTopic(channel, topic, done) {
    if (!done) { done = util.noop }
    const links = this._links(channel)
    const buf = TOPIC_POST.create(this.kp.publicKey, this.kp.secretKey, links, channel, util.timestamp(), topic)
    const bufHash = this.hash(buf)
    this.store.topic(buf, () => {
      // we're storing a new post we have *just* created -> we *know* this is our latest heads for the specified channel
      this.store.linksView.api.setNewHeads(channel, [bufHash], () => {
        // update the newest heads
        this.heads.set(channel, [bufHash])
        done()
      })
    })
    return buf
  }

	// post/join
	join(channel, done) {
    if (!done) { done = util.noop }
    const links = this._links(channel)
    const buf = JOIN_POST.create(this.kp.publicKey, this.kp.secretKey, links, channel, util.timestamp())
    const bufHash = this.hash(buf)
    this.store.join(buf, () => {
      // we're storing a new post we have *just* created -> we *know* this is our latest heads for the specified channel
      this.store.linksView.api.setNewHeads(channel, [bufHash], () => {
        // update the newest heads
        this.heads.set(channel, [bufHash])
        done()
      })
    })
    return buf
  }

	// post/leave
	leave(channel, done) {
    if (!done) { done = util.noop }
    const links = this._links(channel)
    const buf = LEAVE_POST.create(this.kp.publicKey, this.kp.secretKey, links, channel, util.timestamp())
    const bufHash = this.hash(buf)
    this.store.leave(buf, () => {
      // we're storing a new post we have *just* created -> we *know* this is our latest heads for the specified channel
      this.store.linksView.api.setNewHeads(channel, [bufHash], () => {
        // update the newest heads
        this.heads.set(channel, [bufHash])
        done()
      })
    })
    return buf
  }

	// post/delete
  // note: we store the deleted hash to keep track of hashes we don't want to sync.  
  // we also store which channel the post was in, to fulfill channel state requests
  // 
  // q: should we have a flag that is like `persistDelete: true`? enables for deleting for storage reasons, but not
  // blocking reasons. otherwise all deletes are permanent and not reversible
	del(hash, done) {
    if (!done) { done = util.noop }
    // TODO (2023-06-11): decide what do with links for post/delete (lacking channel info)
    const links = this._links()
    // TODO (2023-04-12): create additional api for deleting many hashes
    const buf = DELETE_POST.create(this.kp.publicKey, this.kp.secretKey, links, util.timestamp(), [hash])
    this.store.del(buf, done)
    return buf
  }

  /* methods to get data we already have locally */
  getChat(channel, start, end, limit, cb) {
    coredebug(channel, start, end, limit, cb)
    // TODO (2023-03-07): future work here to augment with links-based retrieval & causal sort
    this.store.getChannelTimeRange(channel, start, end, limit, (err, hashes) => {
      if (err) { return cb(err) }
      this.resolveHashes(hashes, cb)
    })
  }

  // gets the local user's most recently set nickname
  getNick(cb) {
    this.store.userInfoView.api.getLatestNameHash(this.kp.publicKey, (err, hash) => {
      if (err) { return cb(err) }
      this.resolveHashes([hash], (err, results) => {
        if (err) { return cb(err) }
        const obj = results[0]
        cb(null, obj.value)
      })
    })
  }

  // gets the string topic of a particular channel
  getTopic(channel, cb) {
    this.store.getTopic(channel, cb)
  }

  // returns a list of channel names, sorted lexicographically
  getChannels(cb) {
    this.store.channelMembershipView.api.getChannelNames(0, 0, (err, channels) => {
      cb(err, channels)
    })
  }

  // returns a list of channel names the user has joined, sorted lexicographically
  getJoinedChannels(cb) {
    this.store.channelMembershipView.api.getJoinedChannels(this.kp.publicKey, (err, channels) => {
      cb(err, channels)
    })
  }

  // returns a Map mapping user public key (as a hex string) to their current nickname. if they don't have a nickname
  // set, what is returned is the hex-encoded public key
  getUsers(cb) {
    if (!cb) { return }
    coredebug("get users")
    this.store.authorView.api.getUniquePublicKeys((err, publicKeys) => {
      coredebug("err %O", err)
      coredebug("public keys %O", publicKeys)
      const users = new Map()
      // set name equivalent to be hex of public key initially
      publicKeys.forEach(publicKey => {
        const hex = publicKey.toString("hex") 
        users.set(hex, hex)
      })
      this.store.userInfoView.api.getLatestNameHashesAllUsers((err, latestNameHashes) => {
        if (err) return cb(err)
        coredebug(latestNameHashes)
        this.resolveHashes(latestNameHashes, (err, posts) => {
          posts.forEach(post => {
            if (post.postType !== constants.INFO_POST) { return }
            if (post.key !== "name") { throw new Error("core:getUsers - expected name hash") }
            // public key had a post/info:name -> use it
            users.set(post.publicKey.toString("hex"), post.value)
          })
          cb(null, users)
        })
      })
    })
  }

  getUsersInChannel(channel, cb) {
    if (!cb) { return }
    // first get the pubkeys currently in channel
    this.store.channelMembershipView.api.getUsersInChannel(channel, (err, pubkeys) => {
      if (err) return cb(err)
      coredebug(pubkeys)
      const channelUsers = new Map()
      // filter all known users down to only users in the queried channel
      this.getUsers((err, users) => {
        users.forEach((value, key) => {
          if (pubkeys.includes(key)) {
            channelUsers.set(key, value)
          }
        })
        cb(null, channelUsers)
      })
    })
  }

  // resolves hashes into post objects
  resolveHashes(hashes, cb) {
    coredebug("the hashes", hashes)
    this.getData(hashes, (err, bufs) => {
      const posts = []
      bufs.forEach(buf => {
        if (buf !== null) { 
          posts.push(cable.parsePost(buf)) 
        } else {
          posts.push(null)
        }
      })
      cb(null, posts)
    })
  }

  getData(hashes, cb) {
    this.store.blobs.api.getMany(hashes, (err, bufs) => {
      if (err) { return cb(err) }
      coredebug("getData bufs %O", bufs)
      const posts = []
      bufs.forEach(buf => {
        if (typeof buf === "undefined") {
          posts.push(null)
          return
        }
        posts.push(buf)
      })
      cb(null, posts)
    })
  }

  getChannelState(channel, cb) {
    // resolve the hashes into cable posts and return them
    this.getChannelStateHashes(channel, (err, hashes) => {
      if (err) { return cb(err) }
      this.resolveHashes(hashes, cb)
    })
  }

  getChannelStateHashes(channel, cb) {
    // get historic membership of channel
    this.store.channelMembershipView.api.getHistoricUsers(channel, (err, pubkeys) => {
      // get the latest nickname for each user that has been a member of channel
      const namePromise = new Promise((res, reject) => {
        this.store.userInfoView.api.getLatestNameHashMany(pubkeys, (err, nameHashes) => {
          if (err) return reject(err)
          res(nameHashes)
        })
      })
      // get the latest state hashes of the channel
      const statePromise = new Promise((res, reject) => {
        this.store.channelStateView.api.getLatestState(channel, (err, hashes) => {
          if (err) return reject(err)
          res(hashes)
        })
      })

      // resolve promises to get at the hashes
      Promise.all([namePromise, statePromise]).then(results => {
        // collapse results into a single array, deduplicate via set and get the list of hashes
        const hashes = Array.from(new Set(results.flatMap(item => item)))
        coredebug("all hashes %O", hashes)
        cb(null, hashes)
      })
    })
  }

  /* methods that control requests to peers, causing responses to stream in (or stop) */
	// cancel request
	cancelRequest(cancelid) {
    // the cancel id is the request to cancel (stop)
    const reqid = crypto.generateReqID()
    // set ttl to 0 as it's is unused in cancel req
    const req = cable.CANCEL_REQUEST.create(reqid, 0, cancelid)
    // signal to others to forget about the canceled request id
    this.dispatchRequest(req)
    this._removeRequest(cancelid)
    return req
  }

  _removeRequest(reqid) {
    const reqidHex = reqid.toString("hex")
    // cancel any potential ongoing live requests
    this._cancelLiveStateRequest(reqidHex)
    // forget the targeted request id locally
    this.requestsMap.delete(reqidHex)
  }
 
  // <-> getChannels
  requestChannels(ttl, offset, limit) {
    const reqid = crypto.generateReqID()
    const req = cable.CHANNEL_LIST_REQUEST.create(reqid, ttl, offset, limit)
    this.dispatchRequest(req)
    return req
  }

  // <-> getChat
  requestPosts(channel, start, end, ttl, limit) {
    const reqid = crypto.generateReqID()
    const req = cable.TIME_RANGE_REQUEST.create(reqid, ttl, channel, start, end, limit)
    this.dispatchRequest(req)
    return req
  }

  // -> request post/topic, post/join, post/leave, post/info
  requestState(channel, ttl, future) {
    const reqid = crypto.generateReqID()
    const req = cable.CHANNEL_STATE_REQUEST.create(reqid, ttl, channel, future)
    this.dispatchRequest(req)
    return req
  }

  _reqEntryTemplate (obj) {
    const entry = {
      obj, // `obj` is the full JSON encoded cable message representing the request being mapped
      "resType": -1,
      "recipients": [],
      "origin": false
    }

    const reqType = obj.msgType
    switch (reqType) {
      case constants.POST_REQUEST:
        entry.resType = constants.POST_RESPONSE
        break
      case constants.CANCEL_REQUEST:
        break
      case constants.TIME_RANGE_REQUEST:
        entry.resType = constants.HASH_RESPONSE
        break
      case constants.CHANNEL_STATE_REQUEST:
        entry.resType = constants.HASH_RESPONSE
        break
      case constants.CHANNEL_LIST_REQUEST:
        entry.resType = constants.CHANNEL_LIST_RESPONSE
        break
      default:
        throw new Error(`make request: unknown reqType (${reqType})`)
    }
    return entry
  }


  _registerRequest(reqid, origin, type, obj) {
    if (this.requestsMap.has(reqid)) {
      coredebug(`request map already had reqid %O`, reqid)
      return
    }
    // TODO (2023-03-23): handle recipients at some point
    // entry.recipients.push(peer)
    const entry = this._reqEntryTemplate(obj)
    entry.origin = origin
    this.requestsMap.set(reqid.toString("hex"), entry)
  }

  // register a request that is originating from the local node, sets origin to true
  _registerLocalRequest(reqid, reqType, buf) {
    const obj = cable.parseMessage(buf)
    this._registerRequest(reqid, true, reqType, obj)
  }

  // register a request that originates from a remote node, sets origin to false
  _registerRemoteRequest(reqid, reqType, buf) {
    const obj = cable.parseMessage(buf)
    this._registerRequest(reqid, false, reqType, obj)
  }

  /* methods that deal with responding to requests */
  // TODO (2023-03-23): write tests that exercise handleRequest cases
  handleRequest(req, done) {
    if (!done) { done = util.noop }
    const reqType = cable.peekMessage(req)
    const reqid = cable.peekReqid(req)
    const reqidHex = reqid.toString("hex")

    // check if message is a request or a response
    if (!this._messageIsRequest(reqType)) {
      coredebug("message is not a request (msgType %d)", reqType)
      return done()
    }

    // deduplicate the request: if we already know about it, we don't need to process it any further
    if (this.requestsMap.has(reqid.toString("hex"))) {
      coredebug("we already know about reqid %O - returning early", reqid)
      return done()
    }

    const obj = cable.parseMessage(req)
    this._registerRemoteRequest(reqid, reqType, req)
    if (obj.ttl > 0) { this.forwardRequest(req) }

    // create the appropriate response depending on the request we're handling
    let promise = new Promise((res, rej) => {
      let response
      switch (reqType) {
        case constants.CANCEL_REQUEST:
          this._removeRequest(obj.cancelid)
          // note: there is no corresponding response for a cancel request
          return res(null)
        case constants.POST_REQUEST:
          // get posts corresponding to the requested hashes
          this.getData(obj.hashes, (err, posts) => {
            if (err) { return rej(err) }
            // hashes we could not find in our database are represented as null: filter those out
            const responsePosts = posts.filter(post => post !== null)
            response = cable.POST_RESPONSE.create(reqid, responsePosts)
            return res([response])
          })
          break
        case constants.TIME_RANGE_REQUEST:
          coredebug("create a response: get time range using params in %O", obj)
          // if obj.timeEnd === 0 => keep this request alive
          // TODO (2023-04-26): if timeEnd !== 0 and we've gotten out all our hashes, send a hash response with
          // hashes=[] to signal end of request + conclude it & remove request
          if (obj.timeEnd === 0) {
            const hasLimit = obj.limit !== 0
            this._addLiveStateRequest(obj.channel, obj.reqid, obj.limit, hasLimit)
          }
          // get post hashes for a certain channel & time range
          this.store.getChannelTimeRange(obj.channel, obj.timeStart, obj.timeEnd, obj.limit, (err, hashes) => {
            if (err) { return rej(err) }
            if (hashes && hashes.length > 0) {
              const responses = []
              response = cable.HASH_RESPONSE.create(reqid, hashes)
              responses.push(response)
              // timeEnd !== 0 => not keeping this request alive + we've returned everything we have: conclude it
              if (obj.timeEnd > 0) {
                coredebug("time-range-request: prepare concluding hash response for %O", reqid)
                response = cable.HASH_RESPONSE.create(reqid, [])
                responses.push(response)
                this._removeRequest(reqid)
              }
              return res(responses)
            } else {
              return res(null)
            }
          })
          break
        case constants.CHANNEL_STATE_REQUEST:
          // if obj.future === 1 => keep this request alive
          if (obj.future === 1) {
            // it has no implicit limit && updatesRemaining does not apply
            this._addLiveStateRequest(obj.channel, obj.reqid, 0, false)
          }
          // get channel state hashes
          this.getChannelStateHashes(obj.channel, (err, hashes) => {
            if (err) { return rej(err) }
            if (hashes && hashes.length > 0) {
              const responses = []
              response = cable.HASH_RESPONSE.create(reqid, hashes)
              responses.push(response)
              // timeEnd !== 0 => not keeping this request alive + we've returned everything we have: conclude it
              if (obj.future === 0) {
                coredebug("channel-state-request: prepare concluding hash response for %O", reqid)
                response = cable.HASH_RESPONSE.create(reqid, [])
                responses.push(response)
                this._removeRequest(reqid)
              }
              return res(responses)
            } else {
              return res(null)
            }
          })
          break
        case constants.CHANNEL_LIST_REQUEST:
          this.store.channelMembershipView.api.getChannelNames(obj.offset, obj.limit, (err, channels) => {
            if (err) { return rej(err) }
            // get a list of channel names
            response = cable.CHANNEL_LIST_RESPONSE.create(reqid, channels)
            return res([response])
          })
          break
        default:
          throw new Error(`handle request: unknown request type ${reqType}`)
      }
    })

    promise.then(responses => {
      // cancel request has no response => it returns null to resolve promise
      if (responses !== null) {
        responses.forEach(response => {
          this.dispatchResponse(response)
        })
      }
      done()
    })
    // TODO (2023-03-28): handle errors in a .catch(err) clause
  }

  /* methods for emitting data outwards (responding, forwarding requests not for us) */
  dispatchResponse(buf) {
    this.emit("response", buf)
  }

  dispatchRequest(buf) {
    const reqtype = cable.peekMessage(buf)
    if (!this._messageIsRequest(reqtype)) {
      return
    }
    const reqid = cable.peekReqid(buf)
    // don't remember a cancel request id as it expects no response
    if (reqtype !== constants.CANCEL_REQUEST) {
      this._registerLocalRequest(reqid, reqtype, buf)
    }
    this.emit("request", buf)
  }

  // TODO (2023-04-24): write tests that verify live query behaviour for both
  // channel state request
  // channel time range request
  //
  // we want to test the following when a request sets live query to true:
  // * receives new hash responses when they are produced locally (e.g. a post is written whose timespan fits the interval)
  // * time range request's limits are not exceeded & the live query is canceled once reached
  // * cancel request cancels the related live queries, if they exist

  // in this implementation a `live request` is a request that has asked to receive updates as they are produced; i.e.
  // future posts, instead of only asking for historic posts.
  //
  // requests which have a live query component:
  // * TIME_RANGE_REQUEST (channel time range request)
  // * CHANNEL_STATE_REQUEST (channel state request) -- has no limit to updates!
  // that's it!
  //
  // _addLiveStateRequest maps a channel name to one of potentially many ongoing "live" requests
  //
  // Map structure: <channel name> -> [{ updatesRemaining: Number, hasLimit: boolean, reqid: hexStringOfBuffer}]
  _addLiveStateRequest(channel, reqid, updatesRemaining, hasLimit) {
    // TODO (2023-04-24): live state request currently has no conception of a valid time range, which could affect the
    // anticipated behaviour of channel time range request (e.g. we could receive & store a post/text whose timestamp is
    // older than the timeStart of a live channel time range request)
    
    // TODO (2023-03-31): use _addLiveRequest when processing an incoming TIME_RANGE_REQUEST + CHANNEL_STATE_REQUEST
    const reqidHex = reqid.toString("hex")
    livedebug("track %s", reqidHex)

    // a potentially rascally attempt to fuck shit up; abort
    if (channel === "reqid-to-channels") { return } 

    const reqidMap = this.liveQueries.get("reqid-to-channels")
    if (!reqidMap.has(reqidHex)) {
      reqidMap.set(reqidHex, channel)
    }

    if (!this.liveQueries.has(channel)) {
      this.liveQueries.set(channel, [])
    }
    const arr = this.liveQueries.get(channel)
    // track the live request, including how many updates it has left before it has finished being served
    const req = { reqid: reqidHex, updatesRemaining, hasLimit }
    arr.push(req)
  }

  // returns a list of reqidHex, corresponding to live requests for the given channel
  _getLiveRequests(channel) {
    livedebug("get live request for %s", channel)
    const channelQueries = this.liveQueries.get(channel)
    // no such channel
    if (!channelQueries) { return [] }
    return channelQueries.map(item => b4a.from(item.reqid, "hex"))
  }

  _updateLiveStateRequest(channel, reqid, updatesSpent) {
    const channelQueries = this.liveQueries.get(channel)
    // no such channel
    if (!channelQueries) { return }
    const index = channelQueries.findIndex(item => item.reqid === reqid.toString("hex"))
    const entry = channelQueries[index]
    // no live query with `reqid`
    if (!entry) { return }
    if (entry.hasLimit) {
      entry.updatesRemaining = entry.updatesRemaining - updatesSpent
      livedebug("updated live request for %O", entry)
      if (entry.updatesRemaining <= 0) {
        this._cancelLiveStateRequest(entry.reqid)
        // emit an event when a live request has finished service
        this.emit("live-request-ended", entry.reqid)
      }
    }
  }

  _cancelLiveStateRequest(reqidHex) {
    const channel = this.liveQueries.get("reqid-to-channels").get(reqidHex)
    if (!channel) {
      coredebug("cancel live request could not find channel for reqid %s", reqidHex)
      return
    }
    let channelQueries = this.liveQueries.get(channel)
    const index = channelQueries.findIndex(item => item.reqid === reqidHex)
    if (index < 0) {
      coredebug("cancel live request could not find entry for reqid %s", reqidHex)
      return 
    }
    // remove the entry tracking this particular req_id: delete 1 item at `index`
    channelQueries = channelQueries.splice(1, index)
    // there are no longer any live queries being tracked for `channel`, stop tracking it
    if (channelQueries.length === 0) {
      this.liveQueries.delete(channel)
    } else {
      this.liveQueries.set(channel, channelQueries)
    }
    this.liveQueries.get("reqid-to-channels").delete(reqidHex)
  }

  _messageIsRequest (type) {
    switch (type) {
      case constants.POST_REQUEST:
      case constants.CANCEL_REQUEST:
      case constants.TIME_RANGE_REQUEST:
      case constants.CHANNEL_STATE_REQUEST:
      case constants.CHANNEL_LIST_REQUEST:
        return true
        break
      default:
        return false
    }
  }

  _messageIsResponse (type) {
    switch (type) {
      case constants.HASH_RESPONSE:
      case constants.POST_RESPONSE:
      case constants.CHANNEL_LIST_RESPONSE:
        return true
        break
      default:
        return false
    }
  }

  // send buf onwards to other peers
  forwardRequest(buf) {
    const reqType = cable.peekMessage(buf)
    let decrementedBuf 
    switch (reqType) {
      case constants.POST_REQUEST:
        decrementedBuf = cable.POST_REQUEST.decrementTTL(buf)
        break
      case constants.TIME_RANGE_REQUEST:
        decrementedBuf = cable.TIME_RANGE_REQUEST.decrementTTL(buf)
        break
      case constants.CHANNEL_STATE_REQUEST:
        decrementedBuf = cable.CHANNEL_STATE_REQUEST.decrementTTL(buf)
        break
      case constants.CHANNEL_LIST_REQUEST:
        decrementedBuf = cable.CHANNEL_LIST_REQUEST.decrementTTL(buf)
        break
      default:
        throw new Error(`forward request: unknown request type ${reqType}`)
    }
    console.log("forward request", decrementedBuf)
  }

  forwardResponse(buf) {
    console.log("forward response", buf)
  }

  _storeExternalBuf(buf, done) {
    if (!done) { done = util.noop }
    const hash = this.hash(buf)
    this.store.deletedView.api.isDeleted(hash, (err, deleted) => {
      if (err) { return done() }
      if (deleted) { 
        // this hash has been deleted -> we should never try to store and reindex a deleted message
        // i.e. we abort here
        return done()
      }
      // the buf was not a deleted buf: onward!
      new Promise((res, rej) => {
        const postType = cable.peekPost(buf)
        switch (postType) {
          case constants.TEXT_POST:
            this.store.text(buf, () => { res() })
            break
          case constants.DELETE_POST:
            this.store.del(buf, () => { res() })
            break
          case constants.INFO_POST:
            this.store.info(buf, () => { res() })
            break
          case constants.TOPIC_POST:
            this.store.topic(buf, () => { res() })
            break
          case constants.JOIN_POST:
            this.store.join(buf, () => { res() })
            break
          case constants.LEAVE_POST:
            this.store.leave(buf, () => { res() })
            break
          default:
            rej()
            throw new Error(`store external buf: unknown post type ${postType}`)
        }
      }).then(() => {
        const obj = cable.parsePost(buf)
        // TODO (2023-06-12): figure out how to links-index post/info + post/delete
        if (!obj.channel) { 
          return done() 
        }
        this.store.linksView.map([{ links: obj.links, hash }], () => {
          this.store.linksView.api.checkIfHeads([ hash ], (err, heads) => {
            if (err) { 
              coredebug("store external buf: error when checking if heads for %O (%O)", hash, err)
              return done()
            }
            if (heads.length > 0) {
              this.store.linksView.api.pushHeadsChanges(obj.channel, heads, obj.links, (err, newHeads) => {
                if (err) {
                  coredebug("store external buf: error when pushing new heads for %O (%O)", hash, err)
                  return done()
                }
                this.heads.set(obj.channel, newHeads)
                done()
              })
            }
          })
        })
      })
    })
  }

  // returns an array of posts whose hashes have been verified to have been requested by us
  _processPostResponse(obj) {
    const requestedPosts = []
    obj.posts.forEach(post => {
      const hash = crypto.hash(post)
      // we wanted this post!
      if (this.requestedHashes.has(hash.toString("hex"))) {
        requestedPosts.push(post)
        // clear hash from map
        this.requestedHashes.delete(hash.toString("hex"))
      }
    })
    return requestedPosts
  }

  // useful for tests
  _isReqidKnown (reqid) {
    return this.requestsMap.has(reqid.toString("hex"))
  }

  _handleRequestedBufs(bufs, done) {
    let p
    const promises = []
    const hashes = bufs.map(buf => { return this.hash(buf) })
    // make sure we never try to store a post we know has been deleted
    new Promise((res, rej) => {
      this.store.deletedView.api.isDeletedMany(hashes, (err, deleted) => {
        if (err) { return rej(err) }
        let bufsToStore = []
        for (let i = 0; i < bufs.length; i++) {
          if (!deleted[i]) {
            bufsToStore.push(bufs[i])
          }
        }
        res(bufsToStore)
      })
    }).then(bufsToStore => {
      // here we check: 
      // does the hash of each entry in the post response correspond to hashes we have requested?  
      bufsToStore.forEach(buf => {
        p = new Promise((res, rej) => {
          // _storeExternalBuf correctly indexes the external buf depending on post type
          this._storeExternalBuf(buf, () => { res() })
        })
        promises.push(p)
      })
      p = new Promise((res, rej) => {
        // remove handled hashes from requestedHashes
        hashes.forEach(hash => {
          this.requestedHashes.delete(hash.toString("hex")) 
        })
      })
      promises.push(p)
      Promise.all(promises).then(() => { done() })
    })
  }

  /* methods that handle responses */
  handleResponse(res, done) {
    if (!done) { done = util.noop }
    const resType = cable.peekMessage(res)
    const reqid = cable.peekReqid(res)
    const reqidHex = reqid.toString("hex")

    // check if message is a request or a response
    if (!this._messageIsResponse(resType)) {
      return
    }

    // if we don't know about a reqid, then the corresponding response is not something we want to handle
    if (!this.requestsMap.has(reqidHex)) {
      return
    }

    const entry = this.requestsMap.get(reqidHex)

    if (entry.resType === resType) {
      coredebug("response for id %O is of the type expected when making the request", reqid)
    } else {
      coredebug("response for id %O does not have the expected type (was %d, expected %d)", reqid, resType, entry.resType)
    }

    const obj = cable.parseMessage(res)

    // TODO (2023-03-23): handle decommissioning all data relating to a reqid whose request-response lifetime has ended
    //
    // TODO (2023-03-23): handle forwarding responses onward; use entry.origin?
    if (!entry.origin) {
      this.forwardResponse(res)
      // we are not the terminal for this response (we did not request it), so in the base case we should not store its
      // data.
      // however: we could inspect the payload of a POST_RESPONSE to see if it contains posts for any hashes we are waiting for..
      if (resType === constants.POST_RESPONSE) {
        this._handleRequestedBufs(this._processPostResponse(obj), () => {
          // console.log("TODO: wow very great :)")
        })
      }
      return
    }
 
    // process the response according to what type it was
    switch (resType) {
      case constants.HASH_RESPONSE:
        // hash response has signalled end of responses, deallocate reqid
        if (obj.hashes.length === 0) {
          this._removeRequest(reqid)
          return done()
        }
        // query data store and try to get the data for each of the returned hashes. 
        this.store.blobs.api.getMany(obj.hashes, (err, bufs) => {
          // collect all the hashes we still don't have data for (represented by null in returned `bufs`) and create a
          // post request
          let wantedHashes = []
          bufs.forEach((buf, index) => {
            if (buf === null) {
              // we don't have the hash represented by hashes[index]: good! we want to request it.
              const hash = obj.hashes[index]
              wantedHashes.push(hash)
              // remember the requested hashes
              this.requestedHashes.set(hash.toString("hex"), true)
            }
          })
          if (wantedHashes.length === 0) {
            return done()
          }
          // make sure we don't request posts for any hashes that we honor as deleted
          this.store.deletedView.api.isDeletedMany(wantedHashes, (err, deleteArr) => {
            if (err) { throw err }
            // each entry in deleteArr contains either true or false for the corresponding hash in wantedHashes.
            // reduce wantedHashes to only contain the hashes we know have not been deleted
            let temp = []
            for (let i = 0; i < wantedHashes.length; i++) {
              if (!deleteArr[i]) {
                temp.push(wantedHashes[i])
              }
            }
            wantedHashes = temp // update wantedHashes to new set of values known to not be deleted
            // dispatch a `post request` for the missing hashes
            const newReqid = crypto.generateReqID()
            const req = cable.POST_REQUEST.create(newReqid, this._defaultTTL, wantedHashes)
            this.dispatchRequest(req)
            done()
          })
        })
        break
      case constants.POST_RESPONSE:
        // TODO (2023-03-23): handle empty post response as a signal that "this concludes the lifetime of this req-res chain" 
        // action: decommission the reqid
        this._handleRequestedBufs(this._processPostResponse(obj), () => { 
          done()
        }) 
        break
      case constants.CHANNEL_LIST_RESPONSE:
        this._indexNewChannels(obj.channels, done)
        break
      default:
        throw new Error(`handle response: unknown response type ${resType}`)
    }
  }

  // indexes channel names received as part of a channel list request/response cycle.
  // as we receive a list of channel names, and not a set of join/leave posts we use a sentinel to keep track of these
  // inserted channels while maintaining the overall key scheme in channel-membership.js
  _indexNewChannels(channels, done) {
    const arr = channels.map(channel => { return { publicKey: "sentinel", channel }})
    this.store.channelMembershipView.map(arr, done)
  }
}

module.exports = { CableCore, CableStore }
