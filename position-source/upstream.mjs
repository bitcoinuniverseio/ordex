export const HASH = /^[0-9a-f]{64}$/;
export const ATOMIC = /^(?:0|[1-9][0-9]{0,77})$/;
export const MAX_BODY = 2 * 1024 * 1024;

export class PositionError extends Error {
  constructor(code, status = 503) {
    super(code);
    this.status = status;
  }
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function readJson(url, options, code) {
  try {
    const response = await fetch(url, { ...options, redirect: 'error', cache: 'no-store' });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_BODY) {
      await response.body?.cancel();
      throw new PositionError(code);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_BODY) throw new PositionError(code);
      chunks.push(chunk);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new PositionError(code);
  }
}
