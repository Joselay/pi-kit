import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PROVIDER_ID = "openai-codex";
const IMAGE_MODELS = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"];
const MAX_EDIT_IMAGES = 5;
const MAX_REQUEST_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 200;

function usage() {
  console.log(`Usage:
  imagegen.mjs --model <model> --prompt <text>
  imagegen.mjs --model <model> --prompt-file <file>
  imagegen.mjs --model <model> --prompt <text> --input <image> [--input <image> ...]

Options:
  --model <model> Required: ${IMAGE_MODELS.join(" or ")}; no default
  --input <path>  Edit/use a source image; repeat up to ${MAX_EDIT_IMAGES} times
  --help          Show this help

Requests send the model, prompt, any input images, and explicit auto settings
for background, quality, and size. Describe the desired output in the prompt.
Uses Pi's existing OpenAI OAuth login; API keys are not supported.
The image is saved under $PI_HOME/generated_images/ (default: ~/.pi/generated_images/)
with a unique name, and the path is printed.`);
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const args = {
    model: undefined,
    prompt: undefined,
    promptFile: undefined,
    inputs: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${arg}`);
    switch (arg) {
      case "--model":
        args.model = value;
        break;
      case "--prompt":
        args.prompt = value;
        break;
      case "--prompt-file":
        args.promptFile = value;
        break;
      case "--input":
        args.inputs.push(value);
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
    fail("image-generation OAuth is not configured; run /login in pi");
  }

  const result = await runtime.getAuth(PROVIDER_ID);
  const token = result?.auth?.apiKey;
  if (!token) fail("image-generation OAuth could not be resolved; run /login again");

  const provider = runtime.getProvider(PROVIDER_ID);
  const baseUrl = result.auth.baseUrl ?? provider?.baseUrl;
  if (!baseUrl) fail("image-generation provider is unavailable");

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
    fail("image-generation OAuth is invalid; run /login again");
  }
}

function endpointFor(baseUrl, editing) {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (url.origin !== "https://chatgpt.com" || url.username || url.password
      || url.search || url.hash
      || !["/backend-api", "/backend-api/codex"].includes(path)) {
    fail("refusing to send OAuth credentials to an unsupported provider URL");
  }
  return `${url.origin}/backend-api/codex/images/${editing ? "edits" : "generations"}`;
}

function imageMediaType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  fail("unsupported input image format; use PNG, JPEG, WebP, or GIF");
}

async function imageDataUrl(path) {
  const bytes = await readFile(resolve(path));
  return { image_url: `data:${imageMediaType(bytes)};base64,${bytes.toString("base64")}` };
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
      const payload = await response.clone().json().catch(() => undefined);
      const error = payload?.error;
      if (error?.type === "image_generation_user_error"
          || [error?.code, error?.type].some((value) =>
            ["moderation_blocked", "insufficient_quota", "usage_limit_reached"]
              .includes(value))) return response;
      await response.body?.cancel();
    } catch (error) {
      if (attempt === MAX_REQUEST_RETRIES) throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelay(attempt + 1)));
  }
  throw new Error("image request exhausted its retry limit");
}

async function responseError(response) {
  const text = await response.text();
  const compact = text.replace(/\s+/g, " ").trim().slice(0, 2000);
  const requestId = response.headers.get("x-codex-imagegen-request-id")
    ?? response.headers.get("x-request-id");
  const loginHint = response.status === 401 ? "; run /login in pi" : "";
  return `request failed (${response.status} ${response.statusText})${loginHint}`
    + (requestId ? ` [request ID: ${requestId}]` : "")
    + (compact ? `: ${compact}` : "");
}

function decodeImage(encoded) {
  if (typeof encoded !== "string" || encoded.trim().length === 0) {
    fail("the image endpoint returned no base64 image data");
  }
  const normalized = encoded.trim();
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.toString("base64") !== normalized) fail("the image endpoint returned invalid base64");
  const type = imageMediaType(bytes);
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[type];
  if (!extension) fail("the image endpoint returned an unsupported output format");
  return { bytes, extension };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.model === undefined) fail("provide --model; choose the model that best fits the task");
  if (!IMAGE_MODELS.includes(args.model)) fail(`--model must be ${IMAGE_MODELS.join(" or ")}`);
  if (Boolean(args.prompt) === Boolean(args.promptFile)) {
    fail("provide exactly one of --prompt or --prompt-file");
  }
  if (args.inputs.length > MAX_EDIT_IMAGES) fail(`provide at most ${MAX_EDIT_IMAGES} input images`);

  const prompt = (args.prompt ?? await readFile(resolve(args.promptFile), "utf8")).trim();
  if (!prompt) fail("prompt must not be empty");

  const editing = args.inputs.length > 0;
  const images = editing ? await Promise.all(args.inputs.map(imageDataUrl)) : undefined;

  const { token, baseUrl } = await resolveOAuth();
  const requestBody = {
    ...(editing ? { images } : {}),
    model: args.model,
    prompt,
    background: "auto",
    quality: "auto",
    size: "auto",
  };

  const response = await fetchWithRetries(endpointFor(baseUrl, editing), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "chatgpt-account-id": accountIdFromToken(token),
      originator: "pi",
      accept: "application/json",
      "content-type": "application/json",
      // One standalone invocation is one logical image turn; retain it across retries.
      "x-codex-image-turn-id": randomUUID(),
      "user-agent": `pi-imagegen-skill (${process.platform}; ${process.arch})`,
    },
    redirect: "error",
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) fail(await responseError(response));
  const payload = await response.json();
  const { bytes: imageBytes, extension } = decodeImage(payload?.data?.[0]?.b64_json);

  const piHome = process.env.PI_HOME || join(homedir(), ".pi");
  const outputPath = join(piHome, "generated_images", `${randomUUID()}.${extension}`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, imageBytes, { mode: 0o600, flag: "wx" });
  console.log(outputPath);
}

export { decodeImage, endpointFor, fetchWithRetries, imageMediaType, responseError };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`imagegen: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
