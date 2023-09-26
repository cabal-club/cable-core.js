// SPDX-FileCopyrightText: 2023 the cabal-club authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const test = require("tape")
const CableCore = require("../index.js").CableCore
const constants = require("cable.js/constants")
const cable = require("cable.js/index.js")
const { testPostType, getDescriptiveType, assertPostType, assertBufType }  = require("../testutils.js")

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

test("hashing message buffer works as expected", t => {
  const core = new CableCore()
  const bufLeave = core.leave("introduction")
  t.ok(bufLeave, "message buffer should be not null")
  const hash = core.hash(bufLeave)
  t.ok(hash, "hash should be not null")
  t.equal(hash.length, constants.HASH_SIZE, `hash should be ${constants.HASH_SIZE} bytes`)
  t.end()
})

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

test("writing to channel implicitly signals membership, user should read as a member after posting", t => {
  const core = new CableCore()
  const pubkey = core.kp.publicKey
  const channel = "introduction"
  const text = "hello cablers! i am cable-person"
  core.getUsersInChannel(channel, (err, users) => {
    t.error(err, "get users in channel should work")
    t.equal(users.size, 0, "should be no users at start")
  })
  const buf = core.postText(channel, text, () => {
    const obj = cable.parsePost(buf)
    t.ok(obj.channel, "channel property should exist")
    t.equal(obj.channel, channel, `channel should be ${channel}`)
    t.equal(obj.text, text, `text in object should be identical to input`)

    core.getUsersInChannel(channel, (err, users) => {
      t.error(err, "get users in channel should work")
      t.equal(users.size, 1, "should have 1 user after posting")
      t.true(users.has(pubkey.toString("hex")), "returned users map should have posting user")
      t.end()
    })
  })
})

test("implicitly joined channel should be possible to leave", t => {
  const core = new CableCore()
  const pubkey = core.kp.publicKey
  const channel = "introduction"
  const text = "hello cablers! i am cable-person"
  const buf = core.postText(channel, text, () => {
    const obj = cable.parsePost(buf)
    t.ok(obj.channel, "channel property should exist")
    t.equal(obj.channel, channel, `channel should be ${channel}`)
    t.equal(obj.text, text, `text in object should be identical to input`)

    core.getUsersInChannel(channel, (err, users) => {
      t.error(err, "get users in channel should work")
      t.equal(users.size, 1, "should have 1 user after posting")
      t.true(users.has(pubkey.toString("hex")), "returned users map should have posting user")
      core.leave(channel, () => {
        core.getUsersInChannel(channel, (err, users) => {
          t.error(err, "get users in channel should work")
          t.equal(users.size, 0, "channel should have no user after leaving")
          t.end()
        })
      })
    })
  })
})

test("write to a channel and then get message as chat", t => {
  const core = new CableCore()
  const channel = "introduction"
  const text = "hello cablers! i am cable-person"
  const buf = core.postText(channel, text, () => {
    assertBufType(t, buf, constants.TEXT_POST)

    core.getChat("introduction", 0, 0, -1, (err, chat) => {
      t.error(err)
      t.equal(chat.length, 1, "chat should have 1 message")
      t.equal(chat[0].channel, channel)
      t.equal(chat[0].text, text)
      t.end()
    })
  })
})

test("write to a channel and then delete", t => {
  const core = new CableCore()
  const channel = "introduction"
  const text = "hello cablers! i am cable-person"
  const buf = core.postText(channel, text, () => {
    assertBufType(t, buf, constants.TEXT_POST)
    const textHash = core.hash(buf)

    core.getChat("introduction", 0, 0, -1, (err, chat) => {
      t.error(err)
      t.equal(chat.length, 1, "chat should have 1 message")
      t.equal(chat[0].channel, channel)
      t.equal(chat[0].text, text)
      t.equal(chat[0].postType, constants.TEXT_POST)

      const delBuf = core.del(textHash, () => {
        t.ok(delBuf, "delete buf should be not null")
        assertBufType(t, delBuf, constants.DELETE_POST)
        setTimeout(() => {
        core.getChat("introduction", 0, 0, -1, (err, chat) => {
          t.error(err)
          t.equal(chat.length, 1, "chat should have 1 message (this time it's only the delete message")
          t.deepEqual(chat[0].hashes[0], textHash, "target of delete should be hash of our prior post/text")
          t.equal(chat[0].postType, constants.DELETE_POST)
          t.end()
        })
        }, 500)
      })
    })
  })
})

test("post/text delete functionality", t => {
  const core = new CableCore()
  const channel = "introduction"
  const text = "hello cablers! i am cable-person"
  const buf = core.postText(channel, text)
  const textHash = core.hash(buf)
  assertBufType(t, buf, constants.TEXT_POST)

  core.getChat("introduction", 0, 0, -1, (err, chat) => {
    t.error(err)
    t.equal(chat.length, 1, "chat should have 1 message")

    const delBuf = core.del(textHash, () => {
    t.ok(delBuf, "delete buf should be not null")
    assertBufType(t, delBuf, constants.DELETE_POST)
      core.getChat("introduction", 0, 0, -1, (err, chat) => {
        t.error(err)
        t.deepEqual(chat[0].hashes[0], textHash, "target of delete should be hash of our prior post/text")
        t.equal(chat[0].postType, constants.DELETE_POST)

        core.store.getData([textHash], (err, data) => {
          t.error(err)
          t.equal(data.length, 1, "we queried for 1 hash so result list should be same size")
          t.notOk(data[0], "returned data should be null because we should not be able to retrieve the deleted post/text")
          t.end()
        })
      })
    })
  })
})

test("setting channel topic should persist post in store", t => {
  const core = new CableCore()
  const channel = "introduction"
  const topic = "introduce yourself to fellow cablers"
  const buf = core.setTopic(channel, topic)
  assertBufType(t, buf, constants.TOPIC_POST)

  const obj = cable.parsePost(buf)
  t.ok(obj.channel, "channel property should exist")
  t.equal(obj.channel, channel, `channel should be ${channel}`)
  t.equal(obj.topic, topic, `topic in object should be identical to input`)

  testPostType(t, core, buf, constants.TOPIC_POST, t.end)
})

test("setting channel topic should implicitly join channel", t => {
  const core = new CableCore()
  const pubkey = core.kp.publicKey
  const channel = "introduction"
  const topic = "introduce yourself to fellow cablers"
  core.getUsersInChannel(channel, (err, users) => {
    t.error(err, "get users in channel should work")
    t.equal(users.size, 0, "should have no users initially")
  })

  const buf = core.setTopic(channel, topic, () => {
    assertBufType(t, buf, constants.TOPIC_POST)
    const obj = cable.parsePost(buf)
    t.ok(obj.channel, "channel property should exist")
    t.equal(obj.channel, channel, `channel should be ${channel}`)
    t.equal(obj.topic, topic, `topic in object should be identical to input`)

    core.getUsersInChannel(channel, (err, users) => {
      t.error(err, "get users in channel should work")
      t.equal(users.size, 1, "should have 1 user after setting topic")
      t.true(users.has(pubkey.toString("hex")), "returned users map should have posting user")
      t.end()
    })
  })
})

test("implicitly joined channel (by setting topic) should be possible to leave", t => {
  const core = new CableCore()
  const pubkey = core.kp.publicKey
  const channel = "introduction"
  const topic = "introduce yourself to fellow cablers"

  const buf = core.setTopic(channel, topic, () => {
    assertBufType(t, buf, constants.TOPIC_POST)
    const obj = cable.parsePost(buf)
    t.ok(obj.channel, "channel property should exist")
    t.equal(obj.channel, channel, `channel should be ${channel}`)
    t.equal(obj.topic, topic, `topic in object should be identical to input`)

    core.getUsersInChannel(channel, (err, users) => {
      t.error(err, "get users in channel should work")
      t.equal(users.size, 1, "should have 1 user after setting topic")
      t.true(users.has(pubkey.toString("hex")), "returned users map should have posting user")
      core.leave(channel, () => {
        core.getUsersInChannel(channel, (err, users) => {
          t.error(err, "get users in channel should work")
          t.equal(users.size, 0, "channel should have no user after leaving")
          t.end()
        })
      })
    })
  })
})

test("setting a nick should persist post in store", t => {
  const core = new CableCore()
  const value = "cabler"
  const buf = core.setName(value)
  assertBufType(t, buf, constants.INFO_POST)

  const obj = cable.parsePost(buf)
  const key = "name"
  t.ok(obj.key, "key property should exist")
  t.ok(obj.value, "value property should exist")
  t.equal(obj.key, key, `info property 'key' should be '${key}`)
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
  assertBufType(t, buf, constants.LEAVE_POST)

  const obj = cable.parsePost(buf)
  t.ok(obj.channel, "channel property should exist")
  t.equal(obj.channel, channel, `channel should be ${channel}`)

  testPostType(t, core, buf, constants.LEAVE_POST, t.end)
})

test("joining channel should persist post in store", t => {
  const core = new CableCore()
  const channel = "introduction"
  const buf = core.join(channel)
  assertBufType(t, buf, constants.JOIN_POST)

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
  core.setTopic(channel, topics[0], () => {
    // set second topic, and then get it
    core.setTopic(channel, topics[1])
    // set an unrelated topic (should not be set for main line of inquiry)
    core.setTopic(unrelated[0], unrelated[1])
    core.getTopic(channel, (err, topic) => {
      t.error(err, "get topic should work")
      t.equal(topic, topics[1], `actively set topic should be second topic (${topics[1]}`)
      // a buf representing post/topic cable post for the third topic we set
      // set and get third topic
      const thirdTopic = core.setTopic(channel, topics[2], () => {
        core.getTopic(channel, (err, topic) => {
          t.error(err, "get topic should work")
          t.equal(topic, topics[2], `active topic should be third topic (${topics[2]}`)
          // delete the third topic
          const thirdHash = core.hash(thirdTopic)
          core.del(thirdHash, () => {
            // get topic one final time (should be second topic now)
            core.getTopic(channel, (err, topic) => {
              t.error(err, "get topic should work after a delete")
              t.equal(topic, topics[1], `active topic should now be second topic (${topics[1]}) not first (${topics[0]}) or third (${topics[2]})`)
              t.end()
            })
          })
        })
      })
    })
  })
})

test("persisted posts should be indexed by reverse hash map view", t => {
  const core = new CableCore()
  const channel = "introduction"
  const buf = core.join(channel, () => {
  assertBufType(t, buf, constants.JOIN_POST)
  const hash = core.hash(buf)
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
        const delBuf = core.del(hash, () => {
          // after we delete the post/join, all the views that referenced it should no longer have an entry (the views
          // have been reindexed & wiped wrt the deleted post)
          assertBufType(t, delBuf, constants.DELETE_POST)
          const delHash = core.hash(delBuf)
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
        })
      })
    })
  })
})
