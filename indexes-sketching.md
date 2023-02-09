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

```
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

The following entries try to map each cable request to what kind of database index operations
will suffice to correctly answer the request. It's a form of sketching / thinking out loud that
helps to identify holes ahead of time, before views have been written.

#### Answer a channel list request

Query:

    !channel!<channel>!member!<pubkey> -> 1 or 0

Use the retrieved keys to extract a list of channel names, and convert the list into the set of
known channel names. Then convert the set back into a list and stable sort it.

#### Answer a channel time range request

Query:

    !chat!text!<channel>!<ts> -> <hash>

Use the request's specified start and end time ranges, and the limit option, when querying to get the correct range
of data. Answer with the list of hashes in a hash response.

#### Answer a channel state request

Query:

        !state!<channel>!member!<pubkey> -> <hash>
        !state!<channel>!nick!<pubkey> -> <hash>
        !state!<channel>!topic -> <hash>

Using the request's channel name. the query range should span any public keys, which are only part
of the key to provide unique records that only point to the latest hash. Answer with the list of
hashes that are retrieved from executing the query.

#### Answer a request by hash

Query:

    hash to binary blob view

Use the returned binary payloads, i.e. cablegrams, to fashion the data response.

#### Honor a delete request

A delete request is only valid if:

1. the requester is regarded as a moderator or admin by the local user, or
2. the requester is requesting to delete posts they have authored themselves 
    * i.e. public key of the delete/post payload and the post identified by the requested hash
      are the same.

And in all cases: the cryptographic signature of the post/delete payload must be correct.

Honor the delete request by removing the associated payload from:

    hash to binary blob view

Persist the post/delete cablegram by saving the binary payload:

    hash to binary blob view

and persist the hash of the post/delete cablegram in the posts view:

    !chat!text!<channel>!<ts> -> <hash>

Finally, persist the hash identifying the deleted post, to limit future attempts to resync this
post, by making an entry in:

    !chat!delete!<hash> -> 1
