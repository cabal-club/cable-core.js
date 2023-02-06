// these all generate a cablegram using the local keypair
// equivalents are needed for storing their resulting messages into the database. these equivalents would also be used when receiving messages from the network


// database interaction, operate on the cablegram?
class CableStore {
  join(buf) {}
  leave(buf) {}
  delete(buf) {}
  topic(buf) {}
  post(buf) {}
  info(buf) {}
  // store a dispatched request
  request(buf) {}
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
    //  add
    //  remove
    this.channels = null
    // channels events:
    //  add
    //  join
    //  leave
    //  topic
    this.network = null
    // network events:
    //  connection
    //  join (peer)
    //  leave (peer)
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

	// post/delete. 
  // store to keep track of hashes we don't want to sync.  
  // also store which channel msg was in, to fulfill state requests
	delete(hash) {}


  /* methods to get data we already have locally */
  getPosts(channel, start, end, limit, cb) {}

  getNick(cb) {}

  getTopic(channel, cb) {}

  getChannels(cb) {}

  getJoinedChannels(cb) {}

  /* methods that control requests to peers, causing responses to stream in (or stop) */
	// cancel request
	cancelRequest(reqid) {}
 
  // <-> getChannels
  requestChannels(ttl, limit) 

  // <-> delete
  requestDelete(hash) 

  // <-> getPosts
  requestPosts(channel, start, end, ttl, limit)

  // -> topic, delete, join, leave
  requestState(channel, ttl, limit, updates)
}
