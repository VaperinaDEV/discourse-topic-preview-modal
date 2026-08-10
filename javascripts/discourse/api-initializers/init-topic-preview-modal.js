import { apiInitializer } from "discourse/lib/api";
import TopicListItemClick from "../components/click";
import TopicPreviewButtonTrigger from "../components/button-trigger";

export default apiInitializer((api) => {
  if (settings.trigger_style === "button") {
    api.renderInOutlet(settings.plugin_outlet, TopicPreviewButtonTrigger);
  } else {
    api.renderInOutlet("topic-list-before-link", TopicListItemClick);
  }
});
