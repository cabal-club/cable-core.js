const CableCore = require("./index.js").CableCore
const core = new CableCore()

// core.setNick("boop")
// const buf = core.join("testing")
// core.getJoinedChannels((err, channels) => {
//   // should print ["testing"]
//   console.log(channels)
//   const hash = core.hash(buf)
//   // remove join post
//   core.del(hash, () => {
//     // after del has finished indexing, call get joined channels
//     core.getJoinedChannels((err, channels) => {
//       // should print an empty list
//       console.log(channels)
//     })
//   })
// })

const ttl = 0
const channel = "introduction"
const text = "Hello hello."
const start = +(new Date("2023-03-01"))
const end = 0
const limit = 1500
core.on("request", reqBuf => {
  console.log("emitted request", reqBuf)
})
core.on("response", resBuf => {
  console.log("emitted response", resBuf)
})
const buf = core.requestPosts(channel, start, end, ttl, limit)
// console.log(buf)
// core.handleRequest(buf, "me")

core.postText(channel, text, () => {
  core.handleRequest(buf, () => {
    console.log("handle request is done")
  })
})
