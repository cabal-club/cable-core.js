// node core dependencies
const EventEmitter = require('events').EventEmitter
// external dependencies
const ts = require("monotonic-timestamp")
const b4a = require("b4a")
const storedebug = require("debug")("core/store")
const coredebug = require("debug")("core/")
const { Level } = require("level")
const { MemoryLevel } = require("memory-level")
// internal dependencies
const cable = require("../cable/index.js")
const crypto = require("../cable/cryptography.js")
const constants = require("../cable/constants.js")
// materialized views and indices
const createDatastore = require("./data-store.js")
const createChannelStateView = require("./channel-state.js")
const createChannelMembershipView = require("./channel-membership.js")
const createUserInfoView = require("./user-info.js")
const createAuthorView = require("./author.js")
const createMessagesView = require("./messages.js")
const createDeletedView = require("./deleted.js")
// aliases
const TEXT_POST = cable.TEXT_POST
const DELETE_POST = cable.DELETE_POST
const INFO_POST = cable.INFO_POST
const TOPIC_POST = cable.TOPIC_POST
const JOIN_POST = cable.JOIN_POST
const LEAVE_POST = cable.LEAVE_POST

// database interaction, operate on the cablegram?
class CableStore {
  // TODO (2023-02-23): ensure proper handling of duplicates in views that index hashes

  constructor(opts) {
    if (!opts) { opts = { temp: true } }

    this._db = new Level("data")
    if (opts.temp) {
      this._db = new MemoryLevel("data")
    }
    // stores binary representations of message payloads by their hashes
    this.blobs = createDatastore(this._db.sublevel("data-store", { valueEncoding: "binary" }))
    this.channelStateView = createChannelStateView(this._db.sublevel("channel-state", { valueEncoding: "binary" }))
    this.channelMembershipView = createChannelMembershipView(this._db.sublevel("channel-membership", { valueEncoding: "json" }))
    this.userInfoView = createUserInfoView(this._db.sublevel("user-info", { valueEncoding: "binary" }))
    this.authorView = createAuthorView(this._db.sublevel("author", { valueEncoding: "binary" }))
    this.messagesView = createMessagesView(this._db.sublevel("messages", { valueEncoding: "binary" }))
    this.deletedView = createDeletedView(this._db.sublevel("deleted", { valueEncoding: "binary" }))
  }

  _storeNewPost(buf, hash) {
    // store each new post by associating its hash to the binary post payload
    this.blobs.map([{hash, buf}], (err) => {
      if (err !== null) {
        storedebug("blobs (error: %o)", err) 
      } else {
        storedebug("blobs", err) 
      }
    })
    const obj = cable.parsePost(buf)
    // index posts made by author's public key and type of post
    this.authorView.map([{...obj, hash}], (err) => {
      if (err !== null) {
        storedebug("author (error: %o)", err) 
      } else {
        storedebug("author", err) 
      }
    })
  }

  // storage methods
  join(buf) {
    const hash = crypto.hash(buf)
    this._storeNewPost(buf, hash)
    const obj = JOIN_POST.toJSON(buf)
    this.channelStateView.map([{ ...obj, hash}])
    this.channelMembershipView.map([obj])
    
    // TODO (2023-02-22): index in more ways, as indexes come online:
    // * reverse hash map
  }

  leave(buf) {
    const hash = crypto.hash(buf)
    this._storeNewPost(buf, hash)
    const obj = LEAVE_POST.toJSON(buf)
    
    this.channelStateView.map([{ ...obj, hash}])
    this.channelMembershipView.map([obj])
    
    // TODO (2023-02-22): index in more ways, as indexes come online:
    // * reverse hash map
  }

  del(buf) {
    // the hash of the post/delete message
    const hash = crypto.hash(buf)
    // persist cablegram of the post/delete message
    this._storeNewPost(buf, hash)
    // note: obj.hash is hash of the deleted post (not of the post/delete!)
    const obj = DELETE_POST.toJSON(buf)
    const hashToDelete = obj.hash

    this.blobs.api.get(hashToDelete, (err, cablegram) => {
      if (err) {
        storedebug("delete err'd", err)
        return
      }
      const post = cable.parsePost(cablegram)
      storedebug("post to delete %O", post)
      const channel = post.channel
      // record the post/delete in the messages view
      this.messagesView.map([{ ...obj, channel, hash}])
      // delete the targeted post in the data store using obj.hash
      this.blobs.api.del(hashToDelete)
      // record hash of deleted post in upcoming deletedView
      this.deletedView.map([hashToDelete])
    })
  }

  topic(buf) {
    const hash = crypto.hash(buf)
    this._storeNewPost(buf, hash)
    const obj = TOPIC_POST.toJSON(buf)
    
    this.channelStateView.map([{ ...obj, hash}])
  }

  text(buf) {
    const hash = crypto.hash(buf)
    this._storeNewPost(buf, hash)
    const obj = TEXT_POST.toJSON(buf)
    
    this.messagesView.map([{ ...obj, hash}])
  }

  info(buf) {
    const hash = crypto.hash(buf)
    this._storeNewPost(buf, hash)
    const obj = INFO_POST.toJSON(buf)
    
    this.userInfoView.map([{ ...obj, hash}])
    // channel state view keeps track of info posts that set the name
    if (obj.key === "name") {
      // if we're setting a post/info:name via core.setNick() we are not passed a channel. so to do
      // this correctly, for how the channel state index looks like right now, we need to get a list of channels that the
      // user is in and post the update to each of those channels
      this.channelMembershipView.api.getHistoricMembership(obj.publicKey, (err, channels) => {
        const channelStateMessages = []
        channels.forEach(channel => {
          channelStateMessages.push({...obj, hash, channel})
        })
        storedebug(channelStateMessages)
        this.channelStateView.map(channelStateMessages)
      })
      // TODO (2023-02-28): also get for channels that have been left
    }
  }

  // store a dispatched request; by reqid?
  request(buf) {}

  // get data by list of hashes
  getData(hashes, cb) {
    this.blobs.api.getMany(hashes, cb)
  }
  // get hashes by channel name + channel time range
  getChannelTimeRange(channel, start, end, limit, cb) {
    this.messagesView.api.getChannelTimeRange(channel, start, end, limit, cb)
  }
  // hashes relating to channel state
  // (superfluous if we only ever store latest channel membership?)
  getChannelState(channel, historic, limit, cb) {} // superfluous?
  // get all channel names
  getChannelNames(cb) {}

  // rebuild the specified index. could be required if a delete happened for a post type which has an accreted
  // (application state-only) index, such as deleting a post/join or a post/topic
  _rebuildIndex(name) {}
}

class CableCore extends EventEmitter {
  constructor(opts) {
    super()
    if (!opts) { opts = {} }
    if (!opts.storage) {}
    if (!opts.network) {}

    this.kp = crypto.generateKeypair()

    this.store = new CableStore()
    /* used as: 
     * store a join message:
     * store.join(buf) 
    */

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
	postText(channel, text) {
    const link = this._links()
    const buf = TEXT_POST.create(this.kp.publicKey, this.kp.secretKey, link, channel, ts(), text)
    this.store.text(buf)
    return buf
  }

	// post/info key=name
	setNick(name) {
    const link = this._links()
    const buf = INFO_POST.create(this.kp.publicKey, this.kp.secretKey, link, ts(), "name", name)
    this.store.info(buf)
    return buf
  }

	// post/topic
	setTopic(channel, topic) {
    const link = this._links()
    const buf = TOPIC_POST.create(this.kp.publicKey, this.kp.secretKey, link, channel, ts(), topic)
    this.store.topic(buf)
    return buf
  }

  // get the latest links for the given context. with `links` peers have a way to partially order message history
  // without relying on claimed timestamps
  _links(channel) {
    return crypto.hash(b4a.from("not a message payload at all"))
  }

	// post/join
	join(channel) {
    const link = this._links()
    const buf = JOIN_POST.create(this.kp.publicKey, this.kp.secretKey, link, channel, ts())
    this.store.join(buf)
    return buf
  }

	// post/leave
	leave(channel) {
    const link = this._links()
    const buf = LEAVE_POST.create(this.kp.publicKey, this.kp.secretKey, link, channel, ts())
    this.store.leave(buf)
    return buf
  }

	// post/delete
  // note: store deleted hash to keep track of hashes we don't want to sync.  
  // also store which channel msg was in, to fulfill state requests
  // 
  // q: should we have a flag that is like `persistDelete: true`? enables for deleting for storage reasons, but not
  // blocking reasons. otherwise all deletes are permanent and not reversible, seems bad 
	del(hash) {
    const link = this._links()
    const buf = DELETE_POST.create(this.kp.publicKey, this.kp.secretKey, link, ts(), hash)
    this.store.del(buf)
    return buf
  }


  /* methods to get data we already have locally */

  getChat(channel, start, end, limit, cb) {
    coredebug(channel, start, end, limit, cb)
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
    this.store.channelStateView.api.getLatestTopicHash(channel, (err, hash) => {
      this.resolveHashes([hash], (err, results) => {
        if (err) { return cb(err) }
        const obj = results[0]
        cb(null, obj.topic)
      })
    })
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

  // get users in channel? map pubkey -> user object
  getUsers(channel, cb) {}

  // resolves hashes into post objects
  resolveHashes(hashes, cb) {
    coredebug("the hashes", hashes)
    this.store.blobs.api.getMany(hashes, (err, cablegrams) => {
      if (err) { return cb(err) }
      coredebug("resolveHashes cablegrams %O", cablegrams)
      const posts = []
      cablegrams.forEach(gram => {
        if (typeof gram === "undefined") {
          posts.push(null)
          return
        }
        posts.push(cable.parsePost(gram))
      })
      cb(null, posts)
    })
  }

  getChannelState(channel, cb) {
    this.store.channelStateView.api.getLatestState(channel, (err, hashes) => {
      if (err) { return cb(err) }
      this.resolveHashes(hashes, cb)
    })
    // 1) either:
   
    /* return something like {
     * topic: "",
     * users: {<pubkey>: { nick: <>, online: <>}, ...}
     * }
     */

    // this would be useful for rendering in a client

    // 2) or: 
    // return list of bufs relevant to channel corresponding to post/info, post/topic, post/join || post/leave
    //
    // this would be useful for servicing channel state requests
  }

  /* methods that control requests to peers, causing responses to stream in (or stop) */
	// cancel request
	cancelRequest(reqid) {}
 
  // <-> getChannels
  requestChannels(ttl, limit) {}

  // <-> delete
  requestDelete(hash) {}

  // <-> getPosts
  requestPosts(channel, start, end, ttl, limit) {}

  // -> topic, delete, join, leave
  requestState(channel, ttl, limit, updates) {}

  // request data for the sought hashes
  requestData(hashes) {}

  /* methods that deal with responding to requests */
  handleRequest(buf, peer) {
    // 1. log reqid?
    //
    // handle depending on type:
    // * requesting hashes (for posts, for channel state)
    // * requesting delete
    // * requesting data (for given hashes)
    // * requesting channel list (known channels)
  }

  /* methods for emitting data outwards (responding, forwarding requests not for us) */
  dispatchResponse(buf) {
  }

  // send buf onwards to other peers
  forwardRequest(buf) {
    // TODO (2023-02-06): decrease ttl
  }

  /* methods that handle responses */
  // TODO (2023-02-06):
  // * ignore hashes that have not been requested
  // -> track "outbound hashes"
  // -> hash buf
  // * ignore responses that don't map to tracked reqids
  handleResponse(buf, peer) {
    // 1. check reqid
    //  1.1 check that response for reqid logically matches what was requested 
    //  (if answers our request for channel state by only sending hashes that correlated to post/text, that isn't ok)
    // 2. produce hash
    //
    // handle depending on type:
    // * hash response
    // * data response
    // * channel list response
  }

  _handleDataResponse(hash, buf) {}
  _handleHashResponse(hash, buf) {}
  _handleChannelListResponse(buf) {}
}

module.exports = { CableCore, CableStore }
