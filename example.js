const crypto = require("../cable/cryptography.js")
const cable = require("../cable/index.js")
const kp = crypto.generateKeypair()
const CableCore = require("./index.js").CableCore
const requester = new CableCore({kp})
const responder = new CableCore()
const { humanizeMessageType } = require("./util.js")

const ttl = 0
const channel = "introduction"
const text = "Hello hello."
const start = +(new Date("2023-03-01"))
const end = 0
const limit = 1500

/* hook up requester and responder to each other (we're basically simulating a two way network connection :)*/
// each request should reach and be handled by the responder
requester.on("request", reqBuf => {
  console.log(`requester: emitted ${humanizeMessageType(cable.peekMessage(reqBuf))}`, reqBuf)
  console.log(cable.parseMessage(reqBuf))
  console.log()
  // responder receives the request and reacts to it
  responder.handleRequest(reqBuf)
})

// each response should reach and be handled by the requester
responder.on("response", resBuf => {
  console.log(`responder: emitted ${humanizeMessageType(cable.peekMessage(resBuf))}`, resBuf)
  console.log(cable.parseMessage(resBuf))
  console.log()
  // requester receives the response and reacts to it
  requester.handleResponse(resBuf)
})

// responder makes a post that requester will end up with eventually
responder.postText(channel, text, () => {
  // regarding this callback: we want to start the request & responses *after*
  // we're certain that the post/text has finished indexing for responder!

  // requester initiates a request
  const buf = requester.requestPosts(channel, start, end, ttl, limit)
  // we don't need to do anything with buf bc we have hooked things up already
  // with our simulated network connection above, just showing off that it's
  // possible to use it :)

  // wait a little bit for the back and forth of the request and response cycle to be resolved :)
  setTimeout(() => {
    console.log("now: get some chat messages!")
    requester.getChat(channel, start, end, limit, (err, chat) => {
      if (err) console.log("error", err)
      chat.forEach(msg => {
        console.log("get chat:", msg)
      })
    })
  }, 50)
})
