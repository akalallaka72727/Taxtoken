import fs from "fs";
import path from "path";

const REGISTRY_PATH = path.resolve("./data/tokens.json");

function ensureFile() {
  const dir = path.dirname(REGISTRY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(REGISTRY_PATH)) fs.writeFileSync(REGISTRY_PATH, "[]");
}

export function listTokens() {
  ensureFile();
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
}

export function addToken(entry) {
  ensureFile();
  const tokens = listTokens();
  tokens.push({ ...entry, createdAt: new Date().toISOString() });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(tokens, null, 2));
}

export function getToken(mint) {
  return listTokens().find((t) => t.mint === mint);
}
