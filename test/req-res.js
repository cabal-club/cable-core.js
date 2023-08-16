// SPDX-FileCopyrightText: 2023 the cabal-club authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const test = require("tape")
const CableCore = require("../index.js").CableCore
const constants = require("cable.js/constants")
const cable = require("cable.js/index.js")
const b4a = require("b4a")
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
    const msgType = cable.peekMessage(reqBuf)
    t.equal(constants.TIME_RANGE_REQUEST, msgType, `emitted request should be of type time range request (was ${msgType})`)
  })

  // request post hashes (channel time range request)
  const buf = core.requestPosts(channel, start, end, ttl, limit)
  const msgType = cable.peekMessage(buf)
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
    const msgType = cable.peekMessage(reqBuf)
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
    const msgType = cable.peekMessage(buf)
    t.equal(msgType, constants.TIME_RANGE_REQUEST, `returned request should be of type time range request (was ${msgType})`)


    core[1].on("response", resBuf => {
      const msgType = cable.peekMessage(resBuf)
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

test("requesting chat posts and ultimately receiving a post response should work", t => {
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
    const msgType = cable.peekMessage(reqBuf)
    switch (msgType) {
      case constants.TIME_RANGE_REQUEST:
        t.equal(requestCounter, 1, "time range request should be first request")
        break
      case constants.POST_REQUEST:
        t.equal(requestCounter, 2, "post request should be second request")
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

  let pending = 0
  const done = () => {
    pending--
    if (pending <= 0) {
      t.end()
    }
  }
  let responses = 0
  core[1].on("response", resBuf => {
    responses++
    const msgType = cable.peekMessage(resBuf)
    const obj = cable.parseMessage(resBuf)

    switch (msgType) {
      case constants.HASH_RESPONSE:
        t.equal(responses, 1, "hash response should be first response to arrive")
        t.equal(msgType, constants.HASH_RESPONSE, `emitted request should be of type hash response(was ${msgType})`)
        t.equal(obj.hashes.length, 1, "hash response should contain 1 hash")
        core[0].handleResponse(resBuf)
        break
      case constants.POST_RESPONSE:
        pending++
        if (responses === 2) {
          t.equal(obj.posts.length, 1, "post response should contain 1 post")
          core[0].handleResponse(resBuf, () => {
            core[0].getChat(channel, 0, +(new Date()), limit, (err, posts) => {
              t.error(err, "get chat should work")
              t.ok(posts, "posts should be not null")
              t.equal(posts.length, 1, "get chat should return a post")
              const p = posts[0]
              t.equal(p.channel, channel, "channel should be same as initial post")
              t.equal(p.text, text, "text contents should be same as initial post")
              t.deepEqual(p.publicKey, core[1].kp.publicKey.toString("hex"), "public key should be that of instance 1 (not instance 0)")
              done()
            })
          })
        } else if (responses === 3) {
          t.equal(obj.posts.length, 0, "post response should contain no posts as its the concluding post response (no more data is coming)")
          // since we've concluded, let's now process the responses and make sure it's indexed in our database as expected
          core[0].handleResponse(resBuf, () => {
            done()
          })
        }
        break
    }
  })

  // set a topic to add an unrelated post to core[1]'s database
  core[1].setTopic(channel, "channel topic", () => {
    // instance 1 should have a message in their buffer
    core[1].postText(channel, text, () => {
      // request post hashes (channel time range request)
      const buf = core[0].requestPosts(channel, start, end, ttl, limit)
      const msgType = cable.peekMessage(buf)
      t.equal(msgType, constants.TIME_RANGE_REQUEST, `returned request should be of type time range request (was ${msgType})`)
    })
  })
})

test("channel list request should yield a channel list response", t => {
  // core[0] wants data and sends requests and receives responses
  // core[1] has data and receives requests, sends responses
  const core = [new CableCore(), new CableCore()]
  t.notEqual(undefined, core[0], "should not be undefined")
  t.notEqual(null, core[0], "should not be null")

  const channels = ["introduction", "great stuff", "development"]
  channels.sort()

  core[0].on("request", reqBuf => {
    const msgType = cable.peekMessage(reqBuf)
    const obj = cable.parseMessage(reqBuf)
    switch (msgType) {
      case constants.CHANNEL_LIST_REQUEST:
        t.pass("should be a channel list request")
        break
      default:
        t.fail("should never generate a request other than a channel list request")
    }
    core[1].handleRequest(reqBuf)
  })

  core[1].on("response", resBuf => {
    const msgType = cable.peekMessage(resBuf)
    const obj = cable.parseMessage(resBuf)
    switch (msgType) {
      case constants.CHANNEL_LIST_RESPONSE:
        t.pass("should be a channel list response")
        break
      default:
        t.fail("should never generate a response other than a channel list response")
    }
    core[0].handleResponse(resBuf, () => {
      core[0].getChannels((err, returnedChannels) => {
        t.error(err, "get channels should work for core[0]")
        t.equal(returnedChannels.length, channels.length, "core[0]'s returned channels should equal list of channels we joined")
        t.end()
      })
    })
  })

  // seed core[0] with a list of channels
  let promises = []
  channels.forEach(channel => {
    let p = new Promise((res, rej) => {
      core[1].join(channel, () => { res() })
    })
    promises.push(p)
  })
  Promise.all(promises)
  .then(() => {
    return new Promise((res, rej) => {
      core[1].getChannels((err, returnedChannels) => {
        t.error(err, "get channels should work")
        t.equal(returnedChannels.length, channels.length, "returned channels should equal list of channels we joined")
        res()
      })
    })
  })
  .then(() => {
    core[0].requestChannels(0, 0, 10)
  })
})

test("channel state request should yield a hash response", t => {
  // core[0] wants data and sends requests and receives responses
  // core[1] has data and receives requests, sends responses
  const core = [new CableCore(), new CableCore()]
  const channel = "introduction"
  const topic = "everyone says hi and also what kind of ice cream they like (if at all)"
  // names[0] => name of core[0], names[1] => name of core[1]
  const name = ["gelato", "isglass"]

  t.ok(core[0], "CableCore instance 0 should be ok")
  t.ok(core[1], "CableCore instance 1 should be ok")

  let requests = 0
  core[0].on("request", reqBuf => {
    requests++
    const msgType = cable.peekMessage(reqBuf)
    const obj = cable.parseMessage(reqBuf)
    switch (msgType) {
      case constants.CHANNEL_STATE_REQUEST:
        t.equal(requests, 1, "first request should be a channel state request")
        break
      case constants.POST_REQUEST:
        t.equal(requests, 2, "second request should be a post request")
        break
      default:
        t.fail("should never generate a request other than a channel state request or a post request")
    }
    core[1].handleRequest(reqBuf)
  })

  let handledFinalResponse = false
  let responses = 0
  core[1].on("response", resBuf => {
    const msgType = cable.peekMessage(resBuf)
    const obj = cable.parseMessage(resBuf)
    responses++
    switch (msgType) {
      case constants.HASH_RESPONSE:
        t.equal(responses, 1, "first should be a channel state response")
        break
      case constants.POST_RESPONSE:
        switch (responses) {
          case 2:
            t.true(obj.posts.length > 0, "non-concluding post response should have non-zero amount of posts")
            break
          case 3:
            t.equal(obj.posts.length, 0, "last response should be a post response with no posts (concluding)")
          break
        }
        break
      default:
        t.fail("should never generate a response other than a hash response or a post response")
    }

    core[0].handleResponse(resBuf, () => {
      // core[0] should have ingested and indexed the full set of channel state data, let's verify that!
      if (responses === 3 && !handledFinalResponse) {
        handledFinalResponse = true
        setTimeout(() => {
          new Promise((res, rej) => {
            core[0].getChannelStateHashes(channel, (err, hashes) => {
              t.error(err, "get channel state hashes should not err")
              t.equal(hashes.length, 3, `core[0] should have 3 channel state hashes for ${channel} (1 topic, 1 post/info for core[1], 1 post/join for core[1]`)
              hashes.forEach(hash => {
                t.true(b4a.isBuffer(hash), "hash should be a buffer")
                t.equal(hash.length, constants.HASH_SIZE, `hash size should be ${constants.HASH_SIZE}`)
              })
              res()
            })
          }).then(() => {
            core[0].getTopic(channel, (err, returnedTopic) => {
              t.equal(returnedTopic, topic, "indexed topic should be equal to the topic that was set")
            })
          }).then(() => {
            core[0].getUsersInChannel(channel, (err, map) => {
              const core1Pubkey = core[1].kp.publicKey.toString("hex")
              t.true(map.has(core1Pubkey), "core[1]'s user should be in channel after core[0] state sync")
              t.equal(map.get(core1Pubkey), name[1], "name of core[1] should be set correctly")
              t.equal(map.size, 1, "only core[1] should be in channel")
              t.end()
            })
          })
        }, 200)
      }
    })
  })

  // populate core[1] with channel state data
  let promises = []
  let p
  // add a post/join
  p = new Promise((res, rej) => { core[1].join(channel, () => { res() }) })
  promises.push(p)
  // set a topic
  p = new Promise((res, rej) => { core[1].setTopic(channel, topic, () => { res() }) })
  promises.push(p)
  // set name of core[0]
  p = new Promise((res, rej) => { core[0].setNick(name[0], () => { res() }) })
  promises.push(p)
  // set name of core[1]
  p = new Promise((res, rej) => { core[1].setNick(name[1], () => { res() }) })
  promises.push(p)
  Promise.all(promises).then(() => {
    promises = []
    // check initial state of core[0] (should have 0 channel state hashes)
    p = new Promise((res, rej) => {
      core[0].getChannelStateHashes(channel, (err, hashes) => {
        t.error(err, "get channel state hashes should not err")
        t.equal(hashes.length, 0, `core[0] should have 3 channel state hashes for ${channel} before request-response cycle`)
        hashes.forEach(hash => {
          t.true(b4a.isBuffer(hash), "hash should be a buffer")
          t.equal(hash.length, constants.HASH_SIZE, `hash size should be ${constants.HASH_SIZE}`)
        })
        res()
      })
    })
    promises.push(p)

    // check initial state of core[1] (should have 3 channel state hashes)
    p = new Promise((res, rej) => {
      core[1].getChannelStateHashes(channel, (err, hashes) => {
        t.error(err, "get channel state hashes should not err")
        t.equal(hashes.length, 3, `core[1] should have 3 channel state hashes for ${channel} (1 topic, 1 post/info for themselves, 1 post/join for themselves`)
        res()
      })
    })
    promises.push(p)
    return Promise.all(promises)
  })
  .then(() => {
    // initial state has been verified, time to do initiate the request-response cycle to sync channel state!
    core[0].requestState(channel, 0, 100, 0)
  })
})

