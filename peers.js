const EventEmitter = require("events").EventEmitter
const debug = require("debug")("transport/swarm")
const b4a = require("b4a")
const varint = require("varint")

// const TIME_BEFORE_DROP = 5 * 60 * 60 * 1000 // keep alive a peer for 5 minutes without having heard from them

class TransportShim extends EventEmitter {
  constructor() {
    super()
  }
  broadcast() {}
  makeContact() {}
}

// differentiate between:
// new/lost peer (authenticated and accepted)
// new/lost connection (before becoming a peer, could be rejected)
class Swarm extends EventEmitter {
  constructor(key, opts) {
    super()
    this.transports = []
    let networks = []
    if (!opts.network) {
      networks.push(TransportShim)
    } else if (Array.isArray(opts.network)) {
      networks = opts.network
    } else if (typeof opts.network === "object") {
      networks.push(opts.network)
    }

    networks.forEach(network => {
      const transport = new network(opts)
      transport.on("data", this._handleSocketData.bind(this))
      transport.on("peer-connected", () => { this.emit("new-peer") } )
      this.transports.push(transport)
    })

    this.key = key // used to derive topic which is used to discover peers for this particular cabal
    this.blocked = []
    this.peers = new Map()

    // TODO (2023-08-16): reinstate when 1) it's needed and 2) i figure out why having an interval'd function prevents
    // the test suites from exiting properly
    // setInterval(this._attemptPrune.bind(this), TIME_BEFORE_DROP)
  }

  _handleSocketData ({ address, data }) {
    debug("received socket data %O from address [%s]", data, address)
    if (!this.peers.has(address)) {
      this.emitPeerNew(address)
      this.peers.set(address, { } )
    }

    const len = b4a.from(varint.encode(data.length))
    const msgLenData = b4a.concat([len, data])
    // debug("recieved from", msg.address)
    this.peers.get(address).seen = +(new Date())
    this.emit("data", msgLenData)
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
    this.transports.forEach(t => t.broadcast(data))
  }

  makeContact() {
    this.transports.forEach(t => t.broadcast(b4a.from("hello")))
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
