// SPDX-FileCopyrightText: 2023 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// node core dependencies
const EventEmitter = require('events').EventEmitter
// external database dependencies
const { MemoryLevel } = require("memory-level")
// external dependencies
const storedebug = require("debug")("core:store")
const b4a = require("b4a")
// internal dependencies
const cable = require("cable.js")
const crypto = require("cable.js/cryptography.js")
const constants = require("cable.js/constants.js")
const util = require("./util.js")
// materialized views and indices
const createDatastore = require("./views/data-store.js")
const createChannelStateView = require("./views/channel-state.js")
const createChannelMembershipView = require("./views/channel-membership.js")
const createTopicView = require("./views/topics.js")
const createUserInfoView = require("./views/user-info.js")
const createAuthorView = require("./views/author.js")
const createMessagesView = require("./views/messages.js")
const createDeletedView = require("./views/deleted.js")
const createReverseMapView = require("./views/reverse-hash-map.js")
const createLinksView = require("./views/links.js")
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
  constructor(level, opts) {
    super()

    const storage = opts.storage || "data"
    if (!opts) { opts = { temp: true } }

    if (!level) { level = MemoryLevel }

    this._db = new level(storage)

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
    // note: obj.hashes is hash of the deleted post (not of the post/delete!)
    const obj = DELETE_POST.toJSON(buf)

    // verify that each hash requested to be deleted is in fact authorized (delete author and post author are the same)
    // throw an error (and refuse to store this post/delete) if any of the hashes are authored by someone else
    const prom = new Promise((res, rej) => {
      this.blobs.api.getMany(obj.hashes, (err, bufs) => {
        for (let i = 0; i < bufs.length; i++) {
          if (!bufs[i]) { 
            storedebug("can't find buf corresponding to hash", obj.hashes[i])
            continue 
          }
          const post = cable.parsePost(bufs[i])
          if (!b4a.equals(post.publicKey, obj.publicKey)) {
            storedebug("del (err): hashes to delete %O post author was %O, delete author was %O", obj.hashes, post.publicKey, obj.publicKey)
            return rej(new Error("post/delete author and author of hashes to delete did not match"))
          }
        }
        res()
      })
    })

    prom.then(() => {
      // persist the post/delete buffer
      return new Promise((res, rej) => {
        this._storeNewPost(buf, hash, res)
      })
    })
    .then(() => {
      let processed = 0
      // create a self-contained loop of deletions, where each related batch of deletions is performed in unison
      obj.hashes.forEach(hashToDelete => {
        deleteHash(hashToDelete, (err) => {
          if (err) {
            return done(err)
          }
          processed++
          // signal done when all hashes to delete have been processed
          if (processed >= obj.hashes.length) {
            done()
          }
        })
      })
    })
    // there was some kind of error, e.g. the delete post tried to delete someone else's post
    .catch((err) => {
      storedebug("error!", err)
      done(err)
    })

    const deleteHash = (hashToDelete, finished) => {
      const promises = []
      let p
      this.blobs.api.get(hashToDelete, async (err, retrievedBuf) => {
        if (err) {
          storedebug("delete err'd", err)
          return finished(err)
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
    this.channelStateView.api.getLatestInfoHash(channel, publicKey, (err, hash) => {
      storedebug("latest name err", err)
      storedebug("latest name hash", hash)
      if (err && err.notFound) {
        this.userInfoView.api.clearInfo(publicKey)
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
    storedebug("reindex channel membership in %s for %s", channel, util.hex(publicKey))
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

    // when we're setting a post/info we are not passed a channel. so to index this post correctly, for how the channel
    // state index looks like right now, we need to get a list of channels that the user is in and post the update to
    // each of those channels
    this.channelMembershipView.api.getHistoricMembership(obj.publicKey, (err, channels) => {
      const channelStateMessages = []
      channels.forEach(channel => {
        channelStateMessages.push({...obj, hash, channel})
      })
      storedebug(channelStateMessages)
      p = new Promise((res, rej) => {
        this.channelStateView.map(channelStateMessages, res)
      })
      promises.push(p)

      // emit 'store-post' for each channel indexes have been confirmed to be updated
      Promise.all(promises).then(() => {
        new Set(channels).forEach(channel => {
          this._emitStoredPost(hash, buf, channel)
        })
        done()
      })
    })
  }

  _emitStoredPost(hash, buf, channel) {
    const obj = cable.parsePost(buf)
    storedebug("store-post", { obj, hash, timestamp: obj.timestamp, channel, postType: util.humanizePostType(obj.postType) })
    if (channel) {
      this.emit("store-post", { obj, hash, timestamp: obj.timestamp, channel, postType: obj.postType })
    } else { // probably a post/info, which has no channel membership information
      this.emit("store-post", { obj, hash, timestamp: obj.timestamp, channel: null, postType: obj.postType })
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

module.exports = CableStore
