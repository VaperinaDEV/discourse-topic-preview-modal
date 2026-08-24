import Component from "@glimmer/component";
import { service } from "@ember/service";
import { action } from "@ember/object";
import { modifier } from "ember-modifier";
import { bind } from "discourse/lib/decorators";
import didInsert from "@ember/render-modifiers/modifiers/did-insert";
import willDestroy from "@ember/render-modifiers/modifiers/will-destroy";
import TopicPreviewModal from "../components/modal/topic-preview-modal";
import {
  schedulePrefetch,
  discardPrefetch,
  promotePrefetch,
  trackTopicVisit,
} from "../lib/topic-preview-modal/prefetch";

export default class TopicListItemClick extends Component {
  @service modal;
  @service capabilities;

  @bind
  clickHandler(event) {
    // Find the closest .topic-list-item element
    const targetElement = event.target.closest(".topic-list-item");
    if (!targetElement) return;

    // Exclude certain selectors
    const excludedSelectors = [
      "a[data-user-card]",
      ".topic-participants a",
      ".badge-category__wrapper",
      ".discourse-tags a",
      ".topic-statuses a",
      ".bulk-select",
      ".share-toggle",
    ];
    if (excludedSelectors.some((selector) => event.target.closest(selector))) {
      return;
    }

    const topic = this.args.outletArgs.topic;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    trackTopicVisit(topic);
    promotePrefetch(topic);

    this.modal.show(TopicPreviewModal, {
      model: { topic },
    });
  }

  // Track topics already prefetched to avoid duplicate requests on re-entry.
  prefetchedTopicIds = new Set();
  prefetchDebounceTimer = null;

  willDestroy() {
    super.willDestroy(...arguments);
    clearTimeout(this.prefetchDebounceTimer);
  }

  get topic() {
    return this.args.outletArgs.topic;
  }

  // Visibility-driven prefetch (debounced) — this keeps working exactly as
  // before, it's independent of how the click that opens the modal is
  // handled.
  @action
  queueTopicPrefetch() {
    const topic = this.topic;
    if (!topic?.id || this.prefetchedTopicIds.has(topic.id)) {
      return;
    }
    this.prefetchedTopicIds.add(topic.id);
    schedulePrefetch(topic);
  }

  // 200 ms debounce: topics that only flash through the viewport are ignored.
  @action
  scheduleTopicPrefetch() {
    clearTimeout(this.prefetchDebounceTimer);
    this.prefetchDebounceTimer = setTimeout(
      () => this.queueTopicPrefetch(),
      settings.prefetch_debounce_ms
    );
  }

  @action
  cancelTopicPrefetch() {
    clearTimeout(this.prefetchDebounceTimer);
  }

  @action
  discardTopicPrefetch() {
    const topic = this.topic;
    if (!topic?.id) {
      return;
    }
    discardPrefetch(topic.id);
    this.prefetchedTopicIds.delete(topic.id);
  }

  // IntersectionObserver drives the same debounce/discard logic on touch
  // (no hover). rootMargin gives a head-start before the row enters the viewport.
  setupVisibilityPrefetch = modifier((element) => {
    const target = element.parentElement;
  
    if (!target) {
      return;
    }
  
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          this.scheduleTopicPrefetch();
        } else {
          this.cancelTopicPrefetch();
          this.discardTopicPrefetch();
        }
      },
      {
        rootMargin: `${settings.prefetch_root_margin_px}px 0px`,
        threshold: 0,
      }
    );
  
    observer.observe(target);
  
    return () => {
      observer.disconnect();
      this.cancelTopicPrefetch();
      this.discardTopicPrefetch();
    };
  });

  // Register click event handler
  @action
  registerClickHandler(element) {
    element.parentElement.addEventListener("click", this.clickHandler, true);
  }

  // Remove click event handler
  @action
  removeClickHandler(element) {
    element.parentElement.removeEventListener("click", this.clickHandler, true);
  }

  <template>
    <div
      class="hidden"
      {{didInsert this.registerClickHandler}}
      {{willDestroy this.removeClickHandler}}
      {{this.setupVisibilityPrefetch}}
    ></div>
  </template>
}
