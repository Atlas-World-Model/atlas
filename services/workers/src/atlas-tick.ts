import { runAtlasTick } from "../../../packages/agent/src/index.js";

const result = await runAtlasTick();

console.log(JSON.stringify({
  event: "atlas.tick",
  ...result,
}, null, 2));
