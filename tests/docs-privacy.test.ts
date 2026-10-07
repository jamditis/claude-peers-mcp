import { expect, test } from "bun:test";
import { tailnetAddresses } from "../scripts/check-docs-privacy";

test("detects tailnet IPv4 addresses in documentation", () => {
  expect(tailnetAddresses("peer at 100.64.0.1")).toHaveLength(1);
  expect(tailnetAddresses("peer at 100.127.255.254")).toHaveLength(1);
  expect(tailnetAddresses("example 198.51.100.5 and 100.63.0.1")).toHaveLength(0);
  expect(tailnetAddresses("invalid 100.64.256.1 and 100.128.0.1")).toHaveLength(0);
});
