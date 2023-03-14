const test = require("tape")
const CableCore = require("../index.js").CableCore
const constants = require("../../cable/constants")
const cable = require("../../cable/index.js")
const { testPostType, getDescriptiveType, assertPostType, assertBufType }  = require("../testutils.js")

/* this test suite contains a bunch of tests exercising functionality across more than one user. typically one user
 * writes a post, and then we add that post to the other user, finally making sure that the post contents are indexed as
 * expected across both users */

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


test("for two different users: write to a channel and then delete", t => {
  const cores = [new CableCore(), new CableCore()]
  const channel = "introduction"
  const text = "hello i am a cabler!"
  let pending = 0
  const done = (cb) => {
    pending--
    if (pending <= 0) {
      t.end()
    }
  }

  const buf = cores[0].postText(channel, text, () => {
    assertBufType(t, buf, constants.TEXT_POST)
    cores[1]._storeExternalBuf(buf, () => {
      const textHash = cores[0].hash(buf)
      t.deepEqual(cores[1].hash(buf), textHash, "hashes from two independent instance on same buf should be identical")

      // make sure both cores have the message before proceeding with next test steps
      const promises = []
      cores.forEach(core => {
        let promise = new Promise((res, rej) => {
          core.getChat("introduction", 0, 0, -1, (err, chat) => {
            t.error(err)
            t.equal(chat.length, 1, "chat should have 1 message")
            t.equal(chat[0].channel, channel)
            t.equal(chat[0].text, text)
            t.equal(chat[0].postType, constants.TEXT_POST)
            res()
          })
        })
        promises.push(promise)
      })

      // we've confirmed both cores have the message. now we delete it, and then verify that it's gone from both cores
      Promise.all(promises).then(() => {
        const delBuf = cores[0].del(textHash, () => {
          t.ok(delBuf, "delete buf should be not null")
          assertBufType(t, delBuf, constants.DELETE_POST)
          // ingest delete message for the other core, and when it's finished indexed try to get chat again for both
          // cores
          cores[1]._storeExternalBuf(delBuf, () => {
            cores.forEach(core => {
              pending++
              core.getChat("introduction", 0, 0, -1, (err, chat) => {
                // chat message should now be deleted
                t.error(err)
                t.equal(chat.length, 1, "chat should have 1 message (this time it's only the delete message")
                t.deepEqual(chat[0].hash, textHash, "target of delete should be hash of our prior post/text")
                t.equal(chat[0].postType, constants.DELETE_POST)
                done()
              })
            })
          })
        })
      })
    })
  })
})
