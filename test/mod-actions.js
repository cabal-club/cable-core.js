const test = require("tape")
const util = require("../util.js")
const { MemoryLevel } = require("memory-level")
const createActionsIndex = require("../views/actions.js")
const cable = require("cable.js/index.js")
const constants = require("cable.js/constants.js")
const crypto = require("cable.js/cryptography.js")
const b4a = require("b4a")
const { annotateIsAdmin, before, after, between, User } = require("./moderation-test-util.js")

// TODO (2024-02-05): widely (across all indexes) implement consequences when dropping a user

const pubKey = (recp) => recp.kp.publicKey
const now = +(new Date())

function annotateIsApplicable(modAuthoritiesSet) {
  return (post) => {
    const obj = cable.parsePost(post)
    obj.hash = crypto.hash(post)
    if (modAuthoritiesSet.has(util.hex(obj.publicKey))) {
      return {...obj, isApplicable: true }
    }
    return obj
  }
}

const LINKS = []
const PRIVACY = 0
const REASON = ""
const DROP = 1
const NOTIFY = 1
const UNDROP = 1

function act(authorKp, recipient, timestamp, action, channel) {
  let recipients = [recipient]
  // channel drop/undrop actions have a zero length recipients array
  if (!recipient) {
    recipients = []
  }
  const post = cable.MODERATION_POST.create(authorKp.publicKey, authorKp.secretKey, LINKS, channel, timestamp, recipients, action, REASON, PRIVACY)
  const hash = crypto.hash(post)
  return { hash, timestamp, post }
}

function block(authorKp, recipient, timestamp, drop=DROP) {
  const post = cable.BLOCK_POST.create(authorKp.publicKey, authorKp.secretKey, LINKS, timestamp, [recipient], DROP, NOTIFY, REASON, PRIVACY)
  const hash = crypto.hash(post)
  return { hash, timestamp, post }
}

function unblock(authorKp, recipient, timestamp) {
  const post = cable.UNBLOCK_POST.create(authorKp.publicKey, authorKp.secretKey, LINKS, timestamp, [recipient], UNDROP, REASON, PRIVACY)
  const hash = crypto.hash(post)
  return { hash, timestamp, post }
}

test("smoke test", t => {
  t.pass("this test should always pass :>")
  t.end()
})

test("create index smoke test", t => {
  const db = new MemoryLevel({ valueEncoding: "utf8" })
  const index = createActionsIndex(db)
  t.ok(index, "create index should return something useful")
  t.end()
})


test("simple index querying", t => {
  const alice = new User()
  const bob = new User()
  const posthash = crypto.hash(b4a.from([1]))

  const db = new MemoryLevel({ valueEncoding: "utf8" })
  const index = createActionsIndex(db, () => { return pubKey(alice) })

  const posts = []
  const expectedHashes = new Set()
  const push = (o, expected) => { 
    posts.push(o.post) 
    if (expected) {
      expectedHashes.add(util.hex(o.hash))
    }
  }

  let o
  o = act(alice.kp, pubKey(bob), now, constants.ACTION_HIDE_USER, "") // this hide is negated by the unhide and should not be present when querying for applied hashes
  push(o)
  o = act(alice.kp, pubKey(bob), after(now), constants.ACTION_UNHIDE_USER, "") 
  push(o, true)
  o = act(alice.kp, posthash, after(o.timestamp), constants.ACTION_HIDE_POST, "default")
  push(o, true)
  o = act(alice.kp, null, after(o.timestamp), constants.ACTION_DROP_CHANNEL, "shit-channel")
  push(o, true)

  const authorities = new Set([pubKey(alice)].map(util.hex))
  const ops = posts.flatMap(annotateIsApplicable(authorities))
  index.map(ops)

  index.api.getAllApplied((err, hashes) => {
    t.error(err, "should have no error")
    t.equal(hashes.length, expectedHashes.size, "applied hashes from index should be same as expected hashes")
    hashes.forEach(h => {
      t.true(expectedHashes.has(util.hex(h)), "applied hash should be an expected hash" + h)
    })
    t.end()
  })
})

// uses notion of "isApplicable" to signal that an action came from an admin
test("local precedence test", t => {
  const local = new User()
  const alice = new User()
  const bob = new User()
  const posthash = crypto.hash(b4a.from([1]))

  const db = new MemoryLevel({ valueEncoding: "utf8" })
  const index = createActionsIndex(db, () => { return pubKey(local) })

  const posts = []
  const expectedHashes = new Set()
  const push = (o, expected) => { 
    posts.push(o.post) 
    if (expected) {
      expectedHashes.add(util.hex(o.hash))
    }
  }
  let o
  o = act(local.kp, pubKey(bob), now, constants.ACTION_HIDE_USER, "") // due to local precedence this hide should be maintained despite the unhide taking place later 
  push(o, true)
  o = act(alice.kp, pubKey(bob), after(now), constants.ACTION_UNHIDE_USER, "")
  push(o)
  o = act(alice.kp, posthash, now, constants.ACTION_HIDE_POST, "default")
  push(o, true)
  o = act(alice.kp, null, now, constants.ACTION_DROP_CHANNEL, "shit-channel")
  push(o, true)

  const authorities = new Set([local, alice].map(u => util.hex(pubKey(u))))
  const ops = posts.flatMap(annotateIsApplicable(authorities))

  index.map(ops)
  index.api.getAllApplied((err, hashes) => {
    t.error(err, "should have no error")
    t.equal(hashes.length, expectedHashes.size, "applied hashes from index should be same as expected hashes")
    hashes.forEach(h => {
      t.true(expectedHashes.has(util.hex(h)), "applied hash should be an expected hash")
    })
    t.end()
  })
})

test("mix of moderation actions from authorized and unauthorized users", t => {
  const local = new User() // moderation authority
  const alice = new User() // moderation authority
  const bob = new User() // not moderation authority
  const eve = new User() // not moderation authority

  const db = new MemoryLevel({ valueEncoding: "utf8" })
  const index = createActionsIndex(db, () => { return pubKey(local) })

  // alice and local are moderation authorities
  // local hides bob
  // alice drops bob
  // bob blocks alice             -- should not be applied
  // eve drops channel default    -- should not be applied
  // alice hides eve
  const expectedHashes = new Set()
  const posts = []
  const push = (o, expected) => { 
    posts.push(o.post) 
    if (expected) {
      expectedHashes.add(util.hex(o.hash))
    }
  }
  let expectedHashCount = 0
  let relevantHashCount = 0 // includes hashes from all peeps
  let o

  o = act(local.kp, pubKey(bob), now, constants.ACTION_HIDE_USER, "") // due to local precedence this hide should be maintained despite the unhide taking place later 
  push(o, true)
  ++relevantHashCount
  expectedHashCount += 1

  o = block(alice.kp, pubKey(bob), after(now), 1) // drop is part of "post/block" -> block and drop in a single post
  push(o, true)
  ++relevantHashCount
  expectedHashCount += 1 // dropped AND blocked in a single post

  o = block(bob.kp, pubKey(alice), after(o.timestamp))
  push(o)
  ++relevantHashCount

  o = act(eve.kp, null, now, constants.ACTION_DROP_CHANNEL, "default")
  push(o)
  ++relevantHashCount

  o = act(alice.kp, pubKey(eve), after(now), constants.ACTION_HIDE_USER, "") 
  push(o, true)
  ++relevantHashCount
  expectedHashCount += 1

  const authorities = new Set([local, alice].map(u => util.hex(pubKey(u))))
  const ops = posts.flatMap(annotateIsApplicable(authorities))

  index.map(ops)
  index.api.getAllApplied((err, hashes) => {
    t.error(err, "should have no error")
    t.equal(hashes.length, expectedHashCount, "applied hashes from index should be same as expected hashes")
    hashes.forEach(h => {
      t.true(expectedHashes.has(util.hex(h)), "applied hash should be an expected hash")
    })
    index.api.getAllRelevantSince(before(now), (err, hashes) => {
      t.equal(hashes.length, relevantHashCount, "returned relevant hash count should match expected count")
      t.end()
    })
  })
})

// test multiple actions for the same author-recp-context-action_group in order to exercise the removal of
// entries from table "time!" when "relevant!" is updated 
test("exercise changes in latest relevant action for the same set of author-recipient-context", t => {
  const alice = new User()
  const bob = new User()
  const posthash = crypto.hash(b4a.from([1]))

  const db = new MemoryLevel({ valueEncoding: "utf8" })
  const index = createActionsIndex(db, () => { return pubKey(alice) })

  let expectedHashes = new Set()
  const posts = []
  const push = (o, expected) => { 
    posts.push(o.post) 
    if (expected) {
      expectedHashes.add(util.hex(o.hash))
    }
  }
  // we will first index only o1
  const o1 = act(alice.kp, pubKey(bob), now, constants.ACTION_HIDE_USER, "")
  push(o1)
  // we will ingest o2 after asserting on o1 having been indexed correctly
  const o2 = act(alice.kp, pubKey(bob), after(o1.timestamp), constants.ACTION_UNHIDE_USER, "") 
  push(o2)

  const authorities = new Set([util.hex(pubKey(alice))])
  const allOps = posts.flatMap(annotateIsApplicable(authorities))
  const firstOp = allOps.filter(o => b4a.equals(o.hash, o1.hash))
  const secondOp = allOps.filter(o => b4a.equals(o.hash, o2.hash))

  index.map(firstOp)

  const ts = before(now)
  index.api.getAllRelevantSince(ts, (err, hashes) => {
    t.error(err, "should have no error")
    t.equal(hashes.length, 1, "# relevant hashes from index should be: 1")
    hashes.forEach(h => {
      t.equal(util.hex(h), util.hex(o1.hash), "relevant hash should be an expected hash")
    })

    // now ingest the second operation, which should entirely supercede the first operation
    // due to all of the following being the same:
    // * author
    // * recipient
    // * context
    // * type of action (hide or unhide) 
    
    index.map(secondOp)
    index.api.getAllRelevantSince(ts, (err, hashes) => {
      t.equal(hashes.length, 1, "# relevant hashes from index should be: 1")
      hashes.forEach(h => {
        t.equal(util.hex(h), util.hex(o2.hash), "relevant hash should be an expected hash")
      })
      t.end()
    })
  })
})

test("relevant action across a set of channels should only be returned for the queried set of channels", t => {
  const alice = new User()
  const bob = new User()
  const charlie = new User()
  const david = new User()
  const eve = new User()
  const felicia = new User()
  const gordon = new User()

  const posthash = crypto.hash(b4a.from([1]))

  const db = new MemoryLevel({ valueEncoding: "utf8" })
  const index = createActionsIndex(db, () => { return pubKey(alice) })

  let o
  let expectedHashes = new Set()
  const posts = []
  const push = (o, expected) => { 
    posts.push(o.post) 
    if (expected) {
      expectedHashes.add(util.hex(o.hash))
    }
  }
  o = act(alice.kp, pubKey(bob), after(now), constants.ACTION_HIDE_USER, "default")
  push(o, true)
  o = act(alice.kp, pubKey(charlie), after(now), constants.ACTION_HIDE_USER, "default")
  push(o, true)
  o = act(alice.kp, pubKey(david), after(now), constants.ACTION_HIDE_USER, "different-channel") // should be omitted from query
  push(o)
  o = act(alice.kp, pubKey(eve), after(now), constants.ACTION_HIDE_USER, "testing")
  push(o, true)
  o = act(alice.kp, pubKey(felicia), after(now), constants.ACTION_HIDE_USER, "") // should be included in query
  push(o, true)
  o = act(alice.kp, posthash, after(now), constants.ACTION_HIDE_POST, "default") // should be included in query
  push(o, true)
  o = block(alice.kp, pubKey(gordon), after(now)) // should be included in query!
  push(o, true)

  const channels = ["default", "testing"]

  const authorities = new Set([util.hex(pubKey(alice))])
  const ops = posts.flatMap(annotateIsApplicable(authorities))
  index.map(ops)

  const ts = before(now)
  index.api.getRelevantByContextsSince(ts, channels, (err, hashes) => {
    t.error(err, "should have no error")
    t.equal(hashes.length, expectedHashes.size, "relevant hashes from index should be same as expected hashes")
    hashes.forEach(h => {
      t.true(expectedHashes.has(util.hex(h)), "relevant hash should be an expected hash")
    })
    t.end()
  })
})

test(`assert on events emitted from index: 'apply-action' and 'remove-obsolete'`, t => {
  const alice = new User()
  const bob = new User()

  const db = new MemoryLevel({ valueEncoding: "utf8" })
  const index = createActionsIndex(db, () => { return pubKey(alice) })

  const posts = []
  const push = (o) => { 
    posts.push(o.post) 
  }

  // we will first index only o1
  const o1 = act(alice.kp, pubKey(bob), now, constants.ACTION_HIDE_USER, "")
  push(o1)
  // after asserting on o1 having been indexed correctyl, we will ingest o2
  const o2 = act(alice.kp, pubKey(bob), after(o1.timestamp), constants.ACTION_UNHIDE_USER, "") 
  push(o2)
  const o3 = act(bob.kp, pubKey(alice), after(o2.timestamp), constants.ACTION_HIDE_USER, "") // should not be applied nor cause events to emit
  push(o3)

  const authorities = new Set([util.hex(pubKey(alice))])
  const allOps = posts.flatMap(annotateIsApplicable(authorities))
  const firstOp = allOps.filter(o => b4a.equals(o.hash, o1.hash))
  const remainingOps = allOps.filter(o => !b4a.equals(o.hash, o1.hash))
  let pending = 3 // 2x "apply-action" events (one for each mod action) and 1x "remove obsolete"
  const done = (evtName) => {
    t.pass(`${evtName} happened`)
    if (--pending <= 0) {
      t.end()
    }
  }
  index.api.events.on("apply-action", () => { done("apply-action") })
  index.api.events.on("remove-obsolete", () => { done("remove-obsolete") })
  // index the first action and then the rest
  index.map(firstOp, () => { index.map(remainingOps) })
})
