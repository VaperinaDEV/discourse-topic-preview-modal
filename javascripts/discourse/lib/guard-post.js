// Post-component callbacks sometimes receive something other than a
// post record. Returns the record, or null if it isn't one.
export function guardPost(post) {
  if (post && typeof post === "object" && (post.id || post.post_number)) {
    return post;
  }
  return null;
}
