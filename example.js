const CableCore = require("./index.js").CableCore
const core = new CableCore()

core.setNick("boop")
const buf = core.join("testing")
core.getJoinedChannels((err, channels) => {
  // should print ["testing"]
  console.log(channels)
  const hash = core.hash(buf)
  // remove join post
  core.del(hash, () => {
    // after del has finished indexing, call get joined channels
    core.getJoinedChannels((err, channels) => {
      // should print an empty list
      console.log(channels)
    })
  })
})
