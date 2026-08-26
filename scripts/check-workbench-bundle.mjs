import { statSync } from "node:fs";
import { resolve } from "node:path";

const bundle = resolve("web/dist/workbench.js");
const maximumBytes = 450_000;
const size = statSync(bundle).size;

if (size > maximumBytes) {
  throw new Error(
    `CPTR Live Workbench bundle is ${size} bytes; production limit is ${maximumBytes} bytes. ` +
      "Check that React production mode and minification are enabled.",
  );
}
console.log(`CPTR Live Workbench production bundle: ${size} bytes (limit ${maximumBytes})`);
