import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { concat, fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { and, or } from "truth-helpers";
import { addObserver, removeObserver } from "@ember/object/observers";
import { getOwner } from "@ember/owner";
import { schedule } from "@ember/runloop";
import { service } from "@ember/service";
import { htmlSafe } from "@ember/template";
import PreloadStore from "discourse/lib/preload-store";
import bodyClass from "discourse/helpers/body-class";
import replaceEmoji from "discourse/helpers/replace-emoji";
import ConditionalLoadingSpinner from "discourse/components/conditional-loading-spinner";
import DButton from "discourse/components/d-button";
import DModal from "discourse/components/d-modal";
import TopicPreviewModalProgressBar from "../progress-bar";
import TopicPreviewModalProgressScrubberOverlay from "./progress-scrubber-overlay";
import AnonymousFlagModal from "discourse/components/modal/anonymous-flag";
import ChangeOwnerModal from "discourse/components/modal/change-owner";
import ChangePostNoticeModal from "discourse/components/modal/change-post-notice";
import FlagModal from "discourse/components/modal/flag";
import GrantBadgeModal from "discourse/components/modal/grant-badge";
import HistoryModal from "discourse/components/modal/history";
import PermanentlyDeleteConfirmModal from "discourse/components/modal/permanently-delete-confirm";
import RawEmailModal from "discourse/components/modal/raw-email";
import Post from "discourse/components/post";
import Nested from "discourse/components/nested";
import PostSmallAction from "discourse/components/post/small-action";
import PostTextSelection from "discourse/components/post-text-selection";
import PostFlag from "discourse/lib/flag-targets/post-flag";
import TopicPresenceDisplay from "discourse/plugins/discourse-presence/discourse/components/topic-presence-display";
import { ajax } from "discourse/lib/ajax";
import { popupAjaxError } from "discourse/lib/ajax-error";
import { clearBodyLocks } from "discourse/lib/body-scroll-lock";
import { buildQuote } from "discourse/lib/quote";
import QuoteState from "discourse/lib/quote-state";
import DiscourseURL from "discourse/lib/url";
import Composer from "discourse/models/composer";
import Draft from "discourse/models/draft";
import Bookmark from "discourse/models/bookmark";
import { Placeholder } from "discourse/models/post-stream";
import { processNestedRootResponse } from "discourse/lib/nested-topic-model";
import processNode, {
  registerPostInTopicPostStream,
} from "discourse/lib/process-node";
import { i18n } from "discourse-i18n";
import TopicPreviewServicePatches from "../../lib/topic-preview-modal/service-patches";
import TopicPreviewTimingTracker from "../../lib/topic-preview-modal/timing-tracker";
import TopicPreviewHistoryBackDismiss from "../../lib/topic-preview-modal/history-back-dismiss";
import { matchTopicLink } from "../../lib/topic-preview-modal/topic-link";
import { triggerHaptic } from "../../lib/topic-preview-modal/haptic";
import lazyImagesModifier from "../../modifiers/topic-preview-modal/lazy-images";
import createNestedPostTrackerModifier from "../../modifiers/topic-preview-modal/create-nested-post-tracker-modifier";
import createPostVisibilityModifier from "../../modifiers/topic-preview-modal/create-post-visibility-modifier";
import createLoadMoreSentinelModifier from "../../modifiers/topic-preview-modal/create-load-more-sentinel-modifier";
import createProgressTrackerModifier from "../../modifiers/topic-preview-modal/create-progress-tracker-modifier";
import createSwipeUpDismissModifier from "../../modifiers/topic-preview-modal/create-swipe-up-dismiss-modifier";

// One-time mobile hint that the native Back gesture/button closes this
// modal in place. Only shown in "gesture" mode and persisted in localStorage
// for compatibility across supported Discourse versions.
const BACK_GESTURE_HINT_SEEN_KEY =
  "discourse_topic_preview_modal.seen_back_gesture_hint";
const BACK_GESTURE_HINT_DURATION_MS = 10000;

export default class TopicPreviewModal extends Component {
  @service bookmarkApi;
  @service composer;
  @service currentUser;
  @service dialog;
  @service modal;
  @service capabilities;
  @service messageBus;
  @service appEvents;
  @service site;
  @service siteSettings;
  @service router;
  @service store;
  @service topicTrackingState;

  @tracked loading = true;
  @tracked loadingMore = false;
  @tracked loadingAbove = false;
  @tracked topicModel = null;
  @tracked initialPositioning = true;
  // True only while a jump (drag-scrub, jump-to-start/end, internal link,
  // "back to last read"...) is waiting on postStream.refresh() to actually
  // fetch posts from the server - i.e. the target wasn't already loaded.
  // Reuses the exact same skeleton-over-hidden-content mechanism as
  // initialPositioning below, so it never fights with it.
  @tracked jumpLoading = false;
  @tracked showExtraWidgets = false;

  // Nested topics use core Nested + tree endpoint instead of flat PostStream.
  @tracked nestedRootNodes = [];
  @tracked nestedOpPost = null;
  @tracked nestedSort = null;
  @tracked nestedEffectiveSort = null;
  @tracked nestedHasMoreRoots = false;
  @tracked nestedPage = 0;
  @tracked nestedLoadingMore = false;
  @tracked nestedPinnedPostIds = [];
  nestedFetchedChildrenCache = new Map();
  // post_number -> Post for MessageBus updates at any tree depth.
  // Populated via nested-replies:post-registered/unregistered appEvents
  // (same as NestedController). OP is registered manually.
  nestedPostRegistry = new Map();

  // Set once loadTopic() resolves (fresh store records may not notify getters).
  @tracked resolvedTitle = null;
  @tracked resolvedAcceptedAnswer = false;

  // First-frame render limit: cuts layout cost (network still needs forceLoad).
  @tracked renderLimit = 1;

  // Post number currently in the "active reading" band near the top of the
  // modal body, used to drive the topic-progress indicator. See
  // ../../modifiers/topic-preview-modal/create-progress-tracker-modifier.
  @tracked currentProgressPostNumber = null;

  // True while the fullscreen drag-to-jump overlay (core's real
  // TopicTimeline, reused as-is) is open. See
  // ../modal/progress-scrubber-overlay.
  @tracked scrubberOpen = false;

  // Local sub-modal so modal.show() does not close the topic-preview-modal.
  @tracked activeSubModal = null;

  // Disable dismiss while fk-d-menu / sub-modal is open (shared #modal-container).
  @tracked fkMenuOpen = false;

  // One-time "Back also closes this" hint - see #maybeShowBackGestureHint.
  @tracked showBackGestureHint = false;
  backGestureHintTimer = null;

  fkMenuObserver = null;
  fkMenuCloseTimer = null;
  subModalResolve = null;
  // Flag so modal.close patch knows this is our intentional close.
  selfInitiatedClose = false;
  topicController = null;
  originalTopicControllerModel = undefined;
  patchesRestored = false;
  servicePatches = null;
  timingTracker = null;
  historyBackDismiss = null;

  constructor() {
    super(...arguments);

    this.messageBus.subscribe(`/topic/${this.topicId}`, this.handleTopicMessage);

    // App-wide events from core NestedPost (same as NestedController#subscribe).
    this.appEvents.on(
      "nested-replies:post-registered",
      this.handleNestedPostRegistered
    );
    this.appEvents.on(
      "nested-replies:post-unregistered",
      this.handleNestedPostUnregistered
    );

    // Core components (e.g. PostBookmarkManager) read/write topic.bookmarks
    // from controller:topic. Point it at our topicModel while modal is open.
    this.topicController = getOwner(this).lookup("controller:topic");
    if (this.topicController) {
      this.originalTopicControllerModel = this.topicController.model;
    }

    // Delay loadTopic until after first paint unless PreloadStore already has data.
    if (PreloadStore.get(`topic_${this.topicId}`)) {
      this.loadTopic();
    } else {
      requestAnimationFrame(() => this.loadTopic());
    }

    let fkCheckScheduled = false;

    this.fkMenuObserver = new MutationObserver(() => {
      if (fkCheckScheduled) {
        return;
      }
      fkCheckScheduled = true;
      requestAnimationFrame(() => {
        fkCheckScheduled = false;
        if (this.isDestroying || this.isDestroyed) {
          return;
        }
        const isOpen = !!document.querySelector(
          ".fk-d-menu, .fk-d-menu-modal, .fk-d-tooltip, .pswp--open, #reply-control.open"
        );
        if (isOpen) {
          clearTimeout(this.fkMenuCloseTimer);
          this.fkMenuOpen = true;
        } else if (this.fkMenuOpen) {
          clearTimeout(this.fkMenuCloseTimer);
          this.fkMenuCloseTimer = setTimeout(() => {
            this.fkMenuOpen = false;
          }, 400);
        }
      });
    });

    this.fkMenuObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Patches modal.show/close, bookmarkApi, DiscourseURL.routeTo.
    // See ../../lib/topic-preview-modal/service-patches.js
    this.servicePatches = new TopicPreviewServicePatches(this);

    // Per-post visible-time tracking → /topics/timings.
    // See ../../lib/topic-preview-modal/timing-tracker.js
    this.timingTracker = new TopicPreviewTimingTracker(this);

    // Makes mobile edge-swipe-back close the modal in place
    // instead of navigating the underlying page. Mobile-only and gesture mode.
    // See ../../lib/topic-preview-modal/history-back-dismiss.js
    this.historyBackDismiss = new TopicPreviewHistoryBackDismiss(
      () => this.closeModal(),
      this.router
    );
    if (
      !this.capabilities.viewport.sm &&
      settings.modal_dismiss_gesture === "gesture"
    ) {
      this.historyBackDismiss.start();
      this.#maybeShowBackGestureHint();
    }

    addObserver(
      this.composer,
      "model.composeState",
      this.handleComposerStateChange
    );

    document.addEventListener("keydown", this.handleLightboxKeydown, true);
    document.addEventListener("focusin", this.handleDocumentFocusIn, true);
  }

  // Shows a one-time hint in mobile "gesture" mode that Back also closes
  // the modal. Persists via localStorage, falling back to once per session.
  #maybeShowBackGestureHint() {
    try {
      if (localStorage.getItem(BACK_GESTURE_HINT_SEEN_KEY)) {
        return;
      }
      localStorage.setItem(BACK_GESTURE_HINT_SEEN_KEY, "1");
    } catch {
      // Fall through and show it anyway - worst case it reappears on a
      // later visit, which beats a user never being told at all.
    }

    this.showBackGestureHint = true;
    this.backGestureHintTimer = setTimeout(() => {
      this.showBackGestureHint = false;
    }, BACK_GESTURE_HINT_DURATION_MS);
  }

  handleTopicMessage = (data) => {
    if (this.isDestroying || this.isDestroyed || !data?.id) {
      return;
    }

    if (this.isNestedView) {
      this.handleNestedTopicMessage(data);
      return;
    }

    if (!this.postStream) {
      return;
    }

    switch (data.type) {
      case "created":
        // Incremental append (like core) — a full forceLoad refresh has no
        // nearPost anchor and can jump the modal back to an earlier post.
        Promise.resolve(this.postStream.triggerNewPostsInStream(data.id)).catch(
          () => {}
        );
        break;

      // Single-post updates: loadPost merges in place without resetting the stream window.
      case "revised":
      case "rebaked":
      case "recovered":
      case "deleted":
      case "acted":
      case "read":
      case "liked":
      case "unliked":
        this.postStream.loadPost(data.id).catch(() => {});
        break;

      // Hard-deleted posts are no longer addressable via loadPost() (404).
      case "destroyed":
        this.postStream
          .refresh({
            forceLoad: true,
            track_visit: false,
          })
          .catch(() => {});
        break;

      default:
        break;
    }
  };

  // Nested counterpart. Mirrors NestedController#_onMessage: roots prepend
  // to nestedRootNodes; deeper replies via nested-replies:child-created.
  handleNestedTopicMessage(data) {
    switch (data.type) {
      case "created":
        this.handleNestedPostCreated(data).catch(() => {});
        break;

      case "revised":
      case "rebaked":
      case "recovered":
      case "acted":
      case "read":
      case "liked":
      case "unliked":
        this.handleNestedPostChanged(data).catch(() => {});
        break;

      case "deleted":
        this.markNestedPostDeletedLocally(data.id);
        break;

      default:
        break;
    }
  }

  handleNestedPostRegistered = (post) => {
    if (
      post?.post_number != null &&
      this.topicId != null &&
      String(post.topic?.id) === String(this.topicId)
    ) {
      this.nestedPostRegistry.set(post.post_number, post);
    }
  };

  handleNestedPostUnregistered = (post) => {
    if (
      post?.post_number != null &&
      this.nestedPostRegistry.get(post.post_number) === post
    ) {
      this.nestedPostRegistry.delete(post.post_number);
    }
  };

  findNestedPostById(postId) {
    for (const post of this.nestedPostRegistry.values()) {
      if (post.id === postId) {
        return post;
      }
    }
    return null;
  }

  nestedPostBelongsToTopic(postData) {
    return (
      postData?.topic_id != null &&
      String(postData.topic_id) === String(this.topicId)
    );
  }

  // Mirrors NestedController#isActivityLogPost — drop activity-log posts
  // (no activity log in the modal).
  isNestedActivityLogPost(postData) {
    const postTypes = this.site.post_types;
    if (postData.post_type === postTypes.small_action) {
      return true;
    }
    if (postData.post_type === postTypes.whisper && postData.action_code) {
      return true;
    }
    return false;
  }

  isNestedPostKnown(postId) {
    if (this.nestedRootNodes.some((node) => node.post.id === postId)) {
      return true;
    }
    return !!this.findNestedPostById(postId);
  }

  async handleNestedPostCreated(data) {
    if (this.isNestedPostKnown(data.id)) {
      return;
    }

    const topicId = this.topicId;
    let postData;
    try {
      postData = await ajax(`/posts/${data.id}.json`);
    } catch {
      // Post may not be visible to this user.
      return;
    }

    if (
      this.isDestroying ||
      this.isDestroyed ||
      this.topicId !== topicId ||
      !this.nestedPostBelongsToTopic(postData) ||
      this.isNestedActivityLogPost(postData) ||
      this.isNestedPostKnown(postData.id)
    ) {
      return;
    }

    const node = processNode(this.store, this.topicModel, {
      ...postData,
      children: [],
    });
    const replyTo = postData.reply_to_post_number;
    const isRoot = !replyTo || replyTo === 1;

    if (isRoot) {
      this.nestedRootNodes = [node, ...this.nestedRootNodes];
    } else {
      this.appEvents.trigger("nested-replies:child-created", {
        topicId,
        post: node.post,
        parentPostNumber: replyTo,
      });
    }
  }

  async handleNestedPostChanged(data) {
    const topicId = this.topicId;
    let postData;
    try {
      postData = await ajax(`/posts/${data.id}.json`);
    } catch {
      // Post may not be visible to this user.
      return;
    }

    if (
      this.isDestroying ||
      this.isDestroyed ||
      this.topicId !== topicId ||
      !this.nestedPostBelongsToTopic(postData)
    ) {
      return;
    }

    const existing = this.findNestedPostById(data.id);
    if (!existing) {
      // Not rendered yet (collapsed/unfetched subtree) — loads fresh later.
      return;
    }

    // Via store so Post.munge rebuilds ActionSummary (flags stay in sync after "acted").
    const updated = this.store.createRecord("post", postData);
    existing.updateFromPost(updated);
    if (!postData.deleted_at) {
      existing.set("deleted_post_placeholder", false);
    }
  }

  markNestedPostDeletedLocally(postId) {
    const post = this.findNestedPostById(postId);
    if (!post) {
      return;
    }
    post.set("deleted_at", new Date());
    post.set("deleted_post_placeholder", true);
    if (!this.currentUser?.staff) {
      post.set("cooked", "");
    }
  }

  // Idempotent restore of all service patches.
  restoreServicePatches() {
    if (this.patchesRestored) {
      return;
    }
    this.patchesRestored = true;
    this.servicePatches?.restore();
    try {
      if (this.topicController) {
        this.topicController.set("model", this.originalTopicControllerModel);
      }
    } catch {
      // ignore
    }
  }

  willDestroy() {
    super.willDestroy(...arguments);

    this.messageBus.unsubscribe(`/topic/${this.topicId}`, this.handleTopicMessage);
    this.appEvents.off(
      "nested-replies:post-registered",
      this.handleNestedPostRegistered
    );
    this.appEvents.off(
      "nested-replies:post-unregistered",
      this.handleNestedPostUnregistered
    );
    this.nestedPostRegistry.clear();

    this.timingTracker?.stop();
    this.historyBackDismiss?.stop();
    clearTimeout(this.backGestureHintTimer);
    this.restoreServicePatches();
    clearTimeout(this.fkMenuCloseTimer);
    this.observePost.disconnect?.();
    this.progressTracker.disconnect?.();
    this.nestedPostTracker.disconnect?.();
    this.fkMenuObserver?.disconnect();
    removeObserver(
      this.composer,
      "model.composeState",
      this.handleComposerStateChange
    );
    document.removeEventListener("keydown", this.handleLightboxKeydown, true);
    document.removeEventListener("focusin", this.handleDocumentFocusIn, true);
    this.releaseStaleBodyLocks();
  }

  // Clear body-scroll-lock after teardown if no other modal/composer remains.
  releaseStaleBodyLocks() {
    setTimeout(() => {
      if (
        !document.querySelector(".d-modal") &&
        !document.querySelector("#reply-control.open")
      ) {
        clearBodyLocks();
      }
    }, 0);
  }

  // Skeleton during network load, first positioning (prefetch can resolve
  // before first paint otherwise), and a far jump that has to fetch posts.
  get showSkeleton() {
    return this.loading || this.initialPositioning || this.jumpLoading;
  }

  get skeletonItems() {
    return [1, 2, 3, 4, 5, 6, 7, 8];
  }

  get dismissable() {
    return (
      !this.activeSubModal &&
      !this.fkMenuOpen &&
      !this.composerOpen &&
      !this.scrubberOpen
    );
  }

  // Only "grip" mode shows the drag-handle hint; "gesture" uses its own
  // upward-drag gesture, while "none" hides it. Swipe-down dismissal remains
  // available in all modes via DModal's built-in behavior.
  get showGrip() {
    return settings.modal_dismiss_gesture === "grip";
  }

  // composer.isOpen is true even when minimized (DRAFT).
  get composerOpen() {
    const state = this.composer.model?.composeState;
    return !!state && state !== Composer.DRAFT && state !== Composer.CLOSED;
  }

  quoteState = new QuoteState();

  showSubModal(component, model) {
    this.activeSubModal = { component, model };
    return new Promise((resolve) => {
      this.subModalResolve = resolve;
    });
  }

  // Nested passes handlers uncurried; fail-safe if post is missing/malformed.
  guardPost(post) {
    if (post && typeof post === "object" && (post.id || post.post_number)) {
      return post;
    }
    return null;
  }

  closeSubModal = (data) => {
    this.subModalResolve?.(data);
    this.subModalResolve = null;
    this.activeSubModal = null;
  };

  // Restore focus to composer after float-kit menus close (focusTrigger).
  scheduleComposerFocusGuard() {
    [150, 700].forEach((delay) => {
      setTimeout(() => {
        if (this.isDestroying || this.isDestroyed || !this.composerOpen) {
          return;
        }
        if (
          this.activeSubModal ||
          document.querySelector(".fk-d-menu, .fk-d-menu-modal, .fk-d-tooltip")
        ) {
          return;
        }
        const composerEl = document.querySelector("#reply-control");
        if (!composerEl) {
          return;
        }
        const active = document.activeElement;
        if (active && composerEl.contains(active)) {
          return;
        }
        if (typeof this.composer.focusComposer === "function") {
          this.composer.focusComposer();
        } else {
          composerEl.querySelector("textarea.d-editor-input")?.focus();
        }
      }, delay);
    });
  }

  // Capture-phase: pull focus back if a leftover focus-trap steals it.
  handleDocumentFocusIn = (event) => {
    if (!this.composerOpen || this.activeSubModal) {
      return;
    }
    const composerEl = document.querySelector("#reply-control");
    if (!composerEl || composerEl.contains(event.target)) {
      return;
    }
    const legitPopup = document.querySelector(
      ".fk-d-menu, .fk-d-menu-modal, .fk-d-tooltip"
    );
    if (legitPopup?.contains(event.target)) {
      return;
    }
    schedule("afterRender", () => {
      if (this.isDestroying || this.isDestroyed || !this.composerOpen) {
        return;
      }
      if (typeof this.composer.focusComposer === "function") {
        this.composer.focusComposer();
      } else {
        composerEl.querySelector("textarea.d-editor-input")?.focus();
      }
    });
  };

  // Capture lightbox keys before DModal/float-kit can swallow them.
  handleLightboxKeydown = (event) => {
    const pswp = document.querySelector(".pswp--open");
    if (!pswp) {
      return;
    }
    let button;
    if (event.key === "Escape") {
      button = pswp.querySelector(".pswp__button--close");
    } else if (event.key === "ArrowRight") {
      button = pswp.querySelector(".pswp__button--arrow--next");
    } else if (event.key === "ArrowLeft") {
      button = pswp.querySelector(".pswp__button--arrow--prev");
    } else {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    button?.click();
  };

  // Safety net when composer closes/minimizes: clear stuck sub-modal / fkMenuOpen.
  handleComposerStateChange = () => {
    const state = this.composer.model?.composeState;
    const composerGone =
      !state || state === Composer.CLOSED || state === Composer.DRAFT;
    if (!composerGone) {
      window.getSelection()?.removeAllRanges();
      this.scheduleComposerFocusGuard();
      return;
    }
    if (this.activeSubModal) {
      this.closeSubModal();
    }
    clearTimeout(this.fkMenuCloseTimer);
    this.fkMenuOpen = !!document.querySelector(
      ".fk-d-menu, .fk-d-menu-modal, .fk-d-tooltip, .pswp--open, #reply-control.open"
    );
  };

  // Mark close as self-initiated so the modal.close patch lets it through.
  closeModal = (...args) => {
    this.selfInitiatedClose = true;

    triggerHaptic(this.capabilities, "close");

    try {
      return this.args.closeModal(...args);
    } finally {
      this.selfInitiatedClose = false;
    }
  };

  get topic() {
    return this.args.model.topic;
  }

  get topicId() {
    return this.topic.id;
  }

  get postStream() {
    return this.topicModel?.postStream;
  }

  get isNestedView() {
    return !!this.topicModel?.is_nested_view;
  }

  get title() {
    const t =
      this.resolvedTitle ??
      this.topicModel?.fancy_title ??
      this.topic.fancy_title ??
      this.topic.title;
    return this.resolvedAcceptedAnswer || this.topicModel?.accepted_answer
      ? `\u2705 ${t}`
      : t;
  }

  get posts() {
    const allPosts = (this.postStream?.posts ?? []).filter(
      (p) => !(p instanceof Placeholder)
    );
    return allPosts.slice(0, this.renderLimit);
  }

  get postTuples() {
    const posts = this.posts;
    return posts.map((post, index) => ({
      post,
      prevPost: index > 0 ? posts[index - 1] : null,
      nextPost: index < posts.length - 1 ? posts[index + 1] : null,
    }));
  }

  // The Post record currently occupying the "active reading" band, per
  // currentProgressPostNumber (see createProgressTrackerModifier).
  get progressPost() {
    if (!this.currentProgressPostNumber) {
      return null;
    }
    return (this.postStream?.posts ?? []).find(
      (p) =>
        !(p instanceof Placeholder) &&
        p.post_number === this.currentProgressPostNumber
    );
  }

  // 1-based position in the full topic stream (matches core's
  // postStream.progressIndexOfPost, used by the real topic-progress bar).
  get progressPosition() {
    const post = this.progressPost;
    return post ? this.postStream?.progressIndexOfPost(post) : null;
  }

  get progressTotal() {
    return this.postStream?.filteredPostsCount;
  }

  get progressPercent() {
    if (!this.progressPosition || !this.progressTotal) {
      return 0;
    }
    return Math.min(
      100,
      Math.max(0, (this.progressPosition / this.progressTotal) * 100)
    );
  }

  // Mirrors core TopicProgress#hideProgress: nothing to show before the
  // stream loads, before we know the active post, or for a short stream on
  // desktop (matches core's hideOnShortStream).
  get hideProgress() {
    const hideOnShortStream =
      this.site.desktopView && (this.progressTotal ?? 0) < 2;
    return (
      this.isNestedView ||
      !this.postStream?.loaded ||
      !this.progressPost ||
      hideOnShortStream
    );
  }

  // Mirrors core TopicProgress#showBackButton: true once you've scrolled
  // above (before) your own last-read post, so there's somewhere to jump
  // back down to.
  get showProgressBackButton() {
    const lastReadId = this.topicModel?.last_read_post_id;
    const stream = this.postStream?.stream;
    if (!lastReadId || !stream?.length || this.progressPosition == null) {
      return false;
    }
    const readPos = stream.indexOf(lastReadId);
    return (
      readPos >= 0 &&
      readPos < stream.length - 1 &&
      readPos + 1 > this.progressPosition
    );
  }

  // 0-based starting position for the fullscreen scrubber overlay - matches
  // core's own TopicTimeline `enteredIndex` convention (see
  // topic-timeline.gjs: `prevEvent.postIndex - 1`).
  get scrubberEnteredIndex() {
    return Math.max(0, (this.progressPosition ?? 1) - 1);
  }

  openScrubber = () => {
    this.scrubberOpen = true;
  };

  closeScrubber = () => {
    this.scrubberOpen = false;
  };

  // Resolves a 1-based position in the full topic stream to a post_number
  // and performs a single real jump - mirrors core TopicController's
  // jumpToIndex → _jumpToIndex → _jumpToPostId chain (see topic.js), but
  // reuses our own jumpToPost() for the actual navigation/scroll. Also the
  // exact signature core's own TopicTimeline expects for @jumpToIndex, so
  // the fullscreen scrubber overlay wires straight into this.
  jumpToIndex = async (index) => {
    const stream = this.postStream?.stream;
    if (!stream?.length) {
      return;
    }

    const streamIndex = Math.max(1, Math.min(stream.length, index));
    const postId = stream[streamIndex - 1];
    if (!postId) {
      return;
    }

    try {
      let post = this.postStream.findLoadedPost(postId);
      if (!post) {
        [post] = await this.postStream.findPostsByIds([postId]);
      }
      if (post && !this.isDestroying && !this.isDestroyed) {
        await this.jumpToPost(post.post_number);
      }
    } catch (e) {
      if (!this.isDestroying && !this.isDestroyed) {
        popupAjaxError(e);
      }
    }
  };

  jumpToStart = () => this.jumpToPost(1);

  jumpToEnd = () => {
    const target = this.topicModel?.highest_post_number ?? this.progressTotal;
    if (target) {
      this.jumpToPost(target);
    }
  };

  goToLastRead = () => {
    this.jumpToPost(this.topicModel?.last_read_post_number);
  };

  progressTracker = createProgressTrackerModifier({
    rootSelector: ".topic-preview-modal .d-modal__body",
    onCurrentPostChange: (postNumber) => {
      this.currentProgressPostNumber = postNumber;
    },
  });

  // Read internal flags; canAppendMore/canPrependMore flip false on load start.
  get hasMoreBelow() {
    return !!(this.postStream?.hasPosts && this.postStream?.lastPostNotLoaded);
  }

  get hasMoreAbove() {
    return !!(
      this.postStream?.hasPosts && this.postStream?.firstPostNotLoaded
    );
  }

  @tracked canCreatePost = false;

  // createRecord skips Topic#updateFromJson fixups: re-parent details.topic
  // and wrap bookmarks as Bookmark instances (core nested route has same gap).
  repairNestedTopicRecord(topic) {
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


  async loadNestedRoots({ page = 0, sort = null } = {}) {
    const slug = this.topicModel?.slug || this.topic.slug;
    const topicId = this.topicId;
    const resolvedSort =
      sort ||
      this.nestedSort ||
      this.siteSettings.nested_replies_default_sort ||
      "top";

    const params = new URLSearchParams({
      page: String(page),
      sort: resolvedSort,
    });

    const data = await ajax(
      `/n/${slug || "-"}/${topicId}.json?${params.toString()}`
    );

    if (this.isDestroying || this.isDestroyed) {
      return;
    }

    const result = processNestedRootResponse({
      data,
      params: { post_number: null, context: null },
      site: this.site,
      siteSettings: this.siteSettings,
      store: this.store,
    });

    this.topicModel = result.topic;
    this.repairNestedTopicRecord(this.topicModel);

    // Record identity can change on pagination/sort — keep controller:topic in sync.
    if (
      this.topicController &&
      !this.router.currentRouteName.startsWith("topic.")
    ) {
      this.topicController.set("model", this.topicModel);
    }

    this.nestedOpPost = result.opPost;

    // Fresh load (not pagination) — clear registry before replacing the tree.
    if (page === 0) {
      this.nestedPostRegistry.clear();
    }

    // OP is not rendered by NestedPost — register manually (+ postStream).
    if (this.nestedOpPost?.post_number != null) {
      this.nestedPostRegistry.set(
        this.nestedOpPost.post_number,
        this.nestedOpPost
      );
    }
    if (this.nestedOpPost && this.topicModel?.postStream) {
      registerPostInTopicPostStream(this.topicModel, this.nestedOpPost);
    }

    this.nestedRootNodes =
      page === 0 ? result.rootNodes : [...this.nestedRootNodes, ...result.rootNodes];
    this.nestedPage = result.page;
    this.nestedHasMoreRoots = result.hasMoreRoots;
    this.nestedSort = result.sort;
    this.nestedEffectiveSort = result.effectiveSort;
    this.nestedPinnedPostIds = result.pinnedPostIds || [];
  }

  loadMoreNestedRoots = async () => {
    if (this.nestedLoadingMore || !this.nestedHasMoreRoots) {
      return;
    }

    this.nestedLoadingMore = true;
    try {
      await this.loadNestedRoots({
        page: this.nestedPage + 1,
        sort: this.nestedSort,
      });
    } finally {
      if (!this.isDestroying && !this.isDestroyed) {
        this.nestedLoadingMore = false;
      }
    }
  };

  changeNestedSort = async (sort) => {
    if (sort === this.nestedSort) {
      return;
    }

    try {
      this.nestedLoadingMore = true;
      this.nestedFetchedChildrenCache.clear();
      await this.loadNestedRoots({ page: 0, sort });
    } catch (e) {
      if (!this.isDestroying && !this.isDestroyed) {
        popupAjaxError(e);
      }
    } finally {
      if (!this.isDestroying && !this.isDestroyed) {
        this.nestedLoadingMore = false;
      }
    }
  };

  // Shared nested-load tail (fast path when known nested, or after flat detect).
  async finishNestedLoad() {
    await this.loadNestedRoots({ page: 0 });

    if (this.isDestroying || this.isDestroyed) {
      return;
    }

    this.resolvedTitle =
      this.topicModel?.fancy_title ?? this.topicModel?.title ?? null;
    this.resolvedAcceptedAnswer = !!this.topicModel?.accepted_answer;
    this.canCreatePost = !!this.topicModel?.details?.can_create_post;
    this.timingTracker.trackView();
    this.initialPositioning = false;
    this.showExtraWidgets = true;
  }

  async loadTopic() {
    try {
      // Explicit post number from link (e.g. /t/slug/123/7) wins over last-read.
      const explicitPostNumber = this.args.model.postNumber;
      const lastRead = this.topic.last_read_post_number ?? 0;
      const highestPostNumber = this.topic.highest_post_number ?? 1;
      const initialPostNumber = explicitPostNumber
        ? Math.max(1, explicitPostNumber)
        : Math.max(1, Math.min(lastRead + 1, highestPostNumber));

      this.topicModel = this.store.createRecord("topic", {
        id: this.topicId,
        slug: this.topic.slug,
      });

      if (!this.router.currentRouteName.startsWith("topic.")) {
        this.topicController?.set("model", this.topicModel);
      }

      // Fast path: skip flat postStream fetch when topic is already known nested.
      const knownNestedHint =
        this.topic?.is_nested_view ?? this.topic?.nested_topic;

      if (knownNestedHint) {
        return await this.finishNestedLoad();
      }

      // forceLoad required: store may return a stale identity-map instance.
      await this.postStream.refresh({
        forceLoad: true,
        track_visit: true,
        nearPost: initialPostNumber,
      });

      if (this.isDestroying || this.isDestroyed) {
        return;
      }

      if (this.topicModel?.is_nested_view) {
        return await this.finishNestedLoad();
      }

      this.timingTracker.trackView();

      if (this.isDestroying || this.isDestroyed) {
        return;
      }

      // Explicit @tracked copy — fresh store records may not notify the title getter.
      this.resolvedTitle =
        this.topicModel?.fancy_title ?? this.topicModel?.title ?? null;
      this.resolvedAcceptedAnswer = !!this.topicModel?.accepted_answer;

      this.canCreatePost = !!this.topicModel?.details?.can_create_post;

      const targetPostNumber =
        this.postStream?.closestPostNumberFor?.(initialPostNumber) ??
        initialPostNumber;

      // Render only up to target post on first frame; rest after paint.
      const targetIndex = (this.postStream?.posts ?? [])
        .filter((post) => !(post instanceof Placeholder))
        .findIndex((post) => post.post_number === targetPostNumber);
      this.renderLimit = Math.max(3, targetIndex + 1);

      this.scrollToPost(targetPostNumber, false, 0, () => {
        this.initialPositioning = false;
      });

      const renderRemainingPosts = () => {
        if (this.isDestroying || this.isDestroyed) {
          return;
        }

        const totalPosts = this.postStream?.posts?.length || 0;

        if (this.renderLimit < totalPosts) {
          this.renderLimit = Math.min(this.renderLimit + 5, totalPosts);

          if (this.renderLimit < totalPosts) {
            if (window.requestIdleCallback) {
              window.requestIdleCallback(renderRemainingPosts, { timeout: 300 });
            } else {
              setTimeout(renderRemainingPosts, 30);
            }
            return;
          }
        }

        this.renderLimit = Number.MAX_SAFE_INTEGER;
        this.showExtraWidgets = true;
      };

      if (window.requestIdleCallback) {
        window.requestIdleCallback(renderRemainingPosts, { timeout: 500 });
      } else {
        setTimeout(renderRemainingPosts, 0);
      }
    } catch (e) {
      popupAjaxError(e);
      this.closeModal();
    } finally {
      this.loading = false;

      if (this.currentUser) {
        this.timingTracker.start();
      }
    }
  }

  loadBelow = async () => {
    if (this.loading || this.loadingMore || !this.hasMoreBelow) {
      return;
    }
    this.loadingMore = true;
    try {
      await this.postStream?.appendMore();
      this.renderLimit = Number.MAX_SAFE_INTEGER;
    } finally {
      this.loadingMore = false;
    }
  };

  loadAbove = async () => {
    if (this.loading || this.loadingAbove || !this.hasMoreAbove) {
      return;
    }
    this.loadingAbove = true;
    this.renderLimit = Number.MAX_SAFE_INTEGER;

    const scroller = document.querySelector(
      ".topic-preview-modal .d-modal__body"
    );
    const beforeHeight = scroller?.scrollHeight ?? 0;
    try {
      await this.postStream?.prependMore();
    } finally {
      this.loadingAbove = false;
      schedule("afterRender", () => {
        if (scroller) {
          scroller.scrollTop += scroller.scrollHeight - beforeHeight;
        }
      });
    }
  };

  // Manual scroll so the page itself does not move.
  scrollWithinModal(el, smooth = true) {
    const scroller = document.querySelector(
      ".topic-preview-modal .d-modal__body"
    );
    if (!scroller || !el) {
      return;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const topPadding = 12;
    const delta = elRect.top - scrollerRect.top - topPadding;
    scroller.scrollBy({ top: delta, behavior: smooth ? "smooth" : "auto" });
  }

  scrollToPost(postNumber, smooth = true, attempt = 0, onPositioned) {
    schedule("afterRender", () => {
      const el = document.querySelector(
        `.topic-preview-modal [data-post-number="${postNumber}"]`
      );

      if (el) {
        this.scrollWithinModal(el, smooth);
        el.classList.add("highlighted");
        setTimeout(() => el.classList.remove("highlighted"), 1600);

        requestAnimationFrame(() => {
          this.scrollWithinModal(el, false);

          if (onPositioned) {
            setTimeout(() => {
              this.scrollWithinModal(el, false);
              onPositioned();
            }, 150);
          } else {
            setTimeout(() => this.scrollWithinModal(el, false), 150);
          }
        });
      } else if (attempt < 15) {
        setTimeout(
          () =>
            this.scrollToPost(postNumber, smooth, attempt + 1, onPositioned),
          100
        );
      }
    });
  }

  handleInternalLinkClick = (event) => {
    const link = event.target.closest?.("a[href]");
    if (!link) {
      return;
    }
    let url;
    try {
      url = new URL(link.href, window.location.origin);
    } catch {
      return;
    }
    const match = matchTopicLink(url.pathname);
    if (!match || match.topicId !== this.topicId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.jumpToPost(match.postNumber ?? 1);
  };

  jumpToPost = async (postNumber) => {
    // refresh() itself resolves instantly when the post is already in the
    // loaded window (see postStream.refresh in core) - only a real fetch
    // deserves the skeleton, so a nearby/local jump stays flicker-free.
    const alreadyLoaded = (this.postStream?.posts ?? []).some(
      (p) => p.post_number === postNumber
    );
    if (!alreadyLoaded) {
      this.jumpLoading = true;
      // Safety net: scrollToPost's own polling gives up silently after
      // ~1.5s if it never finds the target element, which would otherwise
      // leave the skeleton stuck on screen forever.
      setTimeout(() => {
        if (!this.isDestroying && !this.isDestroyed) {
          this.jumpLoading = false;
        }
      }, 4000);
    }

    try {
      await this.postStream?.refresh({ nearPost: postNumber });
      if (this.isDestroying || this.isDestroyed) {
        return;
      }
      // Cleared inside the positioned callback, not here - the new posts
      // still have to render and scrollToPost still has to locate/position
      // the target element before it's safe to reveal them.
      this.scrollToPost(postNumber, true, 0, () => {
        this.jumpLoading = false;
      });
    } catch (e) {
      this.jumpLoading = false;
      throw e;
    }
  };

  replyToTopic = async () => {
    const opts = {
      action: Composer.REPLY,
      draftKey: this.topicModel?.draft_key ?? `topic_${this.topicId}`,
      draftSequence: this.topicModel?.draft_sequence ?? 0,
      topic: this.topicModel,
    };

    await this.#loadDraftInto(opts);

    this.composer.open(opts);
  };

  replyToPost = async (post) => {
    if (!(post = this.guardPost(post, "replyToPost"))) {
      return;
    }
    const opts = {
      action: Composer.REPLY,
      draftKey: this.topicModel?.draft_key ?? `topic_${this.topicId}`,
      draftSequence: this.topicModel?.draft_sequence ?? 0,
      topic: this.topicModel,
      post,
    };

    await this.#loadDraftInto(opts);

    this.composer.open(opts);
  };

  // Mirrors core TopicController#replyToPost: composer.open() alone does not
  // resurrect a saved draft after the modal (and composer) was closed once.
  #loadDraftInto = async (opts) => {
    if (opts.quote) {
      return;
    }
    try {
      const draftData = await Draft.get(opts.draftKey);
      if (draftData?.draft) {
        const data = JSON.parse(draftData.draft);
        opts.reply = data.reply;
        opts.draftSequence = draftData.draft_sequence;
      }
    } catch {
      // no draft — open blank
    }
  };

  editPost = (post) => {
    if (!(post = this.guardPost(post, "editPost"))) {
      return;
    }
    if (!this.currentUser) {
      return this.dialog.alert(i18n("post.controls.edit_anonymous"));
    }
    if (!post.can_edit) {
      return false;
    }
    return this.composer.open({
      post,
      action: Composer.EDIT,
      draftKey: post.get("topic.draft_key"),
      draftSequence: post.get("topic.draft_sequence"),
    });
  };

  selectText = async () => {
    const { postId } = this.quoteState;
    const postStream = this.postStream;
    const { markdown: buffer, opts } = await this.quoteState.markdown();
    const loadedPost = postStream.findLoadedPost(postId);
    const post = loadedPost ? loadedPost : await postStream.loadPost(postId);

    const composerOpts = {
      action: Composer.REPLY,
      draftSequence: post.get("topic.draft_sequence"),
      draftKey: post.get("topic.draft_key"),
    };

    if (post.get("post_number") === 1) {
      composerOpts.topic = post.get("topic");
    } else {
      composerOpts.post = post;
    }

    composerOpts.quote = buildQuote(post, buffer, opts);
    this.quoteState.clear();
    await this.composer.open(composerOpts);
  };

  buildQuoteMarkdown = async () => {
    const { postId } = this.quoteState;
    const postStream = this.postStream;
    const { markdown: buffer, opts } = await this.quoteState.markdown();
    const loadedPost = postStream.findLoadedPost(postId);
    const post = loadedPost ? loadedPost : await postStream.loadPost(postId);
    return buildQuote(post, buffer, opts);
  };

  deletePost = async (post) => {
    if (!(post = this.guardPost(post, "deletePost"))) {
      return;
    }
    if (post.post_number === 1) {
      return this.openFull();
    }
    if (!post.can_delete) {
      return;
    }
    this.dialog.yesNoConfirm({
      message: i18n("post.confirm_delete"),
      didConfirm: async () => {
        try {
          await post.destroy(this.currentUser);
        } catch (e) {
          popupAjaxError(e);
          post.undoDeleteState();
        }
      },
    });
  };

  recoverPost = (post) => {
    if (!(post = this.guardPost(post, "recoverPost"))) {
      return;
    }
    if (post.post_number === 1) {
      return this.openFull();
    }
    return post.recover();
  };

  permanentlyDeletePost = async (post) => {
    if (!(post = this.guardPost(post, "permanentlyDeletePost"))) {
      return;
    }
    let result;
    try {
      result = await ajax(`/posts/${post.id}/permanently_delete_check.json`);
    } catch (e) {
      return popupAjaxError(e);
    }
    if (!result.can_permanently_delete) {
      return this.dialog.alert(result.reason);
    }
    this.showSubModal(PermanentlyDeleteConfirmModal, {
      message: i18n("post.controls.permanently_delete_post_confirmation"),
      confirmPhrase: i18n("post.controls.permanently_delete_confirm_phrase"),
      didConfirm: async () => {
        try {
          await post.destroy(this.currentUser, { force_destroy: true });
        } catch (e) {
          popupAjaxError(e);
        }
      },
    });
  };

  lockPost = (post) => {
    if (!(post = this.guardPost(post, "lockPost"))) {
      return;
    }
    return post.updatePostField("locked", true);
  };

  unlockPost = (post) => {
    if (!(post = this.guardPost(post, "unlockPost"))) {
      return;
    }
    return post.updatePostField("locked", false);
  };

  toggleWiki = (post) => {
    if (!(post = this.guardPost(post, "toggleWiki"))) {
      return;
    }
    return post.updatePostField("wiki", !post.wiki);
  };

  togglePostType = (post) => {
    if (!(post = this.guardPost(post, "togglePostType"))) {
      return;
    }
    const regular = this.site.post_types.regular;
    const moderator = this.site.post_types.moderator_action;
    return post.updatePostField(
      "post_type",
      post.post_type === moderator ? regular : moderator
    );
  };

  rebakePost = (post) => {
    if (!(post = this.guardPost(post, "rebakePost"))) {
      return;
    }
    return post.rebake();
  };

  unhidePost = (post) => {
    if (!(post = this.guardPost(post, "unhidePost"))) {
      return;
    }
    return post.unhide();
  };

  expandHidden = (post) => {
    if (!(post = this.guardPost(post, "expandHidden"))) {
      return;
    }
    return post.expandHidden();
  };

  changeNotice = async (post) => {
    if (!(post = this.guardPost(post, "changeNotice"))) {
      return;
    }
    await this.showSubModal(ChangePostNoticeModal, { post });
  };

  changePostOwner = (post) => {
    if (!(post = this.guardPost(post, "changePostOwner"))) {
      return;
    }
    this.showSubModal(ChangeOwnerModal, {
      selectedPostsCount: 1,
      selectedPostIds: [post.id],
      selectedPostsUsername: post.username,
      multiSelect: false,
      deselectAll: () => {},
      toggleMultiSelect: () => {},
      topic: post.topic ?? this.topicModel,
    });
  };

  grantBadge = (post) => {
    if (!(post = this.guardPost(post, "grantBadge"))) {
      return;
    }
    this.showSubModal(GrantBadgeModal, { selectedPost: post });
  };

  showFlags = (post) => {
    if (!(post = this.guardPost(post, "showFlags"))) {
      return;
    }
    this.showSubModal(this.currentUser ? FlagModal : AnonymousFlagModal, {
      flagTarget: new PostFlag(),
      flagModel: post,
      setHidden: () => post.set("hidden", true),
    });
  };

  showHistory = (post, revision) => {
    if (!(post = this.guardPost(post, "showHistory"))) {
      return;
    }
    this.showSubModal(HistoryModal, {
      postId: post.id,
      postVersion: revision || "latest",
      post,
      editPost: (p) => this.editPost(p),
    });
  };

  showRawEmail = (post) => {
    if (!(post = this.guardPost(post, "showRawEmail"))) {
      return;
    }
    this.showSubModal(RawEmailModal, post);
  };

  showLogin = () => {
    this.closeModal();
    DiscourseURL.redirectTo("/login");
  };

  showPagePublish = () => this.openFull();
  showInvite = () => this.openFull();
  removeAllowedGroup = () => this.openFull();
  removeAllowedUser = () => this.openFull();
  selectBelow = () => this.openFull();
  selectReplies = (post) => this.openFull();
  cancelFilter = () => {};
  updateTopicPageQueryParams = () => {};

  openFull = () => {
    const slug = this.topicModel?.slug || this.topic.slug;
    const topicId = this.topicId;
    const path = slug ? `/t/${slug}/${topicId}` : `/t/${topicId}`;
    const router = this.router;

    // Stop tracker immediately to avoid a last flush racing the transition.
    this.timingTracker?.stop();
    // Remove the modal's history marker before scheduling the real
    // transition below. The cleanup must not traverse browser history.
    this.historyBackDismiss?.stop();
    this.restoreServicePatches();
    this.closeModal();

    // Avoid DiscourseURL.routeTo() — navigatedToPost() expects a real topic-route
    // PostStream and can hit refresh() on undefined. Teardown first, then transition.
    schedule('afterRender', () => {
      if (!router) {
        return;
      }

      // Skip transition only if page under modal is already this exact topic.
      // currentRouteName starts with "topic." for any topic — compare ids via URL.
      const currentMatch = matchTopicLink(window.location.pathname);
      const alreadyOnThisTopic =
        router.currentRouteName?.startsWith('topic.') &&
        currentMatch &&
        String(currentMatch.topicId) === String(topicId);

      if (alreadyOnThisTopic) {
        return;
      }
      router.transitionTo(path);
    });
  };

  lazyImages = lazyImagesModifier;

  observePost = createPostVisibilityModifier({
    rootSelector: ".topic-preview-modal .d-modal__body",
    onVisible: (postNumber) => this.timingTracker.markVisible(postNumber),
  });

  // Nested counterpart to observePost + lazyImages (container-level modifier).
  nestedPostTracker = createNestedPostTrackerModifier({
    rootSelector: ".topic-preview-modal .d-modal__body",
    onVisible: (postNumber) => this.timingTracker.markVisible(postNumber),
  });

  sentinel = createLoadMoreSentinelModifier({
    rootSelector: ".topic-preview-modal .d-modal__body",
    onIntersect: () => this.loadBelow(),
  });

  swipeUpDismiss = createSwipeUpDismissModifier({
    rootSelector: ".topic-preview-modal .d-modal__container",
    onDismiss: () => this.closeModal(),
    canDismiss: () => this.dismissable,
    enabled:
      !this.capabilities.viewport.sm &&
      settings.modal_dismiss_gesture === "gesture",
  });

  <template>
    {{bodyClass "topic-preview-opened"}}
    <DModal
      @closeModal={{this.closeModal}}
      @title={{replaceEmoji (htmlSafe this.title)}}
      @dismissable={{this.dismissable}}
      @autofocus={{false}}
      @hidden={{this.composerOpen}}
      class="topic-preview-modal"
      {{this.swipeUpDismiss}}
    >
      <:body>
        {{#if this.showBackGestureHint}}
          <div
            class="topic-preview-modal__back-gesture-hint"
            role="status"
          >
            {{i18n (themePrefix "topic_preview.back_gesture_hint")}}
          </div>
        {{/if}}

        {{#if this.showSkeleton}}
          <div
            class="topic-preview-modal__skeleton-wrapper"
          >
            <div
              class="topic-preview-modal__skeleton"
              aria-hidden="true"
            >
              {{#each this.skeletonItems as |i|}}
                <div class="topic-preview-modal__skeleton-item">
                  <div class="topic-preview-modal__skeleton-header">
                    <div class="topic-preview-modal__skeleton-avatar"></div>
                    <div class="topic-preview-modal__skeleton-names">
                      <div class="topic-preview-modal__skeleton-line topic-preview-modal__skeleton-line--name"></div>
                      <div class="topic-preview-modal__skeleton-line topic-preview-modal__skeleton-line--username"></div>
                    </div>
                  </div>
                  <div class="topic-preview-modal__skeleton-body">
                    <div class="topic-preview-modal__skeleton-line"></div>
                    <div class="topic-preview-modal__skeleton-line"></div>
                    <div class="topic-preview-modal__skeleton-line topic-preview-modal__skeleton-line--short"></div>
                  </div>
                </div>
              {{/each}}
            </div>
          </div>
        {{/if}}

        {{#unless this.loading}}
          <div class={{if (or this.initialPositioning this.jumpLoading) "topic-preview-modal__posts-container--hidden"}}>
            {{#unless this.isNestedView}}
              {{#if this.hasMoreAbove}}
              <ConditionalLoadingSpinner @condition={{this.loadingAbove}}>
                <DButton
                  class="btn-default topic-preview-modal__load-earlier"
                  @translatedLabel={{i18n (themePrefix "topic_preview.load_earlier")}}
                  @action={{this.loadAbove}}
                />
              </ConditionalLoadingSpinner>
              {{/if}}
            {{/unless}}

            <div
              class={{if this.isNestedView "topic-preview-modal__posts" "topic-preview-modal__posts post-stream"}}
              {{on "click" this.handleInternalLinkClick capture=true}}
            >
              {{#if this.isNestedView}}
                <div
                  class="topic-preview-modal__nested-tracker"
                  {{this.nestedPostTracker}}
                >
                  <Nested
                    @topic={{this.topicModel}}
                    @opPost={{this.nestedOpPost}}
                    @rootNodes={{this.nestedRootNodes}}
                    @sort={{this.nestedSort}}
                    @effectiveSort={{this.nestedEffectiveSort}}
                    @hasMoreRoots={{this.nestedHasMoreRoots}}
                    @loadingMore={{this.nestedLoadingMore}}
                    @pinnedPostIds={{this.nestedPinnedPostIds}}
                    @loadMoreRoots={{this.loadMoreNestedRoots}}
                    @changeSort={{this.changeNestedSort}}
                    @replyToPost={{this.replyToPost}}
                    @editPost={{this.editPost}}
                    @deletePost={{this.deletePost}}
                    @recoverPost={{this.recoverPost}}
                    @showFlags={{this.showFlags}}
                    @showHistory={{this.showHistory}}
                    @changeNotice={{this.changeNotice}}
                    @changePostOwner={{this.changePostOwner}}
                    @grantBadge={{this.grantBadge}}
                    @lockPost={{this.lockPost}}
                    @unlockPost={{this.unlockPost}}
                    @permanentlyDeletePost={{this.permanentlyDeletePost}}
                    @rebakePost={{this.rebakePost}}
                    @showPagePublish={{this.showPagePublish}}
                    @togglePostType={{this.togglePostType}}
                    @toggleWiki={{this.toggleWiki}}
                    @unhidePost={{this.unhidePost}}
                    @fetchedChildrenCache={{this.nestedFetchedChildrenCache}}
                    @selectReplies={{this.selectReplies}}
                    @selectBelow={{this.selectBelow}}
                    @contextMode={{false}}
                  />
                </div>
              {{else}}
                {{#each this.postTuples key="post.id" as |tuple|}}
                  <div
                    class="topic-preview-modal__post-wrapper"
                    data-post-number={{tuple.post.post_number}}
                    {{this.observePost}}
                    {{this.lazyImages}}
                    {{this.progressTracker}}
                  >
                    {{#let
                      (if tuple.post.isSmallAction PostSmallAction Post)
                      as |PostComponent|
                    }}
                      <PostComponent
                        @elementId={{concat "post_" tuple.post.post_number}}
                        @post={{tuple.post}}
                        @prevPost={{tuple.prevPost}}
                        @nextPost={{tuple.nextPost}}
                        @canCreatePost={{this.canCreatePost}}
                        @changeNotice={{fn this.changeNotice tuple.post}}
                        @changePostOwner={{fn this.changePostOwner tuple.post}}
                        @deletePost={{fn this.deletePost tuple.post}}
                        @editPost={{fn this.editPost tuple.post}}
                        @expandHidden={{fn this.expandHidden tuple.post}}
                        @filteringRepliesToPostNumber={{null}}
                        @grantBadge={{fn this.grantBadge tuple.post}}
                        @lockPost={{fn this.lockPost tuple.post}}
                        @permanentlyDeletePost={{fn this.permanentlyDeletePost tuple.post}}
                        @rebakePost={{fn this.rebakePost tuple.post}}
                        @recoverPost={{fn this.recoverPost tuple.post}}
                        @removeAllowedGroup={{this.removeAllowedGroup}}
                        @removeAllowedUser={{this.removeAllowedUser}}
                        @replyToPost={{fn this.replyToPost tuple.post}}
                        @selectBelow={{fn this.selectBelow tuple.post}}
                        @selectReplies={{fn this.selectReplies tuple.post}}
                        @showFlags={{fn this.showFlags tuple.post}}
                        @showHistory={{fn this.showHistory tuple.post}}
                        @showInvite={{this.showInvite}}
                        @showLogin={{this.showLogin}}
                        @showPagePublish={{this.showPagePublish}}
                        @showRawEmail={{fn this.showRawEmail tuple.post}}
                        @showReadIndicator={{false}}
                        @togglePostType={{fn this.togglePostType tuple.post}}
                        @toggleWiki={{fn this.toggleWiki tuple.post}}
                        @unhidePost={{fn this.unhidePost tuple.post}}
                        @unlockPost={{fn this.unlockPost tuple.post}}
                        @cancelFilter={{this.cancelFilter}}
                        @updateTopicPageQueryParams={{this.updateTopicPageQueryParams}}
                        @streamElement={{true}}
                      />
                    {{/let}}
                  </div>
                {{/each}}
              {{/if}}
            </div>

            {{#if (and this.topicModel this.showExtraWidgets)}}
              <div class="topic-preview-modal__presence">
                <TopicPresenceDisplay @topic={{this.topicModel}} @avatarSize="small" />
              </div>
            {{/if}}

            {{#unless this.isNestedView}}
              {{#if this.hasMoreBelow}}
              <div class="topic-preview-modal__sentinel" {{this.sentinel}}>
                <ConditionalLoadingSpinner @condition={{this.loadingMore}} />
              </div>
              {{/if}}
            {{/unless}}
          </div>
        {{/unless}}
      </:body>

      <:footer>
        {{#unless this.capabilities.viewport.sm}}
          {{#if this.showGrip}}
            <div
              class="topic-preview-modal__footer-grip"
              aria-hidden="true"
            ></div>
          {{/if}}
        {{/unless}}

        {{#unless this.hideProgress}}
          <TopicPreviewModalProgressBar
            @position={{this.progressPosition}}
            @total={{this.progressTotal}}
            @percent={{this.progressPercent}}
            @showBackButton={{this.showProgressBackButton}}
            @onBack={{this.goToLastRead}}
            @onJumpStart={{this.jumpToStart}}
            @onJumpEnd={{this.jumpToEnd}}
            @onOpen={{this.openScrubber}}
          />
        {{/unless}}

        {{#if this.scrubberOpen}}
          <TopicPreviewModalProgressScrubberOverlay
            @topicModel={{this.topicModel}}
            @enteredIndex={{this.scrubberEnteredIndex}}
            @onJumpToIndex={{this.jumpToIndex}}
            @onJumpToStart={{this.jumpToStart}}
            @onJumpToEnd={{this.jumpToEnd}}
            @onClose={{this.closeScrubber}}
          />
        {{/if}}

        <div class="topic-preview-modal__footer-content">
          {{#if (and this.currentUser this.canCreatePost)}}
            <DButton
              class="btn-primary"
              @icon="reply"
              @translatedLabel={{i18n "js.composer.reply"}}
              @action={{this.replyToTopic}}
            />
          {{/if}}
          <DButton
            class="btn-flat"
            @icon="up-right-from-square"
            @translatedLabel={{i18n (themePrefix "topic_preview.open_full")}}
            @action={{this.openFull}}
          />
        </div>
      </:footer>
    </DModal>

    {{#if this.topicModel}}
      <PostTextSelection
        @topic={{this.topicModel}}
        @quoteState={{this.quoteState}}
        @editPost={{this.editPost}}
        @selectText={{this.selectText}}
        @buildQuoteMarkdown={{this.buildQuoteMarkdown}}
      />
    {{/if}}

    {{#if this.activeSubModal}}
      <this.activeSubModal.component
        @model={{this.activeSubModal.model}}
        @closeModal={{this.closeSubModal}}
      />
    {{/if}}
  </template>
}
