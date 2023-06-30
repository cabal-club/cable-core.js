<!--
SPDX-FileCopyrightText: 2023 the cabal-club authors

SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Database indexes and views
## Definitions
* `<thing>` signifies a placeholder value, where the text in brackets is a concrete value
  of the type described by the text and only known at runtime. e.g. `<hash>` is a
  base16-encoded hash appearing something like `7e13a3f34f6494e539ffd32c1bb35f18`
* `<ts>` is short for timestamp, a string representation of a point in time in Unix Time (number of seconds since the Unix Epoch aka since midnight 1970 jan 1)
* `<mono-ts>` is short for monotonic timestamp, i.e. timestamps that only ever
  increase in size and which are guaranteed to not overlap with any other
  monotonic timestamp. This can be used to yield unique database view keys that can also be
  ranged over to sort by time. We will be using the `monotonic-timestamp` nodejs module.
  Monotonic timestamps may look like the following:
  ```
  1676993016405
  1676993016406        < concurrent calls cause a suffix to ensure uniqueness
  1676993016406.001    < concurrent example 1
  1676993016406.002    < concurrent example 2
  1676993016406.003    < concurrent example 3 
  ```
* `<hash>` is the binary-represented 32-byte blake2b hashes that cable operates on
* `<hash.16>` is the base16-encoded 32-byte blake2b hashes that cable operates on
* `<pubkey>` is the binary-represented public portion of a ed25519 keypair
* `<pubkey>` is the base16-encoded public portion of a ed25519 keypair
* `<channel>` is the utf-8 encoded string that represents a cable channel (think: chat channel, because that is what it is).

### Notes on conventions in this document
* accreted state: a view that exists primarily to simplify application-level
  concerns (e.g. make it easy to find the latest topic). Does not help
  answering cable requests. accrete because it changes over time - but maybe not the best name!
  materialized is probably more standard?
* view names starting with `!`: this is not necessary for the indexed views to be
  properly queryable using lexicographic sort, but makes it easier to see which
  strings in this documents are views; it's a convention used in this document,
  if you will

## Key sort order

When you are using a key-value database like leveldb, there's a particular quirk you have to
work around when it comes to structuring data in a table-like manner. That quirk is dealing
with lexicographic sort order. This is a fancy way of saying that keys will be compared in a
left-to-right, character-by-character manner. The key `B` is "higher" than the key `A`.

If you are developing on linux, the command `ascii` is very helpful for seeing the different
ascii values of different characters. 

For instance, `!` is the smallest printable character,
with a decimal value of 33. Whereas `~` is the largest printable character in the ascii table,
with a decimal value of 126. These two are commonly used to delineate queries, using greater
than `!` and a less than `~` operations.

This all means that you have to be somewhat mindful and careful when laying out the key space,
which names and pieces of data in a particular key, of your tables.

## Materialized views
These materialized views comprise the database portion of cable-core, and will be serviced by
instantiations of leveldb e.g. the nodejs wrapping module `level`, which works in browsers and
in nodejs. 

When a cable response streams in as a result of a previously issued request, the received data
will be persisted and tied to its hash in the data store. The data is indexed in different
kinds of views according to what type of post it is.

<!-- links (not captured by any index yet) -->
<!--
reverse hash links
links[message hash] -> [list of message hashes that link to <message hash>]

* if no entries in list -> we've got a head
* for each entry in msg.links do:
    reverse map[msg.links[i]] = msg.hash
-->

The following sections describe the different indexes and stores planned for `cable-core`. Each
section explains what the view is used for and what the storage schema looks like.

### Data store
A data store where each key is a hash, and each value is the data that
generates that hash. This is how we store all the posts we receive in data
responses, or which the local user creates by making posts themselves.

    <hash> -> <blob>

This view is implemented in [`data-store.js`](./data-store.js).

### Reverse hash lookup
A reverse lookup table, mapping hashes to which views and under what keys in those views the
hashes have been referenced. This is how we update other views when a post has been deleted. 

This matters because if a post is deleted, then the hash pointing to it is now
irrelevant to index, because we no longer have that data (and never will
again).

    !<hash.16>!<mono-ts> => "<viewname><separator><viewkey>"


This view is implemented in [`reverse-hash-map.js`](./reverse-hash-map.js).

### Posts
The posts view tracks two different kinds of data. One part of the view, the messages view, keeps track of hashes
of `post/text` and `post/delete. The other, the deleted view, keeps track of which deletes have happened in order
to never ask for or persist those posts. The key schema, as denoted below, is different for the
two subviews.

#### Messages: `post/text` and `post/delete`
The posts view maps channel name+time to a hash, where the hash should resolve to either a
`post/text` or a `post/delete` when queried for in the data store.

    !chat!<mono-ts>!post!<channel> -> <hash>

This view is implemented in [`messages.js`](./messages.js).

**Note:** mono-ts here should be related to the indexed post's claimed timestamp; do some kind
of pass / logic that to index uniquely using the claimed timestamp

**Note:** Do secondary topological sort after retrieving posts?

**Note:** `post/delete` may target any kind of post, including non-`post/text` types

<!-- 
**q:** Do we need a fulltext index as well? To e.g. enable easier search
implementation.  But maybe it doesn't matter? To do search, we essentially get
a window of history, resolve the text and then figure out which of the messages
are relevant to return as results. So: I guess the answer to the initial
question is, no, it seems better to have access to the full message buffer because
it has more data than just the text. 
-->

#### Handling deletions
Deletions. This view allows us to persist deletions and can be used to prevent resyncing deleted posts. 

    !chat!deleted!<hash.16> -> 1

This view is implemented in [`deleted.js`](./deleted.js).

**Note**: This tracks the *hash of the deleted post* i.e. NOT the hash of the `post/delete` itself. 

### Channel state
Channel state maps channel name of a post, alongside extra details part of the key, to a
channel state-related hash. This view keeps track of:

* *all* `post/join` or `post/leave` made by `<pubkey>`
```
!state!member!<channel>!<mono-ts>!<pubkey> -> <hash>
``` 
* *all* `post/info` for nick published by `<pubkey>`
```
!state!nick!<channel>!<mono-ts>!<pubkey> -> <hash>
```
* *all* `post/topic` for channel, published by anyone
```
!state!topic!<channel>!<mono-ts> -> <hash>
``` 

Querying this view should suffice to answer any incoming `Channel State Request`.

This view is implemented in [`channel-state.js`](./channel-state.js).

**Note:** this view *does* handle the case of answering a historic (give all history you
have) channel state request.

### Author
The author view indexes all posts by the public key that authored them. The view key
also includes what type of post it was; e.g. a `post/text` or a `post/join`. Which type of post
it was is encoded by using the corresponding post type ID as defined in the cable spec. Entries
are indexed by mapping the public key and the post type to the corresponding post hash. 

You can query for any given `post_type` authored by any given public key.

    !author!<pubkey>!<post_type-id>!<mono-ts> -> <hash>

The existence of this view facilitates deleting all posts authored by pubkey, which would be
useful if a pubkey has been blocked and you no longer want to host the content they authored.

This view is implemented in [`author.js`](./author.js).

### Channel membership (accreted)
The channel membership view keeps track of which channels have which users currently joined to
it.

    !channel!member!<channel>!<pubkey> -> 1 or 0

* Set value to 1 for `post/join` issued by `<pubkey>` to `<channel>`.
* Set value to 0 for `post/leave` issued by `<pubkey>` to `<channel>`.

This view is implemented in [`channel-membership.js`](./channel-membership.js).

**Note:** Each accreted view needs to be potentially re-indexed if a deleted message had the same type as the view. This can be done by querying the author view to see if there was any post of a related type prior to the deleted post.

**Note:** The stable sorted set of <channel> names, derived from the keys recorded in this view, are what we would respond with to answer a channel list request.

### Channel topic (accreted)
The channel topic view keeps track of the topic of each channel the local user knows about.

    !channel!topic!<channel> -> <topic>

This view is implemented in [`topics.js`](./topics.js).

**Note:** Each accreted view needs to be potentially re-indexed if a deleted message had the same type as the view. This can be done by querying the author view to see if there was any post of a related type prior to the deleted post.

### User information
This view specifically deals with mapping out the different types of
`post/info` contents that may have been authored by users. 

As of writing (2023-03-16) the cable spec only has one specified `post/info` key: `name`. Other
types of user-related information may be added in the future: a user description, a user image,
a user's post expiry preference, etc.

    !user!info!name!<pubkey>!<mono-ts> => latest post/info setting nickname property
    !user!info!<property>!<pubkey>!<mono-ts> in general
    !user!latest!info!<property>!<pubkey> in general

This view is implemented in [`user-info.js`](./user-info.js).

## Tracking a request -> response life cycle
Some notes now follow on how we could keep track of whether respones we get back for
requests made are sensible or not. The notes of this section are more exploratory than
explicative. Jump to section **Verifying index sufficiency**, below, if this is not your jam.

Tracking the path of a request and its sibling, the response, is done with request ids
(`req_id`).

A `req_id` always belongs to a request or to the response caused by a request. Thus a `req_id`
has a source (the message type that "spawns" the request) and an expectation of what to get
back (the message type that correctly answers the request e.g. a `post response` for a `post
request`, a `hash response` for a `channel time range request`, or a `channel list response`
for a `channel list request`). We can also prepare for the cable specification's _circuits_
behaviour by keeping track of an extra id to more efficiently route messages, instead of
floodfilling to all connected peers.

When we deal with a request, we can associate the generated `req_id` with:

* source (the message type of the request), a varint
* expects (the expected message type of the response), a varint
* origin (are we the end destination for the returning response, or are we passing on
  information between other nodes), a boolean
* circuitid (which connected node to send the response to), a varint; might be premature and
  pending on how it is specified

Also worth noting is that a response will have its `req_id` field set to the same value as the
request its responding to. That is: `response[req_id] = request[req_id]`.

### Associating request and response pairs
We could go one step further, and associate the two request-response pairs that will be
required to fulfill the entire life cycle. That is:

Let's say we make a channel time range request. The intent of that is to eventually receive
posts of types `post/text` and `post/delete`. To achieve this, the channel time range
request is sent. The reply that comes back is a hash response (list of hashes). To get the
actual messages containing posts (and not a list of post hashes), we send out a new request, this
time a post request. Back comes a post response, containing some or all of the requested
hashes. That is, we have two roundtrips:

| Roundtrip | Outgoing (Request)            | Incoming  (Response)      |
|:---------:|-------------------------------|---------------------------|
| 1         | Channel Time Range Request    | Hash Response             |
| 2         | Post Request                  | Post Response             |


In roundtrip 1, the request and response are to have the same `req_id`. However, the request
and response in 2 have a different `req_id` than in 1 but which is shared within roundtrip 2's
request and response. i.e. there is potentially a a gap missing between associating the actions
in 1 and the actions in 2, even though 2 happens as a direct result of 1.

### Forwarding facilitation 
To facilitate forwarding, we could have a map to keep track of where a request came from, in
order to send the response that same way. In case we get the same request from multiple
sources, the actual intended destination is uncertain; we should maintain a list of
destinations.

    originMap: req_id -> [peerid]

### Receiving a response
When we receive a response we look up the `req_id`, and ask the following questions:

* Is this intended for us? If `origin = true` then, yes. Otherwise we should forward it
  onwards: look in the `originMap` for where to try forwarding (and remember that entries in the map might have
  gone offline since being added during the current session).
* Does the response adhere to the expected message type? 
    * If not: throw it out? log?
* Are the *contents* of the response what was requested? 
* If not: throw it out? log?
    * for example: sending a bunch of `post/topic` as a response to a channel time range
      (post/text + post/delete) is not the expected behaviour

If we throw out unexpected responses, we risk running foul of the robustness principle:

> "be conservative in what you do, be liberal in what you accept from others". It is often
> reworded as: "be conservative in what you send, be liberal in what you accept". The principle
> is also known as Postel's law, after Jon Postel, who used the wording in an early
> specification of TCP.

Perhaps the best recourse is to log the failed expectations, and in the specification describe
the expected behaviour such that other implementations try their best at "being conservative in
what they send".

## Verifying index sufficiency

The following sections map each cable request to what kind of database index operations will
suffice to correctly answer the request. Initially intended as a form of sketching / thinking out loud
that helps to identify gaps ahead of time, before the views have been written.

<!-- 
### Request expectations
    might need views to handle the following cases:

    * track requested hashes (and check against hashes of response payloads)
    * track & verify results from life cycle of:
        <some channel request> -> hash response, which causes -> post request-> post response
        [                  one reqid                        ]    [         another reqid        ]

-->

### Request expectations
The following brief section outlines what each cable request ultimately expects to receive as
a result of making the request.

#### Post request

Post request expects:

* post response `msg_type=1`
* data payloads to correspond to the requested hashes
    * verify by tracking the requested hashes and cross-referencing with the hash of each
      post in the post response payload?

#### Channel time range request

Channel time range expects:

* hash response `msg_type=0`
* data payloads to be of type:
    * post/text
    * post/delete

#### Channel state request

Channel state expects:

* hash response `msg_type=0`
* post response payloads to be of type:
    * post/topic
    * post/join
    * post/leave
    * post/info

#### Channel list request

Channel list expects:

* a channel list response `msg_type=7`
* payloads to be UTF-8 strings

### Answering requests
This section outlines the index queries and operations needed to answer the different cable
requests.

#### Answer a post request(`msg_type = 2`)
A post request wants the data identified by a list of hashes.

Query:

    <hash> -> <blob>

Use the returned binary payloads to fashion the post response. Construct a
list and fill it with the payloads that were found when querying the view.

#### Answer a channel time range request (`msg_type = 4`)

Query:

    !chat!text!<channel>!<ts> -> <hash>

Use the request's specified start and end time ranges, and the limit option, when querying to get the correct range
of data. Answer with the list of hashes in a hash response.

#### Answer a channel state request (`msg_type = 5`)

Query:

        !state!member!<channel>!<mono-ts>!<pubkey> -> <hash>
        !state!nick!<channel>!<mono-ts>!<pubkey> -> <hash>
        !state!topic!<channel>!<mono-ts> -> <hash>

using the request's channel name and a sort that gives us the latest records
first. In each of the three queries, use leveldb's `limit: 1` option to only
get the latest entry. 

The query range should operate regardless of the public key portion of view
key, which are only part of the key to provide unique records that point to the
entry.

#### Answer a _historic_ channel state request (`msg_type = 5`)
A historic channel state request is a request that sets `historic = 1`.

Query:

        !state!member!<channel>!<mono-ts>!<pubkey> -> <hash>
        !state!nick!<channel>!<mono-ts>!<pubkey> -> <hash>
        !state!topic!<channel>!<mono-ts> -> <hash>

Using the request's channel name, and a sort that gives us the latest entries.
What we get back are lists of hashes. Smoosh the lists together.

Answer with the list of hashes that are retrieved from executing the query.

#### Answer a channel list request (`msg_type = 6`)

Query:

    !channel!member!<channel>!<pubkey> -> 1 or 0

Use the retrieved keys to extract a list of channel names, and convert the list into the set of
known channel names. Then convert the set back into a list and stable sort it.


#### Honor a delete request (`post_type = 1`)

A delete request is only valid (will be honored by the local user) if:

1. the requester is regarded as a moderator or admin by the local user, or
2. the requester is requesting to delete posts they have authored themselves 
    * i.e. public key of the delete/post payload and the post identified by the requested hash
      are the same.

And in all cases: the cryptographic signature of the post/delete payload must be correct.

1) Honor the delete request by removing the associated payload from:

```
<hash> -> <blob>
```

2) Persist the post/delete by saving the binary payload in: 

```
<hash> -> <blob>
```

3) Persist the hash of the post/delete in the posts view:

```
!chat!text!<channel>!<ts> -> <hash>
```

4) Finally, persist the hash identifying the deleted post, to limit future attempts to resync this
post, by making an entry in:

```
!chat!deleted!<hash.16> -> 1
```

### Updating the database indices
The following sections depict the indexing actions that spring forth when a new
post is added to the database, and how to update the database when the
underlying post is deleted from the database.

**In general**: each time a view has a new entry added which maps to a hash, add a new entry to
the reverse lookup table:

    !<hash.16>!<mono-ts> => "<viewname><separator><viewkey>"

#### post/text (`post_type=0`)
##### Creation
A post/text (`post_type=0`) is written, meaning a hash is mapped to a binary
payload and persisted in the database.

The following tables are updated:

    <hash> -> <blob>
    !chat!text!<channel>!<ts> -> <hash>
    !author!<pubkey>!0!<mono-ts> -> <hash> // post/text

To be able to remove these entries later on, for example when a delete request
comes in, we need to know which keys are mapped to that hash for each indexed
view.  We save the following entries in the reverse-hash lookup:

    !<hash.16>!<mono-ts> => "chat!text!<separator>chat!text!<channel>!<ts>"
    !<hash.16>!<mono-ts> => "author<separator>author!<pubkey>!1!<mono-ts>"

##### Deletion
When we delete the corresponding hash, the following operations take place:

Delete <hash> from:

    <hash> -> <blob>

Get each view key using `<hash>`:

    !<hash.16>!<mono-ts> => "chat!text!<separator>chat!text!<channel>!<ts>"
    !<hash.16>!<mono-ts> => "author<separator>author!<pubkey>!1!<mono-ts>"

Delete entry in view using retrieved key:
    
    !chat!text!<channel>!<ts> -> <hash>
    !author!<pubkey>!1!<mono-ts> -> <hash> // post/text

If this delete was from a delete request (post/delete), also persist the delete
by saving the hash of the deleted post:

    !chat!deleted!<hash.16> -> 1

Deletes may also happen as a result of reducing the amount of messages stored. In that case it
did not come from a peer requesting a delete, and so it *should not* be persisted in the view:

    !chat!deleted!<hash.16> -> 1

#### post/delete (`post_type=1`)
##### Creation
This one is a bit tricky to think about correctly. When a `post/delete` is
created, this necessitates deleting what it points to as well.

First: perist the post as usual; a post/delete (`post_type=1`) is written,
meaning a hash is mapped to a binary payload and persisted in the database.

The following tables are updated:

    <hash> -> <blob>
    !chat!deleted!<hash.16> -> 1
    !author!<pubkey>!1!<mono-ts> -> <hash> // post/delete

<!-- To be able to remove these entries later on, for example if a delete should be
reverted, we need to know which keys are mapped to that hash for each indexed
view.  We save the following entries in the reverse-hash lookup:

    !<hash.16>!<mono-ts> => "author<separator>author!<pubkey>!1!<mono-ts>"
-->

Now, time to delete the pointed to content:

* Use the hash to delete the payload from: `<hash> -> <blob>`
* Look up the hash to be deleted in the reverse-lookup, getting table names and the keys.
* For each view name and key pair: remove the entry identified by the key from the associated view.
* Depending on the type of message that was deleted (e.g. a `post/join`, `post/leave`,
  `post/info`), reindex the relevant views in case they now have outdated accreted information.
  This can typically be done by fetching the latest relevant hash (e.g. using the channel-state
  view, or the author view to figure out the newest `post/join` or `post/leave` that's in the
  database), getting its data, and reindexing the view with that data. If the data is already
  indexed it does no harm, and otherwise the index becomes up to date.

##### Deletion
Deleting a previously stored delete request, at least as a result of a newer delete request
targeting the older delete request, is currently not considered a valid operation.

<!--
When we "delete a delete" we are essentially forgetting about a previous delete
request, "undeleting" content and potentially letting it stream back in if
someone has yet to delete it. This can mechanistically be achieved by issuing a
delete request for a delete request, v sneaky!

When we delete the corresponding hash (of the delete request itself), the following operations take place:

Get the delete message payload from:

    <hash> -> <blob>

Then delete `<hash>` of delete message itself from:

    <hash> -> <blob>

Using the delete message payload, "forget" that we deleted the pointed-to post
hash (this is the hash inside the delete payload, *not* the hash of the delete
payload - tricky!):

    !chat!deleted!<hash.16> -> 1

Get the view key using <hash>:

    !<hash.16>!<mono-ts> => "author<separator>author!<pubkey>!1!<mono-ts>"

Delete entry in view using retrieved key:
    
    !author!<pubkey>!1!<mono-ts> -> <hash> // post/delete
-->

#### post/info (`post_type=2`)
##### Creation
A post/info (`post_type=2`) is written, meaning a hash is mapped to a binary
payload and persisted in the database.

The following tables are updated:

    <hash> -> <blob>
    !author!<pubkey>!2!<mono-ts> -> <hash> // post/info
    !state!nick!<channel>!<mono-ts>!<pubkey> -> <hash>
    !user!info!name!<pubkey>!<mono-ts> => latest post/info setting nickname property ??

To be able to remove these entries later on, for example when a new post/info
is written, we need to know which keys are mapped to that hash for each indexed
view.  We save the following entries in the reverse-hash lookup:

    !<hash.16>!<mono-ts> => "author<separator>author!<pubkey>!2!<mono-ts>"
    !<hash.16>!<mono-ts> => "state<separator>state!nick!<channel>!<mono-ts>!<pubkey>"
    !<hash.16>!<mono-ts> => "user<separator>user!info!name!<pubkey>!<mono-ts>"

##### Deletion
When we delete the corresponding hash, the following operations take place:

Delete `<hash>` from:

    <hash> -> <blob>

Get each view key using <hash>:

    !<hash.16>!<mono-ts> => "author<separator>author!<pubkey>!2!<mono-ts>"
    !<hash.16>!<mono-ts> => "state<separator>state!nick!<channel>!<mono-ts>!<pubkey>"
    !<hash.16>!<mono-ts> => "user<separator>user!info!name!<pubkey>!<mono-ts>"

Delete entry in view using retrieved key:
    
    !author!<pubkey>!2!<mono-ts>
    !state!nick!<channel>!<mono-ts>!<pubkey> -> <hash>
    !user!info!name!<pubkey>!<mono-ts>

#### post/topic (`post_type=3`)
##### Creation
A post/topic (`post_type=3`) is written, meaning a hash is mapped to a binary
payload and persisted in the database.

The following tables are updated:

    <hash> -> <blob>
    !channel!topic!<channel> -> <topic>
    !state!topic!<channel>!<mono-ts> -> <hash>
    !author!<pubkey>!3!<mono-ts> -> <hash> // post/topic

To be able to remove these entries later on, for example when a new post/info
is written, we need to know which keys are mapped to that hash for each indexed
view.  We save the following entries in the reverse-hash lookup:

    !<hash.16>!<mono-ts> => "author<separator>author!<pubkey>!3!<mono-ts>"
    !<hash.16>!<mono-ts> => "state<separator>state!topic!<channel>!<mono-ts>"

##### Updating
When a new post/topic comes in, we'll need to update indexes.

Index the new message:

    !author!<pubkey>!3!<mono-ts> -> <hash> // post/topic

Update the latest channel state to point to the new hash:

    !state!topic!<channel>!<mono-ts> -> <hash>

Update the topic index for the channel, setting the new topic:

    !channel!topic!<channel> -> <topic>

Add new reverse-lookup entries:

    !<hash.16>!<mono-ts> => "author<separator>author!<pubkey>!3!<mono-ts>"
    !<hash.16>!<mono-ts> => "state<separator>state!topic!<channel>!<mono-ts>"

##### Deletion
When we delete the corresponding hash, the following operations take place:

Delete `<hash>` from:

    <hash> -> <blob>

Get each view key using <hash>:

    !<hash.16>!<mono-ts> => "author<separator>author!<pubkey>!3!<mono-ts>"
    !<hash.16>!<mono-ts> => "state<separator>state!topic!<channel>!<mono-ts>"

Delete entry in view using retrieved key:
    
    !state!topic!<channel>!<mono-ts> -> <hash>
    !author!<pubkey>!3!<mono-ts> -> <hash> // post/topic

Get the most recent topic message for this channel:

    !state!topic!<channel>!<mono-ts> -> <hash> // post/topic
    <hash> -> <blob>

If there is such a latest message left in the database. If there is,
update the accreted topic for that channel accordingly:

    !channel!topic!<channel> -> <topic>

#### post/join (`post_type=4`) and post/leave (`post_type=5`) 
##### Creation
A post/join (`post_type=4`) is written, meaning a hash is mapped to a binary
payload and persisted in the database.

The following tables are updated:

    <hash> -> <blob>
    !state!member!<channel>!<mono-ts>!<pubkey> -> <hash>
    !channel!member!<channel>!<pubkey> -> 1
    !author!<pubkey>!4!<mono-ts> -> <hash> // post/join

    !author!<pubkey>!5!<mono-ts> -> <hash> // if post/leave

To be able to remove these entries later on, for example when a new post/info
is written, we need to know which keys are mapped to that hash for each indexed
view.  We save the following entries in the reverse-hash lookup:

    !<hash.16>!<mono-ts> => "author<separator>author!<pubkey>!4!<mono-ts>"
    !<hash.16>!<mono-ts> => "state<separator>state!member!<channel>!<mono-ts>!<pubkey>"

    for post/leave: !<hash.16>!<mono-ts> => "author<separator>author!<pubkey>!5!<mono-ts>" 

##### Updating
When a channel membership change happens, i.e. a post/leave for the same
channel as the previous post/join, we'll need to update indexes.

Index the new message:

    !author!<pubkey>!4!<mono-ts> -> <hash> // if post/join

    !author!<pubkey>!5!<mono-ts> -> <hash> // if post/leave

Update the latest channel state to point to the new hash:

    !state!member!<channel>!<mono-ts>!<pubkey> -> <hash>

Update the membership view:

    !channel!member!<channel>!<pubkey> -> 1 // if post/join

    !channel!member!<channel>!<pubkey> -> 0 // if post/leave

Add new reverse-lookup entries:

    !<hash.16>!<mono-ts> => "author<separator>author!<pubkey>!4!<mono-ts>"
    !<hash.16>!<mono-ts> => "state<separator>state!member!<channel>!<mono-ts>!<pubkey>"

    for post/leave: !<hash.16>!<mono-ts> => "author<separator>author!<pubkey>!5!<mono-ts>" 

##### Deletion
When we delete the corresponding hash, the following operations take place:

Delete `<hash>` from:

    <hash> -> <blob>

Get each view key using <hash>:

    !<hash.16>!<mono-ts> => "author<separator>author!<pubkey>!4!<mono-ts>"
    !<hash.16>!<mono-ts> => "state<separator>state!member!<channel>!<mono-ts>!<pubkey>"

    for post/leave: !<hash.16>!<mono-ts> => "author<separator>author!<pubkey>!5!<mono-ts>" 

Using the view key, splice out the channel name.

Delete entry in view using retrieved key:
    
    !channel!member!<channel>!<pubkey>
    !author!<pubkey>!4!<mono-ts>

Get all the most recent membership messages for this user:

    !author!<pubkey>!4!<mono-ts> -> <hash> // post/join
    !author!<pubkey>!5!<mono-ts> -> <hash> // post/leave
    <hash> -> <blob>

Sort the list of entries and pick the latest {join, leave} for the target
channel, if there is such a latest message left in the database. If there is,
update the channel membership for that channel accordingly:

    !channel!member!<channel>!<pubkey> -> 1 or 0
