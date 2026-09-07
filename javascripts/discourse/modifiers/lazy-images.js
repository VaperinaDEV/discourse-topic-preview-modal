import { modifier } from "ember-modifier";

// Marks any not-yet-annotated <img> inside `element` as lazy/async-decoded.
// Stateless - safe to share across every post-wrapper element.
export default modifier((element) => {
  const imgs = element.querySelectorAll("img:not([loading])");
  imgs.forEach((img) => {
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
  });
});
