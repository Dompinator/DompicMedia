import fs from 'node:fs';
import path from 'node:path';

const emojiDir = path.resolve(process.cwd(), 'public/emojis');
const outputFile = path.resolve(process.cwd(), 'src/lib/generated-emojis.ts');

if (!fs.existsSync(emojiDir)) {
  throw new Error(`Emoji directory not found: ${emojiDir}`);
}

const emojis = fs.readdirSync(emojiDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.png')
  .map((entry) => path.basename(entry.name, path.extname(entry.name)).toLowerCase())
  .filter((name) => /^[a-z0-9_]{2,32}$/.test(name));

const unique = [...new Set(emojis)].sort((a, b) => a.localeCompare(b));
const content = `// Generated automatically from public/emojis. Do not edit by hand.
export const BUILTIN_EMOJIS = ${JSON.stringify(unique, null, 2)} as const;
`;

fs.writeFileSync(outputFile, content, 'utf8');
console.log(`Generated emoji registry with ${unique.length} emojis.`);
