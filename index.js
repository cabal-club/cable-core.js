// SPDX-FileCopyrightText: 2023 the cabal-club authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// node core dependencies
const EventEmitter = require('events').EventEmitter
// external dependencies
const b4a = require("b4a")
const coredebug = require("debug")("core/")
const livedebug = require("debug")("core/live")
// internal dependencies
const cable = require("cable.js")
const crypto = require("cable.js/cryptography.js")
const constants = require("cable.js/constants.js")
const util = require("./util.js")
const CableStore = require("./store.js")
const EventsManager = require("./events-manager.js")
const Swarm = require("./peers.js").Swarm

// aliases
const TEXT_POST = cable.TEXT_POST
const DELETE_POST = cable.DELETE_POST
const INFO_POST = cable.INFO_POST
const TOPIC_POST = cable.TOPIC_POST
const JOIN_POST = cable.JOIN_POST
const LEAVE_POST = cable.LEAVE_POST

const REQID_TO_CHANNELS = "reqid-to-channels"

// an abstraction that keeps track of all event listeners. reasoning behind it is that event listeners have historically been:
// 1. many in cabal pursuits
// 2. hard to keep track of, track down, and manage correctly (a source of leaks)
class CableCore extends EventEmitter {
  constructor(level, opts) {
    super()
    if (!opts) { opts = {} }
    if (!opts.storage) {}
    if (!opts.network) { /*opts.network = Network*/ }
    if (!opts.port) { opts.port = 13331 }
    // i.e. the network of connections with other cab[a]l[e] peers
    coredebug("incoming opts", opts)
    this.swarm = new Swarm("fake-key", opts)
    this.swarm.makeContact()
    this.swarm.on("data", (data) => {
      this._handleIncomingMessage(data)
      coredebug("incoming swarm data", data)
    })
    // TODO (2023-08-14): dedupe and cancel previous requests for the same channel if a new request comes in; basically
    // superceding requests
    //
    // make sure it doesn't conflict if multiple different peers create a request
    //
    this.swarm.on("new-peer", (peer) => {
      coredebug("new peer, time to send them our current requests")
      const localRequests = []
      for (let [reqid, entry] of this.requestsMap) {
        if (entry.origin) { localRequests.push(entry.binary) }
      }
      
      localRequests.forEach(req => { coredebug("requesting", util.humanizeMessageType(cable.peekMessage(req)), req) })
      localRequests.forEach(req => { this.swarm.broadcast(req) })
    })
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

    this.store = new CableStore(level)
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
    this.requestedHashes = new Set()
    // tracks "live" requests: requests that have asked for future posts, as they are produced
    this.liveQueries = new Map()
    // expedient way to go from a reqid to the relevant channel name
    this.liveQueries.set(REQID_TO_CHANNELS, new Map())
    this._defaultTTL = 0

    this.events.register("store", this.store, "channel-state-replacement", ({ channel, postType, hash }) => {
      livedebug("channel-state-replacement evt (channel: %s, postType %i, hash %O)", channel, postType, hash)
      // set timestamp to -1 because we don't have it when producing a channel-state-replacement, 
      // and timestamp only matters for correctly sending hash responses for channel time range requests 
      // (i.e. not applicable for channel state requests)
      this._sendLiveHashResponse(channel, postType, [hash], -1)
    })

    this.events.register("store", this.store, "store-post", ({ obj, channel, timestamp, hash, postType }) => {
      livedebug("store post evt, post type: %i", postType)
      this._sendLiveHashResponse(channel, postType, [hash], timestamp)
      // TODO (2023-08-18): how to know when:
      // * a new user joined?
      // * a new channel was added?
    
      const publicKey = obj.publicKey.toString("hex")
      // emit contextual events depending on what type of post was stored
      switch (postType) {
        case constants.TEXT_POST:
          this._emitChat("add", { channel, publicKey, hash: hash.toString("hex"), post: obj })
          break
        case constants.DELETE_POST:
          this._emitChat("remove", { channel, publicKey, hash: hash.toString("hex") })
          break
        case constants.INFO_POST:
          if (obj.key === "name") {
            this._emitUsers("name-changed", {publicKey, name: obj.value})
          } else {
            coredebug("store-post: unknown key for post/info (key: %s)", obj.key)
          }
          break
        case constants.TOPIC_POST:
          this._emitChannels("topic", { channel, topic: obj.topic, publicKey })
          break
        case constants.JOIN_POST:
          this._emitChannels("join", { channel, publicKey })
          break
        case constants.LEAVE_POST:
          this._emitChannels("leave", { channel, publicKey })
          break
        default:
          coredebug("store-post: unknown post type &d", postType)
      }
    })

    this.events.register("core", this, "live-request-ended", (reqidHex) => {
      livedebug("live query concluded for %s", reqidHex)
      this._sendConcludingHashResponse(b4a.from(reqidHex, "hex"))
    })
  }

  _emitUsers(eventName, obj) {
    this.emit(`users/${eventName}`, obj)
  }
  _emitChannels(eventName, obj) {
    this.emit(`channels/${eventName}`, obj)
  }
  _emitChat(eventName, obj) {
    this.emit(`chat/${eventName}`, obj)
  }

  /* event sources */
  // users events:
  //  name-changed -  emit(pubkey, name)
  //  new-user -      emit(pubkey, [joinedChannels?])
  // chat events:
  //  add - emit(channel, post, hash)
  //  remove - emit(channel, hash)
  // channels events:
  //  add - emit(channel)
  //  join - emit(channel, pubkey)
  //  leave - emit(channel, pubkey)
  //  topic - emit(channel, topic)
  //  archive - emit(channel)
  // network events:
  //  connection 
  //  join - emit(peer)
  //  leave - emit(peer)
  //  data - emit(data, {address, data})

  // this function is part of "live query" behaviour of the channel state request (when future = 1) 
  // and the channel time range request (when timeEnd = 0)
  // note: `timestamp` === -1 if event channel-state-replacement called this function (the timestamp only matters for
  // channel time range request, which will always set it)
  _sendLiveHashResponse(channel, postType, hashes, timestamp) {
    const reqidList = this._getLiveRequests(channel)
    reqidList.forEach(reqid => {
      const requestInfo = this.requestsMap.get(reqid.toString("hex"))
      coredebug("requestInfo for reqid %O: %O", reqid, requestInfo)
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
      livedebug("dispatch response with %d hashes %O", hashes.length, response)
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
  _updateNewestHeads(channel, buf, done) {
    const bufHash = this.hash(buf)
    // we're storing a new post we have *just* created -> we *know* this is our latest heads for the specified channel
    this.store.linksView.api.setNewHeads(channel, [bufHash], () => {
      // update the newest heads
      this.heads.set(channel, [bufHash])
      done()
    })
  }

  getReverseLinks(hashes, done) {
    if (!done) { return }
    const promises = []
    const rlinks = new Map()
    for (const hash of hashes) {
      promises.push(new Promise((res, rej) => {
        console.error(this.store.linksView)
        this.store.linksView.api.getReverseLinks(hash, (err, retLinks) => {
          if (retLinks) {
            rlinks.set(hash, retLinks.map(h => b4a.toString(h, "hex")))
            res()
          }
        })
      }))
    }
    Promise.all(promises).then(() => {
      done(null,  rlinks)
    })
  }

	// post/text
	postText(channel, text, done) {
    if (!done) { done = util.noop }
    const links = this._links(channel)
    const buf = TEXT_POST.create(this.kp.publicKey, this.kp.secretKey, links, channel, util.timestamp(), text)
    this.store.text(buf, () => { this._updateNewestHeads(channel, buf, done) })
    return buf
  }

	// post/info key=name
	setName(name, done) {
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
    this.store.topic(buf, () => { this._updateNewestHeads(channel, buf, done) })
    return buf
  }

	// post/join
	join(channel, done) {
    if (!done) { done = util.noop }
    const links = this._links(channel)
    const buf = JOIN_POST.create(this.kp.publicKey, this.kp.secretKey, links, channel, util.timestamp())
    this.store.join(buf, () => { this._updateNewestHeads(channel, buf, done) })
    return buf
  }

	// post/leave
	leave(channel, done) {
    if (!done) { done = util.noop }
    const links = this._links(channel)
    const buf = LEAVE_POST.create(this.kp.publicKey, this.kp.secretKey, links, channel, util.timestamp())
    this.store.leave(buf, () => { this._updateNewestHeads(channel, buf, done) })
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
    const buf = DELETE_POST.create(this.kp.publicKey, this.kp.secretKey, links, util.timestamp(), [hash])
    this.store.del(buf, done)
    return buf
  }

  delMany(hashes, done) {
    if (!done) { done = util.noop }
    // TODO (2023-06-11): decide what do with links for post/delete (lacking channel info)
    const links = this._links()
    const buf = DELETE_POST.create(this.kp.publicKey, this.kp.secretKey, links, util.timestamp(), hashes)
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

  // resolves hashes into post objects. note: all post objects that are returned from cable-core will have their buffer
  // instances be converted to hex strings 
  resolveHashes(hashes, cb) {
    this._getData(hashes, (err, bufs) => {
      const posts = []
      bufs.forEach((buf, index) => {
        if (buf !== null) { 
					const post = cable.parsePost(buf)
          // deviating from spec behaviour!
          // 1. add a 'hash' key to each resolved hash.
          // this allows downstream clients to refer to a particular post and act on it
          post["postHash"] = hashes[index].toString("hex")
          // 2. convert to hex string instead of buffer instance
          post.links = post.links.map(l => l.toString("hex"))
          post.publicKey = post.publicKey.toString("hex")
          post.signature = post.signature.toString("hex")
          posts.push(post) 
        } else {
          posts.push(null)
        }
      })
      cb(null, posts)
    })
  }

  _getData(hashes, cb) {
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
        const hashes = Array.from(new Set(results.flatMap(item => item))).filter(item => typeof item !== "undefined")
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
    coredebug("_removeRequest: remove %O", reqid)
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
    coredebug("request posts for %s (reqid %s)", channel, reqid.toString("hex"))
    const req = cable.TIME_RANGE_REQUEST.create(reqid, ttl, channel, start, end, limit)
    this.dispatchRequest(req)
    return req
  }

  // -> request post/topic, post/join, post/leave, post/info
  // future is either 0 or 1, 1 if we want to request future posts
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
      "origin": false,
      "binary": null
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

  _registerRequest(reqid, origin, type, obj, buf) {
    if (this.requestsMap.has(reqid)) {
      coredebug(`request map already had reqid %O`, reqid)
      return
    }
    // TODO (2023-03-23): handle recipients at some point
    // entry.recipients.push(peer)
    const entry = this._reqEntryTemplate(obj)
    entry.origin = origin
    entry.binary = buf
    this.requestsMap.set(reqid.toString("hex"), entry)
  }

  // register a request that is originating from the local node, sets origin to true
  _registerLocalRequest(reqid, reqType, buf) {
    const reqidHex = reqid.toString("hex")
    const obj = cable.parseMessage(buf)
    coredebug("register local %O", obj)
    // before proceeding: investigate if we have prior a live request for the target channel.
    // requests that can be considered live: channel time range with time_end = 0 or channel state with future = 1 
    switch (reqType) {
        case constants.TIME_RANGE_REQUEST:
        case constants.CHANNEL_STATE_REQUEST:
        coredebug("register local: had channel state or time range with target %s", obj.channel)
        // find out if we already have such requests for this channel in flight and alive
        const localLiveRequests = []
        for (const entry of this.requestsMap.values()) {
          // we only want to operate on our own requests for the given channel
          if (entry.obj.msgType === reqType && entry.origin && (entry.obj.channel === obj.channel)) {
            localLiveRequests.push(entry.obj.reqid.toString("hex"))
          }
        }
        // if we have found any local live requests, this will send a request to cancel them
        localLiveRequests.forEach(liveid => { 
          coredebug("canceling prior live request %s since it has been superceded by %s", liveid, reqidHex)
          this.cancelRequest(b4a.from(liveid, "hex")) 
        })
        break
      default: 
        // pass; no other requests can be considered 'live' as of writing
    }
    this._registerRequest(reqid, true, reqType, obj, buf)
  }

  // keeping track of requests
  // * live requests (future=1, time_end = 0)
  // * in progress requests, waiting for their response
  // * local requests which are to succeed any live request currently made on the same channel

  // register a request that originates from a remote node, sets origin to false
  _registerRemoteRequest(reqid, reqType, buf) {
    const obj = cable.parseMessage(buf)
    this._registerRequest(reqid, false, reqType, obj, buf)
  }

  /* methods that deal with responding to requests */
  // TODO (2023-08-15): wherever we clearly conclude a received request - make sure it is removed from requestsMap /
  // this._removeRequest(reqid) is called
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
    coredebug("request obj", obj)
    this._registerRemoteRequest(reqid, reqType, req)
    if (obj.ttl > 0) { this.forwardRequest(req) }

    // create the appropriate response depending on the request we're handling
    let promise = new Promise((res, rej) => {
      let response
      switch (reqType) {
        case constants.CANCEL_REQUEST:
          // first remove the request that was canceled
          this._removeRequest(obj.cancelid)
          // then make sure the cancel request itself is not persisted, as it has been handled
          this._removeRequest(obj.reqid)
          // note: there is no corresponding response for a cancel request
          return res(null)
        case constants.POST_REQUEST:
          // get posts corresponding to the requested hashes
          this._getData(obj.hashes, (err, posts) => {
            if (err) { return rej(err) }
            const responses = []
            // hashes we could not find in our database are represented as null: filter those out
            const responsePosts = posts.filter(post => post !== null)
            response = cable.POST_RESPONSE.create(reqid, responsePosts)
            responses.push(response)
            coredebug("post response: prepare concluding post response for %O", reqid)
            const finalResponse = cable.POST_RESPONSE.create(reqid, [])
            responses.push(finalResponse)
            this._removeRequest(reqid)
            return res(responses)
          })
          break
        case constants.TIME_RANGE_REQUEST:
          coredebug("create a response for channel time range request using params in %O", obj)
          // if obj.timeEnd === 0 => keep this request alive
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
              // timeEnd !== 0 => not keeping this request alive + we've returned everything we have: 
              // conclude it by sending a hash response with hashes=[] to signal end of request & remove request
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
          coredebug("channel list request: (%O) start preparing response", reqid)
          this.store.channelMembershipView.api.getChannelNames(obj.offset, obj.limit, (err, channels) => {
            if (err) { return rej(err) }
            // get a list of channel names
            response = cable.CHANNEL_LIST_RESPONSE.create(reqid, channels)
            coredebug("channel list request: (%O) response prepared, sending back %s", reqid, channels)
            this._removeRequest(reqid)
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
  }

  /* methods for emitting data outwards (responding, forwarding requests not for us) */
  // TODO (2023-08-09): hook up response / requests to swarm/peers logic
  dispatchResponse(buf) {
    this.emit("response", buf)
    this.swarm.broadcast(buf)
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
    this.swarm.broadcast(buf)
  }

  _handleIncomingMessage(buf) {
    const msgType = cable.peekMessage(buf)
    if (this._messageIsRequest(msgType)) {
      coredebug("message:", util.humanizeMessageType(msgType))
      this.handleRequest(buf)
      return
    } else if (this._messageIsResponse(msgType)) {
      coredebug("message:", util.humanizeMessageType(msgType))
      this.handleResponse(buf)
      return
    }
  }

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
    if (channel === REQID_TO_CHANNELS) { return } 

    const reqidMap = this.liveQueries.get(REQID_TO_CHANNELS)
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
    this.liveQueries.set(channel, arr)
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
    livedebug("cancel live state request for reqid %s", reqidHex)
    const channel = this.liveQueries.get(REQID_TO_CHANNELS).get(reqidHex)
    if (!channel) {
      livedebug("cancel live request could not find channel for reqid %s", reqidHex)
      return
    }
    let channelQueries = this.liveQueries.get(channel)
    if (!channelQueries) { 
      livedebug("channel queries was empty for channel %s (reqid %s)", channel, reqidhex)
      return
    }
    const index = channelQueries.findIndex(item => item.reqid === reqidHex)
    if (index < 0) {
      livedebug("cancel live request could not find entry for reqid %s", reqidHex)
      return 
    }
    // remove the entry tracking this particular req_id: delete 1 item at `index`
    channelQueries.splice(index, 1)

    // there are no longer any live queries being tracked for `channel`, stop tracking it
    if (channelQueries.length === 0) {
      this.liveQueries.delete(channel)
    } else {
      this.liveQueries.set(channel, channelQueries)
    }
    this.liveQueries.get(REQID_TO_CHANNELS).delete(reqidHex)
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
  }

  forwardResponse(buf) {
    coredebug("todo forward response", buf)
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
    coredebug("post response length", obj.posts.length)
    obj.posts.forEach(post => {
      const hash = crypto.hash(post)
      coredebug("post", cable.parsePost(post))
      // we wanted this post!
      if (this.requestedHashes.has(hash.toString("hex"))) {
        requestedPosts.push(post)
        // the hashes will be removed from the set requestedHashes later on, by _handleRequestedBufs, once the hashes
        // are confirmed to have been stored. if we clear them now we'll risk causing additional unnecessary hash
        // requests since they'll be regarded as missing if we query the blobs store for the hashes
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
        res()
      })
      promises.push(p)
      Promise.all(promises).then(() => { 
        done() 
      })
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
      coredebug("incoming response (reqid %s) was not a response type, dropping", reqidHex)
      return done()
    }

    // if we don't know about a reqid, then the corresponding response is not something we want to handle
    if (!this.requestsMap.has(reqidHex)) {
      coredebug("reqid %s was unknown, dropping response", reqidHex)
      return done()
    }

    const entry = this.requestsMap.get(reqidHex)

    if (entry.resType === resType) {
      coredebug("response for id %O is of the type expected when making the request", reqid)
    } else {
      coredebug("response for id %O does not have the expected type (was %d, expected %d)", reqid, resType, entry.resType)
    }

    const obj = cable.parseMessage(res)
    coredebug("response %s, obj :%O", util.humanizeMessageType(obj.msgType), obj)

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
          //
        })
      }
      return done()
    }
 
    // process the response according to what type it was
    switch (resType) {
      case constants.HASH_RESPONSE:
        coredebug("hash response length", obj.hashes.length)
        // hash response has signalled end of responses, deallocate reqid
        if (obj.hashes.length === 0) {
          this._removeRequest(reqid)
          return done()
        }
        // TODO (2023-08-16): make sure this doesn't create any conflicts, where e.g. the peer we requested hashes from goes
        // offline and then we never request them again during the session! one mechanism we could have is, if we know
        // we haven't received any hashes in requestedHashes for a long period of time is fire off another post request
        // for those hashes
        //
        // only want to query (and thereby request, if we lack them) hashes that are not already requested
        const hashesToQuery = obj.hashes.filter(h => !this.requestedHashes.has(h.toString("hex")))
        // query data store and try to get the data for each of the returned hashes. 
        this.store.blobs.api.getMany(hashesToQuery, (err, bufs) => {
          // collect all the hashes we still don't have data for (represented by null in returned `bufs`) and create a
          // post request
          let wantedHashes = []
          bufs.forEach((buf, index) => {
            if (buf === null) {
              // we don't have the hash represented by hashes[index]: good! we want to request it.
              const hash = hashesToQuery[index]
              wantedHashes.push(hash)
              // remember the requested hashes
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
            // track inflight hashes
            wantedHashes.forEach(h => this.requestedHashes.add(h.toString("hex")))
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
        // handle empty post response as a signal that "this concludes the lifetime of this req-res chain" 
        if (obj.posts.length === 0) {
          // action: decommission the reqid
          coredebug("post response done, removing %O", reqid)
          this._removeRequest(reqid)
          done()
          return
        } else {
          this._handleRequestedBufs(this._processPostResponse(obj), () => { 
            done()
          })
        }
        break
      case constants.CHANNEL_LIST_RESPONSE:
        this._indexNewChannels(obj.channels, (err) => {
          this._emitChannels("add", { channels: obj.channels })
          done(err)
        })
        coredebug("received channel list response, removing request %O", reqid)
        this._removeRequest(reqid)
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

module.exports = { CableCore, CableStore, EventsManager }
