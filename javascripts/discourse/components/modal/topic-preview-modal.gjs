import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { concat, fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { and, or } from "truth-helpers";
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
import Post from "discourse/components/post";
import Nested from "discourse/components/nested";
import PostSmallAction from "discourse/components/post/small-action";
import PostTextSelection from "discourse/components/post-text-selection";
import TopicPresenceDisplay from "discourse/plugins/discourse-presence/discourse/components/topic-presence-display";
import { popupAjaxError } from "discourse/lib/ajax-error";
import { clearBodyLocks } from "discourse/lib/body-scroll-lock";
import { Placeholder } from "discourse/models/post-stream";
import { i18n } from "discourse-i18n";
import TopicPreviewServicePatches from "../../lib/service-patches";
import TopicPreviewTimingTracker from "../../lib/timing-tracker";
import TopicPreviewHistoryBackDismiss from "../../lib/history-back-dismiss";
import BackGestureHint from "../../lib/back-gesture-hint";
import OverlayMenuWatcher from "../../lib/overlay-menu-watcher";
import NestedTopicController from "../../lib/nested-topic-controller";
import ProgressNavigator from "../../lib/progress-navigator";
import TopicPreviewComposerInteractions from "../../lib/composer-interactions";
import TopicPreviewPostActions from "../../lib/post-actions";
import { matchTopicLink } from "../../lib/topic-link";
import { triggerHaptic } from "../../lib/haptic";
import lazyImagesModifier from "../../modifiers/lazy-images";
import createNestedPostTrackerModifier from "../../modifiers/create-nested-post-tracker-modifier";
import createPostVisibilityModifier from "../../modifiers/create-post-visibility-modifier";
import createLoadMoreSentinelModifier from "../../modifiers/create-load-more-sentinel-modifier";
import createSwipeUpDismissModifier from "../../modifiers/create-swipe-up-dismiss-modifier";

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
  // True while a jump waits for postStream.refresh() to fetch its target.
  @tracked jumpLoading = false;
  @tracked showExtraWidgets = false;

  @tracked resolvedTitle = null;
  @tracked resolvedAcceptedAnswer = false;

  // Mirrors postStream.filter for post-voting connectors.
  @tracked postVotingFilter = null;

  @tracked renderLimit = 1;

  @tracked canCreatePost = false;

  // Keeps modal.show() from closing the topic preview.
  @tracked activeSubModal = null;

  // Delegates: each owns one concern and reads/writes the tracked state
  // above (and each other's public state) via the `component` reference
  // it's constructed with.
  nested = new NestedTopicController(this);
  progressNav = new ProgressNavigator(this);
  composerInteractions = new TopicPreviewComposerInteractions(this);
  postActions = new TopicPreviewPostActions(this);
  overlayWatcher = new OverlayMenuWatcher(this);
  backGestureHint = new BackGestureHint();

  subModalResolve = null;
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

    this.appEvents.on(
      "nested-replies:post-registered",
      this.nested.handlePostRegistered
    );
    this.appEvents.on(
      "nested-replies:post-unregistered",
      this.nested.handlePostUnregistered
    );

    this.topicController = getOwner(this).lookup("controller:topic");
    if (this.topicController) {
      this.originalTopicControllerModel = this.topicController.model;
    }

    if (PreloadStore.get(`topic_${this.topicId}`)) {
      this.loadTopic();
    } else {
      requestAnimationFrame(() => this.loadTopic());
    }

    this.overlayWatcher.start();

    this.servicePatches = new TopicPreviewServicePatches(this);

    this.timingTracker = new TopicPreviewTimingTracker(this);

    this.historyBackDismiss = new TopicPreviewHistoryBackDismiss(
      () => this.closeModal(),
      this.router
    );
    if (
      !this.capabilities.viewport.sm &&
      settings.modal_dismiss_gesture === "gesture"
    ) {
      this.historyBackDismiss.start();
      this.backGestureHint.maybeShow();
    }

    this.composerInteractions.start();

    document.addEventListener("keydown", this.handleLightboxKeydown, true);
  }

  willDestroy() {
    super.willDestroy(...arguments);

    this.messageBus.unsubscribe(`/topic/${this.topicId}`, this.handleTopicMessage);
    this.appEvents.off(
      "nested-replies:post-registered",
      this.nested.handlePostRegistered
    );
    this.appEvents.off(
      "nested-replies:post-unregistered",
      this.nested.handlePostUnregistered
    );
    this.nested.postRegistry.clear();

    // Stop before transition to avoid a final timing flush racing it.
    this.timingTracker?.stop();
    // Remove the modal history marker without traversing browser history.
    this.historyBackDismiss?.stop();
    this.backGestureHint.stop();
    this.restoreServicePatches();
    this.overlayWatcher.stop();
    this.observePost.disconnect?.();
    this.progressNav.progressTracker.disconnect?.();
    this.nestedPostTracker.disconnect?.();
    this.composerInteractions.stop();
    document.removeEventListener("keydown", this.handleLightboxKeydown, true);
    this.releaseStaleBodyLocks();
  }

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

  // Lightbox (PhotoSwipe) doesn't stop propagation on its own, so Escape
  // and the arrow keys would otherwise also reach the modal/composer.
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

  handleTopicMessage = (data) => {
    if (this.isDestroying || this.isDestroyed || !data?.id) {
      return;
    }

    if (this.isNestedView) {
      this.nested.handleTopicMessage(data);
      return;
    }

    if (!this.postStream) {
      return;
    }

    switch (data.type) {
      case "created":
        Promise.resolve(this.postStream.triggerNewPostsInStream(data.id)).catch(
          () => {}
        );
        break;

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
    }
  }

  get showSkeleton() {
    return this.loading || this.initialPositioning || this.jumpLoading;
  }

  get skeletonItems() {
    return [1, 2, 3, 4, 5, 6, 7, 8];
  }

  get dismissable() {
    return (
      !this.activeSubModal &&
      !this.overlayWatcher.open &&
      !this.composerInteractions.composerOpen &&
      !this.progressNav.scrubberOpen
    );
  }

  get showGrip() {
    return settings.modal_dismiss_gesture === "grip";
  }

  showSubModal(component, model) {
    this.activeSubModal = { component, model };
    return new Promise((resolve) => {
      this.subModalResolve = resolve;
    });
  }

  closeSubModal = (data) => {
    this.subModalResolve?.(data);
    this.subModalResolve = null;
    this.activeSubModal = null;
  };

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

  get hasMoreBelow() {
    return !!(this.postStream?.hasPosts && this.postStream?.lastPostNotLoaded);
  }

  get hasMoreAbove() {
    return !!(
      this.postStream?.hasPosts && this.postStream?.firstPostNotLoaded
    );
  }

  async loadTopic() {
    try {
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

      const knownNestedHint =
        this.topic?.is_nested_view ?? this.topic?.nested_topic;

      if (knownNestedHint) {
        return await this.nested.finishLoad();
      }

      await this.postStream.refresh({
        forceLoad: true,
        track_visit: true,
        nearPost: initialPostNumber,
      });

      if (this.isDestroying || this.isDestroyed) {
        return;
      }

      if (this.topicModel?.is_nested_view) {
        return await this.nested.finishLoad();
      }

      this.timingTracker.trackView();

      if (this.isDestroying || this.isDestroyed) {
        return;
      }

      this.resolvedTitle =
        this.topicModel?.fancy_title ?? this.topicModel?.title ?? null;
      this.resolvedAcceptedAnswer = !!this.topicModel?.accepted_answer;

      this.canCreatePost = !!this.topicModel?.details?.can_create_post;

      const targetPostNumber =
        this.postStream?.closestPostNumberFor?.(initialPostNumber) ??
        initialPostNumber;

      const targetIndex = (this.postStream?.posts ?? [])
        .filter((post) => !(post instanceof Placeholder))
        .findIndex((post) => post.post_number === targetPostNumber);
      this.renderLimit = Math.max(3, targetIndex + 1);

      this.progressNav.scrollToPost(targetPostNumber, false, 0, () => {
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

    if (this.isNestedView) {
      this.openFullAt(url.pathname + url.search);
      return;
    }

    this.progressNav.jumpToPost(match.postNumber ?? 1);
  };

  // TopicPreviewServicePatches intercepts same-topic navigation and calls
  // this directly - keep it as a stable method on the component itself.
  jumpToPost = (postNumber) => this.progressNav.jumpToPost(postNumber);

  openFull = () => {
    const slug = this.topicModel?.slug || this.topic.slug;
    const topicId = this.topicId;
    const path = slug ? `/t/${slug}/${topicId}` : `/t/${topicId}`;
    this.openFullAt(path, { skipIfAlreadyOnTopic: true });
  };

  openFullAt = (path, { skipIfAlreadyOnTopic = false } = {}) => {
    const topicId = this.topicId;
    const router = this.router;

    this.timingTracker?.stop();
    this.historyBackDismiss?.stop();
    this.restoreServicePatches();
    this.closeModal();

    // Use the router directly; DiscourseURL.routeTo() expects a real PostStream.
    schedule('afterRender', () => {
      if (!router) {
        return;
      }

      const currentMatch = matchTopicLink(window.location.pathname);
      const alreadyOnThisTopic =
        router.currentRouteName?.startsWith('topic.') &&
        currentMatch &&
        String(currentMatch.topicId) === String(topicId);

      if (skipIfAlreadyOnTopic && alreadyOnThisTopic) {
        return;
      }
      router.transitionTo(path);
    });
  };

  // Sync after post-voting changes the stream filter.
  updateTopicPageQueryParams = () => {
    this.postVotingFilter = this.topicModel?.postStream?.filter ?? null;
  };

  // Keep the shape expected by post-voting connectors.
  get topicPageQueryParams() {
    return {
      filter: this.postVotingFilter,
      username_filters: null,
      replies_to_post_number: null,
      sort: null,
      context: null,
      collapseReplies: null,
    };
  }

  lazyImages = lazyImagesModifier;

  observePost = createPostVisibilityModifier({
    rootSelector: ".topic-preview-modal .d-modal__body",
    onVisible: (postNumber) => this.timingTracker.markVisible(postNumber),
  });

  // Visibility tracker for nested posts.
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
      @hidden={{this.composerInteractions.composerOpen}}
      class="topic-preview-modal"
      {{this.swipeUpDismiss}}
    >
      <:body>
        {{#if this.backGestureHint.show}}
          <div
            class={{concat
              "topic-preview-modal__back-gesture-hint"
              (if this.backGestureHint.fading " topic-preview-modal__back-gesture-hint--fading" "")
            }}
            role="status"
            {{on "animationend" this.backGestureHint.handleAnimationEnd}}
          >
            {{htmlSafe (i18n (themePrefix "topic_preview.back_gesture_hint"))}}
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
                    @opPost={{this.nested.opPost}}
                    @rootNodes={{this.nested.rootNodes}}
                    @sort={{this.nested.sort}}
                    @effectiveSort={{this.nested.effectiveSort}}
                    @hasMoreRoots={{this.nested.hasMoreRoots}}
                    @loadingMore={{this.nested.loadingMore}}
                    @pinnedPostIds={{this.nested.pinnedPostIds}}
                    @loadMoreRoots={{this.nested.loadMoreRoots}}
                    @changeSort={{this.nested.changeSort}}
                    @replyToPost={{this.composerInteractions.replyToPost}}
                    @editPost={{this.composerInteractions.editPost}}
                    @deletePost={{this.postActions.deletePost}}
                    @recoverPost={{this.postActions.recoverPost}}
                    @showFlags={{this.postActions.showFlags}}
                    @showHistory={{this.postActions.showHistory}}
                    @changeNotice={{this.postActions.changeNotice}}
                    @changePostOwner={{this.postActions.changePostOwner}}
                    @grantBadge={{this.postActions.grantBadge}}
                    @lockPost={{this.postActions.lockPost}}
                    @unlockPost={{this.postActions.unlockPost}}
                    @permanentlyDeletePost={{this.postActions.permanentlyDeletePost}}
                    @rebakePost={{this.postActions.rebakePost}}
                    @showPagePublish={{this.postActions.showPagePublish}}
                    @togglePostType={{this.postActions.togglePostType}}
                    @toggleWiki={{this.postActions.toggleWiki}}
                    @unhidePost={{this.postActions.unhidePost}}
                    @fetchedChildrenCache={{this.nested.fetchedChildrenCache}}
                    @selectReplies={{this.postActions.selectReplies}}
                    @selectBelow={{this.postActions.selectBelow}}
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
                    {{this.progressNav.progressTracker}}
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
                        @changeNotice={{fn this.postActions.changeNotice tuple.post}}
                        @changePostOwner={{fn this.postActions.changePostOwner tuple.post}}
                        @deletePost={{fn this.postActions.deletePost tuple.post}}
                        @editPost={{fn this.composerInteractions.editPost tuple.post}}
                        @expandHidden={{fn this.postActions.expandHidden tuple.post}}
                        @filteringRepliesToPostNumber={{null}}
                        @grantBadge={{fn this.postActions.grantBadge tuple.post}}
                        @lockPost={{fn this.postActions.lockPost tuple.post}}
                        @permanentlyDeletePost={{fn this.postActions.permanentlyDeletePost tuple.post}}
                        @rebakePost={{fn this.postActions.rebakePost tuple.post}}
                        @recoverPost={{fn this.postActions.recoverPost tuple.post}}
                        @removeAllowedGroup={{this.postActions.removeAllowedGroup}}
                        @removeAllowedUser={{this.postActions.removeAllowedUser}}
                        @replyToPost={{fn this.composerInteractions.replyToPost tuple.post}}
                        @selectBelow={{fn this.postActions.selectBelow tuple.post}}
                        @selectReplies={{fn this.postActions.selectReplies tuple.post}}
                        @showFlags={{fn this.postActions.showFlags tuple.post}}
                        @showHistory={{fn this.postActions.showHistory tuple.post}}
                        @showInvite={{this.postActions.showInvite}}
                        @showLogin={{this.postActions.showLogin}}
                        @showPagePublish={{this.postActions.showPagePublish}}
                        @showRawEmail={{fn this.postActions.showRawEmail tuple.post}}
                        @showReadIndicator={{false}}
                        @togglePostType={{fn this.postActions.togglePostType tuple.post}}
                        @toggleWiki={{fn this.postActions.toggleWiki tuple.post}}
                        @unhidePost={{fn this.postActions.unhidePost tuple.post}}
                        @unlockPost={{fn this.postActions.unlockPost tuple.post}}
                        @cancelFilter={{this.postActions.cancelFilter}}
                        @topicPageQueryParams={{this.topicPageQueryParams}}
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

        {{#unless this.progressNav.hideProgress}}
          <TopicPreviewModalProgressBar
            @position={{this.progressNav.progressPosition}}
            @total={{this.progressNav.progressTotal}}
            @percent={{this.progressNav.progressPercent}}
            @showBackButton={{this.progressNav.showProgressBackButton}}
            @onBack={{this.progressNav.goToLastRead}}
            @onJumpStart={{this.progressNav.jumpToStart}}
            @onJumpEnd={{this.progressNav.jumpToEnd}}
            @onOpen={{this.progressNav.openScrubber}}
          />
        {{/unless}}

        {{#if this.progressNav.scrubberOpen}}
          <TopicPreviewModalProgressScrubberOverlay
            @topicModel={{this.topicModel}}
            @enteredIndex={{this.progressNav.scrubberEnteredIndex}}
            @onJumpToIndex={{this.progressNav.jumpToIndex}}
            @onJumpToStart={{this.progressNav.jumpToStart}}
            @onJumpToEnd={{this.progressNav.jumpToEnd}}
            @onClose={{this.progressNav.closeScrubber}}
          />
        {{/if}}

        <div class="topic-preview-modal__footer-content">
          {{#if (and this.currentUser this.canCreatePost)}}
            <DButton
              class="btn-primary"
              @icon="reply"
              @translatedLabel={{i18n "js.composer.reply"}}
              @action={{this.composerInteractions.replyToTopic}}
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
        @quoteState={{this.composerInteractions.quoteState}}
        @editPost={{this.composerInteractions.editPost}}
        @selectText={{this.composerInteractions.selectText}}
        @buildQuoteMarkdown={{this.composerInteractions.buildQuoteMarkdown}}
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
