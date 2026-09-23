#!/usr/bin/env bun

if (process.argv[2] === "cli") {
  process.argv.splice(2, 1);
  await import("../cli.ts");
} else {
  await import("../server.ts");
}
