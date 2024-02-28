// SPDX-FileCopyrightText: 2023 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const test = require("tape")
const CableCore = require("../index.js").CableCore
const b4a = require("b4a")
const constants = require("cable.js/constants")
const cable = require("cable.js/index.js")
const { testPostType, getDescriptiveType, assertPostType, assertBufType }  = require("../testutils.js")

/* this test suite contains a tests exercising opt-out of `post/role` using post/info:accept-role */
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

test("simple opt-out should be indexed correctly", t => {
  const core = new CableCore()
  const optOut = 0
  const LINKS = []
  const ts = +(new Date())
  t.notEqual(undefined, core, "should not be undefined")
  t.notEqual(null, core, "should not be null")
  const post = cable.INFO_POST.create(core.kp.publicKey, core.kp.secretKey, LINKS, ts, [["accept-role", optOut]])
  t.notEqual(null, post)

  core._storeExternalBuf(post, () => {
    core.store.userInfoView.api.getRoleOptOutAllUsers((err, keys) => {
      t.error(err, "get role opt out should not err")
      t.equal(keys.length, 1, "keys should return 1 public key")
      t.true(b4a.equals(keys[0], core.kp.publicKey), "the public key should be that of the author")
      t.end()
    })
  })
})

test("opt-out and then opt-in should be indexed correctly", t => {
  const core = new CableCore()
  t.notEqual(undefined, core, "should not be undefined")
  t.notEqual(null, core, "should not be null")

  const optOut = 0
  const optIn = 1
  const LINKS = []
  const ts = +(new Date())

  const optOutPost = cable.INFO_POST.create(core.kp.publicKey, core.kp.secretKey, LINKS, ts, [["accept-role", optOut]])
  const optInPost = cable.INFO_POST.create(core.kp.publicKey, core.kp.secretKey, LINKS, ts+1000, [["accept-role", optIn]])

  t.notEqual(null, optOutPost)
  t.notEqual(null, optInPost)

  // first we opt out
  core._storeExternalBuf(optOutPost, () => {
    core.store.userInfoView.api.getRoleOptOutAllUsers((err, keys) => {
      t.error(err, "get role opt out should not err")
      t.equal(keys.length, 1, "keys should return 1 public key")
      t.true(b4a.equals(keys[0], core.kp.publicKey), "the public key should be that of the author")
      // then we opt in
      core._storeExternalBuf(optInPost, () => {
        core.store.userInfoView.api.getRoleOptOutAllUsers((err, keys) => {
          t.error(err, "get role opt out should not err")
          t.equal(keys.length, 0, "keys should return no public key")
          t.end()
        })
      })
    })
  })
})

test("*implicit* opt-in should be indexed correctly", t => {
  const core = new CableCore()
  t.notEqual(undefined, core, "should not be undefined")
  t.notEqual(null, core, "should not be null")

  const optOut = 0
  const optIn = 1
  const LINKS = []
  const ts = +(new Date())

  const optOutPost = cable.INFO_POST.create(core.kp.publicKey, core.kp.secretKey, LINKS, ts, [["accept-role", optOut]])
  // the default value of accept-role, if not specified, is equal to opting in for post/role assignments
  const implicitOptInPost = cable.INFO_POST.create(core.kp.publicKey, core.kp.secretKey, LINKS, ts+1000, [])

  t.notEqual(null, optOutPost)
  t.notEqual(null, implicitOptInPost)

  // first we opt out
  core._storeExternalBuf(optOutPost, () => {
    core.store.userInfoView.api.getRoleOptOutAllUsers((err, keys) => {
      t.error(err, "get role opt out should not err")
      t.equal(keys.length, 1, "keys should return 1 public key")
      t.true(b4a.equals(keys[0], core.kp.publicKey), "the public key should be that of the author")
      // then we opt in
      core._storeExternalBuf(implicitOptInPost, () => {
        core.store.userInfoView.api.getRoleOptOutAllUsers((err, keys) => {
          t.error(err, "get role opt out should not err")
          t.equal(keys.length, 0, "keys should return no public key")
          t.end()
        })
      })
    })
  })
})
