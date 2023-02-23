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
const createDatastore = require("./data-store.js")
const createChannelStateView = require("./channel-state.js")
// aliases
const JOIN_POST = cable.JOIN_POST
const LEAVE_POST = cable.LEAVE_POST
const TOPIC_POST = cable.TOPIC_POST


// database interaction, operate on the cablegram?
class CableStore {
  constructor(opts) {
    if (!opts) { opts = { temp: true } }

    this._db = new Level("data")
    if (opts.temp) {
      this._db = new MemoryLevel("data")
    }
    // stores binary representations of message payloads by their hashes
    this.blobs = createDatastore(this._db.sublevel("data-store", { valueEncoding: "binary" }))
    this.channelStateView = createChannelStateView(this._db.sublevel("channel-state", { valueEncoding: "binary" }))
  }

  // storage methods
  join(buf) {
    const hash = crypto.hash(buf)
    this.blobs.map([{hash, buf}], (err) => {
     if (err !== null) {
       storedebug("join (error: %o)", err) 
     } else {
       storedebug("join", err) 
     }
    })
    const obj = JOIN_POST.toJSON(buf)
    this.channelStateView.map([{ ...obj, hash}])
    
    // TODO (2023-02-22): index in more ways, as indexes come online:
    // * reverse hash map
    // * channel state index
    // * channel membership index
    // * author index
  }

  leave(buf) {
    const hash = crypto.hash(buf)
    this.blobs.map([{hash, buf}], (err) => {
     if (err !== null) {
       storedebug("leave (error: %O)", err) 
     } else {
       storedebug("leave", err) 
     }
    })
    const obj = LEAVE_POST.toJSON(buf)
    
    this.channelStateView.map([{ ...obj, hash}])
    
    // TODO (2023-02-22): index in more ways, as indexes come online:
    // * reverse hash map
    // * channel state index
    // * channel membership index
    // * author index
  }

  delete(buf) {}

  topic(buf) {
    const hash = crypto.hash(buf)
    this.blobs.map([{hash, buf}], (err) => {
     if (err !== null) {
       storedebug("topic (error: %O)", err) 
     } else {
       storedebug("topic", err) 
     }
    })
    const obj = TOPIC_POST.toJSON(buf)
    
    this.channelStateView.map([{ ...obj, hash}])
  }

  post(buf) {}
  info(buf) {}
  // store a dispatched request; by reqid?
  request(buf) {}

  // get data by list of hashes
  getData(hashes, cb) {
    this.blobs.api.getMany(hashes, cb)
  }
  // get hashes by channel name + channel time range
  getHashes(channel, start, end, limit, cb) {}
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
	post(channel, text) {}

	// post/info key=name
	setNick(name) {}

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
	delete(hash) {}


  /* methods to get data we already have locally */
  getPosts(channel, start, end, limit, cb) {}

  getNick(cb) {}

  getTopic(channel, cb) {
    // TODO (2023-02-23): should resolve to a string topic, not the hash of the post/topic message
    this.store.channelStateView.api.getLatestTopicHash("channel", cb)
  }

  getChannels(cb) {}

  getJoinedChannels(channel, cb) {
    // TODO (2023-02-23): make this return joined channels and not be a weird verification that getLatestMembership
    // works X)
    this.store.channelStateView.api.getLatestMembershipHash(channel, this.kp.publicKey, (err, hash) => {
      if (!err) {
        this.store.blobs.api.get(hash, cb)
      }
    })
  }

  // get users in channel? map pubkey -> user object
  getUsers(channel, cb) {}

  // resolves hashes into posts
  resolveHashes(hashes, cb) {
    this.store.blobs.api.getMany(hashes, cb)
  }

  getChannelState(channel, cb) {
    this.store.channelStateView.api.getLatestState(channel, (err, hashes) => {
      if (!err) {
        this.resolveHashes(hashes, cb)
      }
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
