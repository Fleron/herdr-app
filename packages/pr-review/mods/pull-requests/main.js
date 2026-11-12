import { View } from "gpui-kit";
import { props } from "herdr";
import List from "./list.js";
import Review from "./review.js";
import Compose from "./compose.js";

export default class PullRequests extends View {
  init(p, cx) {
    const Role = props()?.role === "compose" ? Compose : props()?.role === "review" ? Review : List;
    this.content = new Role();
    this.content.init(p, cx);
  }
  render(cx) { return this.content.render(cx); }
  async close(cx) { await this.content.close?.(cx); }
}
