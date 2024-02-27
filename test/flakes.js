// SPDX-FileCopyrightText: 2023 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const test = require("tape")
const CableCore = require("../index.js").CableCore
const constants = require("cable.js/constants")
const cable = require("cable.js/index.js")

// this test should fail
// test("failing test with flakes without synchronization", t => {
//   const core = new CableCore()
//   const channel = "testing"
//   const buf = core.join(channel)
//   core.getJoinedChannels((err, channels) => {
//     t.error(err, "get joined channels should work")
//     t.ok(channels, "returned data should be good")
//     t.equal(channels.length, 1, "should have 1 joined channel")
//     t.equal(channels[0], channel, "should be correct channel name")
//     const hash = core.hash(buf)
//     // remove join post
//     core.del(hash)
//     core.getJoinedChannels((err, channels) => {
//       t.error(err, "get joined channels should work")
//       t.ok(channels, "returned data should be good")
//       t.equal(channels.length, 1, "should have no joined channel")
//       t.end()
//     })
//   })
// })

test("successful test without flakes when synchronization utilized", t => {
  const core = new CableCore()
  const channel = "testing"
  const buf = core.join(channel, () => {
    core.getJoinedChannels((err, channels) => {
      t.error(err, "get joined channels should work")
      t.ok(channels, "returned data should be good")
      t.equal(channels.length, 1, "should have 1 joined channel")
      t.equal(channels[0], channel, "should be correct channel name")
      const hash = core.hash(buf)
      // remove join post
      core.del(hash, () => {
        core.getJoinedChannels((err, channels) => {
          t.error(err, "get joined channels should work")
          t.ok(channels, "returned data should be good")
          t.equal(channels.length, 0, "should have no joined channel")
          t.end()
        })
      })
    })
  })
})
