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

function annotateIsApplicable(modAuthoritiesMap) {
  return (post) => {
    const obj = cable.parsePost(post)
    obj.postHash = crypto.hash(post)
    const role_ts = modAuthoritiesMap.get(util.hex(obj.publicKey))
    
    if (role_ts) {
      if (obj.timestamp >= role_ts.since) {
        return {...obj, isApplicable: true }
      }
      return obj
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

// TODO (2024-02-21): 
// make sure all code paths can work with multiple recipients
// * index.js: ModerationSystem
// * actions.js

function assign(authorKp, recipient, timestamp, role, context=constants.CABAL_CONTEXT) {
  const post = cable.ROLE_POST.create(authorKp.publicKey, authorKp.secretKey, LINKS, context, timestamp, b4a.from(recipient, "hex"), role, REASON, PRIVACY)
  const postHash = crypto.hash(post)
  return { postHash, timestamp, post }
}

function act(authorKp, recipient, timestamp, action, channel) {
  let recipients = [recipient]
  // channel drop/undrop actions have a zero length recipients array
  if (!recipient) {
    recipients = []
  }
  const post = cable.MODERATION_POST.create(authorKp.publicKey, authorKp.secretKey, LINKS, channel, timestamp, recipients, action, REASON, PRIVACY)
  const postHash = crypto.hash(post)
  return { postHash, timestamp, post }
}

function block(authorKp, recipient, timestamp) {
  const post = cable.BLOCK_POST.create(authorKp.publicKey, authorKp.secretKey, LINKS, timestamp, [recipient], DROP, NOTIFY, REASON, PRIVACY)
  const postHash = crypto.hash(post)
  return { postHash, timestamp, post }
}

function unblock(authorKp, recipient, timestamp) {
  const post = cable.UNBLOCK_POST.create(authorKp.publicKey, authorKp.secretKey, LINKS, timestamp, [recipient], UNDROP, REASON, PRIVACY)
  const postHash = crypto.hash(post)
  return { postHash, timestamp, post }
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
  const postHashes = [1,2,3,4].map(i => crypto.hash(b4a.from([i])))

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
  const adminKeys = new Set([pubKey(local), pubKey(alice)].map(util.hex))

  let actionPosts = []
  let expectedHashes = new Set()
  const push = (o, expected) => { 
    actionPosts.push(o.post) 
    if (expected) {
      expectedHashes.add(util.hex(o.postHash))
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
  const o_L2 = act(local.kp, postHashes[0], after(o_L1.timestamp), constants.ACTION_HIDE_POST, channel)
  push(o_L2, true)

  // local precedence prevents bob's action from being applied
  const o_B2 = act(bob.kp, postHashes[0], after(o_L2.timestamp), constants.ACTION_UNHIDE_POST, channel)
  push(o_B2)
  const o_B3 = act(bob.kp, postHashes[1], after(o_B2.timestamp), constants.ACTION_HIDE_POST, channel)
  push(o_B3, true)
  // to be overridden by alice's unhide for same post
  const o_B4 = act(bob.kp, postHashes[2], after(o_B3.timestamp), constants.ACTION_HIDE_POST, channel)
  push(o_B4)

  const o_A4 = act(alice.kp, postHashes[2], after(o_B4.timestamp), constants.ACTION_UNHIDE_POST, channel)
  push(o_A4, true)
  const o_A5 = act(alice.kp, postHashes[3], after(o_A4.timestamp), constants.ACTION_DROP_POST, channel)
  push(o_A5, true)

  /* actions on channels */
  const o_B5 = act(bob.kp, null, after(o_L2.timestamp), constants.ACTION_DROP_CHANNEL, hiddenChannel)
  push(o_B5, true)

  const expectedHiddenPosts = new Set([postHashes[0], postHashes[1]].map(util.hex))
  const expectedDroppedPosts = new Set([postHashes[3]].map(util.hex))
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
  
  // convert the assignments into a list of operations 
  const roleOps = assignments.flatMap(annotateIsAdmin(adminKeys))

  // ingest role ops into fakeHashDb
  roleOps.forEach((op) => { fakeHashDb.set(util.hex(op.postHash), op) })
  roles.map(roleOps)

  const sys = new ModerationRoles(pubKey(local))
  roles.api.getAllSinceTime(before(tsFirstAdmin), (err, hashes) => {
    const ops = hashes.map(h => fakeHashDb.get(util.hex(h)))
    const all = sys.analyze(ops)

    // get all our mods and admins
    const roleMap = all.get(constants.CABAL_CONTEXT)
    const admins = util.getRole(roleMap, constants.ADMIN_FLAG)
    t.equal(admins.size, 1, "should have one admin")
    const mods = util.getRole(roleMap, constants.MOD_FLAG)
    t.equal(mods.size, 1, "should have one mod")

    const authoritiesMap = new Map()
    Array.from(admins).concat(Array.from(mods)).forEach(pubkey => {
      const role_ts = roleMap.get(pubkey)
      authoritiesMap.set(pubkey, role_ts)
    })
    authoritiesMap.set(util.hex(pubKey(local)), { role: constants.ADMIN_FLAG, since: 0 })

    const actionOps = actionPosts.flatMap(annotateIsApplicable(authoritiesMap))
    // ingest action ops into fakeHashDb
    actionOps.forEach(op => { 
      if (op) { fakeHashDb.set(util.hex(op.postHash), op) }
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

      const state = new ModerationSystem(ops)
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
