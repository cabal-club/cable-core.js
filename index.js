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
    // TODO (2023-03-01) hook up deleted view to all the appropriate locations in CabalStore
    this.deletedView = createDeletedView(this._db.sublevel("deleted", { valueEncoding: "binary" }))

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
          storedebug("author", err) 
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

    Promise.all(promises).then(done)
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

    Promise.all(promises).then(done)
  }

  del(buf, done) {
    storedebug("done fn %O", done)
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
      this.blobs.api.get(hashToDelete, async (err, cablegram) => {
        if (err) {
          storedebug("delete err'd", err)
          return finished()
        }
        const post = cable.parsePost(cablegram)
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
              this.emit("channel-state-replacement", { channel: res.channel, hash: res.hash })
            }
          }

          // reindex accreted views if they were likely to be impacted e.g. reindex channel topic view if channel topic
          // was deleted
          //
          // note: if we deleted a post/info that necessitates updating all channels that are/have been joined (?)
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
          Promise.all(promises).then(finished)
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
      sendHash({channel, hash})
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
      sendHash({channel, hash})
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
      sendHash({channel, hash})
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

    Promise.all(promises).then(done)
  }

  _emitStoredPost(hash, buf, channel) {
    if (channel) {
      this.emit("store-post", { hash, channel, postType: cable.peekPost(buf) })
    } else { // post/info
      this.emit("store-post", { hash, channel: null, postType: cable.peekPost(buf) })
    }
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
      
        Promise.all(promises).then(done)
      })
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
  //                  [v eventSource]                          [v eventListener     ]
  // register("store", this.store, "channel-state-replacement", () => {/* do stuff */})
  //         [^ className]        [^ eventName               ]
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

    this.events = new EventsManager()
    this.kp = crypto.generateKeypair()

    this.store = new CableStore()
    /* used as: 
     * store a join message:
     * store.join(buf) 
    */

    // tracks still ongoing requests 
    this.requestsMap = new Map()
    // tracks which hashes we have explicitly requested in a 'request for hash' request
    this.requestedHashes = new Map()
    // tracks "live" requests: requests that have asked for future posts, as they are produced
    this.liveQueries = new Map()
    // expedient way to go from a reqid to the relevant channel name
    this.liveQueries.set("reqid-to-channels", new Map())
    this._defaultTTL = 0

    this.events.register("store", this.store, "channel-state-replacement", ({ channel, hash }) => {
      console.log("TODO: Handle channel-state-replacement event")
      console.log("channel: ", channel)
      console.log("hash: ", hash)
    })

    this.events.register("store", this.store, "store-post", ({ channel, hash, postType }) => {
      livedebug("store post evt")
      const reqidList = this._getLiveRequests(channel)
      reqidList.forEach(reqid => {
        const response = cable.HASH_RESPONSE.create(reqid, [hash])
        this.dispatchResponse(response)
        this._updateLiveStateRequest(channel, reqid, 1)
        livedebug("dispatch response %O", response)
        livedebug(this.liveQueries)
      })
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

  hash (buf) {
    if (b4a.isBuffer(buf)) {
      return crypto.hash(buf)
    }
    return null
  }

  /* methods that produce cablegrams, and which we store in our database */

	// post/text
	postText(channel, text, done) {
    const links = this._links()
    const buf = TEXT_POST.create(this.kp.publicKey, this.kp.secretKey, links, channel, util.timestamp(), text)
    this.store.text(buf, done)
    return buf
  }

	// post/info key=name
	setNick(name, done) {
    const links = this._links()
    const buf = INFO_POST.create(this.kp.publicKey, this.kp.secretKey, links, util.timestamp(), "name", name)
    this.store.info(buf, done)
    return buf
  }

	// post/topic
	setTopic(channel, topic, done) {
    const links = this._links()
    const buf = TOPIC_POST.create(this.kp.publicKey, this.kp.secretKey, links, channel, util.timestamp(), topic)
    this.store.topic(buf, done)
    return buf
  }

  // get the latest links for the given context. with `links` peers have a way to partially order message history
  // without relying on claimed timestamps
  _links(channel) {
    return [crypto.hash(b4a.from("not a message payload at all"))]
  }

	// post/join
	join(channel, done) {
    const links = this._links()
    const buf = JOIN_POST.create(this.kp.publicKey, this.kp.secretKey, links, channel, util.timestamp())
    this.store.join(buf, done)
    return buf
  }

	// post/leave
	leave(channel, done) {
    const links = this._links()
    const buf = LEAVE_POST.create(this.kp.publicKey, this.kp.secretKey, links, channel, util.timestamp())
    this.store.leave(buf, done)
    return buf
  }

	// post/delete
  // note: we store the deleted hash to keep track of hashes we don't want to sync.  
  // we also store which channel the post was in, to fulfill channel state requests
  // 
  // q: should we have a flag that is like `persistDelete: true`? enables for deleting for storage reasons, but not
  // blocking reasons. otherwise all deletes are permanent and not reversible
	del(hash, done) {
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
	cancelRequest(reqid, cancelid) {
    // set ttl to 0 as it's is unused in cancel req
    const req = cable.CANCEL_REQUEST.create(reqid, 0, cancelid)
    // cancel any potential ongoing live requests
    this._cancelLiveStateRequest(reqid.toString("hex"))
    // forget about the canceled request id
    this.dispatchRequest(req)
    this.requestsMap.delete(cancelid.toString("hex"))
    return req
  }
 
  // <-> getChannels
  requestChannels(ttl, offset, limit) {
    const reqid = crypto.generateReqID()
    const req = cable.CHANNEL_LIST_REQUEST.create(reqid, ttl, offset, limit)
    this.dispatchRequest(req)
    return req
  }

  // <-> getPosts
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

  _reqEntryTemplate (reqid, reqType) {
    const entry = {
      reqid,
      "circuitId": b4a.alloc(4).fill(0),
      reqType,
      "resType": -1,
      "recipients": [],
      "origin": false
    }

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


  _registerRequest(id, origin, type) {
    if (this.requestsMap.has(id)) {
      throw new Error(`request map already had reqid %O`, reqid)
    }
    // TODO (2023-03-23): handle recipients at some point
    // entry.recipients.push(peer)
    const entry = this._reqEntryTemplate(id, type)
    entry.origin = origin
    this.requestsMap.set(entry.reqid.toString("hex"), entry)
  }

  // register a request that is originating from the local node, sets origin to true
  _registerLocalRequest(reqid, reqType) {
    this._registerRequest(reqid, true, reqType)
  }

  // register a request that originates from a remote node, sets origin to false
  _registerRemoteRequest(reqid, reqType) {
    this._registerRequest(reqid, false, reqType)
  }

  /* methods that deal with responding to requests */
  // TODO (2023-03-23): write tests that exercise handleRequest cases
  handleRequest(req, done) {
    if (!done) { done = util.noop }
    const reqType = cable.peek(req)
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
    this._registerRemoteRequest(reqid, reqType)
    if (obj.ttl > 1) { this.forwardRequest(req) }

    // create the appropriate response depending on the request we're handling
    let promise = new Promise((res, rej) => {
      let response
      switch (reqType) {
        case constants.CANCEL_REQUEST:
          // cancel any potential ongoing live requests
          this._cancelLiveStateRequest(reqidHex)
          // note: there is no corresponding response for a cancel request
          return res(null)
        case constants.POST_REQUEST:
          // get posts corresponding to the requested hashes
          this.getData(obj.hashes, (err, posts) => {
            if (err) { return rej(err) }
            // hashes we could not find in our database are represented as null: filter those out
            const responsePosts = posts.filter(post => post !== null)
            response = cable.POST_RESPONSE.create(reqid, responsePosts)
            return res(response)
          })
          break
        case constants.TIME_RANGE_REQUEST:
          coredebug("create a response: get time range using params in %O", obj)
          // if obj.timeEnd === 0 => keep this request alive
          if (obj.timeEnd === 0) {
            const hasLimit = obj.limit !== 0
            this._addLiveStateRequest(obj.channel, obj.reqid, obj.limit, hasLimit)
          }
          // get post hashes for a certain channel & time range
          this.store.getChannelTimeRange(obj.channel, obj.timeStart, obj.timeEnd, obj.limit, (err, hashes) => {
            if (err) { return rej(err) }
            if (hashes.length > 0) {
              response = cable.HASH_RESPONSE.create(reqid, hashes)
              return res(response)
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
            response = cable.HASH_RESPONSE.create(reqid, hashes)
            return res(response)
          })
          break
        case constants.CHANNEL_LIST_REQUEST:
          this.store.channelMembershipView.api.getChannelNames(obj.offset, obj.limit, (err, channels) => {
            if (err) { return rej(err) }
            // get a list of channel names
            response = cable.CHANNEL_LIST_RESPONSE.create(reqid, channels)
            return res(response)
          })
          break
        default:
          throw new Error(`handle request: unknown request type ${reqType}`)
      }
    })

    promise.then(response => {
      // cancel request has no response => it returns null to resolve promise
      if (response !== null) {
        this.dispatchResponse(response)
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
    const reqtype = cable.peek(buf)
    if (!this._messageIsRequest(reqtype)) {
      return
    }
    const reqid = cable.peekReqid(buf)
    if (reqtype !== constants.CANCEL_REQUEST) {
      this._registerLocalRequest(reqid, reqtype)
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

    // rascally attempt to fuck shit up
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
    // emit an event when a live request has finished service -> enable us to renew the request
    this.emit("live-request-ended", reqidHex)
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
    const reqType = cable.peek(buf)
    let decrementedBuf 
    switch (reqType) {
      case constants.POST_REQUEST:
        decrementedBuf = cable.POST_REQUEST.decrementTTL(buf)
        break
      case constants.CANCEL_REQUEST:
        decrementedBuf = cable.CANCEL_REQUEST.decrementTTL(buf)
        // TODO (2023-04-24): handle cancel request behaviour
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
    const postType = cable.peekPost(buf)
    switch (postType) {
      case constants.TEXT_POST:
        this.store.text(buf, done)
        break
      case constants.DELETE_POST:
        this.store.del(buf, done)
        break
      case constants.INFO_POST:
        this.store.info(buf, done)
        break
      case constants.TOPIC_POST:
        this.store.topic(buf, done)
        break
      case constants.JOIN_POST:
        this.store.join(buf, done)
        break
      case constants.LEAVE_POST:
        this.store.leave(buf, done)
        break
      default:
        throw new Error(`store external buf: unknown post type ${postType}`)
    }
  }

  // returns an array of posts whose hashes have been verified to have been requested by us
  _processPostResponse(obj) {
    const requestedPosts = []
    obj.posts.forEach(post => {
      const hash = crypto.hash(post)
      if (this.requestedHashes.has(hash.toString("hex"))) {
        requestedPosts.push(post)
      }
    })
    return requestedPosts
  }


  _handleRequestedBufs(bufs, done) {
    // check: does the hash of each entry in the post response correspond to hashes we have requested?
    // process each post depending on which type of post it is
    let p
    const promises = []
    bufs.forEach(buf => {
      p = new Promise((res, rej) => {
        this._storeExternalBuf(buf, () => { res() })
      })
      promises.push(p)
    })
    Promise.all(promises).then(() => { done() })
  }

  /* methods that handle responses */
  handleResponse(res, done) {
    if (!done) { done = util.noop }
    const resType = cable.peek(res)
    const reqid = cable.peekReqid(res)

    // check if message is a request or a response
    if (!this._messageIsResponse(resType)) {
      return
    }

    // if we don't know about a reqid, then the corresponding response is not something we want to handle
    if (!this.requestsMap.has(reqid.toString("hex"))) {
      return
    }

    const entry = this.requestsMap.get(reqid.toString("hex"))

    if (entry.resType === resType) {
      coredebug("response for id %O is of the type expected when making the request", reqid)
    } else {
      coredebug("response for id %O does not have the expected type (was %d, expected %d)", reqid, reqstype, entry.resType)
    }

    const obj = cable.parseMessage(res)

    // const entry = this._reqEntryTemplate(resType)
    // entry.reqid = reqid
    // this._registerRequest(entry)
    // if (obj.ttl > 0) { this.forwardRequest(res) }
    
    // TODO (2023-03-23): handle decommissioning all data relating to a reqid whose request-response lifetime has ended
    //
    // TODO (2023-03-23): handle forwarding responses onward; use entry.origin?
    if (!entry.origin) {
      this.forwardResponse(res)
      // we are not the terminal for this response (we did not request it), so in the base case we should not store its
      // data.
      // however: we could inspect the payload of a POST_RESPONSE to see if it contains any hashes we are waiting for..
      if (resType === constants.POST_RESPONSE) {
        this._handleRequestedBufs(this._processPostResponse(obj), () => {
          console.log("TODO: wow very great :)")
        })
        // TODO (2023-03-23): after the post has been ingested: remove it from requestedHashes
      }
      return
    }
 
    // process the response according to what type it was
    switch (resType) {
      case constants.HASH_RESPONSE:
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
          // dispatch a `post request` for the missing hashes
          const newReqid = crypto.generateReqID()
          const req = cable.POST_REQUEST.create(newReqid, this._defaultTTL, wantedHashes)
          this.dispatchRequest(req)
          done()
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
