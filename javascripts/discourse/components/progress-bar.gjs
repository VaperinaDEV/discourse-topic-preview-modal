import Component from "@glimmer/component";
import { concat } from "@ember/helper";
import { on } from "@ember/modifier";
import { htmlSafe } from "@ember/template";
import DButton from "discourse/components/d-button";
import { i18n } from "discourse-i18n";

export default class TopicPreviewModalProgressBar extends Component {
  <template>
    <div class="topic-preview-modal__progress-row">
      {{#if @showBackButton}}
        <DButton
          class="btn-primary btn-small topic-preview-modal__progress-back"
          @icon="arrow-down"
          @translatedLabel={{i18n "topic.timeline.back"}}
          @action={{@onBack}}
        />
      {{/if}}

      <DButton
        class="btn-flat btn-small topic-preview-modal__progress-jump"
        @icon="backward-fast"
        title={{i18n "topic_entrance.jump_top_button_title"}}
        @action={{@onJumpStart}}
      />

      <button
        type="button"
        class="topic-preview-modal__progress"
        title={{i18n "topic.progress.title"}}
        aria-label={{i18n "topic.progress.title"}}
        style={{htmlSafe (concat "--tpm-progress-width: " @percent "%")}}
        {{on "click" @onOpen}}
      >
        <span class="topic-preview-modal__progress-bg"></span>
        <span class="topic-preview-modal__progress-nums">
          <span>{{@position}}</span>
          <span>/</span>
          <span>{{@total}}</span>
        </span>
      </button>

      <DButton
        class="btn-flat btn-small topic-preview-modal__progress-jump"
        @icon="forward-fast"
        title={{i18n "topic_entrance.jump_bottom_button_title"}}
        @action={{@onJumpEnd}}
      />
    </div>
  </template>
}
