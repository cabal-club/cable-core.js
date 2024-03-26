// SPDX-FileCopyrightText: 2023 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// node core dependencies
const EventEmitter = require('events').EventEmitter
// external dependencies
const b4a = require("b4a")
const coredebug = require("debug")("core:core")
const livedebug = require("debug")("core:live")
// internal dependencies (deps made by us :)
const cable = require("cable.js")
const crypto = require("cable.js/cryptography.js")
const constants = require("cable.js/constants.js")
const util = require("./util.js")
const CableStore = require("./store.js")
const EventsManager = require("./events-manager.js")
const Swarm = require("./peers.js").Swarm
const LiveQueries = require("./live-queries.js")
const { ModerationRoles, ModerationSystem } = require("./moderation.js")

// aliases
const TEXT_POST = cable.TEXT_POST
const DELETE_POST = cable.DELETE_POST
const INFO_POST = cable.INFO_POST
const TOPIC_POST = cable.TOPIC_POST
const JOIN_POST = cable.JOIN_POST
const LEAVE_POST = cable.LEAVE_POST
const ROLE_POST = cable.ROLE_POST
const MODERATION_POST = cable.MODERATION_POST
const BLOCK_POST = cable.BLOCK_POST
const UNBLOCK_POST = cable.UNBLOCK_POST

class CableCore extends EventEmitter {
  #moderationReady

  constructor(level, opts) {
    super()
    if (!opts) { opts = {} }
    if (!opts.storage) { coredebug("no storage passed in") }
    if (!opts.network) { coredebug("no network transports passed in; will use transport shim") }
    if (!opts.port) { opts.port = 13331 }
    coredebug("opts", opts)
    // i.e. the network of connections with other cab[a]l[e] peers
    this.swarm = new Swarm(opts.key, opts)
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
      
      localRequests.forEach(req => { 
        const obj = cable.parseMessage(req)
        coredebug("requesting %s with reqid %O (%O)", util.humanizeMessageType(cable.peekMessage(req)), obj.reqid, req) 
      })
      localRequests.forEach(req => { this.swarm.broadcast(req) })
    })
    // assert if we are passed a keypair while starting lib and if format is correct (if not we generate a new kp)
    // TODO (2023-09-01): also persist keypair in e.g. cable-client/cli
    const validKeypair = (
      opts.keypair && opts.keypair.publicKey && opts.keypair.secretKey && 
      b4a.isBuffer(opts.keypair.publicKey) && 
      opts.keypair.publicKey.length === constants.PUBLICKEY_SIZE && 
      b4a.isBuffer(opts.keypair.secretKey) && 
      opts.keypair.secretKey.length === constants.SECRETKEY_SIZE
    )
    if (validKeypair) {
      this.kp = opts.keypair
      coredebug("using opts.keypair as keypair")
    } else {
      this.kp = crypto.generateKeypair()
      coredebug("generated new keypair")
    }

    this.events = new EventsManager()

    this.store = new CableStore(level, this.kp.publicKey, { storage: opts.storage })
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
    this._defaultTTL = 0
    this.live = new LiveQueries(this)

    // call rolesComputer.analyze(<all relevant post/role operations>) to receive a map of which users have which roles
    // in what channels (or on the cabal itself) for the entire cabal
    this.rolesComputer = new ModerationRoles(this.kp.publicKey)
    // `this.activeRoles = rolesComputer.analyze(operations)` i.e. analyze's output will be stored in `this.activeRoles`
    this.activeRoles = new Map() 
    // `this.moderationActions` keeps track of moderation actions (post/moderation, post/block, post/unblock) across channel contexts with methods to get state regarding
    // users, posts, and channels
    this.moderationActions = new ModerationSystem()

    this.#moderationReady = new util.Ready("moderation")
    this.#moderationReady.increment()
    // get the latest moderation state and apply it
    this.store.rolesView.api.getRelevantRoleHashes((err, hashes) => {
      if (err || hashes.length === 0) { 
        // if we have no roles set let's operate on nothing to set the local user as a default admin in all known
        // channels
        this.activeRoles = this.rolesComputer.analyze([])
        return this.#moderationReady.decrement()
      }
      this._getData(hashes, (err, bufs) => {
				const ops = bufs.map(cable.parsePost)
        this.activeRoles = this.rolesComputer.analyze(ops)
        this.#moderationReady.decrement()
      })
    })

    // get the latest roles and compute the final roles applied for the local user's pov
    this.#moderationReady.increment()
    this.store.actionsView.api.getAllApplied((err, hashes) => {
      if (err || hashes.length === 0) {
        coredebug("first read moderation actions ops length 0 (err = %O)", err)
        return this.#moderationReady.decrement()
      }
      this._getData(hashes, (err, bufs) => {
				const ops = bufs.map(cable.parsePost)
        coredebug("first read moderation actions ops %O", ops)
        this.moderationActions.process(ops)
        this.#moderationReady.decrement()
				coredebug("moderation actions done", this.moderationActions)
      })
    })

    this.#moderationReady.call(() => {
      // event `moderation/init` signals that anything and everything moderation has finished initializing and can be
      // relied on :]
			coredebug("FIRE MOD")
      this._emitModeration("init")
    })

    const _emitStoredPost = (obj, hash) => {
      // TODO (2023-08-18): how to know when:
      // * a new user joined?
      // * a new channel was added?
      const publicKey = util.hex(obj.publicKey)
      // emit contextual events depending on what type of post was stored
      switch (obj.postType) {
        case constants.TEXT_POST:
          this._emitChat("add", { channel: obj.channel, publicKey, hash: util.hex(hash), post: obj })
          break
        case constants.DELETE_POST:
          this._emitChat("remove", { channel: obj.channel, publicKey, hash: util.hex(hash) })
          break
        case constants.INFO_POST:
          if (obj.info.has("name")) {
            this._emitUsers("name-changed", {publicKey, name: obj.info.get("name")})
          } else {
            coredebug("store-post: unknown key for post/info (keys: %O)", [...obj.info.keys()])
          }
          break
        case constants.TOPIC_POST:
          this._emitChannels("topic", { channel: obj.channel, topic: obj.topic, publicKey })
          break
        case constants.JOIN_POST:
          this._emitChannels("join", { channel: obj.channel, publicKey })
          break
        case constants.LEAVE_POST:
          this._emitChannels("leave", { channel: obj.channel, publicKey })
          break
        case constants.ROLE_POST:
          this._emitModeration("role", { publicKey, role: obj.role, recipient: util.hex(obj.recipient), reason: obj.reason,
            channel: obj.channel || constants.CABAL_CONTEXT })
          break
        case constants.MODERATION_POST:
          this._emitModeration("action", { publicKey, action: obj.action, recipients: obj.recipients.map(util.hex), 
            reason: obj.reason, channel: obj.channel || constants.CABAL_CONTEXT })
          break
        case constants.BLOCK_POST:
          this._emitModeration("block", { publicKey, recipients: obj.recipients.map(util.hex), reason: obj.reason })
          break
        case constants.UNBLOCK_POST:
          this._emitModeration("unblock", { publicKey, recipients: obj.recipients.map(util.hex), reason: obj.reason })
          break
        default:
          coredebug("store-post: unknown post type %d", obj.postType)
      }
    }

    // obj is the json encoded post/role, with isAdmin attached
    this.events.register("store", this.store, "roles-update", ({ recipient, channel, role }) => {
      // we want to be able to:
      // * diff what the user's current (prev) role is (i.e. their representation in this.rolesComputer) with their new role
      // * discern which context the change happened in: cabal context or a channel

      const updateRolesComputer = () => {
        this.store.rolesView.api.getRelevantRoleHashes((err, hashes) => {
          coredebug("update roles computer %d hashes returned", hashes.length)
          if (hashes.length === 0) { return }
          this._getData(hashes, (err, bufs) => {
            const ops = bufs.map(cable.parsePost)
            coredebug("returned ops %O", ops)
            this.activeRoles = this.rolesComputer.analyze(ops)
            coredebug("active roles %O", this.activeRoles)
            this._emitModeration("roles-update", util.transformUserRoleMapScheme(this.activeRoles))
          })
        })
      }
      
      let performDemote = false
      const context = channel.length ? constants.CABAL_CONTEXT : channel
      // .get(recipient) returns { role: integer, since: timestamp, [precedence] }
      if (this.activeRoles.get(context)?.has(recipient)) {
        const prev = this.activeRoles.get(constants.CABAL_CONTEXT).get(recipient)
        performDemote = prev.role === constants.ADMIN_FLAG && prev.role > role
      }

      if (performDemote) { // -- full update incoming
        this.store.rolesView.api.demoteAdmin(demotedKey, context, updateRolesComputer)
      } else {
      // TODO (2024-03-11): replace full replacement with more efficient (but potentially error-prone) in-place patching
        updateRolesComputer()
      }
      //   // -- in place patching of activeRoles!
      //   const newRoleTs = { role, since: timestamp, precedence: b4a.equals(authorKey, this.kp.publicKey) }
      //
      //   if (context === constants.CABAL_CONTEXT && role === constants.ADMIN_FLAG) {
      //     for (const chan of this.activeRoles) {
      //       if (this.activeRoles.has(recipient)) {
      //         this.activeRoles.get(context).set(recipient, newRoleTs)
      //       }
      //     }
      //   }
      //
      //   if (this.activeRoles.has(context)) {
      //     if (this.activeRoles.get(context).has(recipient)) {
      //       this.activeRoles.get(context).set(recipient, newRoleTs)
      //     }
      //   }
      // }

      // determine if full update of `this.rolesComputer` is required or if a simple patch will do 
      // (e.g. adding a new admin is a patch as it has no far-reaching consequences yet; removing an admin has consequences)
      //
      // patch situations: 
      // * user without any assigned roles is made an mod|admin
      // * user that is a mod is made an admin
      // * note: adding an admin on the cabal context requires patching all channels of rolesComputer
      // * ? mod (mod->user) is demoted?
      //
      // full update situations:
      // * an admin is demoted (admin->mod; admin->user) 
      //   - should we detect this here? and then perform the sequence:
      //   -- store.rolesView.demoteAdmin, AND THEN, once that is done
      //   -- store.rolesView.getRelevantRoleHashes() -> resolveHashes, and finally perform 
      //   -- rolesComputer.analyze(ops)
      // * note: it may be the case that it's only when an admin is demoted that requires a full update; test this
      //         thought
      //
      // TODO (2024-03-07): test situation where a mod at time T_1 does some moderation actions and then later at T_2 they are
      // elevated to being an admin. their previous actions should remain applied, despite having a "newer" timestamp of
      // when they acceded their latest role
    })

    this.events.register("store", this.store, "actions-update", (action) => {
      this.moderationActions.process([action])
      this._emitModeration("actions-update", action)
      // in core we are required to be able to track:
      //
      // * dropped {users, posts, channels} for knowing how to handle incoming posts
      // * blocked users
      //
      // i.e. we don't need necessarily need to maintain a list of hide operations at the core level; we just need to be
      // able to respond to clients with that information
    })

    this.events.register("store", this.store, "channel-state-replacement", ({ channel, postType, hash }) => {
      livedebug("channel-state-replacement evt (channel: %s, postType %i, hash %O)", channel, postType, hash)
      // set timestamp to -1 because we don't have it when producing a channel-state-replacement, 
      // and timestamp only matters for correctly sending hash responses for channel time range requests 
      // (i.e. not applicable for channel state requests)
      this.live.sendLiveHashResponse(channel, postType, [hash], -1)
      // TODO (2023-09-07): also emit the newly reindexed post?
      this.resolveHashes([hash], (err, results) => {
        const obj = results[0]
        if (obj === null) { 
          coredebug("channel-state-replacement: tried to fetch post using %O; nothing in store", hash)
          return 
        }
        _emitStoredPost(obj, hash)
      })

    })

    this.events.register("store", this.store, "store-post", ({ obj, channel, timestamp, hash, postType }) => {
      coredebug("store post evt [%s], post type: %d", channel, postType)
      this.live.sendLiveHashResponse(channel, postType, [hash], timestamp)
     
      _emitStoredPost(obj, hash)
    })

    this.events.register("live", this.live, "live-request-ended", (reqidHex) => {
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
  _emitModeration(eventName, obj) {
    this.emit(`moderation/${eventName}`, obj)
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
        this.store.linksView.api.getReverseLinks(hash, (err, retLinks) => {
          if (retLinks) {
            rlinks.set(hash, retLinks.map(h => util.hex(h)))
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
    // TODO (2023-09-06): current behaviour links to e.g. post/join and not only post/text
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
    // TODO (2024-03-05): get / use the local user's currently set `accept-role` (if any!) and, if set, pass it along to `INFO_POST.create`
    const buf = INFO_POST.create(this.kp.publicKey, this.kp.secretKey, links, util.timestamp(), [["name", name]])
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
    coredebug("join channel %s", channel)
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

  assignRole(recipient, channel, timestamp, role, reason, privacy, done) {
    if (!done) { done = util.noop }
    const links = [] /*this._links(channel)*/
    const buf = cable.ROLE_POST.create(this.kp.publicKey, this.kp.secretKey, links, channel, timestamp, b4a.from(recipient, "hex"), role, reason, privacy)
    this.store.role(buf, util.isAdmin(this.kp, buf, this.activeRoles), done)
    return buf
  }

  moderatePosts (postids, action, reason, privacy, timestamp, done) {
    if (!done) { done = util.noop }
		switch (action) {
			case constants.ACTION_HIDE_POST:
			case constants.ACTION_UNHIDE_POST:
			case constants.ACTION_DROP_POST:
			case constants.ACTION_UNDROP_POST:
				break
			default:
				throw new Error("`action` was not related to acting on a post")
		}
    const channel = ""
    const recipients = postids.map(pid => b4a.from(pid, "hex"))
    const links = [] /*this._links(channel)*/
    const buf = cable.MODERATION_POST.create(this.kp.publicKey, this.kp.secretKey, links, channel, timestamp, recipients, action, reason, privacy)
    this.store.moderation(buf, util.isApplicable(this.kp, buf, this.activeRoles), done)
    return buf
  }

  moderateChannel (channel, action, reason, privacy, timestamp, done) {
		if (!done) { done = util.noop }
		switch (action) {
			case constants.ACTION_DROP_CHANNEL:
			case constants.ACTION_UNDROP_CHANNEL:
				break
			default:
				throw new Error("`action` was not related to acting on a channel")
		}
    const recipients = []
    const links = [] /*this._links(channel)*/
    const buf = cable.MODERATION_POST.create(this.kp.publicKey, this.kp.secretKey, links, channel, timestamp, recipients, action, reason, privacy)
    this.store.moderation(buf, util.isApplicable(this.kp, buf, this.activeRoles), done)
    return buf
  }

  blockUsers (recipients, drop, notify, reason, privacy, timestamp, done) {
    if (!done) { done = util.noop }
    const links = [] /*this._links(channel)*/
		const buf = cable.BLOCK_POST.create(this.kp.publicKey, this.kp.secretKey, links, timestamp, recipients, drop, notify, reason, privacy)
		this.store.block(buf, util.isApplicable(this.kp, buf, this.activeRoles), done)
		return buf
	}

  unblockUsers (recipients, undrop, reason, privacy, timestamp, done) {
    if (!done) { done = util.noop }
    const links = [] /*this._links(channel)*/
		const buf = cable.UNBLOCK_POST.create(this.kp.publicKey, this.kp.secretKey, links, timestamp, recipients, undrop, reason, privacy)
		this.store.unblock(buf, util.isApplicable(this.kp, buf, this.activeRoles), done)
		return buf
	}

  moderateUsers (recipients, channel, action, reason, privacy, timestamp, done) {
		if (!done) { done = util.noop }
		switch (action) {
			case constants.ACTION_HIDE_USER:
			case constants.ACTION_UNHIDE_USER:
				break
			default:
				throw new Error("`action` was not related to hiding/unhiding a user")
		}
    const recipientsBufs = recipients.map(uid => b4a.from(uid, "hex"))
		const links = [] /*this._links(channel)*/
		const buf = cable.MODERATION_POST.create(this.kp.publicKey, this.kp.secretKey, links, channel, timestamp, recipientsBufs, action, reason, privacy)
		this.store.moderation(buf, util.isApplicable(this.kp, buf, this.activeRoles), done)
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
  getName(cb) {
    this.store.userInfoView.api.getLatestInfoHash(this.kp.publicKey, (err, hash) => {
      if (err) { return cb(err) }
      this.resolveHashes([hash], (err, results) => {
        if (err) { return cb(err) }
        const obj = results[0]
        let name = constants.INFO_DEFAULT_NAME
        if (obj.info.has("name")) {
          name = obj.info.get("name")
        }
        cb(null, name)
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
      // set placeholder defaults for all known public keys
      publicKeys.forEach(publicKey => {
        users.set(util.hex(publicKey), { name: "", acceptRole: constants.INFO_DEFAULT_ACCEPT_ROLE })
      })
      this.store.userInfoView.api.getLatestInfoHashAllUsers((err, latestInfoHashes) => {
        if (err) return cb(err)
        this.resolveHashes(latestInfoHashes, (err, posts) => {
          // TODO (2023-09-06): handle post/info deletion and storing null?
          posts.filter(post => post !== null).forEach(post => {
            if (post.postType !== constants.INFO_POST) { return }
            // prepare default values 
            let nameValue = constants.INFO_DEFAULT_NAME
            let acceptRoleValue = constants.INFO_DEFAULT_ACCEPT_ROLE
            if (post.info.has("name")) {
              nameValue = post.info.get("name")
            }
            if (post.info.has("accept-role")) {
              acceptRoleValue = post.info.get("accept-role")
            }
            users.set(post.publicKey, { name: nameValue, acceptRole: acceptRoleValue })
            // public key had a post/info:name -> use it
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

  getRoles(channel, cb) {
    this.#moderationReady.call(() => {
      const context = channel === "" ? constants.CABAL_CONTEXT : channel
      const emptyRoles = new Map()
      if (this.activeRoles.has(context)) {
        return cb(null, this.activeRoles.get(context))
      }
      return cb(null, emptyRoles)
    })
  }

  getAllRoles(cb) {
    if (!cb) return
    // returns a map with the scheme: Map[pubkey] => Map[channel] -> role
    this.#moderationReady.call(() => {
      const userMap = util.transformUserRoleMapScheme(this.activeRoles)
      return cb(null, userMap)
    })
  }

  getAllModerationActions(cb) {
    if (!cb) return
    this.#moderationReady.call(() => {
      cb(null, this.moderationActions)
    })
  }

  // get all relevant roles + get all relevant actions (used for answering requests)
  getRelevantModerationHashes(ts, channels, cb) {
    // TODO (2024-03-25): when handling a moderation state request and fashioning a responce, verify the conformance of
    // requirements for moderation state request wrt "belonging to at least one channel"
   
    // query the actions view to get all matching moderation actions
    const promises = []
    promises.push(new Promise((res, rej) => {
      this.store.actionsView.api.getRelevantByContextsSince(ts, channels, (err, hashes) => {
        coredebug("relmod actions hashes %O", hashes)
        if (err) return rej(err)
        return res(hashes)
      })
    }))
    // query the roles view to get all matching roles
    promises.push(new Promise((res, rej) => {
      this.store.rolesView.api.getAllByContextsSinceTime(ts, channels, (err, hashes) => {
        coredebug("relmod role hashes %O", hashes)
        if (err) return rej(err)
        return res(hashes)
      })
    }))
    // wait until both view calls have returned their results, collect them and pass to the callback
    Promise.all(promises).then((results) => {
      coredebug("relmod results %O", results)
      const flat = results.flatMap(h => h)
      coredebug("flattened %O", flat)
      cb(results.flatMap(h => h))
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
          // deviating from spec-defined fields!
          // 1. add a 'postHash' key to each resolved hash.
          // this allows downstream clients to refer to a particular post and act on it
          post["postHash"] = util.hex(hashes[index])
          // 2. convert to hex string instead of buffer instance
          post.links = post.links.map(l => util.hex(l))
          post.publicKey = util.hex(post.publicKey)
          post.signature = util.hex(post.signature)
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
        this.store.userInfoView.api.getLatestInfoHashMany(pubkeys, (err, nameHashes) => {
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
    const reqidHex = util.hex(reqid)
    // cancel any potential ongoing live requests
    this.live.cancelLiveStateRequest(reqidHex)
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

  // <-> getRelevantModerationHashes
  requestModeration(ttl, channels, future, oldest) {
    const reqid = crypto.generateReqID()
    const req = cable.MODERATION_STATE_REQUEST.create(reqid, ttl, channels, future, oldest)
    this.dispatchRequest(req)
    return req
  }

  // <-> getChat
  requestPosts(channel, start, end, ttl, limit) {
    const reqid = crypto.generateReqID()
    coredebug("request posts for %s (reqid %s)", channel, util.hex(reqid))
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
      case constants.MODERATION_STATE_REQUEST:
        entry.resType = constants.HASH_RESPONSE
        break
      default:
        throw new Error(`make request: unknown reqType (${reqType})`)
    }
    return entry
  }

  _registerRequest(reqid, origin, type, obj, buf) {
    if (this._isReqidKnown(reqid)) {
      coredebug(`request map already had reqid %O`, reqid)
      return
    }
    // TODO (2023-03-23): handle recipients at some point
    // entry.recipients.push(peer)
    const entry = this._reqEntryTemplate(obj)
    entry.origin = origin
    entry.binary = buf
    this.requestsMap.set(util.hex(reqid), entry)
  }

  // register a request that is originating from the local node, sets origin to true
  _registerLocalRequest(reqid, reqType, buf) {
    const reqidHex = util.hex(reqid)
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
            localLiveRequests.push(util.hex(entry.obj.reqid))
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
    const reqidHex = util.hex(reqid)

    // check if message is a request or a response
    if (!this._messageIsRequest(reqType)) {
      coredebug("message is not a request (msgType %d)", reqType)
      return done()
    }

    // deduplicate the request: if we already know about it, we don't need to process it any further
    if (this._isReqidKnown(reqid)) {
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
          // potentially index a new channel we didn't know about as a result of someone making this request
          this._indexNewChannels([obj.channel])
          coredebug("create a response for channel time range request using params in %O", obj)
          // if obj.timeEnd === 0 => keep this request alive
          if (obj.timeEnd === 0) {
            const hasLimit = obj.limit !== 0
            this.live.addLiveStateRequest(obj.channel, obj.reqid, obj.limit, hasLimit)
          }
          // get post hashes for a certain channel & time range
          this.store.getChannelTimeRange(obj.channel, obj.timeStart, obj.timeEnd, obj.limit, (err, hashes) => {
            if (err) { return rej(err) }
            const responses = []
            if (hashes && hashes.length > 0) {
              response = cable.HASH_RESPONSE.create(reqid, hashes)
              responses.push(response)
            }
            // timeEnd !== 0 => not keeping this request alive + we've returned everything we have: 
            // conclude it by sending a hash response with hashes=[] to signal end of request & remove request
            if (obj.timeEnd > 0) {
              coredebug("time-range-request: prepare concluding hash response for %O", reqid)
              response = cable.HASH_RESPONSE.create(reqid, [])
              responses.push(response)
              this._removeRequest(reqid)
            }
            // no hashes to return but also want to keep this alive -> not returning anything
            if (hashes.length === 0 && obj.timeEnd === 0) {
              return res(null)
            }
            return res(responses)
          })
          break
        case constants.CHANNEL_STATE_REQUEST:
          // potentially index a new channel we didn't know about as a result of someone making this request
          this._indexNewChannels([obj.channel])
          // if obj.future === 1 => keep this request alive
          if (obj.future === 1) {
            // it has no implicit limit && updatesRemaining does not apply
            this.live.addLiveStateRequest(obj.channel, obj.reqid, 0, false)
          }
          // get channel state hashes
          this.getChannelStateHashes(obj.channel, (err, hashes) => {
            if (err) { return rej(err) }
            const responses = []
            if (hashes && hashes.length > 0) {
              response = cable.HASH_RESPONSE.create(reqid, hashes)
              responses.push(response)
            } 

            coredebug("channel-state-request [%s] (%s): responding with %d hashes - %O", obj.channel, util.hex(reqid), hashes.length, hashes)
            if (hashes.length) {
              this._getData(hashes, (err, bufs) => {
                const posts = bufs.map(cable.parsePost)
                coredebug("channel-state-request [%s] (%s): data for the (%d) hashes - %O", obj.channel, util.hex(reqid), hashes.length, posts)
              })
            }

            // timeEnd !== 0 => not keeping this request alive + we've returned everything we have: conclude it
            if (obj.future === 0) {
              coredebug("channel-state-request: prepare concluding hash response for %O", reqid)
              response = cable.HASH_RESPONSE.create(reqid, [])
              responses.push(response)
              this._removeRequest(reqid)
            }
            // nothing to return, but also don't want to close the live channel state request
            if (hashes.length === 0 && obj.future === 1) {
              return res(null)
            }
            return res(responses)
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
        case constants.MODERATION_STATE_REQUEST:
          this.getRelevantModerationHashes(obj.oldest, obj.channels, (hashes) => {
            coredebug("moderation state requests: our hashes %O", hashes)
            // if obj.future === 1 => keep this request alive
            // TODO (2024-03-25): think about how to do this nicely for a single request spanning multiple channels
            if (obj.future === 1) {
              // moderation state request has no implicit limit && updatesRemaining does not apply
              //
              // we want to track posts committed on the cabal level
              this.live.addLiveStateRequest(constants.CABAL_CONTEXT, obj.reqid, 0, false)
              // as well as channel-specific posts
              obj.channels.forEach(channel => {
                if (channel.length > 0) {
                  coredebug("moderation-state-request [%s]: tracking new live request for [%s]", util.hex(reqid), channel)
                  this.live.addLiveStateRequest(channel, obj.reqid, 0, false)
                }
              })
            }

            const responses = []
            if (hashes && hashes.length > 0) {
              response = cable.HASH_RESPONSE.create(reqid, hashes)
              responses.push(response)
            }
            // timeEnd !== 0 => not keeping this request alive + we've returned everything we have: conclude it
            if (obj.future === 0) {
              coredebug("moderation-state-request: prepare concluding hash response for %O", reqid)
              response = cable.HASH_RESPONSE.create(reqid, [])
              responses.push(response)
              this._removeRequest(reqid)
            }
            // nothing to return, but also don't want to close the live channel state request
            if (hashes.length === 0 && obj.future === 1) {
              return res(null)
            }
            return res(responses)
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

  _messageIsRequest (type) {
    switch (type) {
      case constants.POST_REQUEST:
      case constants.CANCEL_REQUEST:
      case constants.TIME_RANGE_REQUEST:
      case constants.CHANNEL_STATE_REQUEST:
      case constants.CHANNEL_LIST_REQUEST:
      case constants.MODERATION_STATE_REQUEST:
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
      case constants.MODERATION_STATE_REQUEST:
        decrementedBuf = cable.MODERATION_STATE_REQUEST.decrementTTL(buf)
        break
      default:
        throw new Error(`forward request: unknown request type ${reqType}`)
    }
  }

  forwardResponse(buf) {
    coredebug("todo forward response", buf)
  }

  _storeExternalBuf(buf, done) {
    coredebug("_storeExternalBuf()")
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
          case constants.ROLE_POST:
            this.store.role(buf, util.isAdmin(this.kp, buf, this.activeRoles), () => { res() })
            break
          case constants.MODERATION_POST:
            this.store.moderation(buf, util.isApplicable(this.kp, buf, this.activeRoles), () => { res() })
            break
          case constants.BLOCK_POST:
            this.store.block(buf, util.isApplicable(this.kp, buf, this.activeRoles), () => { res() })
            break
          case constants.UNBLOCK_POST:
            this.store.unblock(buf, util.isApplicable(this.kp, buf, this.activeRoles), () => { res() })
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
      if (this.requestedHashes.has(util.hex(hash))) {
        requestedPosts.push(post)
        // the hashes will be removed from the set requestedHashes later on, by _handleRequestedBufs, once the hashes
        // are confirmed to have been stored. if we clear them now we'll risk causing additional unnecessary hash
        // requests since they'll be regarded as missing if we query the blobs store for the hashes
      }
    })
    return requestedPosts
  }

  // reqid is a buffer, returns a boolean. used by tests and also to prevent mishaps in this file :)
  _isReqidKnown (reqid) {
    return this.requestsMap.has(util.hex(reqid))
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
          this.requestedHashes.delete(util.hex(hash)) 
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
    const reqidHex = util.hex(reqid)

    // check if message is a request or a response
    if (!this._messageIsResponse(resType)) {
      coredebug("incoming response (reqid %s) was not a response type, dropping", reqidHex)
      return done()
    }

    // if we don't know about a reqid, then the corresponding response is not something we want to handle
    if (!this._isReqidKnown(reqid)) {
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
          // TODO (2023-09-05): call done here instead; will it affect anything?
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
        const hashesToQuery = obj.hashes.filter(h => !this.requestedHashes.has(util.hex(h)))
        // query data store and try to get the data for each of the returned hashes. 
        this.store.blobs.api.getMany(hashesToQuery, (err, bufs) => {
          // collect all the hashes we still don't have data for (represented by null in returned `bufs`) and create a
          // post request
          let wantedHashes = []
          bufs.forEach((buf, index) => {
            if (buf === null) {
              // we don't have the hash represented by hashes[index]: good! we want to request it.
              const hash = hashesToQuery[index]
              // remember the requested hashes
              wantedHashes.push(hash)
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
            wantedHashes.forEach(h => this.requestedHashes.add(util.hex(h)))
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
  //
  // (also sneakily used to insert channels we learn of when receiving channel time range request / channel state
  // requests :)
  _indexNewChannels(channels, done) {
    if (!done) { done = util.noop }
    this.getChannels((err, knownChannels) => {
      const newChannels = channels.filter(ch => !knownChannels.includes(ch))
      const arr = newChannels.map(channel => { return { publicKey: "sentinel", channel }})
      if (arr.length === 0) { return done() }
      this.store.channelMembershipView.map(arr, () => {
        this._emitChannels("add", { channels: newChannels })
        done()
      })
    })
  }
}

module.exports = { CableCore, CableStore, EventsManager }
