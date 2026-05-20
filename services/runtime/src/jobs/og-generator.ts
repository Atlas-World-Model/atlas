/**
 * OG image generator — creates 1200x630 social cards using Atlas character poses.
 * Cycles through available poses based on article number.
 *
 * Requires Python 3 + Pillow on the host.
 */

import { execFile } from "child_process";

const ATLAS_DIR = process.env.ATLAS_DIR || "/opt/atlas";
const IMG_DIR = `${ATLAS_DIR}/apps/site/public/img`;

// Cycle through poses — order chosen for visual variety
const POSES = [
  "atlas-holding-world-hand.png",
  "atlas-juggling.png",
  "atlas-holding-world-back.png",
  "atlas-hands-raised.png",
  "atlas-hands-raised-higher.png",
  "atlas-kissing.png",
  "atlas-sad.png",
  "atlas-new-icon.png",
];

export function getPoseForArticle(articleNumber: number): string {
  return POSES[(articleNumber - 1) % POSES.length];
}

export async function generateOgImage(
  slug: string,
  title: string,
  articleNumber: number,
): Promise<string> {
  const pose = getPoseForArticle(articleNumber);
  const outputFilename = `og-${slug}.png`;
  const outputPath = `${IMG_DIR}/${outputFilename}`;

  // Split title into lines (~20 chars per line max)
  const lines = wrapTitle(title, 22);

  const script = `
import sys
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1200, 630
img = Image.new("RGB", (W, H), "#ffffff")
draw = ImageDraw.Draw(img)

# Load atlas pose
pose_path = os.path.join("${IMG_DIR}", "${pose}")
try:
    atlas = Image.open(pose_path).convert("RGBA")
    atlas_h = 460
    ratio = atlas_h / atlas.height
    atlas_w = int(atlas.width * ratio)
    atlas = atlas.resize((atlas_w, atlas_h), Image.LANCZOS)
    atlas_x = W - atlas_w - 40
    atlas_y = (H - atlas_h) // 2 + 10
    img.paste(atlas, (atlas_x, atlas_y), atlas)
    text_right_bound = atlas_x - 40
except Exception as e:
    print(f"Warning: could not load pose: {e}", file=sys.stderr)
    text_right_bound = W - 100

# Find fonts
font_paths = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/System/Library/Fonts/SFPro-Bold.otf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]
small_paths = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/System/Library/Fonts/SFPro-Regular.otf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
]

title_font = None
for fp in font_paths:
    if os.path.exists(fp):
        try:
            title_font = ImageFont.truetype(fp, 48)
            break
        except:
            continue
if not title_font:
    title_font = ImageFont.load_default()

sub_font = None
for fp in small_paths:
    if os.path.exists(fp):
        try:
            sub_font = ImageFont.truetype(fp, 24)
            break
        except:
            continue
if not sub_font:
    sub_font = ImageFont.load_default()

lines = ${JSON.stringify(lines)}
text_x = 72
y = max(155, (H - len(lines) * 60) // 2 - 30)
for line in lines:
    draw.text((text_x, y), line, fill="#1a1a1a", font=title_font)
    y += 60

y += 28
draw.text((text_x, y), "joinatlas.xyz", fill="#999999", font=sub_font)

img.save("${outputPath}", "PNG", quality=95)
print("ok")
`;

  return new Promise((resolve, reject) => {
    const proc = execFile(
      "python3",
      ["-c", script],
      { timeout: 30_000 },
      (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          console.error(`[og-gen] Failed: ${err.message}`);
          if (stderr) console.error(`[og-gen] ${stderr}`);
          reject(err);
          return;
        }
        console.log(`[og-gen] Generated ${outputFilename} with pose ${pose}`);
        resolve(outputFilename);
      },
    );
  });
}

function wrapTitle(title: string, maxCharsPerLine: number): string[] {
  const words = title.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length + word.length + 1 > maxCharsPerLine && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);

  return lines;
}
