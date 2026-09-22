import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface FeishuEmojiCatalogEntry {
  emojiType: string;
  aliases: string[];
  fallbackEmoji?: string;
  tones?: string[];
  intents?: string[];
}

export interface FeishuEmojiCatalog {
  entries: FeishuEmojiCatalogEntry[];
  aliasMap: Map<string, FeishuEmojiCatalogEntry>;
  typeMap: Map<string, FeishuEmojiCatalogEntry>;
}

interface FeishuEmojiCatalogFile {
  version?: number;
  emojis?: Array<Partial<FeishuEmojiCatalogEntry>>;
}

const DEFAULT_EMOJIS: FeishuEmojiCatalogEntry[] = [
  { emojiType: 'SMILE', aliases: ['微笑', '笑', 'smile'], fallbackEmoji: '\u{1F642}', tones: ['friendly'], intents: ['greeting', 'ack'] },
  { emojiType: 'THUMBSUP', aliases: ['赞', '点赞', 'like', 'thumbs_up', '+1'], fallbackEmoji: '\u{1F44D}', tones: ['positive'], intents: ['agree', 'done'] },
  { emojiType: 'OK', aliases: ['OK', 'ok', '好', '可以'], fallbackEmoji: '\u{1F44C}', tones: ['positive'], intents: ['ack', 'done'] },
  { emojiType: 'LAUGH', aliases: ['大笑', '笑哭', 'laugh'], fallbackEmoji: '\u{1F602}', tones: ['playful'], intents: ['joke'] },
  { emojiType: 'BLUSH', aliases: ['脸红', '害羞', 'blush'], fallbackEmoji: '\u{1F60A}', tones: ['warm'], intents: ['thanks'] },
  { emojiType: 'THINKING', aliases: ['思考', '想想', 'thinking'], fallbackEmoji: '\u{1F914}', tones: ['thinking'], intents: ['question'] },
  { emojiType: 'EYES', aliases: ['眼睛', '看看', 'eyes'], fallbackEmoji: '\u{1F440}', tones: ['curious'], intents: ['watching'] },
  { emojiType: 'LOVE', aliases: ['爱心', '心', 'heart', 'love'], fallbackEmoji: '\u2764\uFE0F', tones: ['warm'], intents: ['thanks'] },
  { emojiType: 'FIRE', aliases: ['火', '厉害', 'fire'], fallbackEmoji: '\u{1F525}', tones: ['excited'], intents: ['praise'] },
  { emojiType: 'DONE', aliases: ['完成', '搞定', 'check', 'done'], fallbackEmoji: '\u2705', tones: ['done'], intents: ['done'] },
  { emojiType: 'BULL', aliases: ['牛', '厉害了', 'bull'], fallbackEmoji: '\u{1F44D}', tones: ['positive'], intents: ['praise'] },
];

let cachedCatalog: FeishuEmojiCatalog | null = null;
let cachedSignature = '';

function normalizeAlias(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

function normalizeEmojiType(value: string): string {
  return value.normalize('NFKC').trim().toUpperCase();
}

function isValidEmojiType(value: string): boolean {
  return /^[A-Z0-9_+-]{1,40}$/.test(value);
}

function findAncestor(start: string, marker: string): string | null {
  let current = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(current, marker))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function getCatalogDirs(): string[] {
  const dirs: string[] = [];
  const fromEnv = process.env.CTI_FEISHU_EMOJI_CATALOG_DIR?.trim();
  if (fromEnv) dirs.push(fromEnv);

  const suiteRoot = findAncestor(process.cwd(), 'suite.manifest.json')
    || findAncestor(path.dirname(new URL(import.meta.url).pathname), 'suite.manifest.json');
  if (suiteRoot) dirs.push(path.join(suiteRoot, 'config', 'feishu-emoji.d'));

  dirs.push(path.join(process.cwd(), 'config', 'feishu-emoji.d'));
  dirs.push(path.join(process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im'), 'config', 'feishu-emoji.d'));

  return Array.from(new Set(dirs.map((dir) => path.resolve(dir))));
}

function readCatalogFile(filePath: string): FeishuEmojiCatalogEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as FeishuEmojiCatalogFile;
    const entries: FeishuEmojiCatalogEntry[] = [];
    for (const item of Array.isArray(parsed.emojis) ? parsed.emojis : []) {
      const emojiType = normalizeEmojiType(String(item.emojiType || ''));
      if (!isValidEmojiType(emojiType)) continue;
      entries.push({
        emojiType,
        aliases: Array.isArray(item.aliases) ? item.aliases.map((alias) => String(alias || '').trim()).filter(Boolean) : [],
        fallbackEmoji: typeof item.fallbackEmoji === 'string' ? item.fallbackEmoji : undefined,
        tones: Array.isArray(item.tones) ? item.tones.map(String).filter(Boolean) : undefined,
        intents: Array.isArray(item.intents) ? item.intents.map(String).filter(Boolean) : undefined,
      });
    }
    return entries;
  } catch (err) {
    console.warn('[feishu-emoji] Failed to read catalog file:', filePath, err instanceof Error ? err.message : err);
    return [];
  }
}

function readConfiguredEntries(): { entries: FeishuEmojiCatalogEntry[]; signature: string } {
  const files = getCatalogDirs()
    .filter((dir) => fs.existsSync(dir))
    .flatMap((dir) => fs.readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.json'))
      .map((name) => path.join(dir, name)))
    .sort((a, b) => a.localeCompare(b));
  const signature = files.map((file) => `${file}:${fs.statSync(file).mtimeMs}`).join('|');
  return {
    entries: files.flatMap(readCatalogFile),
    signature,
  };
}

export function loadFeishuEmojiCatalog(): FeishuEmojiCatalog {
  const configured = readConfiguredEntries();
  const signature = configured.signature;
  if (cachedCatalog && cachedSignature === signature) return cachedCatalog;

  const merged = new Map<string, FeishuEmojiCatalogEntry>();
  for (const entry of [...DEFAULT_EMOJIS, ...configured.entries]) {
    const emojiType = normalizeEmojiType(entry.emojiType);
    const existing = merged.get(emojiType);
    merged.set(emojiType, {
      emojiType,
      aliases: Array.from(new Set([...(existing?.aliases || []), ...(entry.aliases || []), emojiType])),
      fallbackEmoji: entry.fallbackEmoji || existing?.fallbackEmoji,
      tones: Array.from(new Set([...(existing?.tones || []), ...(entry.tones || [])])),
      intents: Array.from(new Set([...(existing?.intents || []), ...(entry.intents || [])])),
    });
  }

  const entries = Array.from(merged.values());
  const aliasMap = new Map<string, FeishuEmojiCatalogEntry>();
  const typeMap = new Map<string, FeishuEmojiCatalogEntry>();
  for (const entry of entries) {
    typeMap.set(entry.emojiType, entry);
    for (const alias of entry.aliases) {
      const normalized = normalizeAlias(alias);
      if (normalized) aliasMap.set(normalized, entry);
    }
  }

  cachedCatalog = { entries, aliasMap, typeMap };
  cachedSignature = signature;
  return cachedCatalog;
}

export function resolveFeishuEmojiHint(raw: string): FeishuEmojiCatalogEntry | null {
  const normalizedAlias = normalizeAlias(raw);
  const catalog = loadFeishuEmojiCatalog();
  return catalog.aliasMap.get(normalizedAlias)
    || catalog.typeMap.get(normalizeEmojiType(raw))
    || null;
}

export function normalizeFeishuEmojiType(raw: string): string | null {
  const normalized = normalizeEmojiType(raw);
  return isValidEmojiType(normalized) ? normalized : null;
}

export function buildFeishuEmojiPrompt(limit = 16): string {
  const entries = loadFeishuEmojiCatalog().entries
    .slice()
    .sort((a, b) => Number(a.emojiType === 'SMILE') - Number(b.emojiType === 'SMILE'))
    .slice(0, limit);
  return entries
    .map((entry) => {
      const aliases = entry.aliases.filter((alias) => alias !== entry.emojiType).slice(0, 3).join('/');
      const intents = entry.intents?.length ? ` intent=${entry.intents.join('/')}` : '';
      return aliases ? `${entry.emojiType} aliases=${aliases}${intents}` : `${entry.emojiType}${intents}`;
    })
    .join(', ');
}
