import { ajax } from "discourse/lib/ajax";

export default class TopicPreviewTimingTracker {
  #component;
  #visiblePosts = new Set();
  #lastFlush = Date.now();
  #timer = null;

  constructor(component) {
    this.#component = component;
  }

  // Server only increments view count on requests carrying
  // Discourse-Track-View.
  trackView() {
    const component = this.#component;
    ajax(`/t/${component.topicId}.json`, {
      type: "HEAD",
      dataType: "text",
      headers: { "Discourse-Track-View": "true" },
      data: { track_visit: true },
    }).catch(() => {
      // non-critical
    });
  }

  markVisible(postNumber) {
    this.#visiblePosts.add(postNumber);
  }

  // Idempotent: safe to call every time currentUser becomes available.
  start() {
    if (this.#timer || !this.#component.currentUser) {
      return;
    }
    this.#timer = setInterval(() => this.flush(), 5000);
  }

  // Stops the interval and performs one last flush so trailing read-time
  // isn't lost when the modal closes.
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
        data: { topic_id: component.topicId, topic_time: elapsed, timings },
      });

      const flushedPostNumbers = Object.keys(timings).map(Number);
      const maxFlushedPost = Math.max(...flushedPostNumbers);

      if (
        maxFlushedPost > (component.topicModel?.last_read_post_number || 0)
      ) {
        component.topicModel?.set?.("last_read_post_number", maxFlushedPost);

        // component.model does not exist on this component (Glimmer
        // components only expose args as this.args, not this.model), so
        // component.model?.topic was always undefined and this whole block
        // was silently skipped. component.topic is the existing getter
        // (this.args.model.topic) - it's the exact Topic instance that
        // click.gjs pulled off the topic-list-item outlet, i.e. the same
        // object the row's badge is bound to. Mutating it here is what
        // actually clears the badge on the list; topicTrackingState below
        // does NOT drive that badge, it only feeds header/category counts.
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
              new_posts: remainingUnread === 0 ? 0 : (topic.new_posts || 0),
            });
          } else {
            topic.last_read_post_number = maxFlushedPost;
            topic.unread_posts = remainingUnread;
            topic.unread = remainingUnread;
            if (remainingUnread === 0) {
              topic.new_posts = 0;
            }
          }
        }

        // Keeps topicTrackingState's own entry in sync (header unread
        // count, category pages, etc.) - separate from the topic-list
        // badge fixed above.
        component.topicTrackingState?.modifyStateProp?.(
          component.topicId,
          "last_read_post_number",
          maxFlushedPost
        );
      }

      if (component.topicController) {
        const originalModel = component.topicController.model;
        component.topicController.set("model", component.topicModel);

        component.topicController.readPosts?.(
          component.topicId,
          flushedPostNumbers
        );

        component.topicController.set("model", originalModel);
      }
    } catch {
      // next visibility cycle will retry
    }
  }
}
