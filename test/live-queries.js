const test = require("tape")
const b4a = require("b4a")
const CableCore = require("../index.js").CableCore
const constants = require("../../cable/constants")
const cable = require("../../cable/index.js")
const crypto = require("../../cable/cryptography.js")
const { testPostType, getDescriptiveType, assertPostType, assertBufType }  = require("../testutils.js")

/* this test suite contains a bunch of tests exercising live query functionality of the channel state request
 * and the channel time range request. where one party has received a request for more post hashes as they are produced"
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
    t.true(b4a.isBuffer(buf))
    const obj = cable.parseMessage(buf)
    t.true(obj.hashes.length > 0, "response hashes should be non-zero in length")
    t.equal(obj.msgType, constants.HASH_RESPONSE, "response buffer should be hash response") 
    receiveCounter++
    t.true(receiveCounter <= limit, `receive counter should be at most ${limit}, was ${receiveCounter}`)
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
    t.true(b4a.isBuffer(buf))
    const obj = cable.parseMessage(buf)
    t.true(obj.hashes.length > 0, "response hashes should be non-zero in length")
    t.equal(obj.msgType, constants.HASH_RESPONSE, "response buffer should be hash response") 
    receiveCounter++
    t.true(receiveCounter <= max, `receive counter should be at most ${limit}, was ${receiveCounter}`)
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
    t.true(b4a.isBuffer(buf))
    const obj = cable.parseMessage(buf)
    if (obj.hashes.length > 0 && obj.hashes[0].equals(firstBufHash)) {
      t.comment("first buf received")
      t.false(receivedFirstBufHash, "should only receive hash of first buf once")
      receivedFirstBufHash = true
    } else {
      t.true(obj.hashes.length > 0, "response hashes should be non-zero in length")
      t.comment(`received obj ${JSON.stringify(obj)}`)
      t.equal(obj.msgType, constants.HASH_RESPONSE, "response buffer should be hash response") 
      receiveCounter++
      t.comment(`current receiveCounter: ${receiveCounter}`)
      t.true(receiveCounter <= limit, `receive counter should be at most ${limit}, was ${receiveCounter}`)
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

// TODO (2023-04-25): 
// * test channel state request with deletes -> should surface the now-newest hash
// * test channel state request with cancel request -> should not send more hash responses after a cancel
// * test channel time range request with cancel request -> should not send more hash responses after a cancel

test("channel state request: start with empty database, send hashes as they are produced", t => {
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
    t.true(b4a.isBuffer(buf))
    const obj = cable.parseMessage(buf)
    t.true(obj.hashes.length > 0, "response hashes should be non-zero in length")
    t.equal(obj.msgType, constants.HASH_RESPONSE, "response buffer should be hash response") 
    receiveCounter++
    t.true(receiveCounter <= amount, `receive counter should be at most ${amount}, was ${receiveCounter}`)
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
    t.true(b4a.isBuffer(buf))
    const obj = cable.parseMessage(buf)
    t.true(obj.hashes.length > 0, "response hashes should be non-zero in length")
    t.equal(obj.msgType, constants.HASH_RESPONSE, "response buffer should be hash response") 
    receiveCounter++
    t.true(receiveCounter <= amount, `receive counter should be at most ${amount}, was ${receiveCounter}`)
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
      // now: cancel the open `request channel state`. this means that the final post should not be received
      core[1].handleRequest(cancelBuf, () => {
        // this post should not be emitted as a response
        core[1].postText(channel, `one final: hello hello!`, () => {
          t.end()
        })
      })
    })
  })
})












