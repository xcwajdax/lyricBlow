import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OUTPUT_DIR = join(process.cwd(), "public", "branding");
const HERO_PROMPTS = {
  topkek:
    "Website landing hero image in TOPKEK terminal-HUD style. Dark near-black background (#111 range), subtle grain/texture, very high contrast. Main title text exactly: 'Lyric Blow' (with space), centered, bold, clean display lettering with slight techno/monospace influence, crisp edges, readable at a glance. Behind title: one expressive paint blot + drip/splatter shape (kleks spust), mostly black/charcoal with selective terminal-green glow accents (#4CAF50, #81C784). Composition should feel premium and minimal, not chaotic, with lots of negative space for UI overlays. No extra words, no logos, no watermark, no people, no objects.",
  default:
    "Website landing hero image for default app skin, neon mood. Dark navy-to-black cinematic background with glow haze. Main title text exactly: 'Lyric Blow' (with space), centered, bold, sleek modern lettering, highly readable. Behind title: dramatic ink blot + drip/splatter shape (kleks spust), with luminous neon blue and purple energy accents (electric cyan + violet + magenta), soft bloom, stylish and premium. Keep composition clean and focused, not chaotic, with clear negative space for UI overlays. No extra words, no logos, no watermark, no people, no objects.",
};

async function ensureOutputDir() {
  await mkdir(OUTPUT_DIR, { recursive: true });
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

async function openAiHero(theme = "topkek") {
  const key = required("OPENAI_API_KEY");
  const prompt = HERO_PROMPTS[theme];
  if (!prompt) {
    throw new Error(`Unknown theme "${theme}". Use: topkek | default`);
  }
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt,
      size: "1536x1024",
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI failed: ${response.status} ${await response.text()}`);
  }

  const json = await response.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("OpenAI returned no image data.");
  }

  const outPath = join(OUTPUT_DIR, `lyric-blow-hero-openai-${theme}.png`);
  await writeFile(outPath, Buffer.from(b64, "base64"));
  return outPath;
}

async function pollReplicatePrediction(url, token) {
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const statusRes = await fetch(url, {
      headers: { Authorization: `Token ${token}` },
    });
    if (!statusRes.ok) {
      throw new Error(`Replicate status failed: ${statusRes.status} ${await statusRes.text()}`);
    }
    const statusJson = await statusRes.json();
    if (statusJson.status === "succeeded") {
      return statusJson.output;
    }
    if (statusJson.status === "failed" || statusJson.status === "canceled") {
      throw new Error(`Replicate generation ${statusJson.status}: ${statusJson.error ?? "unknown error"}`);
    }
  }
  throw new Error("Replicate polling timeout.");
}

async function replicateHero() {
  const token = required("REPLICATE_API_TOKEN");
  const createRes = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "black-forest-labs/flux-schnell",
      input: {
        prompt: HERO_PROMPTS.topkek,
        aspect_ratio: "16:9",
        output_format: "png",
      },
    }),
  });

  if (!createRes.ok) {
    throw new Error(`Replicate failed: ${createRes.status} ${await createRes.text()}`);
  }

  const createJson = await createRes.json();
  const output = await pollReplicatePrediction(createJson.urls.get, token);
  const imageUrl = Array.isArray(output) ? output[0] : output;
  if (!imageUrl) {
    throw new Error("Replicate returned no image URL.");
  }

  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) {
    throw new Error(`Replicate image download failed: ${imageRes.status}`);
  }

  const buffer = Buffer.from(await imageRes.arrayBuffer());
  const outPath = join(OUTPUT_DIR, "lyric-blow-hero-replicate.png");
  await writeFile(outPath, buffer);
  return outPath;
}

async function stabilityHero() {
  const key = required("STABILITY_API_KEY");
  const body = new FormData();
  body.set("prompt", HERO_PROMPTS.topkek);
  body.set("aspect_ratio", "16:9");
  body.set("output_format", "png");

  const response = await fetch("https://api.stability.ai/v2beta/stable-image/generate/core", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "image/*",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Stability failed: ${response.status} ${await response.text()}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const outPath = join(OUTPUT_DIR, "lyric-blow-hero-stability.png");
  await writeFile(outPath, buffer);
  return outPath;
}

async function main() {
  await ensureOutputDir();
  const results = [];
  const providerArg = process.argv[2]?.toLowerCase();
  const themeArg = process.argv[3]?.toLowerCase() ?? "topkek";

  const providers = [
    ["openai", () => openAiHero(themeArg)],
    ["replicate", replicateHero],
    ["stability", stabilityHero],
  ];

  const selected = providerArg
    ? providers.filter(([name]) => name === providerArg)
    : providers;

  if (selected.length === 0) {
    throw new Error(
      `Unknown provider "${providerArg}". Use: openai | replicate | stability`
    );
  }

  for (const [name, run] of selected) {
    try {
      const out = await run();
      console.log(`OK ${name}: ${out}`);
      results.push({ name, ok: true, out });
    } catch (error) {
      console.error(`ERR ${name}: ${error.message}`);
      results.push({ name, ok: false, error: error.message });
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
