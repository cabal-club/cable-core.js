const CableCore = require("./index.js").CableCore

const core = new CableCore()
// let hash = core.hash(bufJoin)
// console.log("join hash", hash)
// // TODO (2023-02-23): enable synchronization point (allIndexes.ready(cb)) or sync usage of apis
// core.store.getData([hash], (err, data) => {
//   console.log("error?", err)
//   console.log("data?", data)
// })
//

function logem (err, key, res) {
  console.log("err", err)
  console.log(key, res)
}

// const bufLeave = core.leave("introduction")
// hash = core.hash(bufLeave)
// console.log("leave hash", hash)
// core.store.getData([hash], (err, data) => {
//   console.log("error?", err)
//   console.log("data?", data)
// })
//
// core.getJoinedChannels("introduction", (err, data) => {
//   console.log("error?", err)
//   console.log("data?", data) /*cable.LEAVE_POST.toJSON(data))*/
// })
//
// core.getChannelState("introduction", (err, data) => {
//   console.log("latest channel state")
//   console.log("error?", err)
//   console.log("data?", data)
// })
//
// const bufText = core.postText("introduction", "hi my name is cable-san")
// core.getChat("introduction", 0, 0, -1, (err, chat) => {
//   console.log("chat messages")
//   console.log("error?", err)
//   console.log("chat?", chat)
// })
// core.del(core.hash(bufText))
//
// setTimeout(() => {
//   core.getChat("introduction", 0, 0, -1, (err, chat) => {
//     console.log("2 chat messages")
//     console.log("2 error?", err)
//     console.log("2 chat?", chat)
//   })
// }, 100)
// setTimeout(() => {
// core.getNick((err, nick) => {
//   console.log(nick)
// })
// }, 100)
// core.join("introductions")
const buf = core.join("help-channel")

core.join("testing")
core.leave("testing")
core.setNick("boop")
// core.getJoinedChannels((err, channels) => {
//   console.log("err", err)
//   console.log(channels)
// })
// core.getChannels((err, channels) => {
//   console.log("channel names")
//   console.log("err", err)
//   console.log(channels)
// })
// core.store.authorView.api.getAllHashesByAuthor(core.kp.publicKey, (err, hashes) => {
//   logem(err, "author hashes", hashes)
// })
// setTimeout(() => {
// core.getChannelState("introduction", (err, data) => {
//   logem(err, "channel state", data)
// })
// }, 100)
//
const hash2 = core.hash(buf)
setTimeout(() => {
  core.del(hash2)
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
}, 1000)

const bufTopic = core.setTopic("introduction", "hello cablers")
core.getTopic("introduction", (err, topic) => {
  logem(err, "topic", topic)
})




