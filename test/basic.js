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

test("get users functionality", t => {
  const core = new CableCore()
  const channels = ["introduction", "another-channel"]
  // join and leave one channel
  core.join(channels[0])
  core.leave(channels[0])
  // stay in the other channel
  core.join(channels[1])
  core.getUsers((err, users) => {
    t.error(err, "get users should work")
    t.ok(users)
    t.equal(users.size, 1, "users map should be size 1")
    core.getUsersInChannel(channels[0], (err, users) => {
      t.error(err, "get users in channel should work")
      t.equal(users.size, 0, `channel ${channels[0]} should have no users`)
      core.getUsersInChannel(channels[1], (err, users) => {
        t.error(err, "get users in channel should work")
        t.equal(users.size, 1, `channel ${channels[1]} should have users`)
        t.end()
      })
    })
  })
})

test("set multiple topics and delete", t => {
  const core = new CableCore()
  const topics = ["first topic", "second topic", "third topic"]
  const channel = "introduction"
  const unrelated = ["unrelated-channel", "unrelated topic"]

  // set first topic
  core.setTopic(channel, topics[0])
  setTimeout(() => {
    // set second topic, and then get it
    core.setTopic(channel, topics[1])
    // set an unrelated topic (should not be set for main line of inquiry)
    core.setTopic(unrelated[0], unrelated[1])
    core.getTopic(channel, (err, topic) => {
      t.error(err, "get topic should work")
      t.equal(topic, topics[1], `actively set topic should be second topic (${topics[1]}`)
      setTimeout(() => {
        // a buf representing post/topic cable post for the third topic we set
        // set and get third topic
        const thirdTopic = core.setTopic(channel, topics[2])
        core.getTopic(channel, (err, topic) => {
          t.error(err, "get topic should work")
          t.equal(topic, topics[2], `active topic should be third topic (${topics[2]}`)
          // delete the third topic
          const thirdHash = core.hash(thirdTopic)
          core.del(thirdHash)
          setTimeout(() => {
            // get topic one final time (should be second topic now)
            core.getTopic(channel, (err, topic) => {
              t.error(err, "get topic should work after a delete")
              t.equal(topic, topics[1], `active topic should now be second topic (${topics[1]}) not first (${topics[0]}) or third (${topics[2]})`)
              t.end()
            })
            }, 100)
          })
        }, 100)
      })
    }, 50)
})

test("persisted posts should be indexed by reverse hash map view", t => {
  const core = new CableCore()
  const channel = "introduction"
  const buf = core.join(channel)
  const hash = core.hash(buf)
  setTimeout(() => {
    core.getJoinedChannels((err, data) => {
      t.error(err, "get joined channels should work")
      t.ok(data, "returned data should be good")
      t.equal(data.length, 1, "should return only 1 channel")
      t.equal(data[0], channel, `should have joined channel ${channel}`)
      core.store.reverseMapView.api.getUses(hash, (err, uses) => {
        t.comment("get a map of views where the hash of the post/join is referenced")

        t.error(err, "reverse map view's get uses should work")
        t.ok(uses, "returned data should be good")
        const viewsIndexingJoinPostHash = ["data-store", "channel-state", "author"]
        for (let key of uses.keys()) {
          t.true(viewsIndexingJoinPostHash.includes(key), `view ${key} should index the hash of a join post}`)
        }
        const delBuf = core.del(hash)
        const delHash = core.hash(delBuf)
        // after we delete the post/join, all the views that referenced it should no longer have an entry (the views
        // have been reindexed & wiped wrt the deleted post)
        setTimeout(() => {
          core.store.reverseMapView.api.getUses(hash, (err, uses) => {
            t.comment("post/join message should no longer be referenced anywhere, let's see if that's true")

            t.error(err, "reverse map view's get uses should work")
            t.ok(uses, "returned data should be good")
            const viewsIndexingJoinPostHash = ["data-store", "channel-state", "author"]
            for (let key of uses.keys()) {
              t.false(viewsIndexingJoinPostHash.includes(key), `view ${key} should no longer index the hash of a join post}`)
            }
            core.store.reverseMapView.api.getUses(delHash, (err, uses) => {
              t.comment("the hash of the delete message should now be referenced in the appropriate views")

              t.error(err, "reverse map view's get uses should work")
              t.ok(uses, "returned data should be good")
              const viewsIndexingDeletePostHash = ["data-store", "messages", "author"]
              for (let key of uses.keys()) {
                t.true(viewsIndexingDeletePostHash.includes(key), `view ${key} should index the hash of a delete post}`)
              }
              t.end()
            })
          })
        }, 100)
      })
    })
  }, 200)
})
