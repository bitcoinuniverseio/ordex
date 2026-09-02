/**
 * Ordex Security and Privacy Sanitization Engine
 * 
 * Centralized guard for secret detection, privacy masking, safe JSON parsing,
 * prototype pollution prevention, and allowlist validation.
 * Shared across Launchpad, Sandbox, Artifact Lens, Failure Navigator, and Agent Bridge.
 */

export interface SecretDetectionResult {
  hasHighConfidenceSecrets: boolean;
  detectedSecrets: Array<{
    type: string;
    description: string;
    location?: string;
  }>;
}

export interface SanitizedExportResult<T> {
  sanitized: T;
  redactions: Array<{
    path: string;
    type: string;
  }>;
  blocked: boolean;
  blockReason?: string;
}

// Regex patterns for high confidence private key and secret material
const BIP39_WORDLIST_SAMPLE = new Set([
  'abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse',
  'access', 'accident', 'account', 'accuse', 'achieve', 'acid', 'acoustic', 'acquire', 'across', 'act',
  'action', 'actor', 'actress', 'actual', 'adapt', 'add', 'addict', 'address', 'adjust', 'admit',
  'adult', 'advance', 'advice', 'aerobic', 'affair', 'afford', 'afraid', 'again', 'age', 'agent',
  'agree', 'ahead', 'aim', 'air', 'airport', 'aisle', 'alarm', 'album', 'alcohol', 'alert'
]);

const WIF_REGEX = /\b[5KL][1-9A-HJ-NP-Za-km-z]{49,52}\b/g;
const XPRV_REGEX = /\b(?:[xytuv]prv)[1-9A-HJ-NP-Za-km-z]{90,120}\b/g;
const PEM_PRIVATE_KEY_REGEX = /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g;
const AUTH_HEADER_REGEX = /(?:Authorization|Bearer|token|secret|password|api[_-]?key)\s*[:=]\s*['"]?([a-zA-Z0-9_\-\.]{16,})['"]?/gi;
const BEARER_TOKEN_REGEX = /\b(?:ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g; // JWT pattern

// Sensitive identifier patterns (non-key, but privacy sensitive)
const BITCOIN_ADDRESS_REGEX = /\b(?:bc1[a-z0-9]{25,87}|1[1-9A-HJ-NP-Za-km-z]{25,34}|3[1-9A-HJ-NP-Za-km-z]{25,34}|tb1[a-z0-9]{25,87})\b/g;
const XPUB_REGEX = /\b(?:[xytuv]pub)[1-9A-HJ-NP-Za-km-z]{90,120}\b/g;
const DERIVATION_PATH_REGEX = /\bm\/(?:44|49|84|86)'\/\d+'\/\d+'\/\d+\/\d+\b/g;


/**
 * Detect high confidence secrets that must strictly block export and remote sharing.
 */
export function detectSecrets(text: string): SecretDetectionResult {
  const detectedSecrets: Array<{ type: string; description: string; location?: string }> = [];

  if (PEM_PRIVATE_KEY_REGEX.test(text)) {
    detectedSecrets.push({
      type: 'PEM_PRIVATE_KEY',
      description: 'PEM formatted private key block detected'
    });
  }


  if (XPRV_REGEX.test(text)) {
    detectedSecrets.push({
      type: 'EXTENDED_PRIVATE_KEY',
      description: 'Extended private key (xprv/tprv) detected'
    });
  }

  if (WIF_REGEX.test(text)) {
    detectedSecrets.push({
      type: 'WIF_PRIVATE_KEY',
      description: 'Bitcoin Wallet Import Format (WIF) private key detected'
    });
  }

  if (BEARER_TOKEN_REGEX.test(text)) {
    detectedSecrets.push({
      type: 'JWT_BEARER_TOKEN',
      description: 'JSON Web Token or Bearer credential detected'
    });
  }

  // Check for 12 or 24 word mnemonic sequences
  const words = text.toLowerCase().match(/\b[a-z]{3,8}\b/g) || [];
  if (words.length >= 12) {
    let consecutiveMnemonicWords = 0;
    for (const word of words) {
      if (BIP39_WORDLIST_SAMPLE.has(word)) {
        consecutiveMnemonicWords++;
        if (consecutiveMnemonicWords >= 12) {
          detectedSecrets.push({
            type: 'BIP39_SEED_PHRASE',
            description: 'Potential BIP-39 mnemonic seed phrase detected'
          });
          break;
        }
      } else {
        consecutiveMnemonicWords = 0;
      }
    }
  }

  // Check authorization headers or explicit keys
  AUTH_HEADER_REGEX.lastIndex = 0;
  let authMatch: RegExpExecArray | null;
  while ((authMatch = AUTH_HEADER_REGEX.exec(text)) !== null) {
    detectedSecrets.push({
      type: 'AUTH_CREDENTIAL',
      description: 'Authorization header, password, or secret token detected'
    });
  }

  return {
    hasHighConfidenceSecrets: detectedSecrets.length > 0,
    detectedSecrets
  };
}

export function containsSecret(text: string): boolean {
  if (/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(text)) return true;
  if (/\b[5KL][1-9A-HJ-NP-Za-km-z]{49,52}\b/.test(text)) return true;
  if (/\b(?:[xytuv]prv)[1-9A-HJ-NP-Za-km-z]{90,120}\b/.test(text)) return true;
  if (/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(text)) return true;
  if (/Bearer\s+[A-Za-z0-9._~+/-]+=*/i.test(text)) return true;

  // Check 12-word BIP39 seed
  const words = text.toLowerCase().trim().split(/\s+/);
  if (words.length >= 12 && words.every(w => BIP39_WORDLIST_SAMPLE.has(w))) {
    return true;
  }

  return false;
}

/**
 * Masks privacy sensitive strings like addresses and xpubs for export or safe display.
 */
export function maskSensitiveIdentifiers(text: string): string {
  let masked = text;
  BITCOIN_ADDRESS_REGEX.lastIndex = 0;
  XPUB_REGEX.lastIndex = 0;
  DERIVATION_PATH_REGEX.lastIndex = 0;



  // Mask Bitcoin addresses to preserve prefix and suffix: bc1q...5mdq
  masked = masked.replace(BITCOIN_ADDRESS_REGEX, (match) => {
    if (match.length <= 12) return match;
    const prefix = match.slice(0, 4);
    const suffix = match.slice(-4);
    return `${prefix}...${suffix}`;
  });

  // Mask xpubs
  masked = masked.replace(XPUB_REGEX, (match) => {
    const prefix = match.slice(0, 4);
    const suffix = match.slice(-4);
    return `${prefix}...${suffix}`;
  });

  // Mask derivation paths
  masked = masked.replace(DERIVATION_PATH_REGEX, '[DERIVATION_PATH_MASKED]');

  return masked;
}

export const maskSensitiveData = maskSensitiveIdentifiers;

/**
 * Bounded JSON parser that rejects prototype pollution and limits nesting depth and payload size.
 */
export function safeJsonParse<T = unknown>(jsonString: string, maxBytes = 2 * 1024 * 1024, maxDepth = 32): T {
  if (typeof jsonString !== 'string') {
    throw new Error('safeJsonParse expects a string input');
  }

  const byteLength = new TextEncoder().encode(jsonString).length;
  if (byteLength > maxBytes) {
    throw new Error(`JSON payload size ${byteLength} exceeds allowable bound of ${maxBytes} bytes`);
  }

  // Pre-screen for prototype pollution attack keys
  if (jsonString.includes('__proto__') || jsonString.includes('constructor') || jsonString.includes('prototype')) {
    const rawParsed = JSON.parse(jsonString);
    sanitizePrototypeKeys(rawParsed);
    assertMaxDepth(rawParsed, 0, maxDepth);
    return rawParsed as T;
  }

  const parsed = JSON.parse(jsonString);
  assertMaxDepth(parsed, 0, maxDepth);
  return parsed as T;
}

function sanitizePrototypeKeys(obj: unknown): void {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) sanitizePrototypeKeys(item);
    return;
  }
  const record = obj as Record<string, unknown>;
  delete record.__proto__;
  delete record.constructor;
  delete record.prototype;
  for (const key of Object.keys(record)) {
    sanitizePrototypeKeys(record[key]);
  }
}

function assertMaxDepth(obj: unknown, currentDepth: number, maxDepth: number): void {
  if (currentDepth > maxDepth) {
    throw new Error(`JSON structure exceeds maximum allowed nesting depth of ${maxDepth}`);
  }
  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj)) {
      for (const item of obj) {
        assertMaxDepth(item, currentDepth + 1, maxDepth);
      }
    } else {
      for (const value of Object.values(obj)) {
        assertMaxDepth(value, currentDepth + 1, maxDepth);
      }
    }
  }
}

/**
 * Sanitize an entire session or payload for safe export or sharing.
 */
export function sanitizeForExport<T extends Record<string, unknown>>(data: T): SanitizedExportResult<T> {
  const jsonStr = JSON.stringify(data);
  const secretCheck = detectSecrets(jsonStr);

  if (secretCheck.hasHighConfidenceSecrets) {
    return {
      sanitized: data,
      redactions: [],
      blocked: true,
      blockReason: `High confidence secrets detected: ${secretCheck.detectedSecrets.map(s => s.type).join(', ')}. Export blocked to protect private keys.`
    };
  }

  const redactions: Array<{ path: string; type: string }> = [];

  function deepSanitize(val: unknown, currentPath = ''): unknown {
    if (typeof val === 'string') {
      const masked = maskSensitiveIdentifiers(val);
      if (masked !== val) {
        redactions.push({ path: currentPath, type: 'IDENTIFIER_MASK' });
      }
      return masked;
    }
    if (Array.isArray(val)) {
      return val.map((item, idx) => deepSanitize(item, `${currentPath}[${idx}]`));
    }
    if (val && typeof val === 'object') {
      const copy: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        // Redact known private fields
        if (/password|secret|auth|private|seed|wif|token/i.test(k)) {
          redactions.push({ path: `${currentPath}.${k}`, type: 'SECRET_KEY_REDACTION' });
          copy[k] = '[REDACTED]';
        } else {
          copy[k] = deepSanitize(v, currentPath ? `${currentPath}.${k}` : k);
        }
      }
      return copy;
    }
    return val;
  }

  const sanitized = deepSanitize(data) as T;

  return {
    sanitized,
    redactions,
    blocked: false
  };
}

export const sanitizeSessionExport = sanitizeForExport;


/**
 * Allowlists for protocol verifiers and MCP resources
 */
export const ALLOWED_VERIFIER_FAMILIES = new Set([
  'purchase',
  'offers',
  'safeops',
  'swaps',
  'runes',
  'events',
  'collection-manifest',
  'counterparty-asset',
  'offline-signing'
]);

export function isAllowedVerifierFamily(family: string): boolean {
  return ALLOWED_VERIFIER_FAMILIES.has(family);
}

/**
 * Prevent directory traversal and normalize resource paths
 */
export function sanitizeResourcePath(rawPath: string): string {
  // Strip control chars, null bytes, and traversal attempts
  const cleaned = rawPath.replace(/\0/g, '').replace(/\\/g, '/');
  if (cleaned.includes('../') || cleaned.startsWith('/') || cleaned.includes('..')) {
    throw new Error(`Disallowed path traversal attempt: ${rawPath}`);
  }
  return cleaned;
}

export const sanitizePath = sanitizeResourcePath;

