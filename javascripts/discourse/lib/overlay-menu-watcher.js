import { tracked } from "@glimmer/tracking";

const OPEN_SELECTOR =
  ".fk-d-menu, .fk-d-menu-modal, .fk-d-tooltip, .pswp--open, #reply-control.open";

// `component` must expose: isDestroying, isDestroyed.
export default class OverlayMenuWatcher {
  #component;
  #observer = null;
  #closeTimer = null;
  #checkScheduled = false;

  @tracked open = false;

  constructor(component) {
    this.#component = component;
  }

  start() {
    this.#observer = new MutationObserver(() => {
      if (this.#checkScheduled) {
        return;
      }
      this.#checkScheduled = true;
      requestAnimationFrame(() => {
        this.#checkScheduled = false;
        const component = this.#component;
        if (component.isDestroying || component.isDestroyed) {
          return;
        }
        this.#check();
      });
    });

    this.#observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  stop() {
    this.#observer?.disconnect();
    clearTimeout(this.#closeTimer);
  }

  // Immediate (non-debounced) sync, for callers that already know the
  // answer right now (e.g. composer state just changed).
  syncImmediate() {
    clearTimeout(this.#closeTimer);
    this.open = !!document.querySelector(OPEN_SELECTOR);
  }

  #check() {
    const isOpen = !!document.querySelector(OPEN_SELECTOR);
    if (isOpen) {
      clearTimeout(this.#closeTimer);
      this.open = true;
    } else if (this.open) {
      clearTimeout(this.#closeTimer);
      this.#closeTimer = setTimeout(() => {
        this.open = false;
      }, 400);
    }
  }
}
