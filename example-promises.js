const CableCore = require("./index.js").CableCore
const core = new CableCore()

const { promisify } = require("util")

// note: .bind(<cable-core instance>) is important
let getJoinedChannels = promisify(core.getJoinedChannels).bind(core)
let del = promisify(core.del).bind(core)

core.setNick("boop")
const buf = core.join("testing")
getJoinedChannels().then(channels => {
  // should print ["testing"]
  console.log(channels)
  const hash = core.hash(buf)
  return del(hash)
}).then(() => {
  return getJoinedChannels()
})
.then(channels => {
  // should print an empty list
  console.log(channels)
})
