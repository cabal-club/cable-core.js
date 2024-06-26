// SPDX-FileCopyrightText: 2024 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const test = require("tape")
const util = require("../util.js")
const b4a = require("b4a")
const { MemoryLevel } = require("memory-level")
const createRolesIndex = require("../views/roles.js")
const { ModerationRoles } = require("../moderation.js")
const constants = require("cable.js/constants.js")
const crypto = require("cable.js/cryptography.js")
const cable = require("cable.js/index.js")
const { annotateIsAdmin, before, after, between, User } = require("./moderation-test-util.js")

const now = +(new Date())

const pubKey = (u) => util.hex(u.kp.publicKey)
const pubKeyBuf = (u) => u.kp.publicKey

const LINKS = []
const REASON = ""
const PRIVACY = 0

function toObj(post) {
  const obj = cable.parsePost(post)
  obj.hash = crypto.hash(post)
  return obj
}

function annotate (localKp, rolesMap) {
  return (post) => {
    const obj = toObj(post)
    const isAdmin = util.isAdmin(localKp, post, rolesMap)
    return { ...obj, isAdmin }
  }
}
  

function assign(authorKp, recipient, timestamp, role, context=constants.CABAL_CONTEXT) {
  const post = cable.ROLE_POST.create(authorKp.publicKey, authorKp.secretKey, LINKS, context, timestamp, b4a.from(recipient, "hex"), role, REASON, PRIVACY)
  const hash = crypto.hash(post)
  return { hash, timestamp, post }
}

test("smoke test", t => {
  t.pass("this test should always pass :>")
  t.end()
})

test("create index smoke test", t => {
  const db = new MemoryLevel({ valueEncoding: "binary" })
  const index = createRolesIndex(db)
  t.ok(index, "create index should return something useful")
  t.end()
})

test("create index and make basic query", t => {
  const db = new MemoryLevel({ valueEncoding: "binary" })
  const index = createRolesIndex(db)
  const local = new User()
  const alice = new User()
  const bob = new User()

  const posts = []
  const push = (o) => { 
    posts.push(o.post) 
  }

  const L1 = assign(local.kp, pubKey(alice), after(now), constants.ADMIN_FLAG)
  push(L1)
  const A1 = assign(alice.kp, pubKey(bob), after(L1.timestamp), constants.MOD_FLAG)
  push(A1)
  const adminKeys = new Set([pubKey(local), pubKey(alice)])
  const ops = posts.flatMap(annotateIsAdmin(adminKeys))

  index.map(ops)
  index.api.getLatestByAuthor(pubKey(local), (err, hashes) => {
    t.error(err, "should not error for getting local's hashes")
    t.equal(hashes.length, 1, "hashes returned should equal local's assignments")
    index.api.getAllByAuthorSinceTime(pubKey(local), now, (err, hashes) => {
      t.equal(hashes.length, 1, "hashes returned should equal local's assignments after() ts")
      index.api.getLatestByAuthor(pubKey(bob), (err, hashes) => {
        t.equal(hashes.length, 0, "no hashes from bob")
        t.end()
      })
    })
  })
})

test("testing combined example from spec (section 4.2.5.1.4 Combined example)", t => {
  const ursula = new User() // our pov i.e. the 'local user'
  const aleph = new User()
  const bert = new User()
  const channel = "test"

  const posts = []
  const push = (obj) => {
    posts.push(obj.post)
  }
  // step 1
  const u1 = assign(ursula.kp, pubKey(bert), after(now), constants.ADMIN_FLAG)
  push(u1)
  // step 2
  const u2 = assign(ursula.kp, pubKey(aleph), after(u1.timestamp), constants.MOD_FLAG, channel)
  push(u2)
  // step 3
  const b1 = assign(ursula.kp, pubKey(aleph), after(u2.timestamp), constants.ADMIN_FLAG)
  push(b1)
  // step 4
  const u3 = assign(ursula.kp, pubKey(aleph), after(b1.timestamp), constants.USER_FLAG)
  push(u3)

  /* from spec:
    After applying step 3, Ursula considers Aleph to have role mod in channel
    `test` (rule *2. the local user's roles trump all other roles*) and as
    role admin in all the other channels of the cabal (rule *3. the relevant
    role with the most capabilities trumps roles that have lower
    capabilities*).

    After step 4, Ursula considers Aleph to have role normal user
    in the entire cabal with the exception of channel `test` where they
    retain their moderator role (rule *3.  The relevant role with the most
    capabilities trumps roles that have lower capabilities* causes mod to be
    retained in `test` due to being a relevant role and having greater
    capabilities).
  */

  const db = new MemoryLevel({ valueEncoding: "binary" })
  const index = createRolesIndex(db)
  
  const sys = new ModerationRoles(pubKeyBuf(ursula))
  let all = sys.analyze(posts.flatMap(toObj))
  const ops = posts.flatMap(annotate(ursula.kp, all))


  // simulate having stored the operations by their hash. we'll query this fake database of hashes later using the
  // hashes we get out from querying the indexes
  const fakeHashDb = new Map()
  ops.forEach(op => { fakeHashDb.set(util.hex(op.hash), op) })
  index.map(ops)

  index.api.getRelevantRoleHashes((err, hashes) => {
    const opsMap = new Map()
    opsMap.set("indexes", hashes.map(h => fakeHashDb.get(util.hex(h))))
    opsMap.set("original", ops)

    let roleMap, admins, mods, users
    for (let [source, ops] of opsMap.entries()) {
      all = sys.analyze(ops)
      // on cabal context
      roleMap = all.get(constants.CABAL_CONTEXT)
      admins = util.getRole(roleMap, constants.ADMIN_FLAG) 
      mods = util.getRole(roleMap, constants.MOD_FLAG)
      users = util.getRole(roleMap, constants.USER_FLAG)
      t.equal(admins.size, 2, `${source}: cabal admins`) // bert + ursula
      t.equal(mods.size, 0, `${source}: cabal mods`)
      t.equal(users.size, 1, `${source}: cabal users`)
      // on cabal context
      roleMap = all.get(channel)
      admins = util.getRole(roleMap, constants.ADMIN_FLAG) 
      mods = util.getRole(roleMap, constants.MOD_FLAG)
      users = util.getRole(roleMap, constants.USER_FLAG)
      t.equal(admins.size, 2, `${source}: channel admins`) // bert + ursula
      t.equal(mods.size, 1, `${source}: channel mods`)
      t.equal(users.size, 0, `${source}: channel users`)
    }

    t.end()
  })
})

test("simple scenario with index comparison", t => {
  const local = new User()
  const alice = new User()
  const bob = new User()
  const eve = new User()
  const felicia = new User()

  const posts = []
  const push = (obj) => {
    posts.push(obj.post)
  }
  // from local's pov, local's assignments have precedence over those made by other users
  const l1 = assign(local.kp, pubKey(alice), after(now), constants.ADMIN_FLAG) // constants.ADMIN_FLAG => may assign roles for those viewing that user as admin
  push(l1)
  const l2 = assign(local.kp, pubKey(bob), after(l1.timestamp), constants.ADMIN_FLAG)
  push(l2)
  const l3 = assign(local.kp, pubKey(eve), after(l1.timestamp), constants.USER_FLAG) // eve should never be anything other than a user
  push(l3)

  const a1 = assign(alice.kp, pubKey(felicia), after(l2.timestamp), constants.USER_FLAG) // will be overridden by bob's assignment just a few lines down
  push(a1)

  const b1 = assign(bob.kp, pubKey(felicia), after(a1.timestamp), constants.MOD_FLAG) // will be mod, because it's the highest set capability that is chosen (barring local assignments)
  push(b1)
  const b2 = assign(bob.kp, pubKey(eve), after(b1.timestamp), constants.MOD_FLAG) // denied by local's assignment
  push(b2)

  const e1 = assign(eve.kp, pubKey(alice), after(b1.timestamp), constants.USER_FLAG) // no effect
  push(e1)
  const e2 = assign(eve.kp, pubKey(bob), after(b1.timestamp), constants.USER_FLAG) // no effect
  push(e2)

  /* 
   * local should have:
   *
   * 2+1 admin (alice, bob + local)
   * 1 mod (felicia)
   * 1 user (eve)
   *
   */
  const db = new MemoryLevel({ valueEncoding: "binary" })
  const index = createRolesIndex(db)

  const sys = new ModerationRoles(pubKeyBuf(local))
  let all = sys.analyze(posts.flatMap(toObj))
  const ops = posts.flatMap(annotate(local.kp, all))

  // simulate having stored the operations by their hash. we'll query this fake database of hashes later using the
  // hashes we get out from querying the indexes
  const fakeHashDb = new Map()
  ops.forEach(op => { fakeHashDb.set(util.hex(op.hash), op) })
  index.map(ops)

  index.api.getAllSinceTime(now, (err, hashes) => {
    const opsMap = new Map()
    opsMap.set("indexes", hashes.map(h => fakeHashDb.get(util.hex(h))))
    opsMap.set("original", ops)

    for (let [source, ops] of opsMap.entries()) {
      all = sys.analyze(ops)
      const roleMap = all.get(constants.CABAL_CONTEXT)
      const admins = util.getRole(roleMap, constants.ADMIN_FLAG) 
      const mods = util.getRole(roleMap, constants.MOD_FLAG)
      const users = util.getRole(roleMap, constants.USER_FLAG)
      t.equal(admins.size, 3, `${source}: admins`)
      t.equal(mods.size, 1, `${source}: mods`)
      t.equal(users.size, 1, `${source}: users`)
    }

    t.end()
  })
})

test("assert that the timestamp a role is valid from is the *lowest* timestamp for the *most* capable role assigned to this recipient", t => {
  const local = new User()
  const alice = new User()
  const bob = new User()
  const felicia = new User()

  const posts = []
  const push = (obj) => {
    posts.push(obj.post)
  }

  const L1 = assign(local.kp, pubKey(alice), after(now), constants.ADMIN_FLAG)
  push(L1)
  const L2 = assign(local.kp, pubKey(bob), after(L1.timestamp), constants.ADMIN_FLAG)
  push(L2)

  // alice's assignment for felicia has a lower timestamp than bob's -> it's the time the role should be valid from for local's perspective
  const A1 = assign(alice.kp, pubKey(felicia), after(L2.timestamp), constants.MOD_FLAG) 
  push(A1)
  const B1 = assign(bob.kp, pubKey(felicia), after(A1.timestamp), constants.MOD_FLAG) 
  push(B1)

  /* 
   * local should have:
   *
   * 2+1 admin (alice, bob + local)
   * 1 mod (felicia)
   *
   */

  const sys = new ModerationRoles(pubKeyBuf(local))
  let all = sys.analyze(posts.flatMap(toObj))
  const feliciaTs = all.get(constants.CABAL_CONTEXT).get(pubKey(felicia)).since
  t.true(feliciaTs === A1.timestamp, "felicia's role was valid from the time alice issued it")
  t.end()
})

test("test index table `latest`", t => {
  const local = new User()
  const alice = new User()
  const bob = new User()
  const eve = new User()
  const felicia = new User()
  const gordon = new User()

  const posts = []
  const push = (o) => {
    posts.push(o.post)
  }
  const adminHashes = []

  // from local's pov, local's assignments have precedence over those made by other users
  const L0 = assign(local.kp, pubKey(alice), after(now), constants.ADMIN_FLAG) // ADMIN => may assign roles for those viewing that user as admin
  push(L0)
  adminHashes.push(L0.hash)
  // don't add this to adminHashes - it's overridden on the next line
  const L1 = assign(local.kp, pubKey(bob), after(L0.timestamp), constants.USER_FLAG)
  push(L1)
  const L2 = assign(local.kp, pubKey(bob), after(L1.timestamp), constants.ADMIN_FLAG)
  push(L2)
  adminHashes.push(L2.hash)
  const L3 = assign(local.kp, pubKey(eve), after(now), constants.USER_FLAG) // eve should never be anything other than a user
  push(L3)
  adminHashes.push(L3.hash)

  const A1 = assign(alice.kp, pubKey(felicia), after(L0.timestamp), constants.USER_FLAG) // will be overridden by bob's assignment just a few lines down
  push(A1)
  adminHashes.push(A1.hash)

  const B1 = assign(bob.kp, pubKey(gordon), between(L1.timestamp, L2.timestamp), constants.MOD_FLAG) // made when bob was not an admin, no effect
  push(B1)
  const B2 = assign(bob.kp, pubKey(eve), after(L2.timestamp), constants.MOD_FLAG) // denied by local's assignment - should still be indexed?
  push(B2)
  adminHashes.push(B2.hash)
  const B3 = assign(bob.kp, pubKey(felicia), after(L2.timestamp), constants.MOD_FLAG) // will be mod, because it's the highest set capability that is chosen (barring local assignments)
  push(B3)
  adminHashes.push(B3.hash)

  const E1 = assign(eve.kp, pubKey(alice), after(now), constants.USER_FLAG) // no effect
  push(E1)
  const E2 = assign(eve.kp, pubKey(bob), after(now), constants.USER_FLAG) // no effect
  push(E2)

  // these should have no effect
  const F1 = assign(felicia.kp, pubKey(gordon), after(now), constants.ADMIN_FLAG)
  push(F1)
  const G1 = assign(gordon.kp, pubKey(eve), after(now), constants.MOD_FLAG)
  push(G1)

  /* 
   * local should have:
   *
   * 2+1 admin (alice, bob + local)
   * 1 mod (felicia)
   * 1 user (eve)
   *
   */

  const db = new MemoryLevel({ valueEncoding: "binary" })
  const index = createRolesIndex(db)

  const sys = new ModerationRoles(pubKeyBuf(local))
  let all = sys.analyze(posts.flatMap(toObj))
  const ops = posts.flatMap(annotate(local.kp, all))

  const adminKeys = new Set([pubKey(local), pubKey(alice), pubKey(bob)])
  const numAdminSetRows = ops.reduce((acc, curr) => {
    if (adminKeys.has(b4a.toString(curr.publicKey, "hex"))) {
      acc += 1
    }
    return acc
  }, 0)

  // simulate having stored the operations by their hash. we'll query this fake database of hashes later using the
  // hashes we get out from querying the indexes
  const fakeHashDb = new Map()
  ops.forEach(op => { fakeHashDb.set(util.hex(op.hash), op) })
  index.map(ops)

  index.api.getRelevantRoleHashes((err, hashes) => {
    t.equal(hashes.length, adminHashes.length, "correct number of post hashes set by admins were returned as expected")
    const adminSet = new Set(adminHashes.map(util.hex))
    t.true(adminSet.size, adminHashes.length)
    hashes.forEach(h => {
      t.true(adminSet.has(util.hex(h)), `has admin hash ${util.hex(h)}`)
    })
  })

  index.api.getAllSinceTime(now, (err, hashes) => {
    const opsMap = new Map()
    opsMap.set("indexes", hashes.map(h => fakeHashDb.get(util.hex(h))))
    opsMap.set("original", ops)

    const sys = new ModerationRoles(pubKeyBuf(local))
    for (let [source, ops] of opsMap.entries()) {
      const all = sys.analyze(ops)
      const roleMap = all.get(constants.CABAL_CONTEXT)
      const admins = util.getRole(roleMap, constants.ADMIN_FLAG) 
      const mods = util.getRole(roleMap, constants.MOD_FLAG)
      const users = util.getRole(roleMap, constants.USER_FLAG)
      t.equal(admins.size, 3, `${source}: admins`)
      t.equal(mods.size, 1, `${source}: mods`)
      // only explicitly assigned users
      t.equal(users.size, 1, `${source}: users`)
      t.equal(Array.from(users)[0], pubKey(eve), `the user was, indeed, eve (${pubKey(eve)})`)
    }

    t.end()
  })
})

test("index table `latest` with admin demote should cause row deletion", t => {
  const db = new MemoryLevel({ valueEncoding: "binary" })
  const index = createRolesIndex(db)

  const local = new User()
  const alice = new User()
  const bob = new User()
  const eve = new User()

  const posts = []
  const push = (o) => {
    posts.push(o.post)
  }

  // from local's pov, local's assignments have precedence over those made by other users
  const L1 = assign(local.kp, pubKey(alice), now, constants.ADMIN_FLAG) // ADMIN => may assign roles for those viewing that user as admin
  push(L1)
  const A1 = assign(alice.kp, pubKey(bob), after(L1.timestamp), constants.MOD_FLAG)
  push(A1)

  const adminKeys = new Set([pubKey(local), pubKey(alice)])
  const numAdminSetRows = 2 

  const sys = new ModerationRoles(pubKeyBuf(local))
  let all = sys.analyze(posts.flatMap(toObj))
  const ops = posts.flatMap(annotate(local.kp, all))
  index.map(ops)

  index.api.getRelevantRoleHashes((err, hashes) => {
    t.equal(hashes.length, numAdminSetRows, "expecting very nice hashes")
    const L2 = assign(local.kp, pubKey(alice), after(L1.timestamp), constants.USER_FLAG)
    adminKeys.delete(pubKey(alice))
    index.map(posts.flatMap(annotateIsAdmin(adminKeys)))
    index.api.demoteAdmin(pubKey(alice), constants.CABAL_CONTEXT, (err) => {
      t.error(err, "demote admin should work, no error pls")
      index.api.getRelevantRoleHashes((err, hashes) => {
        t.error(err, "no error pls")
        t.equal(hashes.length, 1, "after demotion only local's latest role assignments should remain")
        t.end()
      })
    })
  })
})

test("simple scenario", t => {
  const local = new User()
  const alice = new User()
  const bob = new User()
  const eve = new User()
  const felicia = new User()

  const posts = []
  const push = (o) => {
    posts.push(o.post)
  }

  // from local's pov, local's assignments have precedence over those made by other users
  const L1 = assign(local.kp, pubKey(alice), now, constants.ADMIN_FLAG) // ADMIN => may assign roles for those viewing that user as admin
  push(L1)
  const L2 = assign(local.kp, pubKey(bob), now, constants.ADMIN_FLAG)
  push(L2)
  const L3 = assign(local.kp, pubKey(eve), now, constants.USER_FLAG) // eve should never be anything other than a user
  push(L3)

  const A1 = assign(alice.kp, pubKey(felicia), after(now), constants.USER_FLAG) // will be overridden by bob's assignment just a few lines down
  push(A1)

  const B1 = assign(bob.kp, pubKey(eve), after(A1.timestamp), constants.MOD_FLAG) // denied by local's assignment
  push(B1)
  const B2 = assign(bob.kp, pubKey(felicia), after(B1.timestamp), constants.MOD_FLAG) // will be mod, because it's the highest set capability that is chosen (barring local assignments)
  push(B2)

  const E1 = assign(eve.kp, pubKey(alice), after(B2.timestamp), constants.USER_FLAG) // no effect
  push(E1)
  const E2 = assign(eve.kp, pubKey(bob), after(B2.timestamp), constants.USER_FLAG) // no effect
  push(E2)

  /* 
   * local should have:
   *
   * 2+1 admin (alice, bob + local)
   * 1 mod (felicia)
   * 1 user (eve)
   *
   */


  const sys = new ModerationRoles(pubKeyBuf(local))
  const all = sys.analyze(posts.flatMap(toObj))

  const roleMap = all.get(constants.CABAL_CONTEXT)
  const admins = util.getRole(roleMap, constants.ADMIN_FLAG) 
  const mods = util.getRole(roleMap, constants.MOD_FLAG)
  const users = util.getRole(roleMap, constants.USER_FLAG)
  t.equal(admins.size, 3, "admins")
  t.equal(mods.size, 1, "mods")
  t.equal(users.size, 1, "users") // note: only counts explicitly assigned atm 

  t.end()
})

test("simple scenario extended", t => {
  const local = new User()
  const alice = new User()
  const bob = new User()
  const eve = new User()
  const felicia = new User()
  const gordon = new User()

  const posts = []
  const push = (o) => {
    posts.push(o.post)
  }

  // from local's pov, local's assignments have precedence over those made by other users
  const L1 = assign(local.kp, pubKey(alice), now, constants.ADMIN_FLAG) // ADMIN => may assign roles for those viewing that user as admin
  push(L1)
  const L2 = assign(local.kp, pubKey(bob), now, constants.ADMIN_FLAG)
  push(L2)
  const L3 = assign(local.kp, pubKey(eve), now, constants.USER_FLAG) // eve should never be anything other than a user
  push(L3)

  const A1 = assign(alice.kp, pubKey(felicia), after(now), constants.ADMIN_FLAG)
  push(A1)

  const F1 = assign(felicia.kp, pubKey(gordon), between(now, A1.timestamp), constants.ADMIN_FLAG) // should not be applied! this happened *right before* alice assigned felicia as admin
  push(F1)

  /* 
   * local should have:
   *
   * 3+1 admin (alice, bob, felicia) + local
   * 1 user (eve)
   *
   */

  const sys = new ModerationRoles(pubKeyBuf(local))
  const all = sys.analyze(posts.flatMap(toObj))

  const roleMap = all.get(constants.CABAL_CONTEXT)
  const admins = util.getRole(roleMap, constants.ADMIN_FLAG)
  const mods = util.getRole(roleMap, constants.MOD_FLAG)
  const users = util.getRole(roleMap, constants.USER_FLAG)
  t.equal(admins.size, 4, "admins")
  t.equal(mods.size, 0, "mods")
  t.equal(users.size, 1, "users") // note: only counts explicitly assigned atm 

  t.end()
})

test("basic scenario 1", t => {
  const local = new User()
  const alice = new User()
  const bob = new User()
  const eve = new User()
  const felicia = new User()
  const gordon = new User()
  const herbert = new User()
  const ion = new User()
  const john = new User()
  const knut = new User()
  const liam = new User()
  const nat = new User()
  const mallory = new User()

  const posts = []
  const push = (o) => {
    posts.push(o.post)
  }

  const channel = "programming"

  const L0 = assign(local.kp, pubKey(eve), now, constants.USER_FLAG)
  push(L0)
  const L1 = assign(local.kp, pubKey(alice), now, constants.USER_FLAG)
  push(L1)
  const L2 = assign(local.kp, pubKey(bob), now, constants.ADMIN_FLAG)
  push(L2)

  const A0 = assign(alice.kp, pubKey(herbert), before(now), constants.ADMIN_FLAG)
  push(A0)
  const A1 = assign(alice.kp, pubKey(felicia), after(now), constants.ADMIN_FLAG)
  push(A1)
  const A2 = assign(alice.kp, pubKey(john), after(now), constants.MOD_FLAG)
  push(A2)
  const A3 = assign(alice.kp, pubKey(liam), after(now), constants.MOD_FLAG, channel)
  push(A3)
  const A4 = assign(alice.kp, pubKey(mallory), after(now), constants.MOD_FLAG, channel)
  push(A4)

  const B1 = assign(bob.kp, pubKey(eve), after(now), constants.MOD_FLAG) // denied by local's assignment
  push(B1)
  const B2 = assign(bob.kp, pubKey(john), after(now), constants.MOD_FLAG)
  push(B2)
  const B3 = assign(bob.kp, pubKey(liam), after(now), constants.MOD_FLAG, channel)
  push(B3)
  const A5 = assign(alice.kp, pubKey(john), after(A2.timestamp), constants.ADMIN_FLAG) // reassignment
  push(A5)

  // alice, felicia, and gordon's assignments will all be cutoff by local's assignment of alice as a user
  const F1 = assign(felicia.kp, pubKey(knut), after(A1.timestamp), constants.MOD_FLAG)
  push(F1)
  const F2 = assign(felicia.kp, pubKey(gordon), after(A1.timestamp), constants.ADMIN_FLAG)
  push(F2)
  const F3 = assign(felicia.kp, pubKey(nat), after(A1.timestamp), constants.MOD_FLAG, channel)
  push(F3)
  const F4 = assign(felicia.kp, pubKey(john), after(A1.timestamp), constants.ADMIN_FLAG)
  push(F4)

  const G1 = assign(gordon.kp, pubKey(ion), after(now), constants.MOD_FLAG)
  push(G1)
  const G2 = assign(gordon.kp, pubKey(knut), after(now), constants.USER_FLAG)
  push(G2)

  const L3 = assign(local.kp, pubKey(mallory), now, constants.USER_FLAG)
  push(L3)

  /* 
   * local should have:
   *
   * 1+1 admin (bob + local)
   * 2 mod (john)
   * 3 user (alice, eve, mallory)
   *
   * channel "programming"
   * 0                  + 1 cabal-wide + local = 2 admin
   * 1 mod (liam)       + 1 cabal-wide = 2 mods
   *
   */

  let roleMap
  const sys = new ModerationRoles(pubKeyBuf(local))
  const all = sys.analyze(posts.flatMap(toObj))
  const ops = posts.flatMap(annotate(local.kp, all))

  roleMap = all.get(constants.CABAL_CONTEXT)
  const admins = util.getRole(roleMap, constants.ADMIN_FLAG) 
  const mods = util.getRole(roleMap, constants.MOD_FLAG)
  const users = util.getRole(roleMap, constants.USER_FLAG)
  t.equal(admins.size, 2, "cabal-wide admins")
  t.equal(mods.size, 1, "cabal-wide mods")
  t.equal(users.size, 3, "cabal-wide users") // note: explicitly assigned atm 

  roleMap = all.get(channel)
  const channelMods = util.getRole(roleMap, constants.MOD_FLAG) // also includes cabal-wide admins/mods etc
  const channelAdmins = util.getRole(roleMap, constants.ADMIN_FLAG) 
  const channelUsers = util.getRole(roleMap, constants.USER_FLAG) 
  t.equal(channelAdmins.size, 2, "channel-specific admins")
  t.equal(channelMods.size, 2, "channel-specific mods")
  t.equal(channelUsers.size, 3, "channel-specific users")
  t.end()
})

test("basic scenario 2", t => {
  const local = new User()
  const alice = new User()
  const bob = new User()
  const eve = new User()
  const felicia = new User()
  const gordon = new User()
  const herbert = new User()
  const ion = new User()
  const john = new User()
  const knut = new User()
  const liam = new User()
  const nat = new User()
  const mallory = new User()

  const channel = "programming"

  const posts = []
  const push = (o) => {
    posts.push(o.post)
  }

  // local -admin-> alice, bob
  // local -user-> eve
  const L0 = assign(local.kp, pubKey(eve), now, constants.USER_FLAG)
  push(L0)
  const L1 = assign(local.kp, pubKey(alice), now, constants.ADMIN_FLAG)
  push(L1)
  const L2 = assign(local.kp, pubKey(bob), now, constants.ADMIN_FLAG)
  push(L2)

  // assignments relevant from local's POV:
  // alice -admin-> felicia
  // alice -mod-> john
  // alice -channel-mod-> liam, mallory
  const A0 = assign(alice.kp, pubKey(herbert), before(L1.timestamp), constants.ADMIN_FLAG)
  push(A0)
  const A1 = assign(alice.kp, pubKey(felicia), after(L1.timestamp), constants.ADMIN_FLAG)
  push(A1)
  const A2 = assign(alice.kp, pubKey(john), after(L1.timestamp), constants.MOD_FLAG)
  push(A2)
  const A3 = assign(alice.kp, pubKey(liam), after(L1.timestamp), constants.MOD_FLAG, channel)
  push(A3)
  const A4 = assign(alice.kp, pubKey(mallory), after(L1.timestamp), constants.MOD_FLAG, channel)
  push(A4)

  // assignments relevant from local's POV:
  // bob -mod-> john
  // bob -channel-mod-> liam
  const B1 = assign(bob.kp, pubKey(eve), after(now), constants.MOD_FLAG) // denied by local's assignment
  push(B1)
  const B2 = assign(bob.kp, pubKey(john), after(now), constants.MOD_FLAG)
  push(B2)
  const B3 = assign(bob.kp, pubKey(liam), after(now), constants.MOD_FLAG, channel)
  push(B3)

  // alice -admin-> john
  const A5 = assign(alice.kp, pubKey(john), after(now), constants.ADMIN_FLAG)
  push(A5)

  // assignments relevant from local's POV:
  // felicia -mod-> knut
  // felicia -channel-mod-> nat
  // felicia -admin-> gordon, john
  const F0 = assign(felicia.kp, pubKey(knut), after(A1.timestamp), constants.MOD_FLAG)
  push(F0)
  const F1 = assign(felicia.kp, pubKey(gordon), after(A1.timestamp), constants.ADMIN_FLAG)
  push(F1)
  const F2 = assign(felicia.kp, pubKey(nat), after(A1.timestamp), constants.MOD_FLAG, channel)
  push(F2)
  const F3 = assign(felicia.kp, pubKey(john), after(A1.timestamp), constants.ADMIN_FLAG)
  push(F3)

  // assignments relevant from local's POV:
  // gordon -mod-> ion
  // (gordon -knut-> user)
  const G1 = assign(gordon.kp, pubKey(ion), after(F1.timestamp), constants.MOD_FLAG)
  push(G1)
  const G2 = assign(gordon.kp, pubKey(knut), after(F1.timestamp), constants.USER_FLAG)
  push(G2)

  // local -user-> mallory
  const L3 = assign(local.kp, pubKey(mallory), now, constants.USER_FLAG)
  push(L3)

  /* 
   * local should have:
   *
   * 5+1 admin (alice, bob, felicia, gordon, john + local)
   * 2 mod (ion, knut)
   * 2 user (eve, mallory)
   * ?? herbert
   *
   * channel "programming"
   * 0 admins           + 5 cabal-wide + local = 6
   * 2 mod (liam, nat)  + 2 cabal wide = 4
   *
   */

  let roleMap

  const sys = new ModerationRoles(pubKeyBuf(local))
  const all = sys.analyze(posts.flatMap(toObj))
  const ops = posts.flatMap(annotate(local.kp, all))

  // cabal-wide
  roleMap = all.get(constants.CABAL_CONTEXT)
  t.equal(util.getRole(roleMap, constants.ADMIN_FLAG).size, 6, "admins")
  t.equal(util.getRole(roleMap, constants.MOD_FLAG).size, 2, "mods")
  t.equal(util.getRole(roleMap, constants.USER_FLAG).size, 2, "users")
  // cabal-wide + channel specific assignments
  roleMap = all.get(channel)
  t.equal(util.getRole(roleMap, constants.ADMIN_FLAG).size, 6, "channel admins")
  t.equal(util.getRole(roleMap, constants.MOD_FLAG).size, 4, "channel mods")
  t.equal(util.getRole(roleMap, constants.USER_FLAG).size, 2, "channel users")
  t.end()
})

test("basic scenario 2 with indexes", t => {
  const local = new User()
  const alice = new User()
  const bob = new User()
  const eve = new User()
  const felicia = new User()
  const gordon = new User()
  const herbert = new User()
  const ion = new User()
  const john = new User()
  const knut = new User()
  const liam = new User()
  const nat = new User()
  const mallory = new User()

  const channel = "programming"

  const posts = []
  const push = (o) => {
    posts.push(o.post)
  }

  // local -admin-> alice, bob
  // local -user-> eve
  const L1 = assign(local.kp, pubKey(eve), now, constants.USER_FLAG)
  push(L1)
  const L2 = assign(local.kp, pubKey(alice), now, constants.ADMIN_FLAG)
  push(L2)
  const L3 = assign(local.kp, pubKey(bob), now, constants.ADMIN_FLAG)
  push(L3)

  // assignments relevant from local's POV:
  // alice -admin-> felicia
  // alice -mod-> john
  // alice -channel-mod-> liam, mallory
  const A0 = assign(alice.kp, pubKey(herbert), before(now), constants.ADMIN_FLAG)
  push(A0)
  const A1 = assign(alice.kp, pubKey(felicia), after(now), constants.ADMIN_FLAG)
  push(A1)
  const A2 = assign(alice.kp, pubKey(john), after(now), constants.MOD_FLAG)
  push(A2)
  const A3 = assign(alice.kp, pubKey(liam), after(now), constants.MOD_FLAG, channel)
  push(A3)
  const A4 = assign(alice.kp, pubKey(mallory), after(now), constants.MOD_FLAG, channel)
  push(A4)

  // assignments relevant from local's POV:
  // bob -mod-> john
  // bob -channel-mod-> liam
  const B1 = assign(bob.kp, pubKey(eve), after(now), constants.MOD_FLAG) // denied by local's assignment
  push(B1)
  const B2 = assign(bob.kp, pubKey(john), after(now), constants.MOD_FLAG)
  push(B2)
  const B3 = assign(bob.kp, pubKey(liam), after(now), constants.MOD_FLAG, channel)
  push(B3)

  // alice -admin-> john
  const A5 = assign(alice.kp, pubKey(john), after(A2.timestamp), constants.ADMIN_FLAG)
  push(A5)

  // assignments relevant from local's POV:
  // felicia -mod-> knut
  // felicia -channel-mod-> nat
  // felicia -admin-> gordon, john
  const F0 = assign(felicia.kp, pubKey(knut), after(A1.timestamp), constants.MOD_FLAG)
  push(F0)
  const F1 = assign(felicia.kp, pubKey(gordon), after(A1.timestamp), constants.ADMIN_FLAG)
  push(F1)
  const F2 = assign(felicia.kp, pubKey(nat), after(A1.timestamp), constants.MOD_FLAG, channel)
  push(F2)
  const F3 = assign(felicia.kp, pubKey(john), after(A1.timestamp), constants.ADMIN_FLAG)
  push(F3)

  // assignments relevant from local's POV:
  // gordon -mod-> ion
  // (gordon -knut-> user)
  const G1 = assign(gordon.kp, pubKey(ion), after(F1.timestamp), constants.MOD_FLAG)
  push(G1)
  const G2 = assign(gordon.kp, pubKey(knut), after(F1.timestamp), constants.USER_FLAG)
  push(G2)

  // local -user-> mallory
  const L4 = assign(local.kp, pubKey(mallory), now, constants.USER_FLAG)
  push(L4)

  /* 
   * local should have:
   *
   * 5+1 admin (alice, bob, felicia, gordon, john + local)
   * 2 mod (ion, knut)
   * 2 user (eve, mallory)
   * ?? herbert
   *
   * channel "programming"
   * 0 admins           + 5 cabal-wide + local = 6
   * 2 mod (liam, nat)  + 2 cabal wide = 4
   *
   */

  const db = new MemoryLevel({ valueEncoding: "binary" })
  const index = createRolesIndex(db)

  const sys = new ModerationRoles(pubKeyBuf(local))
  let all = sys.analyze(posts.flatMap(toObj))
  const originalOps = posts.flatMap(annotate(local.kp, all))
  // simulate having stored the operations by their hash. we'll query this fake database of hashes later using the
  // hashes we get out from querying the indexes
  const fakeHashDb = new Map()
  originalOps.forEach(op => { fakeHashDb.set(util.hex(op.hash), op) })
  index.map(originalOps)
  index.api.getAllSinceTime(now, (err, hashes) => {
    const opsMap = new Map()
    opsMap.set("indexes", hashes.map(h => fakeHashDb.get(util.hex(h))))
    opsMap.set("original", originalOps)

    for (let [source, ops] of opsMap) {
      const all = sys.analyze(ops)
      // cabal-wide
      roleMap = all.get(constants.CABAL_CONTEXT)
      t.equal(util.getRole(roleMap, constants.ADMIN_FLAG).size, 6, `${source}: admins`)
      t.equal(util.getRole(roleMap, constants.MOD_FLAG).size, 2, `${source}: mods`)
      t.equal(util.getRole(roleMap, constants.USER_FLAG).size, 2, `${source}: users`)
      // cabal-wide + channel specific assignments
      roleMap = all.get(channel)
      t.equal(util.getRole(roleMap, constants.ADMIN_FLAG).size, 6, `${source}: channel admins`)
      t.equal(util.getRole(roleMap, constants.MOD_FLAG).size, 4, `${source}: channel mods`)
      t.equal(util.getRole(roleMap, constants.USER_FLAG).size, 2, `${source}: channel users`)
    }
    t.end()
  })
})

test("basic scenario 3", t => {
  t.comment("basic scenario 3 is basically the same as scenario 1 except with a different ordering; outcome should be identical")
  const local = new User()
  const alice = new User()
  const bob = new User()
  const eve = new User()
  const felicia = new User()
  const gordon = new User()
  const herbert = new User()
  const ion = new User()
  const john = new User()
  const knut = new User()
  const liam = new User()
  const nat = new User()
  const mallory = new User()

  const channel = "programming"
  const posts = []
  const push = (o) => {
    posts.push(o.post)
  }

  // local -admin-> alice, bob
  const L1 = assign(local.kp, pubKey(alice), now, constants.ADMIN_FLAG)
  push(L1)
  const L2 = assign(local.kp, pubKey(bob), now, constants.ADMIN_FLAG)
  push(L2)

  // assignments relevant from local's POV:
  // alice -admin-> felicia
  // alice -mod-> john
  // alice -channel-mod-> liam, mallory
  const A0 = assign(alice.kp, pubKey(herbert), before(now), constants.ADMIN_FLAG)
  push(A0)
  const A1 = assign(alice.kp, pubKey(felicia), after(now), constants.ADMIN_FLAG)
  push(A1)
  const A2 = assign(alice.kp, pubKey(john), after(now), constants.MOD_FLAG) // will be overridden by felicia's assignment for john
  push(A2)
  const A3 = assign(alice.kp, pubKey(liam), after(now), constants.MOD_FLAG, channel)
  push(A3)
  const A4 = assign(alice.kp, pubKey(mallory), after(now), constants.MOD_FLAG, channel) // will be overridden by local further down
  push(A4)

  // assignments relevant from local's POV:
  // bob -mod-> john
  // bob -channel-mod-> liam
  const B1 = assign(bob.kp, pubKey(eve), after(now), constants.MOD_FLAG)
  push(B1)
  const B2 = assign(bob.kp, pubKey(john), after(now), constants.MOD_FLAG)
  push(B2)
  const B3 = assign(bob.kp, pubKey(liam), after(now), constants.MOD_FLAG, channel)
  push(B3)
  const B4 = assign(bob.kp, pubKey(felicia), before(now), constants.ADMIN_FLAG) // should not count due to time of role assignment
  push(B4)

  // local -user-> eve
  const L3 = assign(local.kp, pubKey(eve), after(now), constants.USER_FLAG) // should deny eve as anything other than a user
  push(L3)

  // assignments relevant from local's POV:
  // felicia -mod-> knut
  // felicia -channel-mod-> nat
  // felicia -admin-> gordon, john
  const F0 = assign(felicia.kp, pubKey(herbert), before(now), constants.MOD_FLAG)
  push(F0)
  const F1 = assign(felicia.kp, pubKey(knut), after(A1.timestamp), constants.MOD_FLAG)
  push(F1)
  const F2 = assign(felicia.kp, pubKey(gordon), after(A1.timestamp), constants.ADMIN_FLAG)
  push(F2)
  const F3 = assign(felicia.kp, pubKey(nat), after(A1.timestamp), constants.MOD_FLAG, channel)
  push(F3)
  const F4 = assign(felicia.kp, pubKey(john), after(A1.timestamp), constants.ADMIN_FLAG)
  push(F4)

  // assignments relevant from local's POV:
  // gordon -mod-> ion
  // gordon -user-> knut 
  const G1 = assign(gordon.kp, pubKey(ion), after(F2.timestamp), constants.MOD_FLAG)
  push(G1)
  const G2 = assign(gordon.kp, pubKey(knut), after(F2.timestamp), constants.USER_FLAG) // knut will be a mod thanks to felicia's assignment
  push(G2)

  // local -user-> mallory
  const L4 = assign(local.kp, pubKey(mallory), now, constants.USER_FLAG)
  push(L4)

  /* 
   * local should have:
   *
   * 5+1 admin (alice, bob, felicia, gordon, john + local)
   * 2 mod (ion, knut)
   * 2 user (eve, mallory)
   * ?? herbert
   *
   * channel "programming"
   * 0 admins           + 5 cabal-wide + local = 6
   * 2 mod (liam, nat)  + 2 cabal wide = 4
   *
   */

  let roleMap

  const sys = new ModerationRoles(pubKeyBuf(local))
  const all = sys.analyze(posts.flatMap(toObj))
  const ops = posts.flatMap(annotate(local.kp, all))

  // cabal-wide
  roleMap = all.get(constants.CABAL_CONTEXT)
  t.equal(util.getRole(roleMap, constants.ADMIN_FLAG).size, 6, "admins")
  t.equal(util.getRole(roleMap, constants.MOD_FLAG).size, 2, "mods")
  t.equal(util.getRole(roleMap, constants.USER_FLAG).size, 2, "users")

  // cabal-wide + channel specific assignments
  roleMap = all.get(channel)
  t.equal(util.getRole(roleMap, constants.ADMIN_FLAG).size, 6, "channel admins")
  t.equal(util.getRole(roleMap, constants.MOD_FLAG).size, 4, "channel mods")
  t.equal(util.getRole(roleMap, constants.USER_FLAG).size, 2, "channel users")
  t.end()
})
