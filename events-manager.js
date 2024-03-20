// SPDX-FileCopyrightText: 2023 the cable-core.js authors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const debug = require("debug")("core:event-manager")

// an abstraction that keeps track of all event listeners. reasoning behind it is that event listeners have historically been:
// 1. many in cabal pursuits
// 2. hard to keep track of, track down, and manage correctly (a source of leaks)
class EventsManager {
  // TODO (2023-04-24): return a singleton instance?
  
  constructor (opts) {
    if (!opts) { opts = {} }
    // stores the following:
    // this.sources["store:<event>"] = { listener: eventListener, source: eventSource, eventName: eventName }
    this.sources = new Map()
  }

  _id(className, eventName) {
    return `${className}:${eventName}`
  }

  // register() argument example:
  //
  //                  {v eventSource}                          {v eventListener     }
  // register("store", this.store, "channel-state-replacement", () => {/* do stuff */})
  //         {^ className}        {^ eventName               }
  //
  register(className, eventSource, eventName, eventListener) {
    const id = this._id(className, eventName)
    if (this.sources.has(id)) { return }
    debug("register new listener %s", id)
    this.sources.set(id, { source: eventSource, listener: eventListener })
    eventSource.on(eventName, eventListener)
  }

  // removes all event listeners registered on className
  deregisterAll(className) {
    debug("deregister all events on %s", className)
    const subset = []
    for (const key of this.sources.keys()) {
      if (key.startsWith(className)) {
        subset.push(key)
      }
    }

    subset.forEach(id => {
      const index = id.indexOf(":")
      const className = id.slice(0, index)
      const eventName = id.slice(index+1)
      this.deregister(className, eventName)
    })
  }

  deregister(className, eventName) {
    const id = this._id(className, eventName)
    if (!this.sources.has(id)) { return }
    const { source, listener } = this.sources.get(id)
    debug("deregister listener %s", id)
    source.removeListener(eventName, listener)
    this.sources.delete(id)
  }
}
module.exports = EventsManager
