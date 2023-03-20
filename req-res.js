/* from INDEXES.md (2023-03-16)

A `req_id` always belongs to a request or to the response caused by a request. Thus a `req_id` has
a source (the message type that "spawns" the request) and an expectation of what to get
back (the message type that correctly answers the request e.g. a `data response` for a `request by
hash`, a `hash response` for a `channel time range request`, or a `channel list response` for a
`channel list request`). We can also prepare for the cable specification's _circuits_ behaviour
by keeping track of an extra id to more efficiently route messages, instead of floodfilling to
all connected peers.

When we deal with a request, we can associate the generated `req_id` with:

* source (the message type of the request), a varint
* expects (the expected message type of the response), a varint
* origin (are we the end destination for the returning response, or are we passing on
  information between other nodes), a boolean
* circuitid (which connected node to send the response to), a varint; might be premature and
  pending on how it is specified

Also worth noting is that a response will have its `req_id` field set to the same value as the
request its responding to. That is: `response[req_id] = request[req_id]`.
*/

const constants = require("../cable/constants.js")
const crypto = require("../cable/cryptography.js")
const b4a = require("b4a")

// const reqmapEntry = {
//   "reqId": "",
//   "circuitId": "",
//   "reqType": 0,
//   "resType": 0,
//   "recipients": [],
//   "origin": false
// }

function reqEntryTemplate (reqId, reqType) {
  const entry = {
    "reqId": reqId,
    "circuitId": b4a.alloc(4).fill(0),
    "reqType": reqType,
    "resType": -1,
    "recipients": [],
    "origin": false
  }

  switch (reqType) {
    case constants.HASH_REQUEST:
      entry.resType = constants.DATA_RESPONSE
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

function makeRequest (reqType) {
  const entry = reqEntryTemplate(crypto.generateReqID(), reqType)
  entry.recipients.push("me")
  entry.origin = true
  return entry
}

function forwardRequest(reqId, reqType, recipient) {
  const entry = reqEntryTemplate(reqId, reqType)
  entry.recipients.push(recipient)
  entry.origin = false
  return entry
}

/* LIVE QUERIES, and how to handle them
 channel state: 
 * DONE: `updates` amount (total) of future channel state post hashes; does not count initial batch
 channel time range: 
 * DONE: check lower bound `timeend`. use a sorted list / priority queue to get all requests that satisfy the lower boundary?
*/

/* LIVE QUERY: Request Channel State */
// map channel name to an ongoing request
// "channel" -> [{ updatesRemaining: Number, reqId: Buffer}]
const liveChannelState = new Map()
function addLiveStateRequest(channel, req) {
  if (!liveChannelState.has(channel)) {
    liveChannelState.set(channel, [])
  }
  const arr = liveChannelState.get(channel)
  arr.push(req)
}

/* LIVE QUERY: Request Channel Time Range */
// to service ongoing 'live' time range requests, we need to figure out which new messages fall within the boundaries of 
// the known live requests. to do this we keep a sorted list of requests, sorting them by their lower boundary.
// whenever we save a post to the database, we use its timestamp to get a subset of the live requests from the sorted
// list. each of the subsets stored requests should have a hash response fired off to them, containing the hash of the
// newly stored post

function dateCmp (a, b) {
  return a.timeStart - b.timeStart
}

function findIndex(arr, val, cmp) {
  let start = 0
  let end = arr.length - 1
  let mid
  let v
  let comparison

  if (arr[start] > val) { return -1 }
  if (arr[end] < val) { return arr.length }

  while (start !== end) {
    mid = Math.round((end + start) / 2)
    v = arr[mid]
    comparison = cmp(v, val)
    if (comparison === 0) { // v === val
      return mid
    }
    if (comparison < 0) { // v < val; 
      start = mid
    } else if (comparison > 0) { // v > val
      end = mid - 1
    }
  }
  return start
}

// get a subset of arr, where the returned subset is greater than or equal to val
function getSubset(arr, val, cmp) {
  const i = findIndex(arr, val, cmp)
  // make subset range inclusive
  if (arr[i] === val) { return arr.slice(i) }
  return arr.slice(i+1)
}

/* sketch on how to store a list of ongoing requests & how to query it using a lower bound */
// let ongoingRequests = []
// const dates = [  "2018-04-20", "2023-03-17", "2023-03-19", "2023-03-21",  "2023-03-15", "2023-02-27", "2023-03-02",
// "2023-03-03"]
// ongoingRequests = dates.map(d => { return { timeStart: +(new Date(d)) } })
// ongoingRequests.sort(dateCmp)
// console.log(ongoingRequests)
//
// getSubset(ongoingRequests, { timeStart: +(new Date("2023-03-05")) }, dateCmp).forEach(l => console.log(new Date(l.timeStart).toISOString().split("T")[0]))

const reqMap = new Map()
const req = makeRequest(constants.TIME_RANGE_REQUEST)
reqMap.set(req.reqId, req)

console.log("req", req)
console.log(forwardRequest(req.reqId, req.reqType, "someone else"))
