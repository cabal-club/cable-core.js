const test = require("tape")
const CableCore = require("../index.js").CableCore
const constants = require("../../cable/constants")
const cable = require("../../cable/index.js")
const b4a = require("b4a")
const { testPostType, getDescriptiveType, assertPostType, assertBufType }  = require("../testutils.js")

/* this test suite contains a bunch of tests exercising the links functionality of cable. `links` is the concept
 * that enables better post sorting and causality in cable, wherein a newly made post will "link" to its last known
 * posts for that channel context by including the hashes of those newest posts in its links field. this post, once
 * made, becomes the newest post from our perspective -- a newest post in the `links` vernacular is referred to as a
 * 'head'.
*/

test("test passes", t => {
  t.plan(1)
  t.pass("this test always passes")
})

// this first proper links test makes sure that the links functionality is operating as expected underneath the api
// surface. when a first post is made, there is no links content to set so that post will have an empty links field.
//
// when the second post is made, we know of the first post; the second post's links field should contain the hash of the
// first post
test("setting links should work", t => {
  const core = new CableCore
  t.notEqual(undefined, core, "should not be undefined")
  t.notEqual(null, core, "should not be null")

  const channel = "introduction"
  const text = ["Hello hello.", "this is the second message!"]

  const buf1 = core.postText(channel, text[0], () => {
    t.ok(buf1, "first post buffer should be ok")
    const firstHash = core.hash(buf1)
    const obj1 = cable.parsePost(buf1)
    t.equal(obj1.links.length, 0, "links of first post buffer should be empty")
    t.equal(obj1.text, text[0], "first post's contents should be correct")
    const buf2 = core.postText(channel, text[1], () => {
      t.ok(buf2, "second post buffer should be ok")
      const obj2 = cable.parsePost(buf2)
      t.equal(obj2.links.length, 1, "links of second post buffer should have 1 entry")
      t.equal(obj2.text, text[1], "second post's contents should be correct")
      t.deepEqual(obj2.links[0], firstHash, "links of second post buffer should be hash of first post")
      t.end()
    })
  })
})

test("links should not be set if posts are two separate channel contexts", t => {
  const core = new CableCore
  t.notEqual(undefined, core, "should not be undefined")
  t.notEqual(null, core, "should not be null")

  const channel = ["introduction", "dev"]
  const text = ["Hello hello.", "this is the second message!"]

  const buf1 = core.postText(channel[0], text[0], () => {
    t.ok(buf1, "first post buffer should be ok")
    const firstHash = core.hash(buf1)
    const obj1 = cable.parsePost(buf1)
    t.equal(obj1.links.length, 0, "links of first post buffer should be empty")
    const buf2 = core.postText(channel[1], text[1], () => {
      t.ok(buf2, "second post buffer should be ok")
      const obj2 = cable.parsePost(buf2)
      t.equal(obj2.links.length, 0, "links of second post buffer should have no entry")
      t.end()
    })
  })
})

// TODO: check heads ordering when making post, then ingesting vs ingesting, then making post
test("links should be set correctly when ingesting external posts", t => {
  const core = [new CableCore(), new CableCore()]
  t.notEqual(undefined, core[0], "should not be undefined")
  t.notEqual(null, core[0], "should not be null")

  const channel = "introduction"
  const text = ["Hello hello.", "this is the second message!"]

  const buf1 = core[0].postText(channel, text[0], () => {
    t.ok(buf1, "first post buffer should be ok")
    const firstHash = core[0].hash(buf1)
    const obj1 = cable.parsePost(buf1)
    t.equal(obj1.links.length, 0, "links of first post buffer should be empty")
    t.equal(obj1.text, text[0], "first post's contents should be correct")
    // store core[0]'s post
    core[1]._storeExternalBuf(buf1, () => {
      // then make a post ourselves
      const buf2 = core[1].postText(channel, text[1], () => {
        t.ok(buf2, "second post buffer should be ok")
        const obj2 = cable.parsePost(buf2)
        t.equal(obj2.links.length, 1, "links of second post buffer should have 1 entry")
        t.equal(obj2.text, text[1], "second post's contents should be correct")
        t.deepEqual(obj2.links[0], firstHash, "links of second post buffer should be hash of first post")
        t.end()
      })
    })
  })
})

// sometimes when we ingest an external post, we can end up with a set of links that is > 1. typically this happens if
// posts are made to a channel at the same time, "concurrently" as it is known. 
//
// in this case, an external peer, core[0], makes a post. our peer, core[1] makes a post at the same time, at least as regards causality.
// when our peer ingests the external post, we should end up with two entries for the links of the specified channel
test("multiple links should be tracked", t => {
  const core = [new CableCore(), new CableCore()]
  t.notEqual(undefined, core[0], "should not be undefined")
  t.notEqual(null, core[0], "should not be null")

  const channel = "introduction"
  const text = ["Hello hello.", "this is the second message!"]

  const buf1 = core[0].postText(channel, text[0], () => {
    t.ok(buf1, "first post buffer should be ok")
    const firstHash = core[0].hash(buf1)
    const obj1 = cable.parsePost(buf1)
    t.equal(obj1.links.length, 0, "links of first post buffer should be empty")
    t.equal(obj1.text, text[0], "first post's contents should be correct")
    // simultaneously: make a post ourselves
    const buf2 = core[1].postText(channel, text[1], () => {
      t.ok(buf2, "second post buffer should be ok")
      const obj2 = cable.parsePost(buf2)
      t.equal(obj2.links.length, 0, "links of second post buffer should have no entry")
      t.equal(obj2.text, text[1], "second post's contents should be correct")
      // store core[0]'s post
      core[1]._storeExternalBuf(buf1, () => {
        const links = core[1]._links(channel)
        t.equal(links.length, 2, "tracked heads for channel should contain two links")
        t.end()
      })
    })
  })
})

test("multiple links should be set and merged", t => {
  const core = [new CableCore(), new CableCore()]
  t.notEqual(undefined, core[0], "should not be undefined")
  t.notEqual(null, core[0], "should not be null")

  const channel = "introduction"
  const text = ["Hello hello.", "this is the second message!", "third!", "4th!"]

  const buf1 = core[0].postText(channel, text[0], () => {
    t.ok(buf1, "first post buffer should be ok")
    const firstHash = core[0].hash(buf1)
    const obj1 = cable.parsePost(buf1)
    t.equal(obj1.links.length, 0, "links of first post buffer should be empty")
    t.equal(obj1.text, text[0], "first post's contents should be correct")
    // simultaneously: make a post ourselves
    const buf2 = core[1].postText(channel, text[1], () => {
      t.ok(buf2, "second post buffer should be ok")
      const obj2 = cable.parsePost(buf2)
      t.equal(obj2.links.length, 0, "links of second post buffer should have no entry")
      t.equal(obj2.text, text[1], "second post's contents should be correct")
      // store core[0]'s post
      core[1]._storeExternalBuf(buf1, () => {
        const links = core[1]._links(channel)
        t.equal(links.length, 2, "tracked heads for channel should contain two links")
        const buf3 = core[1].postText(channel, text[2], () => {
          const obj3 = cable.parsePost(buf3)
          t.equal(obj3.links.length, 2, "links of third post buffer should have two links set")
          t.equal(obj3.text, text[2], "third post's contents should be correct")
          const buf4 = core[1].postText(channel, text[3], () => {
            const obj4 = cable.parsePost(buf4)
            t.equal(obj4.links.length, 1, "links of last post buffer should have one link set")
            t.equal(obj4.text, text[3], "last post's contents should be correct")
            t.end()
          })
        })
      })
    })
  })
})
