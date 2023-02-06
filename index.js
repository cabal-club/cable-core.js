// these all generate a cablegram using the local keypair
// equivalents are needed for storing their resulting messages into the database. these equivalents would also be used when receiving messages from the network

// database interaction, operate on the cablegram?
class CableStore {
  // storage methods
  join(buf) {}
  leave(buf) {}
  delete(buf) {}
  topic(buf) {}
  post(buf) {}
  info(buf) {}
  // store a dispatched request; by reqid?
  request(buf) {}

  // get data by list of hashes
  getData(hashes, cb) {}
  // get hashes by channel name + channel time range
  getHashes(channel, start, end, cb) {}
  // hashes relating to channel state
  // (superfluous if we only ever store latest channel membership?)
  getChannelState(channel, cb) {} // superfluous?
  // get all channel names
  getChannelNames(cb) {}
}

class CableCore extends EventEmitter {
  constructor() {
    this.store = new CableStore()
    /* used as: 
     * store a join message:
     * store.join(buf) 
    */

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

  /* methods that produce cablegrams, and which we store in our database */
	// post/text
	post(channel, text) {}

	// post/info key=nick
	setNick(name) {}

	// post/topic
	setTopic(channel, topic) {}

	// post/join
	join(channel) {}

	// post/leave
	leave(channel) {}

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

  getTopic(channel, cb) {}

  getChannels(cb) {}

  getJoinedChannels(cb) {}

  // get users in channel? map pubkey -> user object
  getUsers(channel, cb)

  getChannelState(channel, cb) {
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
    // 2. produce hash
    //
    // handle depending on type:
    // * hash response
    // * data response
    // * channel list response
  }

  handleDataResponse(hash, buf) {}
  handleHashResponse(hash, buf) {}
  handleChannelListResponse(buf) {}
}
