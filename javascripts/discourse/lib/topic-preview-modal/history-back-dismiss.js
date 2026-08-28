// Handles native mobile Back as modal dismissal.
// Uses a same-URL history entry so Back closes the modal without
// navigating away from the underlying page.
//
// Ember's router also reacts to the resulting popstate, so same-route
// transitions are aborted to prevent the progress bar and scroll reset.
//
// When the modal closes another way, the history entry is cleaned up
// without affecting the real navigation history.
export default class TopicPreviewHistoryBackDismiss {
  #onDismiss;
  #router;
  #pushed = false;
  #consumedByPopState = false;
  #stopped = false;
  #cleanupInFlight = false;
  #cleanupFallbackTimer = null;
  #abortingRouteChange = false;

  constructor(onDismiss, router) {
    this.#onDismiss = onDismiss;
    this.#router = router;
  }

  start() {
    if (this.#pushed) {
      return;
    }
    try {
      history.pushState({ topicPreviewModal: true }, "", location.href);
      this.#pushed = true;
    } catch {
      // Fall back to normal modal behavior if history is unavailable.
      return;
    }
    window.addEventListener("popstate", this.#handlePopState);
    this.#router?.on("routeWillChange", this.#handleRouteWillChange);
  }

  // Abort same-route transitions to prevent the progress bar and scroll reset.
  // Guard against recursive route changes triggered by transition.abort().
  #handleRouteWillChange = (transition) => {
    if (this.#abortingRouteChange) {
      return;
    }

    const targetName = transition.to?.name;
    if (targetName == null || targetName !== this.#router?.currentRouteName) {
      return;
    }

    this.#abortingRouteChange = true;
    try {
      transition.abort();
    } finally {
      this.#abortingRouteChange = false;
    }
  };

  #handlePopState = () => {
    if (this.#cleanupInFlight) {
      // Ignore the cleanup pop; the modal is already closing.
      this.#cleanupInFlight = false;
      clearTimeout(this.#cleanupFallbackTimer);
      this.#detach();
      return;
    }
    this.#consumedByPopState = true;
    this.#onDismiss();
  };

  #detach() {
    window.removeEventListener("popstate", this.#handlePopState);
    this.#router?.off("routeWillChange", this.#handleRouteWillChange);
  }

  // Safe to call during navigation or modal teardown.
  stop() {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;

    if (this.#pushed) {
      // Remove our history marker without traversing browser history.
      try {
        if (window.history.state?.topicPreviewModal) {
          const state = { ...window.history.state };
          delete state.topicPreviewModal;
          window.history.replaceState(state, "", window.location.href);
        }
      } catch {
        // History is only an enhancement; never let cleanup break navigation.
      }
      this.#pushed = false;
    }

    this.#detach();
  }
}
