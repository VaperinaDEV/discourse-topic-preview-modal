import { getOwner } from "@ember/owner";
import DiscourseURL from "discourse/lib/url";
import { matchTopicLink } from "./topic-link";

// Temporarily redirects a few shared services/singletons so that core
// components (Post, PostBookmarkManager, flag/history/etc. modals) behave
// correctly while rendered *inside* the topic-preview-modal, then restores
// them when the modal closes.
//
//   - modal.show()      -> routed into the modal's own local sub-modal
//                           mechanism (component.showSubModal), so opening
//                           e.g. the flag modal doesn't close the preview.
//   - modal.close()     -> foreign close calls (e.g. a mobile DMenuInstance)
//                           are swallowed unless self-initiated by the modal
//                           itself, or close the active sub-modal instead.
//   - bookmarkApi.create/update -> re-throw on falsy result, since these
//                           normally swallow errors via popupAjaxError and
//                           return undefined, which would otherwise cause a
//                           secondary error inside PostBookmarkManager.
//   - DiscourseURL.routeTo -> same-topic links are intercepted and jump
//                           inside the modal instead of navigating away.
//   - route:topic#modelFor -> "topic" resolves to our topicModel instead
//                           of undefined. We render core's topic template
//                           without ever transitioning the router into the
//                           "topic" route, so any TopicRoute @action
//                           calling `this.modelFor("topic")`
//                           (showFlagTopic, showPagePublish,
//                           showTopicTimerModal, etc.) would otherwise get
//                           undefined and crash - confirmed against core
//                           source, e.g. showFlagTopic passes that model
//                           straight to FlagModal as `flagModel`.
//
// `component` must expose: modal, bookmarkApi (services), topicModel,
// selfInitiatedClose, activeSubModal, topicId, showSubModal(),
// closeSubModal(), jumpToPost().
export default class TopicPreviewServicePatches {
  #component;
  #originalModalShow = null;
  #originalModalClose = null;
  #originalBookmarkCreate = null;
  #originalBookmarkUpdate = null;
  #originalRouteTo = null;
  #originalModelFor = null;
  #topicRoute = null;
  #restored = false;

  constructor(component) {
    this.#component = component;
    this.#apply();
  }

  #apply() {
    const component = this.#component;
    const { modal, bookmarkApi } = component;

    // Redirect core modal.show() calls to our local sub-modal mechanism.
    this.#originalModalShow = modal.show.bind(modal);
    modal.show = (modalComponent, opts = {}) => {
      return component.showSubModal(modalComponent, opts.model);
    };

    // Swallow foreign modal.close() (e.g. mobile DMenuInstance) so they
    // don't close the topic-preview-modal. Only pass through self-initiated
    // closes, or close our own activeSubModal when present.
    this.#originalModalClose = modal.close.bind(modal);
    modal.close = (...args) => {
      if (component.selfInitiatedClose) {
        return this.#originalModalClose(...args);
      }
      if (component.activeSubModal) {
        component.closeSubModal();
        return Promise.resolve();
      }
      return Promise.resolve();
    };

    // bookmarkApi.create/update swallow errors with popupAjaxError and
    // return undefined; re-throw so PostBookmarkManager doesn't hit a
    // secondary error.
    this.#originalBookmarkCreate = bookmarkApi.create.bind(bookmarkApi);
    bookmarkApi.create = (...args) => {
      return this.#originalBookmarkCreate(...args).then((result) => {
        if (!result) {
          throw new Error("bookmark-create-failed");
        }
        return result;
      });
    };
    this.#originalBookmarkUpdate = bookmarkApi.update.bind(bookmarkApi);
    bookmarkApi.update = (...args) => {
      return this.#originalBookmarkUpdate(...args).then((result) => {
        if (!result) {
          throw new Error("bookmark-update-failed");
        }
        return result;
      });
    };

    // Intercept DiscourseURL.routeTo for same-topic links -> jump inside modal.
    this.#originalRouteTo = DiscourseURL.routeTo.bind(DiscourseURL);
    DiscourseURL.routeTo = (path, opts) => {
      if (typeof path === "string") {
        const match = matchTopicLink(path);
        if (match && match.topicId === component.topicId) {
          component.jumpToPost(match.postNumber ?? 1);
          return Promise.resolve();
        }
      }
      // Navigating away to a genuinely different topic. Restoring the
      // service patches alone isn't enough here - the modal itself must
      // be fully closed/destroyed *before* the real route transition
      // runs. Otherwise it stays mounted against the topic that's no
      // longer shown: its messageBus subscription and timing-tracker
      // interval (which periodically swaps topicController.model back
      // and forth, see timing-tracker.js) keep firing against the old
      // topic, racing with the freshly-entered real topic route's own
      // presence/screen-track/post-stream setup for the new one. That
      // race is what produces "PresenceChannel not found", 404s from
      // /topics/timings, and null errors in currentPostChanged.
      component.restoreServicePatches();
      component.closeModal();
      return this.#originalRouteTo(path, opts);
    };

    // TopicRoute actions read their model via modelFor("topic"), not
    // topicController - see class comment above.
    const topicRoute = getOwner(component)?.lookup?.("route:topic");
    if (topicRoute) {
      this.#topicRoute = topicRoute;
      this.#originalModelFor = topicRoute.modelFor.bind(topicRoute);
      topicRoute.modelFor = (name) => {
        if (name === "topic" && component.topicModel) {
          return component.topicModel;
        }
        return this.#originalModelFor(name);
      };
    }
  }

  // Idempotent restore of all patched methods. Safe to call multiple times.
  restore() {
    if (this.#restored) {
      return;
    }
    this.#restored = true;

    const component = this.#component;

    try {
      if (this.#originalModalShow) {
        component.modal.show = this.#originalModalShow;
      }
    } catch {
      // ignore
    }
    try {
      if (this.#originalModalClose) {
        component.modal.close = this.#originalModalClose;
      }
    } catch {
      // ignore
    }
    try {
      if (this.#originalBookmarkCreate) {
        component.bookmarkApi.create = this.#originalBookmarkCreate;
      }
    } catch {
      // ignore
    }
    try {
      if (this.#originalBookmarkUpdate) {
        component.bookmarkApi.update = this.#originalBookmarkUpdate;
      }
    } catch {
      // ignore
    }
    try {
      if (this.#originalRouteTo) {
        DiscourseURL.routeTo = this.#originalRouteTo;
      }
    } catch {
      // ignore
    }
    try {
      if (this.#originalModelFor && this.#topicRoute) {
        this.#topicRoute.modelFor = this.#originalModelFor;
      }
    } catch {
      // ignore
    }
  }
}
