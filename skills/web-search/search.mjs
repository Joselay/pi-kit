#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PROVIDER_ID = "openai-codex";
// Pinned to a current model on the OAuth responses endpoint that supports the
// hosted web_search tool.
const SEARCH_MODEL = "gpt-5.6-luna";
// Upstream models.json marks gpt-5.6-luna as web_search_tool_type
// "text_and_image", so codex always sends both content types for it.
const SEARCH_CONTENT_TYPES = ["text", "image"];
const MODES = ["cached", "indexed", "live"];
const CONTEXT_SIZES = ["low", "medium", "high"];
const MAX_REQUEST_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 200;

function usage() {
  console.log(`Usage:
  search.mjs --query <text> [options]
  search.mjs --query-file <file> [options]

Options:
  --mode <cached|indexed|live>       Web access mode (default: cached, like upstream)
  --allowed-domains <a,b,...>        Restrict search results to these domains
  --search-context-size <low|medium|high>
                                     How much search context the tool retrieves
  --country <ISO code>               Approximate user location for result ranking
  --region <text>                    Approximate user region
  --city <text>                      Approximate user city
  --timezone <IANA tz>               Approximate user timezone
  --json                             Print structured JSON instead of text
  --help                             Show this help

Like the upstream built-in web_search tool, the search runs server-side through
the configured OAuth subscription. The answer is printed with the searches that
were performed and a numbered source list.`);
}

function fail(message) {
  console.error(`web-search: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    query: undefined,
    queryFile: undefined,
    mode: "cached",
    allowedDomains: undefined,
    searchContextSize: undefined,
    country: undefined,
    region: undefined,
    city: undefined,
    timezone: undefined,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) fail(`missing value for ${arg}`);
    switch (arg) {
      case "--query":
        args.query = value;
        break;
      case "--query-file":
        args.queryFile = value;
        break;
      case "--mode":
        if (!MODES.includes(value)) fail(`--mode must be one of: ${MODES.join(", ")}`);
        args.mode = value;
        break;
      case "--allowed-domains":
        args.allowedDomains = value.split(",").map((domain) => domain.trim()).filter(Boolean);
        break;
      case "--search-context-size":
        if (!CONTEXT_SIZES.includes(value)) {
          fail(`--search-context-size must be one of: ${CONTEXT_SIZES.join(", ")}`);
        }
        args.searchContextSize = value;
        break;
      case "--country":
        args.country = value;
        break;
      case "--region":
        args.region = value;
        break;
      case "--city":
        args.city = value;
        break;
      case "--timezone":
        args.timezone = value;
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function locatePiIndex() {
  const explicit = process.env.PI_CODING_AGENT_MODULE;
  if (explicit) return explicit;

  let piExecutable;
  try {
    piExecutable = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
  } catch {
    fail("could not locate the pi executable; set PI_CODING_AGENT_MODULE to pi's dist/index.js");
  }
  if (!piExecutable) fail("could not locate the pi executable");

  const cliPath = realpathSync(piExecutable);
  return join(dirname(cliPath), "index.js");
}

async function resolveOAuth() {
  const moduleUrl = pathToFileURL(locatePiIndex()).href;
  const { ModelRuntime } = await import(moduleUrl);
  const runtime = await ModelRuntime.create();

  const authCheck = await runtime.checkAuth(PROVIDER_ID);
  if (!runtime.isUsingOAuth(PROVIDER_ID) || authCheck?.type !== "oauth") {
    fail("web-search OAuth is not configured; run /login in pi");
  }

  const result = await runtime.getAuth(PROVIDER_ID);
  const token = result?.auth?.apiKey;
  if (!token) fail("web-search OAuth could not be resolved; run /login again");

  const provider = runtime.getProvider(PROVIDER_ID);
  const baseUrl = result.auth.baseUrl ?? provider?.baseUrl;
  if (!baseUrl) fail("web-search provider is unavailable");

  return { token, baseUrl };
}

function accountIdFromToken(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("not a JWT");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof accountId !== "string" || accountId.length === 0) {
      throw new Error("account ID claim missing");
    }
    return accountId;
  } catch {
    fail("web-search OAuth is invalid; run /login again");
  }
}

function endpointFor(baseUrl) {
  const normalized = baseUrl.replace(/\/+$/, "");
  const codexBase = normalized.endsWith("/codex") ? normalized : `${normalized}/codex`;
  return `${codexBase}/responses`;
}

// Mirrors upstream create_web_search_tool: cached -> no external access,
// indexed -> live fetches restricted to indexed URLs, live -> unrestricted.
function webSearchTool({ mode, allowedDomains, searchContextSize, country, region, city, timezone }) {
  const tool = { type: "web_search" };
  if (mode === "cached") tool.external_web_access = false;
  if (mode === "indexed") {
    tool.external_web_access = true;
    tool.indexed_web_access = true;
  }
  if (mode === "live") tool.external_web_access = true;
  if (allowedDomains?.length) tool.filters = { allowed_domains: allowedDomains };
  if (country || region || city || timezone) {
    tool.user_location = {
      type: "approximate",
      ...(country && { country }),
      ...(region && { region }),
      ...(city && { city }),
      ...(timezone && { timezone }),
    };
  }
  if (searchContextSize) tool.search_context_size = searchContextSize;
  tool.search_content_types = SEARCH_CONTENT_TYPES;
  return tool;
}

function retryDelay(attempt) {
  const exponential = RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1));
  return exponential * (0.9 + Math.random() * 0.2);
}

async function fetchWithRetries(url, options) {
  for (let attempt = 0; attempt <= MAX_REQUEST_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.status < 500 || attempt === MAX_REQUEST_RETRIES) return response;
      await response.body?.cancel();
    } catch (error) {
      if (attempt === MAX_REQUEST_RETRIES) throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelay(attempt + 1)));
  }
  throw new Error("web-search request exhausted its retry limit");
}

async function responseError(response) {
  const text = await response.text();
  const compact = text.replace(/\s+/g, " ").trim().slice(0, 2000);
  return `request failed (${response.status} ${response.statusText})${compact ? `: ${compact}` : ""}`;
}

function searchActionDetail(action) {
  if (!action) return "";
  switch (action.type) {
    case "search": {
      if (action.query) return action.query;
      const queries = action.queries ?? [];
      if (queries.length > 1) return `${queries[0]} ...`;
      return queries[0] ?? "";
    }
    case "open_page":
      return action.url ? `open ${action.url}` : "";
    case "find_in_page":
      return [action.pattern && `'${action.pattern}'`, action.url && `in ${action.url}`]
        .filter(Boolean)
        .join(" ");
    default:
      return "";
  }
}

// The backend wraps citation markers in Unicode private-use characters; the
// citations themselves are reported separately as url_citation annotations.
function cleanText(text) {
  return text
    .replace(/\uE200[^\uE201]*\uE201/g, "")
    .replace(/[\uE000-\uF8FF]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffered.indexOf("\n\n")) !== -1) {
      const rawEvent = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const data = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data);
      } catch {
        // Ignore malformed keep-alive frames.
      }
    }
  }
}

async function collectResult(body) {
  const searches = [];
  const sources = [];
  const seenUrls = new Set();
  let answer = "";
  let completed = false;

  for await (const event of sseEvents(body)) {
    switch (event.type) {
      case "response.output_item.done": {
        const item = event.item;
        if (item?.type === "web_search_call") {
          const detail = searchActionDetail(item.action);
          if (detail) searches.push(detail);
        }
        if (item?.type === "message" && item.role === "assistant") {
          for (const part of item.content ?? []) {
            if (part.type !== "output_text") continue;
            answer += part.text ?? "";
            for (const annotation of part.annotations ?? []) {
              if (annotation.type !== "url_citation" || !annotation.url) continue;
              if (seenUrls.has(annotation.url)) continue;
              seenUrls.add(annotation.url);
              sources.push({ title: annotation.title ?? "", url: annotation.url });
            }
          }
        }
        break;
      }
      case "response.completed":
        completed = true;
        break;
      case "response.failed":
        throw new Error(event.response?.error?.message ?? "the web-search request failed");
      case "error":
        throw new Error(event.message ?? "the web-search stream reported an error");
      default:
        break;
    }
  }

  if (!completed && !answer) throw new Error("the web-search stream ended without a result");
  return { searches, answer: cleanText(answer), sources };
}

const args = parseArgs(process.argv.slice(2));

try {
  if (Boolean(args.query) === Boolean(args.queryFile)) {
    fail("provide exactly one of --query or --query-file");
  }
  const query = (args.query ?? await readFile(resolve(args.queryFile), "utf8")).trim();
  if (!query) fail("query must not be empty");

  const { token, baseUrl } = await resolveOAuth();
  const requestBody = {
    model: SEARCH_MODEL,
    instructions:
      "You are a web search assistant. Always use the web_search tool to research " +
      "the query before answering; never answer from memory alone. Report what the " +
      "sources say, concisely and factually, quoting exact figures, versions, and " +
      "dates. Cite a source for every claim. If sources conflict or are stale, say " +
      "so. Do not pad the answer with generic advice.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: query }],
      },
    ],
    tools: [webSearchTool(args)],
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "low" },
    store: false,
    stream: true,
    include: [],
  };

  const response = await fetchWithRetries(endpointFor(baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "chatgpt-account-id": accountIdFromToken(token),
      originator: "pi",
      "session-id": randomUUID(),
      accept: "text/event-stream",
      "content-type": "application/json",
      "user-agent": `pi-web-search-skill (${process.platform}; ${process.arch})`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) fail(await responseError(response));
  if (!response.body) fail("the web-search endpoint returned no response stream");

  const result = await collectResult(response.body);
  if (!result.answer) fail("the web-search endpoint returned no answer text");

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.searches.length) {
      console.log(`Searched: ${[...new Set(result.searches)].join("; ")}\n`);
    }
    console.log(result.answer);
    if (result.sources.length) {
      console.log("\nSources:");
      result.sources.forEach((source, index) => {
        console.log(`  [${index + 1}] ${source.title ? `${source.title} — ` : ""}${source.url}`);
      });
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
