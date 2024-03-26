// SPDX-FileCopyrightText: 2023 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const EventEmitter = require('events').EventEmitter
const livedebug = require("debug")("core:live")
const constants = require("cable.js/constants.js")
const cable = require("cable.js")
const util = require("./util.js")
const b4a = require("b4a")

const REQID_TO_CHANNELS = "reqid-to-channels"

/* this class encapsulates the logic required to handle 'live requests' i.e. requests which expect to receive additional
 * hashes after their first response has already been sent. channel state request with future=1 is an example of a 'live
 * request' */
class LiveQueries extends EventEmitter {
  constructor (core) {
    super()
    this.core = core
    // tracks "live" requests: requests that have asked for future posts, as they are produced
    this.liveQueries = new Map()
    // expedient way to go from a reqid to the relevant channel name
    this.liveQueries.set(REQID_TO_CHANNELS, new Map())
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
  // * MODERATION_STATE_REQUEST (moderation state request) -- has no limit to updates AND has multiple channels in the same request
  // that's it!
  //
  // _addLiveStateRequest maps a channel name to one of potentially many ongoing "live" requests
  //
  // Map structure: <channel name> -> [{ updatesRemaining: Number, hasLimit: boolean, reqid: hexStringOfBuffer}]
  addLiveStateRequest(channel, reqid, updatesRemaining, hasLimit) {
    // TODO (2023-04-24): live state request currently has no conception of a valid time range, which could affect the
    // anticipated behaviour of channel time range request (e.g. we could receive & store a post/text whose timestamp is
    // older than the timeStart of a live channel time range request)
    
    // TODO (2023-03-31): use _addLiveRequest when processing an incoming TIME_RANGE_REQUEST + CHANNEL_STATE_REQUEST
    const reqidHex = util.hex(reqid)
    livedebug("track %s", reqidHex)

    // a potentially rascally attempt to fuck shit up; abort
    if (channel === REQID_TO_CHANNELS) { return }

    // `reqidMap`, due to moderation state request operating on many channels in a single request, maps each request to
    // a set of channels (as opposed to a single channel as is the case for the live queries in the other cases)
    const reqidMap = this.liveQueries.get(REQID_TO_CHANNELS)
    if (!reqidMap.has(reqidHex)) {
      reqidMap.set(reqidHex, new Set())
    }
    reqidMap.get(reqidHex).add(channel)

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
  getLiveRequests(channel) {
    livedebug("get live request for %s", channel)
    const channelQueries = this.liveQueries.get(channel)
    // no such channel
    if (!channelQueries) { return [] }
    return channelQueries.map(item => b4a.from(item.reqid, "hex"))
  }

  updateLiveStateRequest(channel, reqid, updatesSpent) {
    const channelQueries = this.liveQueries.get(channel)
    // no such channel
    if (!channelQueries) { return }
    const index = channelQueries.findIndex(item => item.reqid === util.hex(reqid))
    const entry = channelQueries[index]
    // no live query with `reqid`
    if (!entry) { return }
    if (entry.hasLimit) {
      entry.updatesRemaining = entry.updatesRemaining - updatesSpent
      livedebug("updated live request for %O", entry)
      if (entry.updatesRemaining <= 0) {
        this.cancelLiveStateRequest(entry.reqid)
        // emit an event when a live request has finished service
        this.emit("live-request-ended", entry.reqid)
      }
    }
  }

  cancelLiveStateRequest(reqidHex) {
    livedebug("cancel live state request for reqid %s", reqidHex)
    const channelSet = this.liveQueries.get(REQID_TO_CHANNELS).get(reqidHex)
    if (!channelSet) {
      livedebug("cancel live request could not find channel for reqid %s", reqidHex)
      return
    }
    // iterating over the channel set is caused by moderation state request operating on multiple channels in the same
    // request
    for (const channel of channelSet) {
      let channelQueries = this.liveQueries.get(channel)
      if (!channelQueries) { 
        livedebug("channel queries was empty for channel %s (reqid %s)", channel, reqidHex)
        continue
      }
      const index = channelQueries.findIndex(item => item.reqid === reqidHex)
      if (index < 0) {
        livedebug("cancel live request could not find entry for reqid %s", reqidHex)
        continue
      }
      // remove the entry tracking this particular req_id: delete 1 item at `index`
      channelQueries.splice(index, 1)

      // there are no longer any live queries being tracked for `channel`, stop tracking it
      if (channelQueries.length === 0) {
        this.liveQueries.delete(channel)
      } else {
        this.liveQueries.set(channel, channelQueries)
      }
      this.liveQueries.get(REQID_TO_CHANNELS).get(reqidHex).delete(channel)
    }
  }

  // this function is part of "live query" behaviour of the channel state request (when future = 1) 
  // and the channel time range request (when timeEnd = 0)
  // note: `timestamp` === -1 if event channel-state-replacement called this function (the timestamp only matters for
  // channel time range request, which will always set it)
  sendLiveHashResponse(channel, postType, hashes, timestamp) {
    const reqidList = this.getLiveRequests(channel)
    reqidList.forEach(reqid => {
      const requestInfo = this.core.requestsMap.get(util.hex(reqid))
      livedebug("requestInfo for reqid %O: %O", reqid, requestInfo)
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
      } else if (reqType === constants.MODERATION_STATE_REQUEST) {
        switch (postType) {
          case constants.BLOCK_POST:
          case constants.UNBLOCK_POST:
          case constants.MODERATION_POST:
          case constants.ROLE_POST:
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
      this.core.dispatchResponse(response)
      this.updateLiveStateRequest(channel, reqid, hashes.length)
      livedebug("dispatch response with %d hashes %O", hashes.length, response)
    })
  }
}
module.exports = LiveQueries
