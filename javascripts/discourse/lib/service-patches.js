import { getOwner } from "@ember/owner";
import DiscourseURL from "discourse/lib/url";
import { matchTopicLink } from "./topic-link";

// Temporarily redirects shared services/singletons so core components (Post,
// PostBookmarkManager, flag/history modals) behave correctly while rendered
// inside the modal, then restores them on close:
//   modal.show/close    -> routed into the modal's own sub-modal mechanism.
//   bookmarkApi.create/update -> re-thrown on falsy result (they normally
//                           swallow errors via popupAjaxError).
//   DiscourseURL.routeTo -> same-topic links jump inside the modal instead
//                           of navigating away.
//   route:topic#modelFor -> resolves "topic" to our topicModel, since we
//                           render core's topic template without ever
//                           transitioning into the "topic" route, and
//                           TopicRoute actions (showFlagTopic etc.) call
//                           this.modelFor("topic") directly.
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
      // Navigating to a different topic: close the modal before the real
      // transition runs, rather than leaving it mounted (messageBus,
      // timing-tracker) against a topic that's no longer shown.
      component.restoreServicePatches();
      component.historyBackDismiss?.stop();
      component.closeModal();
      return this.#originalRouteTo(path, opts);
    };

    // TopicRoute actions read their model via modelFor("topic").
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
