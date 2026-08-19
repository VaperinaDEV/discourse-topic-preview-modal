import { apiInitializer } from "discourse/lib/api";
import TopicListItemClick from "../components/click";
import TopicPreviewButtonTrigger from "../components/button-trigger";
import { installGlobalTopicLinkInterceptor } from "../lib/topic-preview-modal/global-link-interceptor";

export default apiInitializer((api) => {
  if (settings.trigger_style === "button") {
    api.renderInOutlet(settings.plugin_outlet, TopicPreviewButtonTrigger);
  } else {
    api.renderInOutlet("topic-list-before-link", TopicListItemClick);
  }

  if (settings.open_all_topic_links) {
    installGlobalTopicLinkInterceptor(api);
  }
});
