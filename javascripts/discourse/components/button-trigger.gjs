import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { action } from "@ember/object";
import { on } from "@ember/modifier";
import { service } from "@ember/service";
import { modifier } from "ember-modifier";
import icon from "discourse/helpers/d-icon";
import { i18n } from "discourse-i18n";
import TopicPreviewModal from "./modal/topic-preview-modal";
import {
  schedulePrefetch,
  discardPrefetch,
  promotePrefetch,
  trackTopicVisit,
} from "../lib/topic-preview-modal/prefetch";
import { triggerHaptic } from "../lib/topic-preview-modal/haptic";

// Explicit trigger icon (settings.trigger_style === "button").
// Unlike click.gjs this does not overlay the row — title link and other
// outlets keep working as core ships them. Shares TopicPreviewModal +
// prefetch/timing-tracker/service-patches with the click trigger.
export default class TopicPreviewButtonTrigger extends Component {
  @service modal;
  @service capabilities;

  @tracked isActivating = false;

  get topic() {
    return this.args.outletArgs.topic;
  }

  // Visibility-driven prefetch (debounced upstream in schedulePrefetch).
  setupVisibilityPrefetch = modifier((element) => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          schedulePrefetch(this.topic);
        } else {
          discardPrefetch(this.topic?.id);
        }
      },
      { rootMargin: `${settings.prefetch_root_margin_px}px 0px`, threshold: 0 }
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
      discardPrefetch(this.topic?.id);
    };
  });

  @action
  async openPreview(event) {
    if (this.isActivating) {
      return;
    }
    event?.preventDefault();
    event?.stopPropagation();

    this.isActivating = true;

    await new Promise((resolve) => setTimeout(resolve, 40));

    const topic = this.topic;

    trackTopicVisit(topic);
    promotePrefetch(topic);

    triggerHaptic(this.capabilities, "open");

    try {
      await this.modal.show(TopicPreviewModal, {
        model: { topic },
      });
    } finally {
      this.isActivating = false;
    }
  }

  <template>
    <div
      class="topic-preview-modal__trigger-wrapper"
      {{this.setupVisibilityPrefetch}}
    >
      {{#if this.isActivating}}
        <span
          class="topic-preview-modal__trigger-wrapper--loading"
        >
          {{icon "spinner"}}
        </span>
      {{else}}
        <span
          {{on "click" this.openPreview}}
          title={{i18n (themePrefix "topic_preview.modal_trigger")}}
          role="button"
          tabindex="0"
          class="topic-preview-modal__trigger-wrapper--button"
        >
          {{icon "expand"}}
        </span>
      {{/if}}
    </div>
  </template>
}
