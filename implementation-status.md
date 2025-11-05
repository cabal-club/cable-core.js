# Implementation tasks

This document tracks the nodejs implementation of the Cable protocol. It lists which protocol
behaviours have been implemented (ticked checkbox = behaviour implemented). Below are
enumerated the Cable protocol's expected behaviour by way of its three specificatons:
[wire][wire], [handshake][handshake], [moderation][moderation]. When in doubt or needing more
context: read the specs themselves. The listings below are to provide an overview of what has
and has not yet been implemented, and should not serve as an authoritative reference for
protocol behaviour.

This document is current as of 2025-11-04 and Cable protocol version `1.0-draft8`.

**Note:** This page is currently a WIP, I need to go through the implementation and compare it
to the current spec. Only then can I start checking off boxes :)

[wire]: https://github.com/cabal-club/cable/blob/815bbe0689b06dd9600bc2030b3eadec73efcd3c/wire.md
[handshake]: https://github.com/cabal-club/cable/blob/815bbe0689b06dd9600bc2030b3eadec73efcd3c/handshake.md
[moderation]: https://github.com/cabal-club/cable/blob/815bbe0689b06dd9600bc2030b3eadec73efcd3c/moderation.md

## Wire spec
version 1.0-draft8

## 2. Scope
- [ ] This protocol does not specify encryption nor authentication of the connection, nor a mechanism for the discovery of network peers. For encryption and authentication, it is RECOMMENDED to utilize the [Cable Handshake Protocol][handshake].

##### 5.1.2.1 Setting links
- [ ] When a post 𝑃 is created such that `𝑃.type ∈ linkableTypes`, it SHOULD link to all other posts 𝑄ᵢ known to the host that meet the following criteria:

#### 5.1.4 Ingesting a New Post
- [ ] When a host receives any new post, P, in a Post Response message, it MUST pass the following criteria to be accepted and stored by said host:

#### 5.1.5 Keeping & Discarding Posts
- [ ] A host MAY discard any post at any time, whether in the interest of saving disk space, processing time, or not wanting to contribute to the propagate of certain content.

#### 5.2.1 Lifetime of a Request
- [ ] Further, any host who receives an incoming request with a `req_id` equal to a known alive request's `req_id` SHOULD be discarded.

#### 5.2.2 Limits
- [ ] Some requests have a `limit` field specifying an upper bound on how many hashes a host wishes to receive in response. A peer responding to such a request MUST honour that limit by counting how many hashes they send back to the requester, including hashes received through other peers that the responding host has forwarded that request to.
- [ ] A requester receiving more than `limit` hashes MAY choose to discard the extraneous ones.

#### 5.3.1 Names
- [ ] A valid user name MUST be a UTF-8 string.
- [ ] A valid user name MUST between 1 and 32 codepoints.

### 5.4 Channels
- [ ] A user writing a chat message or join to a channel implies that that named channel has now been created, if it hasn't already been, and thus MUST be returned in future Channel List Requests.

#### 5.4.1 Names
- [ ] A valid channel name MUST be a UTF-8 string.
- [ ] A valid channel name MUST between 1 and 64 codepoints.

#### 5.4.2 Topics
- [ ] A valid channel topic MUST be a UTF-8 string.
- [ ] A valid channel topic MUST be between 0 and 512 codepoints.
- [ ] If there is no known topic set for a channel, it MUST be considered the empty string (`""`).
- [ ] A channel topic string set by a user to the empty string MUST be considered as there being no topic currently set.

#### 5.4.3 User Membership
- [ ] Hosts SHOULD issue a `post/join` post before issuing any other posts to a channel, and SHOULD issue a `post/leave` post when the user of the program expresses a desire to leave a channel.

#### 5.4.5 Synchronization
- [ ] When building a Channel Time Range Request, hosts SHOULD set the `time_end` and `time_start` fields in the following manner, to reliably track recent channel chat history:
- [ ] `time_end = now() time_start = now() - WINDOW_WIDTH`  where `now()` is the current system timestamp, and `WINDOW_WIDTH` is the size of the "rolling window" to track chat messages within, in milliseconds. Hosts are RECOMMENDED to use a `WINDOW_WIDTH` of one week (25,200,000 milliseconds).
- [ ] This value MAY be customized, since there are network environments where users may be offline for up to several months at a time, and a wider rolling window would be necessary to ensure those chat messages are synchronized when such a user connects once again to other peers in the cabal.

#### 6.2.1 Header
- [ ] Every post MUST begin with the following 6-field header: FIXME
- [ ] The post type sections below document the fields that MUST follow these initial fields, depending on the `post_type`.
- [ ] The protocol MAY be extended by implementers by creating additional `post_type`s. Implementers MUST only use `post_type > 255`. The first 256 are reserved for core protocol use.
- [ ] All fields specified in the subsequent subsections MUST be present for a post of a given `post_type`.

#### 6.2.2 `post/text`
- [ ] `post_type` MUST be set to `0`.
- [ ] The `text` body of a chat message MUST be a valid UTF-8 string. Its length MUST NOT exceed 4 kibibytes (4096 bytes).

#### 6.2.3 `post/delete`
- [ ] `post_type` MUST be set to `1`.
- [ ] A host interpreting this post MUST only perform a local deletion of the referenced posts if the author (`post.public_key`) matches the author of the post to be deleted (i.e. only the user who authored a post may delete it).

#### 6.2.4 `post/info`
- [ ] `post_type` MUST be set to `2`.
- [ ] Several key/value pairs MAY be set at once.
- [ ] A `post/info` post is a complete description of a user's self-published information. The latest `post/info` post by a user fully replaces any previously known versions. They are not additive. If a key is set in one `post/info` but not the subsequent one, that key MUST be treated as being set to its default. See the table of keys/values below for each key's default value.
- [ ] Keys MUST be UTF-8 strings, and MUST be between 1 and 128 codepoints in length.
- [ ] A value field MUST NOT exceed 4096 bytes (4 kibibytes) in length.
- [ ] The following keys MUST be supported: FIXME
- [ ] The following keys are RECOMMENDED to be supported: FIXME
- [ ] A post MAY contain other keys, even if they are unknown to an implementation at the time.
- [ ] To save space, a host MAY discard older versions of a `post/info` for a user.

#### 6.2.5 `post/topic`
- [ ] `post_type` MUST be set to `3`.
- [ ] A `topic` field MUST be a valid UTF-8 string, between 0 and 512 codepoints. A topic of length zero MUST be considered as the current topic being cleared to the empty string, "".

#### 6.2.6 `post/join`
- [ ] `post_type` MUST be set to `4`.

#### 6.2.7 `post/leave`
- [ ] `post_type` MUST be set to `5`.

#### 6.3.1 Message Header
- [ ] All messages MUST begin with the following header fields: FIXME
- [ ] Hosts encountering a `msg_type` they do not know how to parse MUST ignore and discard it.
- [ ] When a host forwards a request to further peers, the `req_id` MUST NOT be changed, so that routing loops can be more easily detected by peers in the network.
- [ ] The protocol MAY be extended by implementers by creating additional `msg_type`s. Implementers MUST only use `msg_type > 255`. The first 256 are reserved for core protocol use.

##### 6.3.2.1 Post Request
- [ ] `msg_type` MUST be set to `2`.
- [ ] The responder SHOULD immediately return what data is locally available, rather than holding on to the request in anticipation of perhaps seeing the requested hashes in the future.
- [ ] Hosts MUST be able to handle receiving posts of unexpected types appearing in responses, and MAY choose for themselves whether to discard them or not.

##### 6.3.2.2 Cancel Request
- [ ] `msg_type` MUST be set to `3`.
- [ ] `cancel_id` MUST be set to the `req_id` of the request to be cancelled.
- [ ] Like any other request, this request MUST have its own unique `req_id` in order to function as intended. `cancel_id` is used to set the request identifier to cancel, not the `req_id`.
- [ ] A peer receiving a Cancel Request SHOULD forward it along the same route and peers it forwarded the original message with `req_id = cancel_id`, to the same peers as the original request, so that all peers who know of the original request are notified.

##### 6.3.2.3 Channel Time Range Request
- [ ] `msg_type` MUST be set to `4`.
- [ ] A responder receiving this request MUST respond with 1 or more Hash Response messages.
- [ ] A responder SHOULD include the hashes of all known `post/text` and `post/delete` posts made to a channel between `time_start` and `time_end`.
- [ ] Only when `time_end` is set to 0 SHOULD the responder keep this request alive even after all known hashes in the range `time_start` to `now()` are provided, and continue to receive any new chat messages that the responder learns of in the future, so long as this request is still alive.
- [ ] A responder SHOULD respond with all known chat messages within the requested time range, though they may desire not to in certain circumstances, particularly if a channel has a very long history and the responding host lacks sufficient resources at the time to return thousands or hundreds of thousands of chat message hashes.
- [ ] A responder is RECOMMENDED to send posts in reverse chronological order by post timestamp, so that, if the requester sees that they received a number of hashes equal to their `limit`, they can be assured that they now have all posts newer than the oldest post hash the responder did send, and can make subsequent requests to paginate backwards in time.
- [ ] A `limit` of 0 MUST be understood as having no maximum on the number of hashes the requester wishes to receive.

##### 6.3.2.4 Channel State Request
- [ ] `msg_type` MUST be set to `5`.
- [ ] A responder receiving this request MUST respond with 1 or more Hash Response messages, with only posts that relate to the current state of the channel.
- [ ] Requesters MAY discard hashes mapping to posts that do not contain relevant information.
- [ ] See Section 5.4.4 for context on what comprises channel state. Chat messages SHOULD NOT be included in responses to this request.
- [ ] `future` MUST be set to either `1` or `0`.
- [ ] If `future = 1`, the responder SHOULD respond with future channel state changes as they become known to the responder, and the request SHOULD be held open indefinitely on both the requester and responder side until a Cancel Request is issued by the requester, or the responder elects to end the request by sending a Hash Response with `hash_count = 0`.
- [ ] If `future = 1` and a post that is part of the latest state for a channel is deleted, the responder MUST immediately send the hash of the next-latest piece of state of that same type as a Hash Response. For example, if the latest `post/topic` setting the channel's topic string is deleted by its author with a `post/delete` post, the hash of the second-latest `post/topic` for that channel SHOULD be sent.
- [ ] If `future = 0`, only the latest state posts will be included, and the request MUST NOT be held open.

##### 6.3.2.4.1 Special Case of Transmission of Causal Chains
- [ ] In order to ensure sync operates consistently in these cases, when the above is true about a post P, the responder SHOULD also include the hashes of all posts that make up the causal chain `P -> ... -> Q` (including Q).

##### 6.3.2.5 Channel List Request
- [ ] `msg_type` MUST be set to `6`.
- [ ] If `limit` is 0, the responder MUST respond with all known channels (after skipping the first `offset` entries).

#### 6.3.3 Responses
- [ ] Multiple responses MAY be generated for a single request, where results trickle in from the set of responding peers.
- [ ] Every response MUST begin with the message header detailed in Section 6.3.1, followed by bytes specific to the response `msg_type`, detailed in the sections that follow.
- [ ] Responses containing an unknown `req_id` SHOULD be ignored.
- [ ] Responders MUST set a response's `req_id` set to the same `req_id` of the request they are responding to.

##### 6.3.3.1 Hash Response
- [ ] `msg_type` MUST be set to `0`.
- [ ] A responder MUST send a Hash Response message with `hash_count = 0` to indicate that they do not intend to return any further hashes for the given `req_id` and they have concluded the request on their side.

##### 6.3.3.2 Post Response
- [ ] `msg_type` MUST be set to `1`.
- [ ] A responder MUST send a Post Response message with `post0_len = 0` to indicate that they do not intend to return any further posts for the given `req_id` and they have concluded the request on their side.
- [ ] Hosts SHOULD hash an entire post to check whether it is post that it was expecting (i.e. had sent out a Post Request for). However, misbehaving peers may end up providing posts that are still coincidentally useful to the host, so hosts MAY elect to keep certain posts.
- [ ] Each post MUST contain the complete and valid body of a known post type (Section 6.2).

##### 6.3.3.3 Channel List Response
- [ ] `msg_type` MUST be set to `7`.
- [ ] The channel names SHOULD be sorted lexicographically in ascending order, so that requesters can effectively sent subsequent requests to paginate through the results.

## Moderation spec
Version 1.0-draft8

### 4.1 Channel context
- [ ] A user MAY have different roles in different channels and actions MAY target different channels. Therefor we say that a post is issued for a particular *channel context*. A channel context MUST be considered to be either the entire cabal or a specific channel.

#### 4.1.1 The cabal context
- [ ] When a post's channel context is set to the entire cabal the effect of that post MUST be considered applicable to all channels comprising the cabal.

#### 4.2.1 Moderation authority
- [ ] Users with moderation authority SHOULD have their moderation actions take effect for those users who regard them as having moderation authority.

##### 4.2.1.1 Subjective authority
- [ ] All users have roles, *which* role a given user has depends on the perspective of a particular user. Roles granting moderation authority MUST be considered from the point of view of the local user.

###### 4.2.1.1.2 Transitive moderation authority
- [ ] If there exists no role transitivity from the local user to another user, then the other user MUST be regarded to have no moderation authority. If role transitivity exists, then the role on the other user MUST determine whether they possess moderation authority.

#### 4.2.2 Authoring `post/role`
- [ ] When authoring a `post/role` the following MUST apply:
- [ ] A single user MAY issue roles for many users.
- [ ] A user MUST have at most 1 issued role per combination of recipient     and channel context.
- [ ] A role MUST be overridden if a new role is issued where post author,     recipient, and channel context remain the same. The post author's     newly issued role for the recipient SHOULD replace their previously     issued role, and the post representing the older role SHOULD be     regarded obsolete and MAY be discarded.

#### 4.2.3 Relevant roles
- [ ] A particular `post/role`, as authored by a single user, MUST be considered a *relevant role* if:

#### 4.2.4 Declining roles
- [ ] A user MAY opt-out of roles, such as moderator or admin, being assigned them by other users by setting `post/info`'s key `accept-role` with `value = 0`.
- [ ] A user with `accept-role = 0` set MUST be regarded as a normal user, irrespective of any roles previously set on them. Posts of type `post/role` that were previously issued for a recipient that has opted out of roles SHOULD be discarded.
- [ ] When authoring a `post/role`, field `recipient` MUST NOT contain a `public_key` corresponding to a user with `accept-role = 0` set. A user who has opted out MAY still author `post/role` for users accepting role assignments.

#### 4.2.5 Applying and resolving roles
- [ ] When the local user applies role admin for a user, any roles issued by the admin from that point on MUST be applied. Roles issued from before the admin assignment MUST NOT be applied; i.e. historic roles should not be inherited.
- [ ] If an admin has their role revoked, the roles they issued for that channel context MUST NOT remain applied. If the role was revoked for the cabal context then their issued roles MUST be revoked for all channels except those where they still retain role admin.
- [ ] If multiple active roles are set for a single user, for example as a result of roles issued by the local user and other admins, the way to resolve that user's role MUST be as follows, in order of precedence from top to bottom:
- [ ] 1.  The local user's role is always admin 2.  The local user's issued roles trump all other roles 3.  The *relevant role* with the most capabilities trumps roles that     have lower capabilities 4.  The default role is a normal user  If possible, roles authored by different users SHOULD be applied such that the roles issued with an older timestamp are applied before roles issued with a newer timestamp.

###### 4.2.5.1.3 The default role is a normal user
- [ ] If a user does not have any role assigned to them, they MUST be regarded as a normal user.

### 4.3 Displaying posts
- [ ] When we refer to "displaying a post", we mean that the contents encoded by the post SHOULD be rendered in a user-facing client in some way meaningful and interpretable by a user. In this document, we primarily concern ourselves with displaying posts representing moderation actions or roles.
- [ ] A displayed post SHOULD include information about who authored it.
- [ ] Information about the encoded action SHOULD be rendered in a human meaningful format, such as a descriptive string rather than the varint representing the action.
- [ ] If a post has a field `reason` where `reason_size` \> 0, then the `reason` string SHOULD be included in the display in some way. For instance, if a post has been hidden by a `post/moderation` with `action = 2 hide post` and the post has a populated `reason` field, then the `reason` contents MAY be displayed instead of the hidden post.

### 4.4 Moderation actions
- [ ] One user MAY have many moderation actions apply to them at once; for instance, a user may be hidden and blocked.   Actions for a given recipient taken on both the cabal context and on a specific channel SHOULD interact in the following way: A user that is e.g. hidden for the cabal context and subsequently unhidden in a specific channel SHOULD be hidden in all channels except the channel where they were unhidden.
- [ ] In general, moderation actions that take effect SHOULD be displayed in some manner. Moderation actions that do not take effect, for instance due to lack of moderation authority, MAY be displayed.

#### 4.4.1 Undoing a moderation action
- [ ] hiding a post, blocking a user) SHOULD be accomplished by authoring a corresponding undoing action of which there is one for each moderation action that can be taken.

#### 4.4.2 Relevant moderation actions
- [ ] If the effects of one moderation action are undone by another action, the undoing action is the relevant action and the older action MUST be considered obsolete and MAY be discarded.

#### 4.4.3 Applicable moderation actions
- [ ] A moderation action MUST be regarded as an *applicable action* if it is considered a *relevant action* and if it was issued by a user who at the time of issuing held moderation authority.
- [ ] For a moderation action to be regarded applicable, the timestamp of the moderation action MUST be newer than the timestamp of the `post/role` causing the author to become a moderation authority.
- [ ] A `post/role`'s field `recipient` MUST NOT contain the author's `public_key`, i.e. roles targeting oneself are disallowed.

#### 4.4.4 Applying moderation actions
- [ ] Only moderation actions regarded as applicable SHOULD be applied.
- [ ] If undoing an action, the effects of the action SHOULD be undone to the extent possible.
- [ ] Users applying a moderation action issued by another user with moderation authority MUST NOT issue a post identical to the moderation action taking effect. Instead, they SHOULD apply the effects of the moderation action without issuing any new post.
- [ ] A moderation action MUST remain applied until another action undoes it.
- [ ] If an author deletes their moderation action, its effects MUST be undone.
- [ ] Older moderation actions from before a user achieved moderation authority MUST NOT be applied. The actions were issued during a time when they lacked authority.
- [ ] Moderation actions applied when a user had moderation authority at the time of issuing but whose authority has been revoked MUST remain applied. The actions were issued during a time in which they had authority.
- [ ] If possible, moderation actions SHOULD be applied in order of oldest to newest. If, for instance, three moderation actions were newly received with with the following timestamps: `1700000000000`, `1711111111111`, `1722222222222`. Then the order of application SHOULD be:

#### 4.4.5 Conflicting moderation actions
- [ ] 1.  If one of the actions originate from the local user, the effects of     the local user's action MUST trump those of the other action,     irrespective of whether it is the newest of the two actions.
- [ ] 2.  Otherwise, the action with the latest timestamp SHOULD be the action     to take effect.
- [ ] Moderation actions affecting users with moderation authority SHOULD NOT be applied unless originating from the local user. Instead, information that the action was issued SHOULD be displayed. An option to apply the action MAY be displayed.
- [ ] A user MAY issue moderation authority for a user that has been hidden or blocked. In that case, the role recipient SHOULD still remain hidden or blocked until a corresponding undoing action has been issued.

#### 4.4.6 Dropping posts
- [ ] Dropped posts SHOULD always be removed from the local store, and a dropped post SHOULD NOT be requested.
- [ ] Dropping, however, MAY affect posts authored by other users and MAY also be undone.
- [ ] When a post is dropped, the action initiating the drop SHOULD be displayed and include information about the author of the dropped post and the author of the dropping action.
- [ ] Dropping a post SHOULD result in the hash of the dropped post being associated with the hash of the dropping post. By tracking these hashes, a client can prevent resynchronizing the dropped post. This also allows undoing the action, if acting in a timely manner, in the event that a user with moderation authority abuses their delegated power.
- [ ] When undoing a drop, the hashes of the (previously) dropped posts MAY no longer be tracked and MAY be requested with a `Post Request`.

### 4.5 Post privacy
- [ ] If a post has a field `privacy` and it is set to `1 = local-only`, that post MUST NOT leave the local database. The post, or its hash, MUST NOT be sent in response to requests from other users. Consequently, knowledge of such a post only concerns the local user.
- [ ] Implementations MUST only store the encrypted post, referencing it with the hash of the unencrypted post.

#### 4.5.1 Undoing a local-only post
- [ ] If one post undoes the effects of another post where the first post's field `privacy` has been set as `privacy = 1 local-only` then the undoing post MUST also have set its field `privacy` set to the same value i.e. `privacy = 1 local-only`.
- [ ] if field `recipients` overlap, and a newer post undoes the action encoded in an older post,  and the older post has `privacy = 1 local-only`  then the newer post (*post 2* in the example above) MUST also have its field `privacy` set as `privacy 1 = local-only`.
 - [ ] The `post/block` establishing the block SHOULD NOT be sent to the blocked user unless field `notify = 1` is set. Already stored posts authored by the blocked user MAY continue to be stored and displayed unless explicitly dropped by setting `drop = 1`.
- [ ] It is important that block actions reach as many users as possible. If the blocker shares at least one channel with another user that is not the blocked user, then that user SHOULD receive the `post/block`.

#### 4.6.1 Impact on synchronization
- [ ] Clients SHOULD associate each blocked user with whom is blocking them. We illustrate this with the logical pairwise mapping of the blocking user to the blocked user:
- [ ] In the following situations, a user acting as a terminal peer MUST discard any posts received in a Post Response if they were authored by:
- [ ] A user blocking another user through actions issued by moderation authorities MUST behave as if they were the author of the block. A blocked user MUST discard posts they receive from a user blocking them if they have been notified of the block and if the author of the received posts was the same as the author of the `post/block`.  

##### 4.6.1.1 Authenticated Connections
- [ ] Through the Cable Handshake Protocol peers MAY establish authenticated connections, causing each party of a successful connection to know the ed25519 public key of the other.
- [ ] The behaviour described in this section MUST apply to responses created by the terminal peer as well as to forwarded responses and it MUST only be applied for established authenticated connections.
- [ ] If the local user establishes an authenticated connection with a peer they block the connection SHOULD be terminated.
- [ ] When a terminal peer receives a Post Request over an authenticated connection where the requester's associated public key matches a user known to be blocked (notably: in this case, the terminal peer MUST NOT block the requesting user), the responder MUST omit any posts authored by all users blocking the requester.
- [ ] When a terminal peer receives a Post Request over an authenticated connection where the requester's associated public key matches a user known to currently block other users, the responder MUST omit all posts authored by users the requester is blocking.

#### 4.7.2 Solution
- [ ] To address the above scenario and others like it, users MAY join with a *moderation seed*. A moderation seed describes a set of public keys and roles to temporarily assign the users represented by those public keys.
- [ ] The moderation seed for a set of recipients MUST be constructed in the following manner:   1. Take a recipient from the set in no particular order.
- [ ] Following the procedure for a non-empty set of recipients and their roles results in a byte sequence consisting of `<varint role><32 byte ed25519 public key>`  pairs, one pair for each user being assigned a role.   The moderation seed MUST contain no more than 16 public key assignments.
- [ ] Conceptually, the moderation seed MUST temporarily change the default role of the users it references from that of a normal user to that of the specified roles. Consequently, any user with role admin may assign another role to one of the moderation seed referenced users just as they would any other user. Implementations MUST NOT cause `post/role` posts to be created as a result of applying the temporary roles bestowed by the moderation seed.
- [ ] Actions and roles issued by the moderation seed's referenced users MUST be applied irrespective of when they were authored but with respect to the capabilities of the roles they were assigned.
- [ ] Users joining with a moderation seed MUST be notified of that and instructions MAY be displayed on how to revoke it and undo its role assignments. The moderation seed's referenced users SHOULD retain their roles until assigned another role or until the moderation seed is revoked by the local user. When a moderation seed is revoked, the public keys it described MUST have their default roles return to that of a normal user.
- [ ] Actions and roles issued from moderation seed referenced users that have been applied MUST remain applied even after revoking the moderation seed.
- [ ] Sharing of a moderation seed may occur in a similar out-of-band fashion and in conjunction with transmitting the cabal key (e.g. other chat programs, written on paper, etc). Clients may have other ways of representing a moderation seed, such as a query string of a URI query component, however implementations MUST support ingesting the described moderation seed format. We illustrate the format further with the example below.
- [ ] `reason` MAY be used to communicate the rationale behind an action or as a reminder for why it was taken. `reason` MUST be a valid UTF-8 string, between 0 and 128 codepoints. `reason` MAY be left empty in which case `reason_size` MUST be set to `0`.

Encryption](#452-authenticated-encryption). 
- [ ] If `privacy` is set to `0` the post MUST be synchronized as any other post and MUST NOT be encrypted per *Authenticated Encryption*.

#### 5.1.2 `post/role`
- [ ] `post_type` MUST be set to `6`.
- [ ] All roles MUST be regarded as exclusive and can be considered in terms of increasing capabilities, listed below from most capabilities to least:
- [ ] Upper levels MUST incorporate all capabilities of lower levels. A user without any explicitly assigned role SHOULD be regarded as a normal user, unless a moderation seed is active and affecting that user's default role.
- [ ] If a local user mistakenly issues a role for a user, they MAY delete it with a `post/delete`.

##### 5.1.2.1 `role = 2 set normal user`
- [ ] This role SHOULD be regarded as overriding any previous role set on `recipient`, if any, setting their capabilities to the default role of normal user.
- [ ] Similar to roles mod and admin, this role when set by the local user MUST NOT be overridden by new roles set by users with moderation authority.

actions](#445-conflicting-moderation-actions). 
- [ ] A user regarded as having role mod MUST NOT have any `post/role` they author applied.

##### 5.1.2.3 `role = 0 set admin`
- [ ] Has moderation authority and MAY issue moderation actions and MAY propose roles:

#### 5.1.3 `post/moderation`
- [ ] `post_type` MUST be set to `7`.
- [ ] When acting on users or posts, `recipient_count` SHOULD be set to a value between 1 and 16 otherwise it should be set to 0.

##### 5.1.3.1 Acting on users
- [ ] Field `recipients` MUST be set to a sequence of 32 byte ed25519 public keys representing the users being acted on.
- [ ] If `channel_size` and `channel` are set when acting on a user, the action MUST only apply to the specified channel. When actions apply to the entire cabal, `channel_size = 0` MUST be set.

##### 5.1.3.2 Acting on posts
- [ ] Field `recipient_count` MUST be set to the number of post hashes being acted on. Field `recipients` MUST be set to the post hashes.
- [ ] Field `channel` MUST be set to the same value as the `channel` field of  the posts being acted on.

##### 5.1.3.3 Acting on channels
- [ ] Field `recipient_count` MUST be set to 0. Field `channel` MUST be set to the channel name being acted on.

##### 5.1.3.4 `action = 0 hide user`
- [ ] A hidden user's posts of type `post/text` MUST NOT be displayed. This applies to old and new posts. Their posts MUST be stored and their new posts MUST be requested. A hidden user's `post/info` MAY be displayed differently for key `name`, such as displaying "hidden user" instead of the value corresponding to key `name`.
- [ ] The undoing action is `action = 1 unhide user`, which SHOULD cause the user's posts to be displayed.

##### 5.1.3.5 `action = 2 hide post`
- [ ] Hidden posts MUST NOT be displayed. The post being hidden MUST be of post type `post/text`. All other post types MUST NOT be hidden with this action. Hidden posts MUST still be stored and returned in response to requests by other users.
- [ ] If `reason` is set, it MAY be used to replace the contents of the post with a content warning reflecting the contents of `reason`.
- [ ] The undoing action is `action = 3 unhide post`, which SHOULD enable the post to be displayed.

##### 5.1.3.6 `action = 4 drop post`
- [ ] The post being dropped MUST be of either post type `post/text` or `post/topic`. All other post types MUST NOT be dropped with this action.
- [ ] The undoing action is `action = 5 undrop post`. An undropped post SHOULD be possible to request and store.

##### 5.1.3.7 `action = 6 drop channel`
- [ ] Dropped channels MUST have all posts associated with that channel dropped, regardless of post type. New posts authored in that channel MUST NOT be requested nor stored.
- [ ] `channel` MUST be set to channel name being dropped.
- [ ] `recipient_count` MUST be set to `0`.
- [ ] Dropped channels MUST NOT be represented in a `channel list response`.
- [ ] The undoing action is `action = 7 undrop channel`. An undropped channel MUST function like any other channel and posts authored for that channel MUST be possible to request and store.

#### 5.1.4 `post/block`
- [ ] `post_type` MUST be set to `8`.
- [ ] `recipient_count` MUST be set to a value between 1 and 16. `recipients` MUST contain a sequence of 32 byte ed25519 public keys.
- [ ] Setting `drop` to 1 MUST drop all posts authored by `recipients` from the local database. Setting `drop` to 0 MUST keep the posts in the local database. Allowing posts to be kept enables situations where a user may want to keep posts from blocked peers, for instance when preserving evidence of abuse.
- [ ] When `notify` is set to `0 = do not notify blocked user` the `post/block` MUST NOT be transmitted to the blocked user.
- [ ] If field `notify` is set to `1 = notify blocked user` the `post/block` MUST be transmitted to the blocked user. Posts authored after the `post/block` should function as otherwise specified and MUST NOT be transmitted to the blocked user.

##### 5.1.4.1 Dropping a user
- [ ] Users MAY "drop a user" without impacting post synchronization of that user's posts for other users by setting `drop = 1` and `privacy = 1`.
- [ ] The outcome of the operation MUST be that the recipient's posts are dropped for the local user, who MUST NOT store nor request new posts authored by the blocked user. Due to setting `privacy = 1`, other peers SHOULD still store, receive, and synchronize the dropped user's posts.

#### 5.1.5 `post/unblock`
- [ ] `post_type` MUST be set to `9`.
- [ ] `recipient_count` MUST be set to a value between 1 and 16.
- [ ] Setting `undrop` to 1 SHOULD undo the drop of all posts authored by `recipients`, making them possible to retrieve again. Setting `undrop` to 0 SHOULD keep the old posts as dropped.

##### 5.2.1.1 Moderation State Request
- [ ] `msg_type` MUST be set to 8.
- [ ] A request MUST indicate it is done specifying channels by setting the final `channelN_size` to 0.
- [ ] Responders SHOULD be a member of at least one of the requested channels and respond with hashes for:
- [ ] Responders MUST NOT include post hashes corresponding to `post/role` set on users who have opted out of roles by setting `accept-role = 0` in `post/info`.
- [ ] `future` MUST be set to either `1` or `0`.
- [ ] If `future = 1`, the responder SHOULD respond with future moderation state changes as they become known to the responder. The request SHOULD be held open indefinitely on both the requester and responder side until a Cancel Request is issued by the requester, or the responder elects to end the request by sending a Hash Response with `hash_count = 0`.
- [ ] If `future = 0`, only presently known moderation state hashes SHOULD be included in the response, limited by `oldest` and channel membership, and the request MUST NOT be held open.
- [ ] Field `oldest` is a time, expressed in milliseconds since UNIX Epoch, limiting the amount of history sent when set. If `oldest > 0` then the posts whose hashes are being returned SHOULD fulfill `post.timestamp >= oldest`. If `oldest = 0` then this SHOULD be regarded as the limit being unset.
- [ ] Implementations are RECOMMENDED to set a large value for `oldest`, for example on the order of 1 year from the time of requesting: `oldest = <current time ms> - 31536000000`.
- [ ] A response to this request SHOULD return **all** known hashes concerning types `post/block` and `post/unblock`, i.e. disregarding the value of field `oldest` if set. This to ensure user safety by respecting issued blocks such that they will reach all users of a channel.

## Handshake spec
version 1.0-draft8

- [ ] The Cable Handshake protocol MUST be executed first. Upon successful completion of the handshake, the pair of hosts may then exchange messages using the Cable Wire Protocol.

### 1.2 Document versioning
- [ ] A valid implementation of Cable MUST follow both documents at the same version.

### 2.1 Initiator and responder
- [ ] Since different transports have different properties, a single rule cannot be provided as to which host takes on which role. However, for transport protocols where there are well-defined *client* and *server* roles, such as TCP/IP, implementations SHOULD regard the client as the initiator and the server as the responder.

### 2.4 Cabal key
- [ ] The cabal key effectively acts as a "secret passphrase": only hosts who know the key can successfully handshake and then exchange Cable Wire Protocol messages. If either party doesn't know the key, Noise will indicate handshake failure. This key is only ever used locally and is never sent over the network transport. Members of a cabal can share the cabal key over various out-of-band means (e.g. other chat programs, written on paper, etc.)  The pre-shared key MUST be mixed into the handshake state as per the rules in *9. Pre-shared symmetric keys* of the Noise specification.

### 3.1 Static Keypair
- [ ] This keypair SHOULD be generated when a user first joins or creates a cabal, and SHOULD be persisted in some manner, so that it can be re-used for the handshake of every peer connection made. For security reasons, the keypair MUST be unique to that cabal, and MUST NOT be shared across other cabals. (See the Wire Protocol's Security Considerations section for a more detailed explanation.)  The keypair is used to both authenticate connections and to sign posts in the Cable Wire Protocol. The same keypair SHOULD be used for both.

### 3.2 Process
- [ ] The Noise Handshake phase is performed by following the listed steps in the Noise specification, under *5. Processing rules*, which MUST be executed:
- [ ] - The ASCII-encoded string `"CABLE/1.0"` MUST be used as the `prologue` in `Initialize()`. The number "1.0" in the prologue is so because this version of the protocol is 1.0. The definitive bytes of this, in hexadecimal, are `43 41 42 4c 45 2f 31 2e 30`.
- [ ] - The string `"XXpsk0"` MUST be used as the `handshake_pattern` in   `Initialize()`.
- [ ] - The initiator MUST set `initiator` to `true` in `Initialize()`. Otherwise, it   MUST be set to `false`.
- [ ] - The cabal key MUST be mixed into the `SymmetricState` as described in *9.
- [ ] - If an error is signaled by the `DECRYPT()` or `DH()` functions, the   connection MUST also be terminated.

## 4. Post-Handshake Operation
- [ ] Once the Noise Handshake phase is complete, the Cable Handshake is in the Post-Handshake Operation phase, where Cable Wire Protocol messages MAY be transmitted and received. There is a final set of rules, described here, for how incoming and outgoing data speaking the Cable Wire Protocol must be encoded and decoded.
- [ ] - For the initiator, `c1` MUST be used for encryption, and `c2` for decryption.
- [ ] - For the responder, `c2` MUST be used for encryption, and `c1` for decryption.
- [ ] Specifically, to exchange messages during Post-Handshake Operation, the listed steps in the Noise specification, under *5. Processing rules*, MUST be followed:
- [ ] In this context, "transport messages" are Cable Wire Protocol messages. If `DecryptWithAd()` signals an error due to `DECRYPT()` failure, the client MUST terminate the connection.

#### 4.2.1 Fragmentation
- [ ] FIXME: prior to transmission, such that the first `n - 1` segments are 65519 bytes in length, and the final segment is of a length constituting the remaining bytes.
- [ ] Messages with a length less than or equal to 65519 bytes MUST be sent without any fragmentation.

#### 4.2.2 Encryption and Authentication
- [ ] Each segment MUST be encrypted with a MAC using the Noise function `EncryptWithAd`.

#### 4.2.3 Message length
- [ ] `lenEncrypted = EncryptWithAd(ZERO, len)`.  `lenEncrypted` MUST be computed first, followed by each ciphertext in sequence, C₁ through Cₙ. The order of encryption is essential, since `EncryptWithAd` is a stateful function.

#### 4.2.4 Message transmission
- [ ] Using the values produced from the preceding subsections, the final message MUST be transmitted in the following sequence:

### 4.4 End of stream
- [ ] When a host has decided to terminate the exchange of messages, they MUST send a message of length zero to indicate this intention, and MUST NOT send any further messages. The zero-length message is known as an end-of-stream marker.
- [ ] The host receiving an end-of-stream marker SHOULD respond with an end-of-stream marker of its own to indicate it has also finished writing. An implementation SHOULD have a time-out of some kind in case the other side does not transmit an end-of-stream marker or the marker is truncated by an attacker.
