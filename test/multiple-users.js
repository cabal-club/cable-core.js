const test = require("tape")
const CableCore = require("../index.js").CableCore
const constants = require("../../cable/constants")
const cable = require("../../cable/index.js")

/* this test suite contains a bunch of tests exercising the basic functionality of cable-core.js with one user writing
 * posts and trying to get their indexed results */

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

test("multiple cores should be initializable", t => {
  const cores = [new CableCore(), new CableCore()]
  cores.forEach(core => {
    t.notEqual(undefined, core, "should not be undefined")
    t.notEqual(null, core, "should not be null")
  })
  t.end()
})

test("indexing external cable post should work as expected", t => {
  const cores = [new CableCore(), new CableCore()]
  const channel = "introduction"
  const text = "hello i am a cabler!"
  let pending = 0
  const done = () => {
    pending--
    if (pending <= 0) {
      t.end()
    }
  }
  const keys = cores.map(core => { return core.kp.publicKey })
  t.notDeepEqual(keys[0], keys[1], "public keys should be different for the two cores")

  // core 0 creates a text/post
  const bufLeave = cores[0].postText(channel, text, () => {
    // core 1 stores it
    cores[1]._storeExternalBuf(bufLeave, () => {
      cores.forEach(core => {
        pending++
        core.getChat("introduction", 0, 0, -1, (err, chat) => {
          t.error(err)
          t.equal(chat.length, 1, "chat should have 1 message")
          t.equal(chat[0].channel, channel)
          t.equal(chat[0].text, text)
          t.deepEqual(chat[0].publicKey, keys[0], `author of message should be core 0's public key (${keys[0].toString("hex")})`)
          done()
        })
      })
    })
  })
})
