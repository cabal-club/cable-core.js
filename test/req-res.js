const test = require("tape")
const CableCore = require("../index.js").CableCore
const constants = require("../../cable/constants")
const cable = require("../../cable/index.js")
const { testPostType, getDescriptiveType, assertPostType, assertBufType }  = require("../testutils.js")

/* this test suite contains a bunch of tests exercising the request response functionality of cable, as mediated by
 * cable-core.js. typically, one user instance will be creating a request, which will be passed to another instance,
 * resulting in a response that the first instance can ingest */

test("test passes", t => {
  t.plan(1)
  t.pass("this test always passes")
})

test("core should be initializable", t => {
  const core = new CableCore()
  t.notEqual(undefined, core, "should not be undefined")
  t.notEqual(null, core, "should not be null")
  t.end()
})

// these tests rely on requests and responses being emitted when they are being dispatched. whether to keep that or not
// is up to the future, but it's an easy place to get started with exercising functionality when there is no transport
// layer coded up yet
test("request should be emitted", t => {
  const core = new CableCore()
  t.notEqual(undefined, core, "should not be undefined")
  t.notEqual(null, core, "should not be null")

  const ttl = 0
  const channel = "introduction"
  const text = "Hello hello."
  const start = +(new Date("2023-03-01"))
  const end = 0
  const limit = 1500

  // register event handler for `request` type event (emitted when a request has been dispatched)
  core.on("request", reqBuf => {
    const msgType = cable.peek(reqBuf)
    t.equal(constants.TIME_RANGE_REQUEST, msgType, `emitted request should be of type time range request (was ${msgType})`)
  })

  // request post hashes (channel time range request)
  const buf = core.requestPosts(channel, start, end, ttl, limit)
  const msgType = cable.peek(buf)
  t.equal(constants.TIME_RANGE_REQUEST, msgType, `returned request should be of type time range request (was ${msgType})`)
  t.end()
})

test("handling a request should emit a correct response message", t => {
  const core = [new CableCore(), new CableCore()]
  t.notEqual(undefined, core[0], "should not be undefined")
  t.notEqual(null, core[0], "should not be null")

  const ttl = 0
  const channel = "introduction"
  const text = "Hello hello."
  const startDate = new Date()
  startDate.setTime(startDate.getTime() - 5 * 60 * 1000) // set timeStart to be 5 minutes ago
  const start = +(startDate)
  const end = 0
  const limit = 1500

  // register event handler for `request` type event (emitted when a request has been dispatched)
  core[0].on("request", reqBuf => {
    const msgType = cable.peek(reqBuf)
    t.equal(msgType, constants.TIME_RANGE_REQUEST, `emitted request should be of type time range request (was ${msgType})`)
  })

  core[1].on("request", reqBuf => {
    t.fail("instance 1 should not emit any requests")
  })

  // instance 1 should have a message in their buffer
  core[1].postText(channel, text, () => {
    // request post hashes (channel time range request)
    const buf = core[0].requestPosts(channel, start, end, ttl, limit)
    const reqid = cable.peekReqid(buf)
    const msgType = cable.peek(buf)
    t.equal(msgType, constants.TIME_RANGE_REQUEST, `returned request should be of type time range request (was ${msgType})`)


    core[1].on("response", resBuf => {
      const msgType = cable.peek(resBuf)
      t.equal(msgType, constants.HASH_RESPONSE, `emitted request should be of type hash response(was ${msgType})`)
      const obj = cable.parseMessage(resBuf)
      t.equal(obj.hashes.length, 1, "hash response should contain 1 hash")
      t.deepEqual(obj.reqid, reqid, "req_id of initial request and response message should be identical")
      t.end()
    })

    // core[1] receives the request, should emit a response
    core[1].handleRequest(buf)
  })
})

test("complete request->response, request->response cycle for requesting posts should work", t => {
  const core = [new CableCore(), new CableCore()]
  t.notEqual(undefined, core[0], "should not be undefined")
  t.notEqual(null, core[0], "should not be null")

  const ttl = 0
  const channel = "introduction"
  const text = "Hello hello."
  const startDate = new Date()
  startDate.setTime(startDate.getTime() - 5 * 60 * 1000) // set timeStart to be 5 minutes ago
  const start = +(startDate)
  const end = 0
  const limit = 1500

  let requestCounter = 0
  // register event handler for `request` type event (emitted when a request has been dispatched)
  core[0].on("request", reqBuf => {
    requestCounter++
    const msgType = cable.peek(reqBuf)
    switch (msgType) {
      case constants.TIME_RANGE_REQUEST:
        t.equal(requestCounter, 1, "time range request should be first request")
        break
      case constants.HASH_REQUEST:
        t.equal(requestCounter, 2, "hash request should be second request")
        break
      default:
        t.fail(`unexpected request was emitted (${msgType})`)
    }
    // core[1] receives the request, should emit a response
    core[1].handleRequest(reqBuf)
  })

  core[1].on("request", reqBuf => {
    t.fail("instance 1 should not emit any requests")
  })

  core[1].on("response", resBuf => {
    const msgType = cable.peek(resBuf)
    const obj = cable.parseMessage(resBuf)
    switch (msgType) {
      case constants.HASH_RESPONSE:
        t.equal(msgType, constants.HASH_RESPONSE, `emitted request should be of type hash response(was ${msgType})`)
        t.equal(obj.hashes.length, 1, "hash response should contain 1 hash")
        core[0].handleResponse(resBuf)
        break
      case constants.DATA_RESPONSE:
        t.equal(obj.data.length, 1, "data response should contain 1 post")
        core[0].handleResponse(resBuf, () => {
          setTimeout(() => {
          core[0].getChat(channel, 0, +(new Date()), limit, (err, posts) => {
            t.error(err, "get chat should work")
            t.ok(posts, "posts should be not null")
            t.equal(posts.length, 1, "get chat should return a post")
            const p = posts[0]
            t.equal(p.channel, channel, "channel should be same as initial post")
            t.equal(p.text, text, "text contents should be same as initial post")
            t.deepEqual(p.publicKey, core[1].kp.publicKey, "public key should be that of instance 1 (not instance 0)")
            t.end()
          })
          }, 200)
        })
        break
    }
  })

  // instance 1 should have a message in their buffer
  core[1].postText(channel, text, () => {
    // request post hashes (channel time range request)
    const buf = core[0].requestPosts(channel, start, end, ttl, limit)
    const msgType = cable.peek(buf)
    t.equal(msgType, constants.TIME_RANGE_REQUEST, `returned request should be of type time range request (was ${msgType})`)
  })
})
