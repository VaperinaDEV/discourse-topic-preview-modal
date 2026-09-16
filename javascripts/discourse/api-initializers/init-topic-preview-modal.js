import { apiInitializer } from "discourse/lib/api";
import TopicListItemClick from "../components/click";
import TopicPreviewButtonTrigger from "../components/button-trigger";
import { installGlobalTopicLinkInterceptor } from "../lib/global-link-interceptor";
import { installMoreTopicsTabsGuard } from "../lib/more-topics-tabs-guard";

export default apiInitializer((api) => {
  // Must run before the device check: the modal renders core's <Nested>, which
  // mounts a second <MoreTopics> on top of the page's own one, and core's
  // more-topics-tabs service is a singleton that can only serve one.
  // See lib/more-topics-tabs-guard.js for the full write-up.
  installMoreTopicsTabsGuard(api.container);

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
