const EventEmitter = require("events").EventEmitter
const debug = require("debug")("transport/swarm")
const b4a = require("b4a")

const TIME_BEFORE_DROP = 5 * 60 * 60 * 1000 // keep alive a peer for 5 minutes without having heard from them

const HELLO = b4a.from("hello")

class TransportShim extends EventEmitter {
  constructor() {
    super()
  }
  broadcast() {}
}

// differentiate between:
// new/lost peer (authenticated and accepted)
// new/lost connection (before becoming a peer, could be rejected)
class Swarm extends EventEmitter {
  constructor(transport, key, port) {
    super()
    if (!transport) { transport = TransportShim }
    this.transport = new transport(port)
    this.transport.on("data", this._handleSocketData.bind(this))
    this.key = key // used to derive topic which is used to discover peers for this particular cabal
    this.blocked = []
    this.peers = new Map()

    setInterval(this._attemptPrune.bind(this), TIME_BEFORE_DROP)
  }

  _handleSocketData ({ address, data }) {
    debug("received socket data", data)
    if (!this.peers.has(address)) {
      this.emitPeerNew(address)
      this.peers.set(address, { } )
    }
    // hack to make sure peers on the same ip identify each other as new peers
    if (b4a.equals(data, HELLO)) {
      this.emitPeerNew(address)
    }
    this.peers.get(address).seen = +(new Date())
    this.emit("data", data)
  }

  _attemptPrune() {
    const now = +(new Date())
    for (const [id, opts] of this.peers.keys()) {
      if (opts.seen < now - TIME_BEFORE_DROP) {
        this.peers.delete(id)
        this.emitPeerLost(id)
      }
    }
  }

  emitPeerNew(ident) {
    debug("new peer", ident)
    this.emit("new-peer", {identity: ident})
  }
  emitPeerLost(ident) {
    debug("lost peer", ident)
    this.emit("lost-peer", {identity: ident})
  }
  // broadcast a piece of data to all connected peers
  broadcast(data) {
    debug("broadcast data", data)    
    this.transport.broadcast(data)
  }

  makeContact() {
    this.transport.broadcast(b4a.from("hello"))
  }

  // emitConnectionNew() {
  //   this.emit("new-connection", {})
  // }
  //
  // emitConnectionLost() {
  //   this.emit("lost-connection", {})
  // }
  //
  // get(peer) {
  //   return {found: false}
  // }
  // block(peer) {}
  // send(peer, data) {
  //   /* imagined usage */
  //   swarm.on("new-peer", (peer) {
  //     requests.forEach(request => {
  //       swarm.send(peer, request)
  //     })
  //   })
  // }
}

module.exports = { Swarm }
