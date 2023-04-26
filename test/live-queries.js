const test = require("tape")
const b4a = require("b4a")
const CableCore = require("../index.js").CableCore
const constants = require("../../cable/constants")
const cable = require("../../cable/index.js")
const crypto = require("../../cable/cryptography.js")
const { testPostType, getDescriptiveType, assertPostType, assertBufType }  = require("../testutils.js")

/* this test suite contains a bunch of tests exercising live query functionality of the channel state request
 * and the channel time range request. what is termed "live query" refers to the behaviour where one party has
 * received a request to respond with more post hashes as they are produced
*/

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

const ONE_DAY_MS = 1 * 1000 * 60 * 60 * 24
test("channel time range request: start with empty database, send hashes as they are produced", t => {
  const core = [new CableCore(), new CableCore()]
  t.notEqual(undefined, core, "should not be undefined")
  t.notEqual(null, core, "should not be null")
  const referenceTime = new Date("2023-04-25")
  const startTime = new Date(referenceTime - ONE_DAY_MS).getTime()
  const channel = "introduction"
  const endTime = 0
  const ttl = 1
  const limit = 3
  const reqBuf = core[0].requestPosts(channel, startTime, endTime, ttl, limit)
  t.true(b4a.isBuffer(reqBuf), "should be buffer")

  let receiveCounter = 0
  core[1].on("response", (buf) => {
    receiveCounter++
    t.true(b4a.isBuffer(buf))
    const obj = cable.parseMessage(buf)
    if (receiveCounter <= limit) {
      t.true(obj.hashes.length > 0, "response hashes should be non-zero in length")
    }
    t.equal(obj.msgType, constants.HASH_RESPONSE, "response buffer should be hash response") 
    if (obj.hashes.length > 0) {
      t.true(receiveCounter <= limit, `receive counter should be at most ${limit}, was ${receiveCounter}`)
    } 
    if (obj.hashes.length == 0) {
      t.true(receiveCounter == limit + 1, `receive counter should be at ${limit}+1 (has concluding hash response), was ${receiveCounter}`)
    }
  })


  core[1].handleRequest(reqBuf, () => {
    const promises = []
    for (let i = 0; i < limit; i++) {
      const p = new Promise((res, rej) => {
        core[1].postText(channel, `${i}: hello hello!`, () => {
          res()
        })
      })
      promises.push(p)
    }
    Promise.all(promises).then(() => {
      // this post should not be emitted as a response
      core[1].postText(channel, `one final: hello hello!`, () => {
        t.end()
      })
    })
  })
})

test("channel time range request + cancel: start with empty database, send hashes as they are produced. stop after a cancel", t => {
  const core = [new CableCore(), new CableCore()]
  t.notEqual(undefined, core, "should not be undefined")
  t.notEqual(null, core, "should not be null")
  const referenceTime = new Date("2023-04-25")
  const startTime = new Date(referenceTime - ONE_DAY_MS).getTime()
  const channel = "introduction"
  const endTime = 0
  const ttl = 1
  const limit = 3
  const max = limit - 1
  const reqBuf = core[0].requestPosts(channel, startTime, endTime, ttl, limit)
  const reqid = cable.peekReqid(reqBuf)
  const cancelBuf = core[0].cancelRequest(reqid) // used later
  t.true(b4a.isBuffer(reqBuf), "should be buffer")

  let receiveCounter = 0
  core[1].on("response", (buf) => {
    receiveCounter++
    t.true(b4a.isBuffer(buf))
    const obj = cable.parseMessage(buf)
    if (receiveCounter <= max) {
      t.true(obj.hashes.length > 0, "response hashes should be non-zero in length")
    }
    t.equal(obj.msgType, constants.HASH_RESPONSE, "response buffer should be hash response") 
    if (obj.hashes.length > 0) {
      t.true(receiveCounter <= max, `receive counter should be at most ${max}, was ${receiveCounter}`)
    } 
    if (obj.hashes.length == 0) {
      t.true(receiveCounter === max + 1, `receive counter should be at ${max}+1 (has concluding hash response), was ${receiveCounter}`)
    }
  })

  core[1].handleRequest(reqBuf, () => {
    const promises = []
    // let's go for one LESS than limit (we want to test cancelling a request whose limit has not yet been reached!)
    for (let i = 0; i < max; i++) {
      const p = new Promise((res, rej) => {
        core[1].postText(channel, `${i}: hello hello!`, () => {
          res()
        })
      })
      promises.push(p)
    }
    Promise.all(promises).then(() => {
      // cancel the open channel time range request
      core[1].handleRequest(cancelBuf, () => {
        // this post should not be emitted as a response
        core[1].postText(channel, `one final: hello hello!`, () => {
          t.end()
        })
      })
    })
  })
})

test("channel time range request: start with populated database, send hashes as they are produced", t => {
  const core = [new CableCore(), new CableCore()]
  t.notEqual(undefined, core, "should not be undefined")
  t.notEqual(null, core, "should not be null")
  const referenceTime = new Date("2023-04-25")
  const startTime = new Date(referenceTime - ONE_DAY_MS).getTime()
  const channel = "introduction"
  const endTime = 0
  const ttl = 1
  const limit = 3
  const reqBuf = core[0].requestPosts(channel, startTime, endTime, ttl, limit)
  t.true(b4a.isBuffer(reqBuf), "should be buffer")

  let receiveCounter = 0
  let receivedFirstBufHash = false
  let firstBufHash
  core[1].on("response", (buf) => {
    receiveCounter++
    t.true(b4a.isBuffer(buf))
    const obj = cable.parseMessage(buf)
    t.equal(obj.msgType, constants.HASH_RESPONSE, "response buffer should be hash response") 
    if (obj.hashes.length > 0 && obj.hashes[0].equals(firstBufHash)) {
      t.comment("first buf received")
      t.false(receivedFirstBufHash, "should only receive hash of first buf once")
      receivedFirstBufHash = true
    } else {
      // +1 because we have one message in database to start with (firstBuf) which will be sent as a response as part
      // of the non-live behaviour of a channel time range request
      if (receiveCounter <= (limit + 1)) {
        t.true(obj.hashes.length > 0, "response hashes should be non-zero in length")
      } else {
        t.true(obj.hashes.length === 0, "concluding response hash should be zero in length")
      }
    }
  })

  let p

  // add posts to database
  p = new Promise((res, rej) => {
    const firstBuf = core[1].postText(channel, "hi this is the first msg", () => {
      res() 
    })
    firstBufHash = crypto.hash(firstBuf)
  })
  p.then(() => {
    // receive && process the channel time range request
    return new Promise((res, rej) => {
      core[1].handleRequest(reqBuf, () => {
        res()
      })
    })
  }).then(() => {
    // once prepop done: produce posts that will trigger hash responses
    let promises = []
    // add more posts (these are the ones that will be emitted as a response to the live query
    for (let i = 0; i < limit; i++) {
      const p = new Promise((res, rej) => {
        core[1].postText(channel, `${i}: hello hello!`, () => {
          res()
        })
      })
      promises.push(p)
    }
    return Promise.all(promises)
  })
  .then(() => {
    // this post should not be emitted as a response
    core[1].postText(channel, `one final: hello hello!`, () => {
      t.end()
    })
  })
})

// a channel state request with future = 1 should only respond with hash responses for the types :
// post/topic
// post/join
// post/join
// post/leave
test("channel state request: start with empty database. store post/text, but should not produce hash responses", t => {
  const core = [new CableCore(), new CableCore()]
  t.notEqual(undefined, core, "should not be undefined")
  t.notEqual(null, core, "should not be null")
  const channel = "introduction"
  const ttl = 1
  const future = 1
  const reqBuf = core[0].requestState(channel, ttl, future)
  const amount = 3
  t.true(b4a.isBuffer(reqBuf), "should be buffer")

  core[1].on("response", (buf) => {
    t.fail("a live channel state request should never emit a hash response when only post/text has been produced")
  })

  core[1].handleRequest(reqBuf, () => {
    const promises = []
    for (let i = 0; i < amount; i++) {
      const p = new Promise((res, rej) => {
        core[1].postText(channel, `${i}: hello hello!`, () => {
          res()
        })
      })
      promises.push(p)
    }
    Promise.all(promises).then(() => {
      t.end()
    })
  })
})

test("channel state request: start with empty database. store post/topic, should produce hash responses", t => {
  const core = [new CableCore(), new CableCore()]
  t.notEqual(undefined, core, "should not be undefined")
  t.notEqual(null, core, "should not be null")
  const channel = "introduction"
  const ttl = 1
  const future = 1
  const reqBuf = core[0].requestState(channel, ttl, future)
  const amount = 3
  t.true(b4a.isBuffer(reqBuf), "should be buffer")

  let receiveCounter = 0
  core[1].on("response", (buf) => {
    receiveCounter++
    t.true(b4a.isBuffer(buf))
    const obj = cable.parseMessage(buf)
    t.equal(obj.msgType, constants.HASH_RESPONSE, "response buffer should be hash response") 
    t.true(obj.hashes.length > 0, "response hashes should be non-zero in length")
  })

  core[1].handleRequest(reqBuf, () => {
    const promises = []
    for (let i = 0; i < amount; i++) {
      const p = new Promise((res, rej) => {
        core[1].setTopic(channel, `topic #${i}: welcome${'!'.repeat(i)}`, () => {
          res()
        })
      })
      promises.push(p)
    }
    Promise.all(promises).then(() => {
      t.end()
    })
  })
})

test("channel state request + cancel request: start with empty database, send hashes as they are produced. stop after cancel", t => {
  const core = [new CableCore(), new CableCore()]
  t.notEqual(undefined, core, "should not be undefined")
  t.notEqual(null, core, "should not be null")
  const channel = "introduction"
  const ttl = 1
  const future = 1
  const reqBuf = core[0].requestState(channel, ttl, future)
  const stateReqid = cable.peekReqid(reqBuf)
  const cancelBuf = core[0].cancelRequest(stateReqid) // this cancel will be ingested by core[1] a bit later
  const amount = 3
  t.true(b4a.isBuffer(reqBuf), "should be buffer")

  let receiveCounter = 0
  core[1].on("response", (buf) => {
    receiveCounter++
    t.true(b4a.isBuffer(buf))
    const obj = cable.parseMessage(buf)
    t.equal(obj.msgType, constants.HASH_RESPONSE, "response buffer should be hash response") 
    t.true(obj.hashes.length > 0, "response hashes should be non-zero in length")
  })

  core[1].handleRequest(reqBuf, () => {
    const promises = []
    for (let i = 0; i < amount; i++) {
      const p = new Promise((res, rej) => {
        core[1].setTopic(channel, `topic #${i}: welcome${'!'.repeat(i)}`, () => {
          res()
        })
      })
      promises.push(p)
    }
    Promise.all(promises).then(() => {
      // now: cancel the open `request channel state`. this means that the final post should not be received
      core[1].handleRequest(cancelBuf, () => {
        // this post should not be emitted as a response
        core[1].setTopic(channel, `topic finale: good bye${'!'.repeat(10)}`, () => {
          t.end()
        })
      })
    })
  })
})

// tests channel state request with deletes -> should surface the now-newest hash
test("channel state request + delete request: start with empty database, send hashes as they are produced. send new latest after a delete", t => {
  const core = [new CableCore(), new CableCore()]
  t.notEqual(undefined, core, "should not be undefined")
  t.notEqual(null, core, "should not be null")
  const channel = "introduction"
  const ttl = 1
  const future = 1
  const amount = 3
  const reqBuf = core[0].requestState(channel, ttl, future)
  t.true(b4a.isBuffer(reqBuf), "should be buffer")
  let latestPostedHash  // used later on
  let hashBeforeLatest // used later on

  let receiveCounter = 0
  core[1].on("response", (buf) => {
    receiveCounter++
    t.true(b4a.isBuffer(buf))
    const obj = cable.parseMessage(buf)
    t.equal(obj.msgType, constants.HASH_RESPONSE, "response buffer should be hash response") 
    t.true(obj.hashes.length > 0, "response hashes should be non-zero in length")
    if (receiveCounter === amount + 1) {
      t.equal(obj.hashes.length, 1, "last hash response should contain 1 hash")
      t.true(!latestPostedHash.equals(hashBeforeLatest), "last hash and n-1 last hash should not be equal")
      t.deepEqual(obj.hashes[0], hashBeforeLatest, "the last hash response should be the hash of the n-1 latest post")
      t.end()
    }
  })

  core[1].handleRequest(reqBuf, () => {
    const promises = []
    for (let i = 0; i < amount; i++) {
      const p = new Promise((res, rej) => {
        const buf = core[1].setTopic(channel, `topic #${i}: welcome${'!'.repeat(i)}`, () => {
          res()
        })
        hashBeforeLatest = latestPostedHash
        latestPostedHash = crypto.hash(buf)
      })
      promises.push(p)
    }
    Promise.all(promises).then(() => {
      // create a quick and dirty delete request :) (core[0] doesn't have the post but using them to create the delete
      // should work anyway)
      t.ok(latestPostedHash, "latest hash should not be empty")
      const deleteBuf = core[0].del(latestPostedHash)
      // store a irrelevant (for this test / channel state request) post, for testing a bit of
      // redundancy wrt correct behaviour & handling
      core[1].postText(channel, "hello hello this is just some garbageo", () => {
        // now: store the delete buf should cause a final hash response to be produced, which should
        // be equivalent with the n-1 latest hash (the hash that was stored right before the hash that was deleted)
        core[1]._storeExternalBuf(deleteBuf)
      })
    })
  })
})

test("channel state request: start with empty database. store post/topic, post/join, post/info. should produce hash responses", t => {
  const core = [new CableCore(), new CableCore()]
  t.notEqual(undefined, core, "should not be undefined")
  t.notEqual(null, core, "should not be null")
  const channel = "introduction"
  const ttl = 1
  const future = 1
  const reqBuf = core[0].requestState(channel, ttl, future)
  const amount = 3
  t.true(b4a.isBuffer(reqBuf), "should be buffer")

  let receiveCounter = 0
  core[1].on("response", (buf) => {
    receiveCounter++
    t.true(b4a.isBuffer(buf))
    const obj = cable.parseMessage(buf)
    t.true(obj.hashes.length > 0, "response hashes should be non-zero in length")
    t.equal(obj.msgType, constants.HASH_RESPONSE, "response buffer should be hash response") 
    t.true(receiveCounter <= amount, `receive counter should be at most ${amount}, was ${receiveCounter}`)
    if (receiveCounter == amount) {
      t.end()
    }
  })

  // register the channel state request
  core[1].handleRequest(reqBuf, () => {
    // then start writing posts to the databasem which will be sent out as future'd hash responses
    const promises = []
    for (let i = 0; i < amount; i++) {
      const p = new Promise((res, rej) => {
        switch (i) {
          case 0:
            core[1].join(channel, () => { res() })
            break
          case 1:
            core[1].setTopic(channel, `topic: welcome!`, () => { res() })
            break
          case 2:
            core[1].setNick("sweet-vine", () => { res() })
            break
        }
      })
      promises.push(p)
    }
    Promise.all(promises)
  })
})

test("channel state request: start with empty database. store post/topic, post/join, post/info, but some to an unrelated channel. should produce hash responses for requested channel only", t => {
  const core = [new CableCore(), new CableCore()]
  t.notEqual(undefined, core, "should not be undefined")
  t.notEqual(null, core, "should not be null")
  const channel = "introduction"
  const unrelatedChannel = "chats-and-such"
  const ttl = 1
  const future = 1
  const reqBuf = core[0].requestState(channel, ttl, future)
  const amount = 3
  t.true(b4a.isBuffer(reqBuf), "should be buffer")

  let receiveCounter = 0
  core[1].on("response", (buf) => {
    receiveCounter++
    t.true(b4a.isBuffer(buf))
    const obj = cable.parseMessage(buf)
    t.true(obj.hashes.length > 0, "response hashes should be non-zero in length")
    t.equal(obj.msgType, constants.HASH_RESPONSE, "response buffer should be hash response") 
    t.true(receiveCounter <= amount, `receive counter should be at most ${amount}, was ${receiveCounter}`)
  })

  // register the channel state request
  core[1].handleRequest(reqBuf, () => {
    // then start writing posts to the databasem which will be sent out as future'd hash responses
    const promises = []
    for (let i = 0; i < amount; i++) {
      const p = new Promise((res, rej) => {
        switch (i) {
          case 0:
            core[1].join(channel, () => { res() })
            break
          case 1:
            core[1].setTopic(unrelatedChannel, `topic: welcome!`, () => { res() })
            break
          case 2:
            core[1].setNick("sweet-vine", () => { res() })
            break
        }
      })
      promises.push(p)
    }
    Promise.all(promises).then(() => { t.end() })
  })
})

