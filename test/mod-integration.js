const test = require("tape")
const util = require("../util.js")
const b4a = require("b4a")
const { MemoryLevel } = require("memory-level")
const createRolesIndex = require("../views/roles.js")
const createActionsIndex = require("../views/actions.js")
const { ModerationRoles, ModerationSystem } = require("../moderation.js")
// TODO (2024-02-19): replace with released cable.js/ version
const constants = require("cable.js/constants.js")
const cable = require("cable.js/index.js")
const crypto = require("cable.js/cryptography.js")

const { annotateIsAdmin, before, after, between, User } = require("./moderation-test-util.js")

const pubKey = (recp) => recp.kp.publicKey
const now = +(new Date())

function annotateIsApplicable(all) {
  return (post) => {
    const obj = cable.parsePost(post)
    obj.hash = crypto.hash(post)
    const isApplicable = util.isApplicable(post, all)
    return {...obj, isApplicable }
  }
}
const LINKS = []
const PRIVACY = 0
const REASON = ""
const DROP = 1
const NOTIFY = 1
const UNDROP = 1

// TODO (2024-02-21): 
// make sure all code paths can work with multiple recipients
// * index.js: ModerationSystem
// * actions.js

function assign(authorKp, recipient, timestamp, role, context=constants.CABAL_CONTEXT) {
  const post = cable.ROLE_POST.create(authorKp.publicKey, authorKp.secretKey, LINKS, context, timestamp, b4a.from(recipient, "hex"), role, REASON, PRIVACY)
  const hash = crypto.hash(post)
  return { hash, timestamp, post }
}

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

function block(authorKp, recipient, timestamp) {
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

// this test is equivalent to test/moderation-system.js
test("integration test across cable.js/ and moderation system", t => {
  const local = new User()

  const actionsDb = new MemoryLevel({ valueEncoding: "utf8" })
  const rolesDb = new MemoryLevel({ valueEncoding: "binary" })
  const roles = createRolesIndex(rolesDb)
  const actions = createActionsIndex(actionsDb, () => { return pubKey(local) })
  const channel = "default"
  const hiddenChannel = "bad-channel"

  // 4 post hashes
  const hashes = [1,2,3,4].map(i => crypto.hash(b4a.from([i])))

  const alice = new User() // admin
  const bob = new User()   // mod
  const felicia = new User()
  const eve = new User()
  const gordon = new User()

  const tsFirstAdmin = before(now) - 100
  const tsBobMod = tsFirstAdmin + 20
  
  const assignments = []
  const pushAssignment = (o) => {
    assignments.push(o.post)
  }
  // set up the roles: local set's alice as an admin. alice sets bob as a mod
  const t_L1 = assign(local.kp, pubKey(alice), tsFirstAdmin, constants.ADMIN_FLAG)
  pushAssignment(t_L1)
  const t_A1 = assign(alice.kp, pubKey(bob), tsBobMod, constants.MOD_FLAG)
  pushAssignment(t_A1)

  const fakeHashDb = new Map()

  let actionPosts = []
  let expectedHashes = new Set()
  const push = (o, expected) => { 
    actionPosts.push(o.post) 
    if (expected) {
      expectedHashes.add(util.hex(o.hash))
    }
  }

  /* actions on users */
  const o_L1 = block(local.kp, pubKey(eve), after(tsFirstAdmin))
  push(o_L1, true)

  // from before anyone other than local became an admin -> should not apply
  const o_B0 = act(bob.kp, pubKey(gordon), before(tsBobMod), constants.ACTION_HIDE_USER, "")
  push(o_B0)
  // overridden by alice's unhide
  const o_B1 = act(bob.kp, pubKey(eve), after(o_L1.timestamp), constants.ACTION_HIDE_USER, "")
  push(o_B1)

  const o_A1 = act(alice.kp, pubKey(eve), after(o_B1.timestamp), constants.ACTION_UNHIDE_USER, "")
  push(o_A1, true)
  // should not apply due to local precedence
  const o_A2 = unblock(alice.kp, pubKey(eve), after(o_A1.timestamp))
  push(o_A2)
  const o_A3 = act(alice.kp, pubKey(felicia), after(o_A2.timestamp), constants.ACTION_HIDE_USER, "")
  push(o_A3, true)

  // /* actions on posts */
  const o_L2 = act(local.kp, hashes[0], after(o_L1.timestamp), constants.ACTION_HIDE_POST, channel)
  push(o_L2, true)

  // local precedence prevents bob's action from being applied
  const o_B2 = act(bob.kp, hashes[0], after(o_L2.timestamp), constants.ACTION_UNHIDE_POST, channel)
  push(o_B2)
  const o_B3 = act(bob.kp, hashes[1], after(o_B2.timestamp), constants.ACTION_HIDE_POST, channel)
  push(o_B3, true)
  // to be overridden by alice's unhide for same post
  const o_B4 = act(bob.kp, hashes[2], after(o_B3.timestamp), constants.ACTION_HIDE_POST, channel)
  push(o_B4)

  const o_A4 = act(alice.kp, hashes[2], after(o_B4.timestamp), constants.ACTION_UNHIDE_POST, channel)
  push(o_A4, true)
  const o_A5 = act(alice.kp, hashes[3], after(o_A4.timestamp), constants.ACTION_DROP_POST, channel)
  push(o_A5, true)

  /* actions on channels */
  const o_B5 = act(bob.kp, null, after(o_L2.timestamp), constants.ACTION_DROP_CHANNEL, hiddenChannel)
  push(o_B5, true)

  const expectedHiddenPosts = new Set([hashes[0], hashes[1]].map(util.hex))
  const expectedDroppedPosts = new Set([hashes[3]].map(util.hex))
  const expectedDroppedChannels = new Set([hiddenChannel])

  // from local's POV
  // blocked: eve
  // hidden: felicia
  // (unhidden: eve, gordon)
  //
  // and two posts have been hidden

  const links = []
  const reason = ""
  const privacy = 0
  // we will go from user assignments to a list of operations -> post/role buffers -> post/role json objects.
  // operating on those last objects. 
  //
  // we do the entire pipeline to test that each individual step works and to confirm that it is also
  // suitable as input for the actual indexes

  function toObj(post) {
    const obj = cable.parsePost(post)
    obj.hash = crypto.hash(post)
    return obj
  }

  function annotate (rolesMap) {
    return (post) => {
      const obj = toObj(post)
      const isAdmin = util.isAdmin(post, rolesMap)
      return { ...obj, isAdmin }
    }
  }
  
  const sys = new ModerationRoles(pubKey(local))
  const roleOps = assignments.flatMap(toObj)
  const all = sys.analyze(roleOps)
  // annotate operations with `isAdmin` which is used as information by view `roles` indexing
  const annotatedOps = assignments.flatMap(annotate(all))

  // ingest role ops into fakeHashDb
  annotatedOps.forEach((op) => { fakeHashDb.set(util.hex(op.hash), op) })
  roles.map(annotatedOps)

  roles.api.getAllSinceTime(before(tsFirstAdmin), (err, hashes) => {
    const ops = hashes.map(h => fakeHashDb.get(util.hex(h)))

    // get all our mods and admins
    const roleMap = all.get(constants.CABAL_CONTEXT)
    const admins = util.getRole(roleMap, constants.ADMIN_FLAG)
    t.equal(admins.size, 2, "should have one admin in addition to local user")
    const mods = util.getRole(roleMap, constants.MOD_FLAG)
    t.equal(mods.size, 1, "should have one mod")

    const actionOps = actionPosts.flatMap(annotateIsApplicable(all))
    // ingest action ops into fakeHashDb
    actionOps.forEach(op => { 
      if (op) { fakeHashDb.set(util.hex(op.hash), op) }
    })
    actions.map(actionOps)

    actions.api.getAllApplied((err, actionHashes) => {
      const ops = actionHashes.map(h => fakeHashDb.get(h))
      // construct a little graph of applied mod actions using action ops
      t.error(err, "should have no error")
      t.equal(actionHashes.length, expectedHashes.size, "applied hashes from index should be same as expected hashes")
      actionHashes.forEach(h => {
        t.true(expectedHashes.has(h), `applied hash '${h}' should be an expected hash`)
      })

      const state = new ModerationSystem()
      state.process(ops)
      const hidden = state.getHiddenUsers()
      const dropped = state.getDroppedUsers()
      const blocked = state.getBlockedUsers()
      const hiddenPosts = state.getHiddenPosts()
      const droppedPosts = state.getDroppedPosts()
      const droppedChannels = state.getDroppedChannels()

      t.equal(droppedChannels.length, 1, "one channel should be dropped")
      t.equal(droppedPosts.length, 1, "one post should be dropped")
      t.equal(hiddenPosts.length, 2, "two posts should be hidden")
      t.equal(dropped.length, 0, "should have no dropped user")
      t.equal(hidden.length, 1, "should have 1 hidden user")
      t.equal(blocked.length, 1, "should have 1 blocked user")
      t.equal(hidden[0], util.hex(pubKey(felicia)), "felicia should be hidden")
      t.equal(blocked[0], util.hex(pubKey(eve)), "eve should be blocked")

      hiddenPosts.forEach(p => {
        t.true(expectedHiddenPosts.has(p), `post ${util.hex(p)} was expected to be hidden`)
      })
      droppedPosts.forEach(p => {
        t.true(expectedDroppedPosts.has(p), `post ${util.hex(p)} was expected to be dropped`)
      })
      droppedChannels.forEach(c => {
        t.true(expectedDroppedChannels.has(c), `${c} was expected to be dropped`)
      })

      t.end()
    })
  })
})
