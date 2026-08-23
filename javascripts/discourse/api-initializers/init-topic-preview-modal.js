import { apiInitializer } from "discourse/lib/api";
import TopicListItemClick from "../components/click";
import TopicPreviewButtonTrigger from "../components/button-trigger";
import { installGlobalTopicLinkInterceptor } from "../lib/topic-preview-modal/global-link-interceptor";

export default apiInitializer((api) => {
  const capabilities = api.container.lookup("capabilities:main");
  const isMobile = capabilities.isMobileDevice;
  const allowedOnThisDevice =
    settings.enabled_on === "both" ||
    (settings.enabled_on === "mobile" && isMobile) ||
    (settings.enabled_on === "desktop" && !isMobile);

  if (!allowedOnThisDevice) {
    return;
  }

  if (settings.trigger_style === "button") {
    api.renderInOutlet(settings.plugin_outlet, TopicPreviewButtonTrigger);
  } else {
    api.renderInOutlet("above-topic-list-item", TopicListItemClick);
  }

  if (settings.open_all_topic_links) {
    installGlobalTopicLinkInterceptor(api);
  }
});
