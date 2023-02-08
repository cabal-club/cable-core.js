# database index + view sketching 

on accreted state vs cable protocol mappings:

some indexes are useful primarily for application level concerns (accreted
state). others are useful primarily for protocol queries (protocol mappings)

instead of a generalized counter, use claimed timestamp? 

otherwise: how do we store, retrieve and update counters? are there significant attacks that
become possible if we prefer using timestamps over monotonic counters?  otherwise i could use
an instance of monotonic-timestamp to use as a generalized counter? could be confusing X)


the tradeoff for designing these indexes, and as of yet still open:

is it better to:

* _not_ have to update many different indexes with basically the same data, or
    * prevents mishaps with inconsistent state! essentially only one source of truth (the posts
      themselves)
* to save computations and secondary calls to resolve hashes to posts, and then to peek inside
  posts for e.g. message type?
  * simpler data pipeline! doesn't become callback -> callback -> processing -> finally returning data to client

```
* hash to binary blob
    <hash> -> <blob>
* channel state: channel name+time to chstate-related hash
    * LATEST post/join or post/leave by <pubkey>
        !state!<channel>!member!<pubkey> -> <hash>
    * LATEST post/info for nick by <pubkey>
        !state!<channel>!nick!<pubkey> -> <hash>
    * LATEST post/topic for channel, by anyone
        !state!<channel>!topic -> <hash>
    * if fully persuing this route: include convenience method that returns the requested data,
      not only the hashes
* posts: map channel name+time to {post/text, post/delete} hash
    !chat!text!<channel>!<ts> -> <hash>
    do secondary topological sort after retrieving posts?
* pubkey to hash
    - facilitate deleting all posts authored by pubkey
    - have some type of counter to keep keys unique? otherwise can only map one pubkey to one hash
    - or ts (of message, or of receive time)
    !author!<pubkey>!<counter> -> <hash>
* channel topic:
    !channel!<channel>!topic -> <topic>
    now subsumed by channel state view? doesn't give us topic name without parsing though
* channel membership:
    !channel!<channel>!member!<pubkey> -> 1 or 0
    might be subsumed by channel state view? doesn't give us joined or left without parsing though
? somehow map pubkey to different message types
    in particular channel/join||leave, post/info (nickname)

    one schema:
        !user!<pubkey>!member!<channel> => {post/join, post/leave} hash
        !user!<pubkey>!info!name => latest post/info setting nickname property
        !user!<pubkey>!info!<property> in general

    cabal-core user schema:
        user!about!<pubkey>
```
