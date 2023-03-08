const CableCore = require("../index.js").CableCore

const core = new CableCore()
// // TODO (2023-02-23): enable synchronization point (allIndexes.ready(cb)) or sync usage of apis

function logem (err, key, res) {
  console.log("err", err)
  console.log(key, res)
}

core.setNick("boop")
const buf = core.join("testing")
setTimeout(() => {
  core.getJoinedChannels((err, data) => {
    console.log("error?", err)
    console.log("data?", data) 
    const hash2 = core.hash(buf)
    core.del(hash2)
    setTimeout(() => {
      core.getJoinedChannels((err, data) => {
        console.log("2 error?", err)
        console.log("2 data?", data) 
        // core.store.reverseMapView.api.getUses(hash2, (err, uses) => {
        //   console.log("the queried hash (post/join) was", hash2.toString("hex"))
        //   logem(err, "reverse map uses", uses)
        //   core.store.reverseMapView.api.del(hash2, () => {
        //     setTimeout(() => {
        //       core.store.reverseMapView.api.getUses(hash2, (err, uses) => {
        //         logem(err, "post del reverse map uses", uses)
        //       })
        //     }, 1000)
        //   })
        // })
      })
    }, 100)
  })
}, 200)
// core.getJoinedChannels((err, channels) => {
//   logem(err, "joined channels", channels)
// })
//
setTimeout(() => {
  core.getUsers((err, result) => {
    logem(err, "get users", result)
  })
}, 500)
// core.getUsersInChannel("introduction", (err, result) => {
//   logem(err, "get users in channel", result)
// })
