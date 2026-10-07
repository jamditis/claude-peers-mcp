import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const historicalExample = "docs/superpowers/plans/2026-06-03-reliable-peer-delivery-m1.md";
const ipv4 = /\b100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

export function tailnetAddresses(text: string): RegExpExecArray[] {
  return [...text.matchAll(ipv4)].filter((match) => {
    const [, second, third, fourth] = match;
    return Number(second) >= 64 && Number(second) <= 127 &&
      Number(third) <= 255 && Number(fourth) <= 255;
  });
}

if (import.meta.main) {
  let found = false;
  for await (const path of new Bun.Glob("docs/**/*.md").scan({ cwd: root })) {
    const text = await Bun.file(resolve(root, path)).text();
    for (const match of tailnetAddresses(text)) {
      // This existing plan uses one example address to test loopback detection.
      if (path.replaceAll("\\", "/") === historicalExample && match[0] === "100.64.0.2") continue;
      const line = text.slice(0, match.index).split("\n").length;
      console.error(`${path}:${line}: Use a 192.0.2.x documentation address.`);
      found = true;
    }
  }
  if (found) process.exitCode = 1;
}
