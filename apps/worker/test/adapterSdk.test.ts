import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "../src/lib/ats/adapterSdk.js";
import { WorkdayAdapter } from "../src/lib/ats/workdayAdapter.js";
import { workdayFieldMap } from "../src/lib/ats/fieldMaps.js";

test("adapter registry resolves workday adapter by URL", () => {
  const registry = new AdapterRegistry();
  registry.register({
    manifest: {
      name: "workday",
      version: "1.0.0",
      supportedDomains: ["workday"]
    },
    adapter: new WorkdayAdapter(),
    fieldMapPack: workdayFieldMap
  });

  const resolved = registry.resolveByUrl("https://company.wd5.myworkdayjobs.com/en-US/jobs");
  assert.ok(resolved);
  assert.equal(resolved?.manifest.name, "workday");
});
