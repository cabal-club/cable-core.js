const CableCore = require("./index.js").CableCore
const cable = require("../cable/index.js")

let hash

const core = new CableCore()
const bufJoin = core.join("introduction")
hash = core.hash(bufJoin)
console.log("join hash", hash)
// TODO (2023-02-23): enable synchronization point (allIndexes.ready(cb)) or sync usage of apis
core.store.getData([hash], (err, data) => {
  console.log("error?", err)
  console.log("data?", data)
})

const bufTopic = core.setTopic("introduction", "hello cablers")

const bufLeave = core.leave("introduction")
hash = core.hash(bufLeave)
console.log("leave hash", hash)
core.store.getData([hash], (err, data) => {
  console.log("error?", err)
  console.log("data?", data)
})

core.getJoinedChannels("introduction", (err, data) => {
  console.log("error?", err)
  console.log("data?", data) /*cable.LEAVE_POST.toJSON(data))*/
})

core.getChannelState("introduction", (err, data) => {
  console.log("latest channel state")
  console.log("error?", err)
  console.log("data?", data)
  data.forEach(cablegram => {
    console.log(cable.parsePost(cablegram))
  })
})
