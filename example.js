const CableCore = require("./index.js").CableCore

let hash

const core = new CableCore()
const bufJoin = core.join("introduction")
hash = core.hash(bufJoin)
console.log("join hash", hash)
core.store.getData([hash], (err, data) => {
  console.log("error?", err)
  console.log("data?", data)
})

const bufLeave = core.leave("introduction")
hash = core.hash(bufLeave)
console.log("leave hash", hash)
core.store.getData([hash], (err, data) => {
  console.log("error?", err)
  console.log("data?", data)
})
