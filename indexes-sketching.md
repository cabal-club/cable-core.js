# database index + view sketching 

on accreted state vs cable protocol mappings:

some indexes are useful primarily for application level concerns (accreted
state). others are useful primarily for protocol queries (protocol mappings)


on unique records:

we can either use a generalized counter, or timestamp.

q: how do we store, retrieve and update counters? are there significant attacks that become
possible if we prefer using timestamps over monotonic counters?  could use an instance of
monotonic-timestamp to use as a generalized counter? might be confusing if new to the codebase
tho X)


the tradeoff for designing these indexes, and as of yet still open, is it better to...:

* _not_ have to update many different indexes with basically the same data (hashes)
    * prevents mishaps with inconsistent state! essentially only one source of truth (the posts
      themselves)
* or: have multiple views over the same data to save computations and secondary calls to
  resolve hashes to posts, and then to peek inside posts for e.g. message type?
  * simpler data pipeline! doesn't become callback -> callback -> processing -> finally returning data to client

the following bullet points describe the different views / indexes under consideration atm to
service both consumers of cable-core as well as incoming and outgoing cable req/res


<!-- TODO (2023-02-09): view keeping track of / associating reqid needed -->
<!-- TODO (2023-02-09): view keeping track of / associating circuits? or memory only -->

```
*reqid (WIP)
    reqid -> {source (msg type), expects (msg type), origin (local or remote), circuitid}

    a reqid always belongs to a request or to a response caused by a request. thus a reqid has
    a source (the message type that "spawns" the request) and an expectation of what to get
    back (the message type that correctly answers the request e.g. a data response, a hash
    response, or a channel list response). we can also prepare for the circuits behaviour by
    adding an id field so that we can more efficiently route messages, instead of floodfilling
    to all connected peers.

    when we receive a request, we log the reqid with:
    * source (the message type of the request)
    * expects (the expected message type of the response)
    * origin (are we the end destination for the returning response, or are we passing on
      information between other nodes)
    * circuitid (which connected node to send the response to)

    when we receive a response we look up the reqid:

    * is the response of the expected message type? (if not: throw it out)
    * are the /contents/ of the response what was requested? (if not:
      throw it out)
        * example: sending a bunch of post/topic as a response to a channel time range
          (post/text + post/delete) is incorrect behaviour (?)
* how do we update tables when a hash has been deleted? reverse lookup table hash -> view-key-name?
    !<hash>!<viewname>!<viewkey>! = 1
    alternative scheme:
    !<hash>!<monotonic-timestamp> => "<viewname>:<viewkey>"
* hash to binary blob
    <hash> -> <blob>
* channel state: map channel name + unique identifier to chstate-related hash
    * LATEST post/join or post/leave by <pubkey>
        !state!<channel>!member!<pubkey> -> <hash>
    * LATEST post/info for nick by <pubkey>
        !state!<channel>!nick!<pubkey> -> <hash>
    * LATEST post/topic for channel, by anyone
        !state!<channel>!topic -> <hash>
    * if fully persuing this route: include convenience method that returns cablegram pointed
      to by hash, in addition to methods that only return a list of hashes
    note: this does not handle the case of answering a historic (give all history you have) channel state req
* posts: map channel name+time to {post/text, post/delete} hash
    !chat!text!<channel>!<ts> -> <hash>
    do secondary topological sort after retrieving posts?
* deletions:
    !chat!delete!<hash> -> 1
    persist deletions to prevent resyncing deleted posts. remove this entry to enable resyncing
    the corresponding hash
* pubkey to hash: map all posts in database made by a specific pubkey
    !author!<pubkey>!<counter> -> <hash>
    - facilitate deleting all posts authored by pubkey
    - have some type of counter to keep keys unique? otherwise can only map one pubkey to one hash
    - or ts (from cablegram, or of receive time)

    tweaked alternative:
    !author!<pubkey>!<post_type-id>!<counter> -> <hash>
* channel topic:
    !channel!<channel>!topic -> <topic>
    now subsumed by channel state view? doesn't give us topic name without parsing though
* channel membership:
    !channel!<channel>!member!<pubkey> -> 1 or 0
    * might be subsumed by channel state view? doesn't give us joined or left without parsing though
    * i guess the stable sorted set of <channel> names, derive from keys of this view, are what we
      would respond with to answer a channel list request?
? do we need to somehow map pubkey to different message types?
    in particular channel/join||leave, post/info (nickname)

    one schema for users:
        !user!<pubkey>!member!<channel> => {post/join, post/leave} hash
        !user!<pubkey>!info!name => latest post/info setting nickname property
        !user!<pubkey>!info!<property> in general

    cabal-core user schema:
        user!about!<pubkey>
```

## Brainstorming & verifying index sufficiency

The following sections try to map each cable request to what kind of database index operations
will suffice to correctly answer the request. Intended as a form of sketching / thinking out loud that
helps to identify gaps ahead of time, before views have been written.

### Mapping requests to their expected returned message types

<!-- 
    might need views to handle the following cases:

    * track requested hashes (and check against hashes of response payloads)
    * track & verify results from life cycle of:
        <some channel request> -> hash response, which causes -> request by hash -> data response
        [                  one reqid                        ]    [         another reqid        ]

-->

### Request by hash

Request by hash expects:

* data response `msg_type=1`
* data payloads to correspond to the requested hashes
    * verify by tracking the requested hashes and cross-referencing with the hash of each
      post in the data response payload

#### Channel time range request

Channel time range expects:

* hash response `msg_type=0`
* data payloads to be of type:
    * post/text
    * post/delete

#### Channel state request

Channel state expects:

* hash response `msg_type=0`
* data response payloads to be of type:
    * post/topic
    * post/join
    * post/leave
    * post/info

#### Channel list request

Channel list expects:

* a channel list response `msg_type=7`
* payloads to be UTF-8 strings.

### Answering requests

#### Answer a request by hash (`msg_type = 2`)
A request by hash wants the data identified by a list of hashes.

Query:

    hash to binary blob view

Use the returned binary payloads, i.e. cablegrams, to fashion the data response. Construct a
list and fill it with the payloads that were found when querying the view.

#### Answer a channel time range request (`msg_type = 4`)

Query:

    !chat!text!<channel>!<ts> -> <hash>

Use the request's specified start and end time ranges, and the limit option, when querying to get the correct range
of data. Answer with the list of hashes in a hash response.

#### Answer a channel state request (`msg_type = 5`)

Query:

        !state!<channel>!member!<pubkey> -> <hash>
        !state!<channel>!nick!<pubkey> -> <hash>
        !state!<channel>!topic -> <hash>

using the request's channel name. The query range should operate regardless of the public key portion
of view key, which are only part of the key to provide unique records that point to the entry.

#### Answer a _historic_ channel state request (`msg_type = 5`)
A historic channel state request is a request that sets `historic = 1`.

Query:

    !channel!<channel>!member!<pubkey> -> 1 or 0

Using the request's channel name. Use the returned results to derive a list of
all public keys related to the channel. 

Then, using the list of public keys, for each public key query:

    !author!<pubkey>!2!<counter> -> <hash> // post/info
    !author!<pubkey>!3!<counter> -> <hash> // post/topic
    !author!<pubkey>!4!<counter> -> <hash> // post/join
    !author!<pubkey>!5!<counter> -> <hash> // post/leave

To get the hashes for all the channel state-related messages.

Answer with the list of hashes that are retrieved from executing the query.

#### Answer a channel list request (`msg_type = 6`)

Query:

    !channel!<channel>!member!<pubkey> -> 1 or 0

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

    hash to binary blob view

2) Persist the post/delete cablegram by saving the binary payload in: 

    hash to binary blob view

3) Persist the hash of the post/delete cablegram in the posts view:

    !chat!text!<channel>!<ts> -> <hash>

4) Finally, persist the hash identifying the deleted post, to limit future attempts to resync this
post, by making an entry in:

    !chat!delete!<hash> -> 1

### Updating the database indices

Each time a view has a new entry added which maps to a hash, add a new entry to
the reverse lookup table:

    !<hash>!<monotonic-timestamp> => "<viewname>:<viewkey>"

    sometimes written below using a different scheme as e.g:

    !<hash>!view-chat!text!<channel>!<ts> -> 1

The following sections depict the indexing actions that spring forth when a new
post is added to the database, and how to update the database when the
underlying post is deleted from the database.

#### post/text (`post_type=0`)
##### Creation
A post/text (`post_type=0`) is written, meaning a hash is mapped to a binary
payload and persisted in the database.

The following tables are updated:

    hash to binary blob view
    !chat!text!<channel>!<ts> -> <hash>
    !author!<pubkey>!0!<counter> -> <hash> // post/text

To be able to remove these entries later on, for example when a delete request
comes in, we need to know which keys are mapped to that hash for each indexed
view.  We save the following entries in the reverse-hash lookup:

    !<hash>!view-chat!text!<channel>!<ts> -> 1
    !<hash>!view-author!<pubkey>!1!<counter> -> 1

##### Deletion
When we delete the corresponding hash, the following operations take place:

Delete <hash> from:

    hash to binary blob view

Get each view key using <hash>:

    !<hash>!view-chat!text!<channel>!<ts> -> 1
    !<hash>!view-author!<pubkey>!1!<counter> -> 1

Delete entry in view using retrieved key:
    
    !chat!text!<channel>!<ts> -> <hash>
    !author!<pubkey>!1!<counter> -> <hash> // post/text

If this delete was from a delete request (post/delete), also persist the delete
by saving the hash of the deleted post:

    !chat!delete!<hash> -> 1

#### post/delete (`post_type=1`)
##### Creation
This one is a bit tricky to think about correctly. When a `post/delete` is
created, this necessitates deleting what it points to as well

First: perist the cablegram as usual; a post/delete (`post_type=1`) is written,
meaning a hash is mapped to a binary payload and persisted in the database.

The following tables are updated:

    hash to binary blob view
    !chat!delete!<hash> -> 1
    !author!<pubkey>!1!<counter> -> <hash> // post/topic

To be able to remove these entries later on, for example if a delete should be
reverted, we need to know which keys are mapped to that hash for each indexed
view.  We save the following entries in the reverse-hash lookup:

    !<hash>!view-author!<pubkey>!1!<counter> -> 1

Now: time to delete the pointed to content:

* Use the hash to delete the payload from: hash to binary blob view
* Look up the hash to be deleted in the reverse-lookup, getting table names and the keys.
* For each view name and key pair: remove the entry identified by the key from the associated view.

**Note:** if the affected view was !state then query to figure out what the replacement entry should be. 
Is it better not to have the latest view? Instead just have !state! index all
the hashes it cares about, when doing a non-historic query grab the latest
entries somehow? It would spare us this special-case "find the previous latest
hash for <view>" replenishment logic.

##### Deletion
When we "delete a delete" we are essentially forgetting about a previous delete
request, "undeleting" content and potentially letting it stream back in if
someone has yet to delete it. This can mechanistically be achieved by issuing a
delete request for a delete request, v sneaky!

When we delete the corresponding hash (of the delete request itself), the following operations take place:

Get the delete message payload from:

    hash to binary blob view

Then delete <hash> of delete message itself from:

    hash to binary blob view

Using the delete message payload, "forget" that we deleted the pointed-to post
hash (this is the hash inside the delete payload, *not* the hash of the delete
payload - tricky!):

    !chat!delete!<hash> -> 1

Get the view key using <hash>:

    !<hash>!view-author!<pubkey>!1!<counter> -> 1

Delete entry in view using retrieved key:
    
    !author!<pubkey>!1!<counter> -> <hash> // post/topic

#### post/info (`post_type=2`)
##### Creation
A post/info (`post_type=2`) is written, meaning a hash is mapped to a binary
payload and persisted in the database.

The following tables are updated:

    hash to binary blob view
    !author!<pubkey>!2!<counter> -> <hash> // post/topic
    !state!<channel>!nick!<pubkey> -> <hash>
    !user!<pubkey>!info!name => latest post/info setting nickname property ??

To be able to remove these entries later on, for example when a new post/info
is written, we need to know which keys are mapped to that hash for each indexed
view.  We save the following entries in the reverse-hash lookup:

    !<hash>!view-author!<pubkey>!2!<counter> -> 1
    !<hash>!view-state!<channel>!nick!<pubkey> -> 1
    !<hash>!view-user!<pubkey>!info!name -> 1

##### Deletion
When we delete the corresponding hash, the following operations take place:

Delete <hash> from:

    hash to binary blob view

Get each view key using <hash>:

    !<hash>!view-author!<pubkey>!2!<counter> -> 1
    !<hash>!view-state!<channel>!nick!<pubkey> -> 1
    !<hash>!view-user!<pubkey>!info!name -> 1

Delete entry in view using retrieved key:
    
    !author!<pubkey>!2!<counter>
    !state!<channel>!nick!<pubkey>
    !user!<pubkey>!info!name

#### post/topic (`post_type=3`)
##### Creation
A post/topic (`post_type=3`) is written, meaning a hash is mapped to a binary
payload and persisted in the database.

The following tables are updated:

    hash to binary blob view
    !channel!<channel>!topic -> <topic>
    !state!<channel>!topic -> <hash>
    !author!<pubkey>!3!<counter> -> <hash> // post/topic

To be able to remove these entries later on, for example when a new post/info
is written, we need to know which keys are mapped to that hash for each indexed
view.  We save the following entries in the reverse-hash lookup:

    !<hash>!view-state!<channel>!topic -> 1
    !<hash>!view-author!<pubkey>!3!<counter> -> 1

##### Updating
When a new post/topic comes in, we'll need to update indexes.

Index the new message:

    !author!<pubkey>!3!<counter> -> <hash> // post/topic

Update the latest channel state to point to the new hash:

    !state!<channel>!topic -> <hash>

Update the topic index for the channel, setting the new topic:

    !channel!<channel>!topic -> <topic>

Add new reverse-lookup entries:

    !<hash>!view-state!<channel>!topic -> 1
    !<hash>!view-author!<pubkey>!3!<counter> -> 1

**Note:** There is a conflict in the latest table + reverse-lookup. We need special logic
to handle the case of someone deleting the hash regarded as latest.

##### Deletion
When we delete the corresponding hash, the following operations take place:

Delete <hash> from:

    hash to binary blob view

Get each view key using <hash>:

    !<hash>!view-state!<channel>!topic -> 1
    !<hash>!view-author!<pubkey>!3!<counter> -> 1

Delete entry in view using retrieved key:
    
    !state!<channel>!topic -> <hash>
    !author!<pubkey>!3!<counter> -> <hash> // post/topic

#### post/join (`post_type=4`) and post/leave (`post_type=5`) 
##### Creation
A post/join (`post_type=4`) is written, meaning a hash is mapped to a binary
payload and persisted in the database.

The following tables are updated:

    hash to binary blob view
    !state!<channel>!member!<pubkey> -> <hash>
    !channel!<channel>!member!<pubkey> -> 1
    !author!<pubkey>!4!<counter> -> <hash> // post/topic

To be able to remove these entries later on, for example when a new post/info
is written, we need to know which keys are mapped to that hash for each indexed
view.  We save the following entries in the reverse-hash lookup:

    !<hash>!view-state!<channel>!member!<pubkey> -> 1
    !<hash>!view-author!<pubkey>!4!<counter> -> 1

##### Updating
When a channel membership change happens, i.e. a post/leave for the same
channel as the previous post/join, we'll need to update indexes.

Index the new message:

    !author!<pubkey>!4!<counter> -> <hash> // post/topic

Update the latest channel state to point to the new hash:

    !state!<channel>!member!<pubkey> -> <hash>

Update the membership view:

    !channel!<channel>!member!<pubkey> -> 0

Add new reverse-lookup entries:

    !<hash>!view-state!<channel>!member!<pubkey> -> 1
    !<hash>!view-author!<pubkey>!4!<counter> -> 1

**Note:** There is a conflict in the latest table + reverse-lookup. We need special logic
to handle the case of someone deleting the hash regarded as latest.

##### Deletion
When we delete the corresponding hash, the following operations take place:

Delete <hash> from:

    hash to binary blob view

Get each view key using <hash>:

    !<hash>!view-state!<channel>!member!<pubkey> -> 1
    !<hash>!view-author!<pubkey>!4!<counter> -> 1

Using the view key, splice out the channel name.

Delete entry in view using retrieved key:
    
    !channel!<channel>!member!<pubkey>
    !author!<pubkey>!4!<counter>

Get all the most recent membership messages for this user:

    !author!<pubkey>!4!<counter> -> <hash> // post/topic
    !author!<pubkey>!5!<counter> -> <hash> // post/topic
    hash to binary blob view

Sort the list of entries and pick the latest {join, leave} for the target
channel, if there is such a latest message left in the database. If there is,
update the channel membership for that channel accordingly:

    !channel!<channel>!member!<pubkey> -> 1 or 0
