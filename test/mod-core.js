const test = require("tape")
const util = require("../util.js")
const b4a = require("b4a")
const { MemoryLevel } = require("memory-level")
const createRolesIndex = require("../views/roles.js")
const createActionsIndex = require("../views/actions.js")
const { CableCore } = require("../index.js")
const { ModerationRoles, ModerationSystem } = require("../moderation.js")
const constants = require("cable.js/constants.js")
const cable = require("cable.js/index.js")
const crypto = require("cable.js/cryptography.js")

const { annotateIsAdmin, before, after, between, User } = require("./moderation-test-util.js")

const pubKey = (recp) => recp.kp.publicKey
const pubKeyStr = (recp) => b4a.toString(recp.kp.publicKey, "hex")
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

function assign(authorKp, recipient, timestamp, role, context="") {
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
test("simple admin and mod role assignment should tally up correctly", t => {
  const local = new User() // always admin
  const core = new CableCore(MemoryLevel, { keypair: local.kp })

  const alice = new User() // admin
  const bob = new User()   // mod

  const tsFirstAdmin = before(now) - 100
  const tsBobMod = tsFirstAdmin + 20

  // after a role assignment has fully propagated, perform assertions on the current
  // roles state to confirm the assignment was applied as expected
  let counter = 0
  core.on("moderation/roles-update", () => {
    counter++
    let admin, mods
    const rolesMap = core.getRoles(constants.CABAL_CONTEXT)
    switch(counter) {
      case 1:
        // assert that we now have an admin applied for the cabal context
        admins = util.getRole(rolesMap, constants.ADMIN_FLAG)
        t.equal(admins.size, 2, "should have two admins after alice was made admin")
        t.true(admins.has(pubKeyStr(local)), "local should be an admin")
        t.true(admins.has(pubKeyStr(alice)), "alice should be an admin")
        mods = util.getRole(rolesMap, constants.MOD_FLAG)
        t.true(!mods.has(pubKeyStr(bob)), "bob should not be mod")
        // assign bob as a mod
        const t_A1 = assign(alice.kp, pubKey(bob), tsBobMod, constants.MOD_FLAG)
        core._storeExternalBuf(t_A1.post)
        break
      case 2:
        // assert that we now have 2 admins (alice + local) and 1 mod (bob)
        admins = util.getRole(rolesMap, constants.ADMIN_FLAG)
        t.equal(admins.size, 2, "should still have two admins after bob was made mod")
        t.true(admins.has(pubKeyStr(local)), "local should be an admin")
        t.true(admins.has(pubKeyStr(alice)), "alice should be an admin")
        mods = util.getRole(rolesMap, constants.MOD_FLAG)
        t.equal(mods.size, 1, "should have mod assigned")
        t.true(mods.has(pubKeyStr(bob)), "bob should be mod")

        t.end()
        break
    }
  })

  const t_L1 = core.assignRole(pubKey(alice), "", tsFirstAdmin, constants.ADMIN_FLAG, "", 0)
  core._storeExternalBuf(t_L1.post)
})
