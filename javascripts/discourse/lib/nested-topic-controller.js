import { tracked } from "@glimmer/tracking";
import { ajax } from "discourse/lib/ajax";
import { popupAjaxError } from "discourse/lib/ajax-error";
import { processNestedRootResponse } from "discourse/lib/nested-topic-model";
import processNode, {
  registerPostInTopicPostStream,
} from "discourse/lib/process-node";
import Bookmark from "discourse/models/bookmark";

// Owns the nested/threaded-view post tree and keeps it in sync with
// MessageBus and nested-replies appEvents. `component` must expose:
// topic, topicId, topicModel (get/set), topicController, router, site,
// siteSettings, store, appEvents, currentUser, timingTracker,
// isDestroying, isDestroyed, resolvedTitle (set), resolvedAcceptedAnswer
// (set), canCreatePost (set), initialPositioning (set), showExtraWidgets
// (set).
export default class NestedTopicController {
  #component;

  @tracked rootNodes = [];
  @tracked opPost = null;
  @tracked sort = null;
  @tracked effectiveSort = null;
  @tracked hasMoreRoots = false;
  @tracked page = 0;
  @tracked loadingMore = false;
  @tracked pinnedPostIds = [];
  fetchedChildrenCache = new Map();
  // post_number -> Post for MessageBus updates at any tree depth.
  postRegistry = new Map();

  constructor(component) {
    this.#component = component;
  }

  handleTopicMessage(data) {
    switch (data.type) {
      case "created":
        this.handlePostCreated(data).catch(() => {});
        break;

      case "revised":
      case "rebaked":
      case "recovered":
      case "acted":
      case "read":
      case "liked":
      case "unliked":
        this.handlePostChanged(data).catch(() => {});
        break;

      case "deleted":
        this.markPostDeletedLocally(data.id);
        break;

      default:
        break;
    }
  }

  findPostById(postId) {
    for (const post of this.postRegistry.values()) {
      if (post.id === postId) {
        return post;
      }
    }
    return null;
  }

  belongsToTopic(postData) {
    const component = this.#component;
    return (
      postData?.topic_id != null &&
      String(postData.topic_id) === String(component.topicId)
    );
  }

  isActivityLogPost(postData) {
    const postTypes = this.#component.site.post_types;
    if (postData.post_type === postTypes.small_action) {
      return true;
    }
    if (postData.post_type === postTypes.whisper && postData.action_code) {
      return true;
    }
    return false;
  }

  isPostKnown(postId) {
    if (this.rootNodes.some((node) => node.post.id === postId)) {
      return true;
    }
    return !!this.findPostById(postId);
  }

  async handlePostCreated(data) {
    if (this.isPostKnown(data.id)) {
      return;
    }

    const component = this.#component;
    const topicId = component.topicId;
    let postData;
    try {
      postData = await ajax(`/posts/${data.id}.json`);
    } catch {
      return;
    }

    if (
      component.isDestroying ||
      component.isDestroyed ||
      component.topicId !== topicId ||
      !this.belongsToTopic(postData) ||
      this.isActivityLogPost(postData) ||
      this.isPostKnown(postData.id)
    ) {
      return;
    }

    const node = processNode(component.store, component.topicModel, {
      ...postData,
      children: [],
    });
    const replyTo = postData.reply_to_post_number;
    const isRoot = !replyTo || replyTo === 1;

    if (isRoot) {
      this.rootNodes = [node, ...this.rootNodes];
    } else {
      component.appEvents.trigger("nested-replies:child-created", {
        topicId,
        post: node.post,
        parentPostNumber: replyTo,
      });
    }
  }

  async handlePostChanged(data) {
    const component = this.#component;
    const topicId = component.topicId;
    let postData;
    try {
      postData = await ajax(`/posts/${data.id}.json`);
    } catch {
      return;
    }

    if (
      component.isDestroying ||
      component.isDestroyed ||
      component.topicId !== topicId ||
      !this.belongsToTopic(postData)
    ) {
      return;
    }

    const existing = this.findPostById(data.id);
    if (!existing) {
      return;
    }

    const updated = component.store.createRecord("post", postData);
    existing.updateFromPost(updated);
    if (!postData.deleted_at) {
      existing.set("deleted_post_placeholder", false);
    }
  }

  markPostDeletedLocally(postId) {
    const post = this.findPostById(postId);
    if (!post) {
      return;
    }
    post.set("deleted_at", new Date());
    post.set("deleted_post_placeholder", true);
    if (!this.#component.currentUser?.staff) {
      post.set("cooked", "");
    }
  }

  handlePostRegistered = (post) => {
    const topicId = this.#component.topicId;
    if (
      post?.post_number != null &&
      topicId != null &&
      String(post.topic?.id) === String(topicId)
    ) {
      this.postRegistry.set(post.post_number, post);
    }
  };

  handlePostUnregistered = (post) => {
    if (
      post?.post_number != null &&
      this.postRegistry.get(post.post_number) === post
    ) {
      this.postRegistry.delete(post.post_number);
    }
  };

  repairTopicRecord(topic) {
    if (!topic) {
      return;
    }

    if (topic.details && topic.details.topic !== topic) {
      topic.details.set("topic", topic);
    }

    if (topic.bookmarks?.length) {
      topic.set(
        "bookmarks",
        topic.bookmarks.map((bookmark) =>
          bookmark instanceof Bookmark ? bookmark : Bookmark.create(bookmark)
        )
      );
    }
  }

  async loadRoots({ page = 0, sort = null } = {}) {
    const component = this.#component;
    const slug = component.topicModel?.slug || component.topic.slug;
    const topicId = component.topicId;
    const resolvedSort =
      sort ||
      this.sort ||
      component.siteSettings.nested_replies_default_sort ||
      "top";

    const params = new URLSearchParams({
      page: String(page),
      sort: resolvedSort,
    });

    const data = await ajax(
      `/n/${slug || "-"}/${topicId}.json?${params.toString()}`
    );

    if (component.isDestroying || component.isDestroyed) {
      return;
    }

    const result = processNestedRootResponse({
      data,
      params: { post_number: null, context: null },
      site: component.site,
      siteSettings: component.siteSettings,
      store: component.store,
    });

    // Pagination returns bare roots without topic metadata. Only replace
    // topicModel when the result has an id/slug, or deeper fetches break.
    if (page === 0 || result.topic?.id != null) {
      component.topicModel = result.topic;
      this.repairTopicRecord(component.topicModel);

      if (
        component.topicController &&
        !component.router.currentRouteName.startsWith("topic.")
      ) {
        component.topicController.set("model", component.topicModel);
      }
    }

    if (page === 0) {
      this.opPost = result.opPost;
      this.postRegistry.clear();
    }

    if (this.opPost?.post_number != null) {
      this.postRegistry.set(this.opPost.post_number, this.opPost);
    }
    if (this.opPost && component.topicModel?.postStream) {
      registerPostInTopicPostStream(component.topicModel, this.opPost);
    }

    this.rootNodes =
      page === 0 ? result.rootNodes : [...this.rootNodes, ...result.rootNodes];
    this.page = result.page;
    this.hasMoreRoots = result.hasMoreRoots;
    this.sort = result.sort;
    this.effectiveSort = result.effectiveSort;
    this.pinnedPostIds = result.pinnedPostIds || [];
  }

  loadMoreRoots = async () => {
    if (this.loadingMore || !this.hasMoreRoots) {
      return;
    }

    const component = this.#component;
    this.loadingMore = true;
    try {
      await this.loadRoots({ page: this.page + 1, sort: this.sort });
    } finally {
      if (!component.isDestroying && !component.isDestroyed) {
        this.loadingMore = false;
      }
    }
  };

  changeSort = async (sort) => {
    if (sort === this.sort) {
      return;
    }

    const component = this.#component;
    try {
      this.loadingMore = true;
      this.fetchedChildrenCache.clear();
      await this.loadRoots({ page: 0, sort });
    } catch (e) {
      if (!component.isDestroying && !component.isDestroyed) {
        popupAjaxError(e);
      }
    } finally {
      if (!component.isDestroying && !component.isDestroyed) {
        this.loadingMore = false;
      }
    }
  };

  async finishLoad() {
    await this.loadRoots({ page: 0 });

    const component = this.#component;
    if (component.isDestroying || component.isDestroyed) {
      return;
    }

    component.resolvedTitle =
      component.topicModel?.fancy_title ?? component.topicModel?.title ?? null;
    component.resolvedAcceptedAnswer = !!component.topicModel?.accepted_answer;
    component.canCreatePost = !!component.topicModel?.details?.can_create_post;
    component.timingTracker.trackView();
    component.initialPositioning = false;
    component.showExtraWidgets = true;
  }
}
