// Matches Discourse topic URLs: /t/slug/123, /t/123, /t/slug/123/7, /t/-/123/7 …
// Capture groups: (slug?)(id)(postNumber?)
const TOPIC_URL_RE = /^\/t\/(?:([^/]+)\/)?(\d+)(?:\/(\d+))?/;

// Parses a pathname (no origin/query/hash) into { topicId, slug, postNumber }
// or null if it isn't a topic URL. slug/postNumber are null when absent.
export function matchTopicLink(pathname) {
  const match = pathname?.match(TOPIC_URL_RE);
  if (!match) {
    return null;
  }
  return {
    slug: match[1] || null,
    topicId: parseInt(match[2], 10),
    postNumber: match[3] ? parseInt(match[3], 10) : null,
  };
}
