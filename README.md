# cable-core.js

**Status**: pre-alpha (api surface still in flux)

The core library powering a [cable](https://github.com/cabal-club/cable/tree/v1-draft) peer.
This specific implementation is written in node.js, we anticipate cable implementations in other
languages to follow. (Interested? See cable's [spec](https://github.com/cabal-club/cable/tree/v1-draft))

**Responsibilities**:

* Provides a clean api for interacting with cable peers
* Maintains database indexes for all of cable's facets
* Handles deletes, including updating all affected indexes
* Keeps track of message causality using cable's links concept
* Provides methods for creating all of cable's post types
* Capable of receiving and generating responses to all of cable's request & response messages

**Non-responsibilities**:

* Does not handle serializing & deserializing cable's binary buffers ([cable.js](https://github.com/cabal-club/cable.js) does that)
* Does not fully take care of all concerns required for a client application (cable-client.js will service that)
* Networking primitives (up & coming)

## Example
This slightly longer example shows how to setup an end-to-end response-request cycle between
two different cable instances. What it lacks in brevity it hopefully makes up for in terms of
elucidation. 

For the nitty gritty details, read the [tests](https://github.com/cabal-club/cable-core.js/tree/main/test).

```js
/* NOTE: require "cable.js" and not just "cable" (the latter is a completely unrelated module!!) */

const crypto = require("cable.js/cryptography.js")
const cable = require("cable.js/index.js")
const { humanizeMessageType } = require("./util.js")
const kp = crypto.generateKeypair()
const CableCore = require("./index.js").CableCore
const requester = new CableCore({kp})
const responder = new CableCore()

const ttl = 0
const channel = "introduction"
const text = "Hello hello."
const start = +(new Date("2023-03-01"))
const end = 0
const limit = 1500

/* phase 1: hook up requester and responder to each other (we're basically simulating a two way network connection :)*/
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

/* phase 2: let's kick this show off! */
// responder makes a post that requester will end up with eventually
responder.postText(channel, text, () => {
  // regarding this callback: we want to start the request & responses *after*
  // we're certain that the post/text has finished indexing for responder!

  // requester initiates a request
  const buf = requester.requestPosts(channel, start, end, ttl, limit)
  // in this example, we don't do anything with buf bc we have hooked things up already above.
  // just showing off that it's possible to use it :)

  // we wait a little bit for the back and forth of the request and response cycle to be resolved :) 
  //
  // the timeout is necessary because it's a standalone example. without it the process
  // would be closed before we get to see anything, due to the asynchronous action going on. 
  // in a long-lived application, we would never need to set a timeout like this

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
```

## License
agpl-3.0-or-later
