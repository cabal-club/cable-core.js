const util = require("./util.js")
const b4a = require("b4a")
const constants = require("cable.js/constants.js")

/* this file contains classes that help compute and keep track of:
 * - moderation actions, i.e. post/{block, unblock, moderation}: class ModerationSystem
 * - moderation roles, i.e. post/role: class ModerationRoles
 *
 * this file, together with the views/roles.js and views/actions.js, implements the cable moderation specification:
 * https://github.com/cabal-club/cable/blob/main/moderation.md
 *
 * it has a thorough set of tests:
 * - test/mod-actions.js 
 * - test/mod-roles.js  
 * - test/mod-integration.js (this last of which combines actions and roles into how the moderation system fundamentally should operate)
*/

const HIDDEN_FLAG   = 0b001
const BLOCKED_FLAG  = 0b010
const DROPPED_FLAG  = 0b100
const ALL_FLAGS     = 0b111

class ModerationState {
  constructor() {
    this.state = 0 // hidden|blocked|dropped
  }
  get() { return this.state }
  isHidden() { return (this.state & HIDDEN_FLAG) > 0 }
  isBlocked() { return (this.state & BLOCKED_FLAG) > 0 }
  isDropped() { return (this.state & DROPPED_FLAG) > 0 }
  hide() { this.state |= HIDDEN_FLAG }
  block() { this.state |= BLOCKED_FLAG }
  drop() { this.state |= DROPPED_FLAG }
  unhide() { this.state &= (ALL_FLAGS ^ HIDDEN_FLAG) }
  unblock() { this.state &= (ALL_FLAGS ^ BLOCKED_FLAG) }
  undrop() { this.state &= (ALL_FLAGS ^ DROPPED_FLAG) }
}

// used internally in this file to make sure keys are represented accurately and to group data
class Role {
  constructor(author, recipient, ts, role, context) {
    // operate internally on hexadecimal string representations of keys
    this.author = util.hex(author)
    this.recipient = util.hex(recipient)
    this.timestamp = parseInt(ts)
    this.role = role
    this.channel = context
  }
}

// one of the ideas used here is to calculate the given role of a user by aggregating vouches (roles assigned from other
// users which are regarded as valid) and OR-ing all those vouches together and getting the highest set bit, with some additional
// logic for local user's overrides

// tracks the set of roles for a particular channel context
class RoleTracker {
  constructor(localKeyBuf, localAssignedKeys) {
    this.localKeyHex = util.hex(localKeyBuf)
    this.roles = []
    this.localAssignedKeys = localAssignedKeys
    this.adminRoles = new Map()
  }

  hasLocalAssignment (key) {
    return this.localAssignedKeys.has(key)
  }

  // called by util.getSmallestValidTime
  getRoleValidSince(authorKey) {
    const role = this.adminRoles.get(authorKey)
    if (!role) { return -1 }
    return role.timestamp
  }

  // returns public key when an admin is added
  addRole (role) {
    if (role.author === this.localKeyHex) {
      this.localAssignedKeys.add(role.recipient)
    }
    // add teh role :)
    this.roles.push(role)
    // make sure a local user's overrides for particular users are intact wrt assigning admins; only override a local
    // user assignment if issued by the local user 
    if (role.author !== this.localKeyHex && this.hasLocalAssignment(role.recipient)) { return }

    if (role.role === constants.ADMIN_FLAG) {
        const prev = this.adminRoles.get(role.recipient)
        // previous role making this user an admin had a lower timestamp, so keep that
        if (prev) {
          if (prev.timestamp < role.timestamp) { return role.recipient }
        }
        this.adminRoles.set(role.recipient, role)
        return role.recipient
    }
    return null
  }

  clear() {
    this.roles = []
    // maps public key to the role that makes a user an admin
    this.adminRoles = new Map()
  }

  determineRoles () {
    const recipients = new Set()
    const userFlags = new Map()
    const localUserFlags = new Map() // keep local user's assigned flags separate

    const pushRole = (map, role) => {
      if (!map.has(role.recipient)) {
        map.set(role.recipient, [])
      }
      map.get(role.recipient).push(role)
    }

    this.roles.forEach(role => {
      recipients.add(role.recipient)
      // add the local user's roles to their own little stash and go to the next role
      if (role.author === this.localKeyHex) { pushRole(localUserFlags, role); return }

      const ts = this.adminRoles.get(role.author).timestamp
      // role was issued before user become an admin
      if (role.timestamp < ts) { return }
      pushRole(userFlags, role)
    })

    // the final role for each recipient is the valid role assigned them with the most capabilities
    const finalRoles = new Map()
    // maps recipients to timestamps representing when their most capable role started to be regarded as valid
    const timetable = new Map()
    recipients.forEach(recipient => {
      if (localUserFlags.has(recipient)) {
        // pick the latest-set role by the local user for this recipient
        const localSetRole = localUserFlags.get(recipient).reduce((acc, curr) => { 
          if (curr.timestamp > acc.timestamp) { return curr } 
          return acc 
        })
        timetable.set(recipient, localSetRole.timestamp)
        // precedence: true indicates local precedence is in action. used when we combine roles on both the cabal
        // context with those of a specific channel
        return finalRoles.set(recipient, { role: localSetRole.role, since: localSetRole.timestamp, precedence: true })
      }
      // reduce all applicable roles set for the recipient to the most capable role
      const finalRole = userFlags.get(recipient).reduce((acc, val) => {
        // we are after the *lowest* timestamp for the *most* capable role assigned to this recipient
        if (val.role < acc || (val.role === acc && val.timestamp < timetable.get(recipient))) {
          timetable.set(recipient, val.timestamp)
          acc = val.role
        }
        return acc
      }, 2)
      // precedence: false indicates local precedence is not in action
      finalRoles.set(recipient, { role: finalRole, since: timetable.get(recipient), precedence: false })
    })

    return finalRoles
  }
}

// TODO (2024-01-25): consider construction faults of this class in terms of load on memory for very very many
// `operations` being passed to method analyze()
class ModerationRoles {
  constructor(localKey) {
    this.localKeyBuf = localKey
  }

  // `analyze` produces the set of final roles, as viewed from the local user, across all channels and the cabal context
  //
  // `analyze` returns a map with channels as keys and as values a map. the values maps each public key with an assigned role to
  // that role. each role is represented by { role: int constant, since: timestamp since role was regarded valid }
  //
  // analyze() *always* starts from scratch using what it assumes is the full state of deduplicated role operations in
  // `operations` (as derived from querying views/roles.js)
  analyze(operations) {
    // shared across all role trackers to help track which recipients have been assigned some kind of role by the local user
    const localAssignedKeys = new Set()
    // reset state
    const cabal = new RoleTracker(this.localKeyBuf, localAssignedKeys)

    // maps channel name to a role tracker
    const channelTrackers = new Map()

    const getTracker = (channelContext) => {
      if (!channelTrackers.has(channelContext)) { channelTrackers.set(channelContext, new RoleTracker(this.localKeyBuf, localAssignedKeys)) }
      if (channelContext === constants.CABAL_CONTEXT) { return cabal }
      return channelTrackers.get(channelContext)
    }

    // all newly assigned admins are added to this set. it is initially seeded with the local user's admins
    const newAdmins = new Set()

    const op2role = (op) => { return new Role(op.publicKey, op.recipient, op.timestamp, op.role, op.channel) }
    const localAssignments = operations.filter(op => {
      return b4a.equals(op.publicKey, this.localKeyBuf)
    }).map(op2role)
    const externalAssignments = operations.filter(op => !b4a.equals(op.publicKey, this.localKeyBuf)).map(op2role)

    // first we process the local user's assignments as they have an effect on all other roles
    for (const role of localAssignments) {
      const newAdmin = getTracker(role.channel).addRole(role)
      if (newAdmin) { newAdmins.add(newAdmin) }
    }

    const seen = new Set()
    while (newAdmins.size > 0) {
      newAdmins.forEach(publicKey => {
        newAdmins.delete(publicKey)
        for (let role of externalAssignments) {
          const tracker = getTracker(role.channel)
          // we never override local assignments, and so we skip conflicting assignments
          if (tracker.hasLocalAssignment(role.recipient)) {
            continue
          }
          // we don't consider roles assigned from before a user was regarded as an admin from local's POV
          let validTime = util.getSmallestValidTime(tracker, cabal, role.author)
          if (validTime === -1 || role.timestamp < validTime) {
            continue
          }
          // HACK: if a channel-specific role is assigned from a cabal-wide admin: 
          // inject the cabal-wide admin as a role into the channel tracker
          //
          // rationale: in determineRoles we use the information of which admin added a particular user as a role, and performing this hack
          // repairs the gap between channel-wide roles and cabal-wide roles
          if (role.channel !== constants.CABAL_CONTEXT && cabal.adminRoles.has(role.author)) {
            tracker.addRole(cabal.adminRoles.get(role.author))
          }

          const newAdmin = tracker.addRole(role)
          if (newAdmin && !seen.has(newAdmin)) { 
            seen.add(publicKey)
            newAdmins.add(newAdmin) 
          }
        }
      })
    }

    // combine the results into a single map
    const ret = new Map()
    const cabalRoles = cabal.determineRoles()
    ret.set(constants.CABAL_CONTEXT, cabalRoles)
    for (let [context, tracker] of channelTrackers.entries()) {
      // for each channel the set of user roles is the union of roles applied on the cabal with the roles set on the
      // channel
      const contextMap = new Map([...cabalRoles])
      for (let [recipient, role] of tracker.determineRoles()) {
        const cabalRole = contextMap.get(recipient)
        // if one role has local precedence but not the other, choose the one with local precedence
        if (cabalRole && cabalRole.precedence && !role.precedence) {
          continue
        }
        // the role with the most capability should be chosen. in this case we may have a role set on the cabal and one
        // set on the channel. or we simply pick the one with local precedence
        if (!contextMap.has(recipient) || role.role > cabalRole.role || !cabalRole.precedence && role.precedence) {
          contextMap.set(recipient, role)
          continue
        }
      }
      ret.set(context, contextMap)
    }
    return ret
  }
}

function timeCmp(a, b) {
  return parseInt(a.timestamp) - parseInt(b.timestamp)
}

class ModerationSystem {
  recipients = new Map()
  posts = new Map()
  channels = new Map()

  constructor (actions) {
    let activeMap
    actions.sort(timeCmp).forEach(action => {
      let recipients 
      switch (action.action) {
        case constants.ACTION_HIDE_POST:
        case constants.ACTION_UNHIDE_POST:
        case constants.ACTION_DROP_POST:
        case constants.ACTION_UNDROP_POST:
          recipients = action.recipients.map(util.hex)
          activeMap = this.posts
          break
        case constants.ACTION_DROP_CHANNEL:
        case constants.ACTION_UNDROP_CHANNEL:
          recipients = [action.channel]
          activeMap = this.channels
          break
        default:
          recipients = action.recipients.map(util.hex)
          activeMap = this.recipients
      }

      for (const recipient of recipients) {
        let u 
        if (!activeMap.has(recipient)) {
          u = new ModerationState()
          activeMap.set(recipient, u)
        } else {
          u = activeMap.get(recipient)
        }
        switch (action.action) {
          case constants.ACTION_BLOCK_USER:
            u.block()
            break
          case constants.ACTION_UNBLOCK_USER:
            u.unblock()
            break
          case constants.ACTION_DROP_CHANNEL:
          case constants.ACTION_DROP_POST:
          case constants.ACTION_DROP_USER:
            u.drop()
            break
          case constants.ACTION_UNDROP_CHANNEL:
          case constants.ACTION_UNDROP_POST:
          case constants.ACTION_UNDROP_USER:
            u.undrop()
            break
          case constants.ACTION_HIDE_POST:
          case constants.ACTION_HIDE_USER:
            u.hide()
            break
          case constants.ACTION_UNHIDE_POST:
          case constants.ACTION_UNHIDE_USER:
            u.unhide()
            break
          default:
            return new Error("moderation system: unknown action constant")
        }
        activeMap.set(recipient, u)
      }
    })
  }
  
  #getHidden(map) {
    return [...map].map(([recp, u]) => {
      return u.isHidden() ? recp : null
    }).filter(u => u)
  }
  #getDropped(map) {
    return [...map].map(([recp, u]) => {
      return u.isDropped() ? recp : null
    }).filter(u => u)
  }
  getHiddenUsers() {
    return this.#getHidden(this.recipients)
  }
  getDroppedChannels() {
    return this.#getDropped(this.channels)
  }
  getDroppedUsers() {
    return this.#getDropped(this.recipients)
  }
  getDroppedPosts() {
    return this.#getDropped(this.posts)
  }
  getBlockedUsers() {
    return [...this.recipients].map(([recp, u]) => {
      return u.isBlocked() ? recp : null
    }).filter(u => u)
  }
  getHiddenPosts() {
    return this.#getHidden(this.posts)
  }
}

module.exports = { ModerationRoles, ModerationSystem }
