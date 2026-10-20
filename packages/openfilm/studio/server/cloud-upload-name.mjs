import { HttpError } from './http.mjs';

/** Keep the actual media extension: the cloud API derives content type from this name. */
export function cloudUploadName(sourceName, requested) {
  if (requested === undefined) return sourceName;
  if (typeof requested !== 'string' || !requested.trim() || /[/\\:\x00-\x1f]/.test(requested)) {
    throw new HttpError(400, 'Choose a plain file name.');
  }
  const extension = /\.[^./]+$/.exec(sourceName)?.[0] ?? '';
  const title = requested.trim();
  const name = extension && !title.toLowerCase().endsWith(extension.toLowerCase()) ? title + extension : title;
  if (name.length > 200 || name === '.' || name === '..') throw new HttpError(400, 'Use a file name of at most 200 characters.');
  return name;
}
