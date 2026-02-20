#!/usr/bin/env node
/**
 * opencode-session-memory CLI
 *
 * Usage:
 *   npx opencode-session-memory install   — install plugin, skill and initialise DB
 *   npx opencode-session-memory status    — show installation status
 *   npx opencode-session-memory uninstall — remove plugin and skill files
 */

import fs from "fs";
import path from "path";
import os from "os";
import { resolveDbPath, openDatabase } from "./database";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getOpenCodeConfigDir(): string {
  // Respect OPENCODE_CONFIG_DIR if set
  const envDir = process.env.OPENCODE_CONFIG_DIR;
  if (envDir) return envDir;
  return path.join(os.homedir(), ".config", "opencode");
}

function getPluginDir(): string {
  return path.join(getOpenCodeConfigDir(), "plugins");
}

function getSkillDir(): string {
  return path.join(getOpenCodeConfigDir(), "skills");
}

function getPluginDst(): string {
  return path.join(getPluginDir(), "opencode-session-memory.ts");
}

function getSkillDst(): string {
  return path.join(getSkillDir(), "opencode-session-memory.md");
}

// The installed package location
function getPackageRoot(): string {
  // __dirname is dist/src/ after build, so go two levels up
  return path.resolve(__dirname, "..", "..");
}

function getPluginSrc(): string {
  return path.join(getPackageRoot(), "plugin", "memory.ts");
}

function getSkillSrc(): string {
  return path.join(getPackageRoot(), "skill", "memory.md");
}

function getMcpServerPath(): string {
  return path.join(getPackageRoot(), "dist", "mcp", "index.js");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src: string, dst: string): void {
  if (!fs.existsSync(src)) {
    throw new Error(`Source file not found: ${src}\nDid you run "npm run build" first?`);
  }
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

/**
 * Copies the plugin template, replacing the OPENCODE_MEMORY_INDEXER_PATH
 * placeholder with the absolute path to the compiled indexer-cli.js so it
 * resolves correctly when Bun executes the plugin from
 * ~/.config/opencode/plugins/.
 */
function installPlugin(src: string, dst: string): void {
  if (!fs.existsSync(src)) {
    throw new Error(`Plugin source not found: ${src}\nDid you run "npm run build" first?`);
  }
  const indexerCliPath = path.join(getPackageRoot(), "dist", "src", "indexer-cli.js");
  let content = fs.readFileSync(src, "utf8");
  // Replace the placeholder string literal with the absolute path to the indexer CLI
  content = content.replace(
    '"OPENCODE_MEMORY_INDEXER_PATH"',
    JSON.stringify(indexerCliPath),
  );
  ensureDir(path.dirname(dst));
  fs.writeFileSync(dst, content, "utf8");
}

function checkMark(ok: boolean): string {
  return ok ? "✓" : "✗";
}

function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}

function green(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}

function red(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}

function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function install(): void {
  console.log(bold("\nopencode-session-memory install\n"));

  const dbPath = resolveDbPath();
  const pluginDst = getPluginDst();
  const skillDst = getSkillDst();

  // 1. Initialise the database
  process.stdout.write("  Initialising database... ");
  try {
    ensureDir(path.dirname(dbPath));
    const db = openDatabase({ dbPath });
    db.close();
    console.log(green("done") + dim(` (${dbPath})`));
  } catch (err: unknown) {
    console.log(red("failed"));
    console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // 2. Install plugin
  process.stdout.write("  Installing plugin... ");
  try {
    installPlugin(getPluginSrc(), pluginDst);
    console.log(green("done") + dim(` (${pluginDst})`));
  } catch (err: unknown) {
    console.log(red("failed"));
    console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // 3. Install skill
  process.stdout.write("  Installing skill... ");
  try {
    copyFile(getSkillSrc(), skillDst);
    console.log(green("done") + dim(` (${skillDst})`));
  } catch (err: unknown) {
    console.log(red("failed"));
    console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // 4. Print MCP config
  const mcpPath = getMcpServerPath();
  console.log(`
${bold("Installation complete!")}

${bold("Add the MCP server to your opencode config")} (~/.config/opencode/opencode.json):

  ${dim('{')}
    ${dim('"mcp":')} ${dim('{')}
      ${dim('"opencode-session-memory":')} ${dim('{')}
        ${dim('"type": "local",')}
        ${dim(`"command": ["node", "${mcpPath}"]`)}
      ${dim('}')}\n    ${dim('}')}\n  ${dim('}')}

${bold("Environment variables required:")}
  OPENAI_API_KEY            — required for embedding generation
  OPENCODE_MEMORY_DB_PATH   — optional, overrides default DB path

${bold("Default DB path:")} ${dbPath}

Sessions will be automatically indexed after each agent turn.
Run ${bold("npx opencode-session-memory status")} to verify installation.
`);
}

function status(): void {
  console.log(bold("\nopencode-session-memory status\n"));

  const dbPath = resolveDbPath();
  const pluginDst = getPluginDst();
  const skillDst = getSkillDst();
  const mcpPath = getMcpServerPath();

  const dbExists = fs.existsSync(dbPath);
  const pluginExists = fs.existsSync(pluginDst);
  const skillExists = fs.existsSync(skillDst);
  const mcpExists = fs.existsSync(mcpPath);

  const ok = (v: boolean) => v ? green(checkMark(true)) : red(checkMark(false));

  console.log(`  ${ok(dbExists)}  Database       ${dim(dbPath)}`);
  console.log(`  ${ok(pluginExists)}  Plugin         ${dim(pluginDst)}`);
  console.log(`  ${ok(skillExists)}  Skill          ${dim(skillDst)}`);
  console.log(`  ${ok(mcpExists)}  MCP server     ${dim(mcpPath)}`);

  if (dbExists) {
    try {
      const db = openDatabase({ dbPath });
      const countRow = db.prepare("SELECT COUNT(*) as n FROM vec_items").get() as { n: number };
      const sessRow = db.prepare("SELECT COUNT(*) as n FROM sessions_meta").get() as { n: number };
      db.close();
      console.log(`\n  ${dim("Indexed chunks:  ")}${countRow.n}`);
      console.log(`  ${dim("Sessions tracked:")} ${sessRow.n}`);
    } catch {
      // DB might be empty/uninitialised
    }
  }

  const allOk = dbExists && pluginExists && skillExists && mcpExists;
  console.log(`\n  ${allOk ? green("All components installed.") : red("Some components missing — run \"npx opencode-session-memory install\".")}`);
  console.log();
}

function uninstall(): void {
  console.log(bold("\nopencode-session-memory uninstall\n"));

  const pluginDst = getPluginDst();
  const skillDst = getSkillDst();

  for (const [label, filePath] of [["Plugin", pluginDst], ["Skill", skillDst]] as const) {
    process.stdout.write(`  Removing ${label}... `);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(green("done"));
    } else {
      console.log(dim("not found"));
    }
  }

  console.log(`
  ${dim("Note: the database was NOT removed.")}
  ${dim(`To delete it: rm "${resolveDbPath()}"`)}
`);
}

function help(): void {
  console.log(`
${bold("opencode-session-memory")} — Vector memory for OpenCode sessions

${bold("Usage:")}
  npx opencode-session-memory install    Install plugin, skill and initialise the DB
  npx opencode-session-memory status     Show installation status and DB stats
  npx opencode-session-memory uninstall  Remove plugin and skill files (keeps DB)
  npx opencode-session-memory help       Show this help

${bold("Environment variables:")}
  OPENAI_API_KEY            Required for embedding generation
  OPENCODE_MEMORY_DB_PATH   Override the default DB path
  OPENCODE_CONFIG_DIR       Override the OpenCode config directory
`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const cmd = process.argv[2] ?? "help";

switch (cmd) {
  case "install":
    install();
    break;
  case "status":
    status();
    break;
  case "uninstall":
    uninstall();
    break;
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    help();
    process.exit(1);
}
