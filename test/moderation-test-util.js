const util = require("../util.js")
const { CABAL_CONTEXT } = require("cable.js/constants.js")
const crypto = require("cable.js/cryptography.js")
const cable = require("cable.js/index.js")
const b4a = require("b4a")

// simulating a seeded random number gen, used for debugging flaky tests :)
let seed = 0
function random() {
  return Math.random()
  var x = Math.sin(seed++) * 10000;
  return x - Math.floor(x);
}

const before = (referenceTimestamp) => {
  return referenceTimestamp - Math.floor(random() * 10000 + 1)
}
const after = (referenceTimestamp) => {
  return referenceTimestamp  + Math.floor(random() * 10000 + 1)
}
const between = (start, end) => {
  const diff = start - (end-1)
  return start + Math.floor(random() * diff - 1)
}

// convert a binary cable post to it json object representation. optionally: if the author is listed as one of the admins, mark the object with isAdmin: true
function annotateIsAdmin(admins) {
  return (post) => {
    const obj = cable.parsePost(post)
    obj.postHash = crypto.hash(post)
    const key = b4a.toString(obj.publicKey, "hex")
    if (admins.has(key)) {
      return {...obj, isAdmin: true }
    }
    return obj
  }
}


class User {
  constructor() {
    this.kp = crypto.generateKeypair()
  }
}


module.exports = { before, after, between, User, hex: util.hex, annotateIsAdmin }
