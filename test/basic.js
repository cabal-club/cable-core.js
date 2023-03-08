const test = require("tape")
const CableCore = require("../index.js").CableCore
const constants = require("../../cable/constants")
const cable = require("../../cable/index.js")

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

/* TODO (2023-03-08): beware of flake - means we need to review the async structures inside the views :) */
test("join and leave channels", t => {
  const core = new CableCore()
  const names = ["introduction", "another-channel"]
  core.join(names[0])
  core.leave(names[0])
  core.join(names[1])
  core.getJoinedChannels((err, channels) => {
    t.error(err, "should be able to get one joined channel")
    t.equal(channels.length, 1, "should only be joined to one channel")
    t.equal(channels[0], names[1], `joined channel should be '${names[1]}'`)
    t.end()
  })
})

test("hashing message buffer works as expected", t => {
  const core = new CableCore()
  const bufLeave = core.leave("introduction")
  t.ok(bufLeave, "message buffer should be not null")
  const hash = core.hash(bufLeave)
  t.ok(hash, "hash should be not null")
  t.equal(hash.length, constants.HASH_SIZE, `hash should be ${constants.HASH_SIZE} bytes`)
  t.end()
})

function assertPostType(t, obj, postType) {
  let descriptiveType = ""
  switch (postType) {
    case constants.TEXT_POST:
      descriptiveType = "post/text"
      break
    case constants.DELETE_POST:
      descriptiveType = "post/delete"
      break
    case constants.INFO_POST:
      descriptiveType = "post/info"
      break
    case constants.TOPIC_POST:
      descriptiveType = "post/topic"
      break
    case constants.JOIN_POST:
      descriptiveType = "post/join"
      break
    case constants.LEAVE_POST:
      descriptiveType = "post/leave"
      break
    default:
      t.fail(`unknown post type (${postType})`)
  }
  t.equal(obj.postType, postType,  `post type should be ${descriptiveType}`)
}

function testPostType (t, core, buf, postType, next) {
  t.ok(buf, "message buffer should be not null")

  const hash = core.hash(buf)
  t.ok(hash, "hash should be not null")

  const initialObj = cable.parsePost(buf)
  assertPostType(t, initialObj, postType)

  // TODO (2023-03-08): big switch that checks all properties that should exist do exist

  core.store.getData([hash], (err, data) => {
    t.error(err, "getting data for persisted hash should work")
    t.ok(data, "data should be not null")
    t.equal(data.length, 1, "should only return one result when querying one hash")
    const cablegram = data[0]
    const hashedData = core.hash(cablegram)
    t.deepEqual(hashedData, hash, "data put into store and retrieved from store should have identical hashes")

    const retrievedObj = cable.parsePost(cablegram)
    t.ok(retrievedObj, "returned post should be parsed correctly")
    assertPostType(t, retrievedObj, postType)
    t.deepEqual(retrievedObj, initialObj, "parsed bufs should be identical")
    next()
  })
}

test("writing to channel should persist post in store", t => {
  const core = new CableCore()
  const channel = "introduction"
  const text = "hello cablers! i am cable-person"
  const buf = core.postText(channel, text)

  const obj = cable.parsePost(buf)
  t.ok(obj.channel, "channel property should exist")
  t.equal(obj.channel, channel, `channel should be ${channel}`)
  t.equal(obj.text, text, `text in object should be identical to input`)

  testPostType(t, core, buf, constants.TEXT_POST, t.end)
})

test("write to a channel and then get message as chat", t => {
  const core = new CableCore()
  const channel = "introduction"
  const text = "hello cablers! i am cable-person"
  const buf = core.postText(channel, text)

  core.getChat("introduction", 0, 0, -1, (err, chat) => {
    t.error(err)
    t.equal(chat.length, 1, "chat should have 1 message")
    t.equal(chat[0].channel, channel)
    t.equal(chat[0].text, text)
    t.end()
  })
})

test("write to a channel and then delete", t => {
  const core = new CableCore()
  const channel = "introduction"
  const text = "hello cablers! i am cable-person"
  const buf = core.postText(channel, text)
  const textHash = core.hash(buf)

  core.getChat("introduction", 0, 0, -1, (err, chat) => {
    t.error(err)
    t.equal(chat.length, 1, "chat should have 1 message")
    t.equal(chat[0].channel, channel)
    t.equal(chat[0].text, text)
    t.equal(chat[0].postType, constants.TEXT_POST)

    const delBuf = core.del(textHash)
    t.ok(delBuf, "delete buf should be not null")

    setTimeout(() => {
      core.getChat("introduction", 0, 0, -1, (err, chat) => {
        t.error(err)
        t.equal(chat.length, 1, "chat should have 1 message (this time it's only the delete message")
        t.deepEqual(chat[0].hash, textHash, "target of delete should be hash of our prior post/text")
        t.equal(chat[0].postType, constants.DELETE_POST)
        t.end()
      })
    }, 100)
  })
})

test("post/text delete functionality", t => {
  const core = new CableCore()
  const channel = "introduction"
  const text = "hello cablers! i am cable-person"
  const buf = core.postText(channel, text)
  const textHash = core.hash(buf)

  core.getChat("introduction", 0, 0, -1, (err, chat) => {
    t.error(err)
    t.equal(chat.length, 1, "chat should have 1 message")

    const delBuf = core.del(textHash)
    t.ok(delBuf, "delete buf should be not null")

    setTimeout(() => {
      core.getChat("introduction", 0, 0, -1, (err, chat) => {
        t.error(err)
        t.deepEqual(chat[0].hash, textHash, "target of delete should be hash of our prior post/text")
        t.equal(chat[0].postType, constants.DELETE_POST)

        core.store.getData([textHash], (err, data) => {
          t.error(err)
          t.equal(data.length, 1, "we queried for 1 hash so result list should be same size")
          t.notOk(data[0], "returned data should be null because we should not be able to retrieve the deleted post/text")
          t.end()
        })
      })
    }, 100)
  })
})

test("setting channel topic should persist post in store", t => {
  const core = new CableCore()
  const channel = "introduction"
  const topic = "introduce yourself to fellow cablers"
  const buf = core.setTopic(channel, topic)

  const obj = cable.parsePost(buf)
  t.ok(obj.channel, "channel property should exist")
  t.equal(obj.channel, channel, `channel should be ${channel}`)
  t.equal(obj.topic, topic, `topic in object should be identical to input`)

  testPostType(t, core, buf, constants.TOPIC_POST, t.end)
})

test("setting a nick should persist post in store", t => {
  const core = new CableCore()
  const value = "cabler"
  const buf = core.setNick(value)

  const obj = cable.parsePost(buf)
  const key = "name"
  t.ok(obj.key, "key property should exist")
  t.ok(obj.value, "value property should exist")
  t.equal(obj.key, key, `info property 'key' should be '${value}`)
  t.equal(obj.value, value, `info property 'value' should be '${value}`)

  testPostType(t, core, buf, constants.INFO_POST, () => {
    core.getNick((err, nick) => {
      t.error(err, "getNick should work")
      t.equal(nick, value, `the set nickname should be ${value}`)
      t.end()
    })
  })
})

test("leaving channel should persist post in store", t => {
  const core = new CableCore()
  const channel = "introduction"
  const buf = core.leave(channel)

  const obj = cable.parsePost(buf)
  t.ok(obj.channel, "channel property should exist")
  t.equal(obj.channel, channel, `channel should be ${channel}`)

  testPostType(t, core, buf, constants.LEAVE_POST, t.end)
})

test("joining channel should persist post in store", t => {
  const core = new CableCore()
  const channel = "introduction"
  const buf = core.join(channel)

  const obj = cable.parsePost(buf)
  t.ok(obj.channel, "channel property should exist")
  t.equal(obj.channel, channel, `channel should be ${channel}`)

  testPostType(t, core, buf, constants.JOIN_POST, t.end)
})

