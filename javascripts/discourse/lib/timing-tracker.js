import { ajax } from "discourse/lib/ajax";

export default class TopicPreviewTimingTracker {
  #component;
  #visiblePosts = new Set();
  #lastFlush = Date.now();
  #timer = null;

  constructor(component) {
    this.#component = component;
  }

  // HEAD + Discourse-Track-View is required to increment the server view count.
  trackView() {
    const component = this.#component;

    ajax(`/t/${component.topicId}.json`, {
      type: "HEAD",
      dataType: "text",
      headers: { "Discourse-Track-View": "true" },
      data: { track_visit: true },
    }).catch(() => {
      // Non-critical.
    });
  }

  markVisible(postNumber) {
    this.#visiblePosts.add(postNumber);
  }

  start() {
    if (this.#timer || !this.#component.currentUser) {
      return;
    }

    this.#timer = setInterval(() => this.flush(), 5000);
  }

  // Flush once more when the modal closes so trailing read time is preserved.
  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    this.flush();
  }

  async flush() {
    const component = this.#component;

    if (!component.currentUser || !this.#visiblePosts.size) {
      this.#lastFlush = Date.now();
      return;
    }

    const now = Date.now();
    const elapsed = Math.min(now - this.#lastFlush, 60000);
    this.#lastFlush = now;

    const timings = {};
    this.#visiblePosts.forEach((n) => (timings[n] = elapsed));
    this.#visiblePosts.clear();

    try {
      await ajax("/topics/timings", {
        type: "POST",
        data: {
          topic_id: component.topicId,
          topic_time: elapsed,
          timings,
        },
      });

      const flushedPostNumbers = Object.keys(timings).map(Number);
      const maxFlushedPost = Math.max(...flushedPostNumbers);

      if (
        maxFlushedPost > (component.topicModel?.last_read_post_number || 0)
      ) {
        component.topicModel?.set?.(
          "last_read_post_number",
          maxFlushedPost
        );

        const topic = component.topic;
        const highest = Math.max(
          topic?.highest_post_number || 0,
          component.topicModel?.highest_post_number || 0,
          maxFlushedPost
        );
        const remainingUnread = Math.max(0, highest - maxFlushedPost);

        if (topic) {
          if (typeof topic.set === "function") {
            topic.setProperties({
              last_read_post_number: maxFlushedPost,
              unread_posts: remainingUnread,
              unread: remainingUnread,
              new_posts:
                remainingUnread === 0 ? 0 : (topic.new_posts || 0),
              unseen: false,
            });
          } else {
            topic.last_read_post_number = maxFlushedPost;
            topic.unread_posts = remainingUnread;
            topic.unread = remainingUnread;

            if (remainingUnread === 0) {
              topic.new_posts = 0;
            }

            topic.unseen = false;
          }
        }

        // Keep the tracking state in sync with the topic-list record.
        component.topicTrackingState?.modifyStateProp?.(
          component.topicId,
          "last_read_post_number",
          maxFlushedPost
        );
      }

      // Mark posts read on the models this modal owns directly, rather than
      // borrowing controller:topic (that controller also drives the page
      // behind the modal, so swapping its model would re-arg the whole page
      // tree on every flush).
      if (component.isNestedView) {
        component.nested?.readPosts?.(flushedPostNumbers);
      } else {
        for (const post of component.topicModel?.postStream?.posts ?? []) {
          if (!post.read && flushedPostNumbers.includes(post.post_number)) {
            post.set?.("read", true);
          }
        }
      }
    } catch {
      // Retry on the next visibility cycle.
    }
  }
}
