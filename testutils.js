const constants = require("cable.js/constants")
const cable = require("cable.js/index.js")
function assertBufType (t, buf, postType) {
  const desc = getDescriptiveType(t, postType)
  t.equal(cable.peekPost(buf), postType, `expected ${desc}`)
}

function assertPostType(t, obj, postType) {
  let descriptiveType = getDescriptiveType(t, postType)
  t.equal(obj.postType, postType,  `post type should be ${descriptiveType}`)
}

function testPostType (t, core, postBuf, postType, next) {
  t.ok(postBuf, "post buffer should be not null")

  const hash = core.hash(postBuf)
  t.ok(hash, "hash should be not null")

  const initialObj = cable.parsePost(postBuf)
  assertPostType(t, initialObj, postType)

  // TODO (2023-03-08): big switch that checks all properties that should exist do exist

  core.store.getData([hash], (err, data) => {
    t.error(err, "getting data for persisted hash should work")
    t.ok(data, "data should be not null")
    t.equal(data.length, 1, "should only return one result when querying one hash")
    const storedBuf = data[0]
    const hashedData = core.hash(storedBuf)
    t.deepEqual(hashedData, hash, "data put into store and retrieved from store should have identical hashes")

    const retrievedObj = cable.parsePost(storedBuf)
    t.ok(retrievedObj, "returned post should be parsed correctly")
    assertPostType(t, retrievedObj, postType)
    t.deepEqual(retrievedObj, initialObj, "parsed bufs should be identical")
    next()
  })
}

function getDescriptiveType(t, postType) {
  let descriptiveType = ""
  switch (postType) {
    case constants.TEXT_POST:
      descriptiveType = "post/text"
      break
    case constants.DELETE_POST:
      descriptiveType = "post/delete"
      break
    case constants.INFO_POST:
      descriptiveType = "post/info"
      break
    case constants.TOPIC_POST:
      descriptiveType = "post/topic"
      break
    case constants.JOIN_POST:
      descriptiveType = "post/join"
      break
    case constants.LEAVE_POST:
      descriptiveType = "post/leave"
      break
    default:
      t.fail(`unknown post type (${postType})`)
  }
  return descriptiveType
}

module.exports = {
  testPostType,
  getDescriptiveType,
  assertBufType,
  assertPostType
}
