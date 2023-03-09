const CableCore = require("./index.js").CableCore
const core = new CableCore()

core.setNick("boop")
const buf = core.join("testing")
core.getJoinedChannels((err, channels) => {
  // should print ["testing"]
  console.log(channels)
  const hash = core.hash(buf)
  // remove join post
  core.del(hash)
  // TODO (2023-03-09): introduce callbacks to all actions which will fire when done
  setTimeout(() => {
    core.getJoinedChannels((err, channels) => {
      // should print an empty list
      console.log(channels)
    })
  }, 100)
})
